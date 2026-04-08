import chalk from 'chalk';
import EventSource from 'eventsource';
import type { Message, Tool, ToolCall, ToolResult } from '../types/index.js';
import type { LLMProviderInterface } from '../llm/types.js';
import { OllamaClient } from '../ollama/client.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
import { Planner, Plan, PlanStep, createPlanner } from './planner.js';
import { permissionManager } from './permission-manager.js';
import { getToolPermission, extractResource } from './tool-permissions.js';
import { ContextManager, createContextManager } from './context-manager.js';
import { createToolRegistry, ToolRegistry } from './tool-registry.js';
import { createTaskManager } from './task-manager.js';
import { createCronManager } from './cron-manager.js';
import type { MemoryProvider } from './memory-provider.js';
import { getArtifactOutputDir, resolveOutputPath } from '../utils/path-resolution.js';
import type { SkillCandidateRefinement, SkillLearningTodoSearchResult } from './skills.js';
import { TOOL_INTENT_CONTRACT_PROMPT, buildFallbackIntentContract, parseIntentContractResponse, type IntentContract } from './tool-intent-contract.js';
import { createRejectedToolResult, validateToolCallsAgainstContract } from './tool-call-validator.js';

export interface AgentOptions {
  llm: LLMProviderInterface;
  mcpManager?: MCPManager;
  lspManager?: LSPManager;
  sandbox?: Sandbox;
  builtInTools?: BuiltInTools;
  systemPrompt?: string;
  maxIterations?: number;
  maxToolCallsPerTurn?: number;
  planner?: Planner;
  onSkillInstallNeeded?: (skills: string[]) => Promise<void>;
  memoryProvider?: MemoryProvider;
  config?: Record<string, unknown>;
  contextConfig?: {
    maxWorkingTokens?: number;
    maxSummaryTokens?: number;
    enableSummary?: boolean;
    useLangChainFallback?: boolean;
  };
  skillManager?: any;
  agentRole?: string;
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error' | 'plan_summary' | 'plan_progress' | 'write_confirmation' | 'memory_sync' | 'skill_learning' | 'skill_learning_todo';
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  plan?: Plan;
  planProgress?: {
    stepId: string;
    stepDescription: string;
    stepIndex: number;
    totalSteps: number;
    status: 'started' | 'completed' | 'failed';
    result?: string;
  };
  writeData?: {
    content: string;
    suggestedPath?: string;
  };
  memorySync?: {
    backend: 'local' | 'mempalace' | 'hybrid';
    status: 'archived' | 'failed' | 'skipped';
    detail?: string;
  };
  skillLearning?: {
    candidateName: string;
    candidatePath: string;
    sourceTask: string;
  };
  skillLearningTodo?: {
    todoId: string;
    suggestedSkill: string;
    sourceTask: string;
  };
}

export type AgentState = 'IDLE' | 'THINKING' | 'TOOL_CALLING' | 'WAITING_CONFIRMATION' | 'RESPONDING';

export class Agent {
  private llm: LLMProviderInterface;
  private mcpManager: MCPManager;
  private lspManager: LSPManager;
  private sandbox: Sandbox;
  private builtInTools: BuiltInTools;
  private toolRegistry: ToolRegistry;
  private messages: Message[] = [];
  private systemPrompt: string;
  private maxIterations: number;
  private iteration = 0;
  private tools: Tool[] = [];
  private onEvent?: (event: AgentEvent) => void;
  private planner?: Planner;
  private pendingConfirmation?: {
    type: 'plan_execution' | 'write_file';
    callback: (confirmed: boolean, params?: any) => void;
    plan?: Plan;
    originalTask?: string;
  };
  private onSkillInstallNeeded?: (skills: string[]) => Promise<void>;
  private contextManager: ContextManager;
  private state: AgentState = 'IDLE';
  private lastUserInput: string = '';
  private toolCallCount = 0;
  private maxToolCallsPerTurn = 10;
  private lastStopReason: 'completed' | 'tool_limit' | 'max_iterations' | 'error' = 'completed';
  private skillManager?: any;
  private assignedSkills?: Set<string>;
  private agentRole?: string;
  private memoryProvider?: MemoryProvider;
  private config: Record<string, unknown>;
  private runtimeMemoryContext = '';
  private currentKnownGapNotice = '';
  private currentKnownGapContext = '';
  private readonly usingDefaultSystemPrompt: boolean;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    this.mcpManager = options.mcpManager ?? new MCPManager();
    this.lspManager = options.lspManager ?? new LSPManager();
    this.sandbox = options.sandbox ?? new Sandbox({ enabled: true });
    if (options.builtInTools) {
      this.builtInTools = options.builtInTools;
    } else {
      const taskManager = createTaskManager();
      const cronManager = createCronManager();
      void taskManager.initialize();
      void cronManager.initialize();
      this.builtInTools = new BuiltInTools(this.sandbox, this.lspManager, {
        mcpManager: this.mcpManager,
        taskManager,
        cronManager,
      });
    }
    this.skillManager = options.skillManager;
    this.config = options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : {};
    this.toolRegistry = createToolRegistry({
      builtInTools: this.builtInTools,
      mcpManager: this.mcpManager,
      skillManager: this.skillManager,
      skillContextFactory: this.skillManager ? () => ({
        workspace: process.cwd(),
        config: this.config,
        skillsDir: this.skillManager.getSkillsDir(),
      }) : undefined,
    });
    this.usingDefaultSystemPrompt = !options.systemPrompt;
    this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
    this.contextManager = createContextManager(options.contextConfig);
    this.maxIterations = options.maxIterations ?? 100;
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 10;
    this.planner = options.planner;
    this.onSkillInstallNeeded = options.onSkillInstallNeeded;
    this.agentRole = options.agentRole;
    this.memoryProvider = options.memoryProvider;

    this.initializeTools();
  }

  setEventHandler(handler: (event: AgentEvent) => void): void {
    this.onEvent = handler;
  }

  setConfirmationCallback(type: 'plan_execution' | 'write_file', callback: (confirmed: boolean, params?: any) => void): void {
    this.pendingConfirmation = { type, callback };
  }

  getConfirmationStatus(): { pending: boolean; type?: string } {
    return {
      pending: !!this.pendingConfirmation,
      type: this.pendingConfirmation?.type,
    };
  }

  async confirmAction(confirmed: boolean, params?: any): Promise<string | undefined> {
    let executionResult: string | undefined;

    if (this.pendingConfirmation) {
      this.contextManager.addMessage({ role: 'user', content: confirmed ? '是' : '否' });

      if (confirmed && this.pendingConfirmation.type === 'plan_execution' && this.pendingConfirmation.plan) {
        executionResult = await this.executePlan(this.pendingConfirmation.originalTask || 'task', this.pendingConfirmation.plan);
        if (executionResult) {
          this.contextManager.addMessage({ role: 'assistant', content: executionResult });
        }
      } else if (!confirmed && this.pendingConfirmation.type === 'plan_execution') {
        this.contextManager.addMessage({ role: 'assistant', content: '已取消执行当前计划。' });
      }

      this.pendingConfirmation.callback(confirmed, params);
      this.pendingConfirmation = undefined;
      this.state = 'IDLE';
    }

    return executionResult;
  }

  getState(): AgentState {
    return this.state;
  }

  setState(newState: AgentState): void {
    this.state = newState;
    if (newState === 'IDLE') {
      this.iteration = 0;
      this.toolCallCount = 0;
    }
  }

  getLastUserInput(): string {
    return this.lastUserInput;
  }

  isToolOverLimit(): boolean {
    return this.toolCallCount >= this.maxToolCallsPerTurn;
  }

  needsContinuation(): boolean {
    return this.lastStopReason === 'tool_limit';
  }

  getLastStopReason(): 'completed' | 'tool_limit' | 'max_iterations' | 'error' {
    return this.lastStopReason;
  }

  loadSkill(skillName: string): string | undefined {
    if (this.skillManager) {
      return this.skillManager.getSkillContent(skillName);
    }
    return undefined;
  }

  getAvailableSkills(): Array<{ name: string; description: string }> {
    if (this.skillManager) {
      return this.skillManager.getSkillDescriptions();
    }
    return [];
  }

  addSkill(skillName: string): void {
    if (!this.assignedSkills) {
      this.assignedSkills = new Set();
    }
    this.assignedSkills.add(skillName);
  }

  getSkills(): string[] {
    return Array.from(this.assignedSkills || []);
  }

  getRole(): string {
    return this.agentRole || 'default';
  }

  setRole(role: string): void {
    this.agentRole = role;
  }

  setRuntimeMemoryContext(context: string): void {
    this.runtimeMemoryContext = context.trim();
  }

  private async initializeTools(): Promise<void> {
    await this.toolRegistry.refresh();
    this.tools = this.toolRegistry.listTools();

    if (this.usingDefaultSystemPrompt) {
      this.systemPrompt = this.getDefaultSystemPrompt();
    }

    this.llm.setTools(this.tools);
  }

  private getDefaultSystemPrompt(): string {
    const availableSkills = this.getAvailableSkills();
    let skillSection = '';
    
    if (availableSkills.length > 0) {
      skillSection = `
## Available Skills
You can use skills to enhance your capabilities. When you need a skill, use the skill tool to load it.

<available_skills>
${availableSkills.map(s => `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
  </skill>`).join('\n')}
</available_skills>

`;
    }

  const hasMemPalace = this.tools.some(tool => tool.name.includes('mempalace_'));
  const memPalaceSection = hasMemPalace ? `
## Memory Protocol
When MemPalace tools are available, use them as the long-term memory backend.

Rules:
1. Before answering questions about a person, project, prior decision, or past event, first verify with mempalace_search or mempalace_kg_query when relevant.
2. Prefer mempalace_kg_query for structured facts and relationships, and mempalace_search for verbatim recall or broad retrieval.
3. If the answer depends on uncertain historical memory, say you are checking and use the memory tools instead of guessing.
4. After finishing an important task or conversation, write a concise memory using mempalace_diary_write.
5. When you learn a durable new fact that should persist, store it with mempalace_add_drawer or update facts with mempalace_kg_add / mempalace_kg_invalidate.

Do not use MemPalace for every turn. Use it when durable memory or historical verification matters.

` : '';

    return `You are an expert AI coding assistant, like Claude Code or OpenCode.

## Your Capabilities
You can help with:
- Reading, writing, and editing code files
- Running shell commands
- Searching and analyzing codebases
- Explaining complex concepts
- Debugging issues
- Writing tests and documentation${skillSection}${memPalaceSection}
## Tool Usage (CRITICAL - Read Carefully)

When you need to read, write, edit, list, search, or execute ANY file/command operation, you MUST actually call the tool. DO NOT just describe what you would do - you MUST use the tool.

Efficiency rules:
- Before planning, classify the request into one of three paths: direct action, focused investigation, or multi-step execution.
- Direct action means one clear operation like reading files, listing directories, searching text, exporting generated text, or running one explicit command. Handle these with zero or one tool call and do not create a plan.
- Focused investigation means small codebase exploration. Prefer 1-3 targeted tool calls before considering any plan.
- Only create a plan when the task truly has dependent multi-step work such as coordinated edits, staged verification, or several outputs.
- Prefer combining independent lookups into a single tool call when possible.
- Prefer read_multiple_files over repeated read_file calls when the user names several files explicitly.
- Prefer search_files or glob to narrow candidates before opening many files.
- If the user asks to save generated content as Word or PDF and a matching export tool exists, call that export tool directly instead of planning.
- For common save/export intents, prefer the configured outputs directory. Treat relative artifact paths, including ./file.docx and ./file.pdf, as outputs artifacts unless the user explicitly requests Desktop, ~, or an absolute path.
- Avoid long chains of tiny tool calls; aim to finish each focused batch in about 3-5 tool calls when practical.
- If more work is still needed after a focused batch, summarize progress clearly before continuing.

Respond with EXACT format only - no explanations before or after:

<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>

For example:
- To read a file: <tool_call>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tool_call>
- To list directory: <tool_call>{"name": "list_directory", "arguments": {"path": "."}}</tool_call>
- To run command: <tool_call>{"name": "execute_command", "arguments": {"command": "npm install"}}</tool_call>

## Available Tools
- read_file(path) - Read and RETURN file contents to user
- write_file(path, content) - Write content to file
- edit_file(path, old_string, new_string) - Edit file
- delete_file(path) - Delete file
- list_directory(path) - List directory contents
- create_directory(path) - Create directory
- search_files(path, pattern, content) - Search files
- glob(pattern, cwd) - Find files by pattern
- execute_command(command) - Execute shell command

## CRITICAL RULES
1. When user asks to read a file, you MUST call read_file tool and return the content
2. DO NOT say "I'll read the file for you" - actually call the tool
3. ONLY respond with <tool_call> block - no other text
4. After tool result, show the actual content to the user
5. If you don't call a tool, you won't get the file content

## Workflow
User: "Read the package.json file"
You: <tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>

[Tool result shows file content]

You: "Here's the content of package.json:
{actual content here}"`;
  }

  async chat(input: string): Promise<string> {
    this.lastUserInput = input;
    this.toolCallCount = 0;
    this.lastStopReason = 'completed';
    this.setState('THINKING');
    this.contextManager.addMessage({ role: 'user', content: input });
    await this.prepareKnownGapContext(input);

    const isComplex = await this.detectComplexTask(input);

    if (isComplex) {
      return this.chatWithPlanning(input);
    }

    const response = await this.generateResponse();
    this.setState('RESPONDING');
    return response;
  }

  async continueResponse(): Promise<string> {
    this.toolCallCount = 0;
    this.lastStopReason = 'completed';
    this.setState('THINKING');
    const response = await this.generateResponse();
    this.setState('RESPONDING');
    return response;
  }

  private getMessagesForLLM(): Message[] {
    const sanitizedMessages = this.sanitizeMessagesForLLM(this.contextManager.getMessages());
    const runtimeSections = [this.runtimeMemoryContext, this.currentKnownGapContext].filter(Boolean).join('\n\n');
    const runtimeContextMessage = runtimeSections
      ? [{ role: 'system' as const, content: `Runtime memory context:\n${runtimeSections}` }]
      : [];

    return [
      { role: 'system' as const, content: this.systemPrompt },
      ...runtimeContextMessage,
      ...sanitizedMessages,
    ];
  }

  private sanitizeMessagesForLLM(messages: Message[]): Message[] {
    const sanitized: Message[] = [];
    const validToolCallIds = new Set<string>();

    for (const message of messages) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          if (toolCall?.id) {
            validToolCallIds.add(toolCall.id);
          }
        }
        sanitized.push(message);
        continue;
      }

      if (message.role === 'tool') {
        if (message.tool_call_id && validToolCallIds.has(message.tool_call_id)) {
          sanitized.push(message);
        }
        continue;
      }

      sanitized.push(message);
    }

    return sanitized;
  }

  private async detectComplexTask(input: string): Promise<boolean> {
    const trimmedInput = input.trim();
    const inputLower = trimmedInput.toLowerCase();

    const simpleGreetings = [
      '你好', '您好', '嗨', 'hi', 'hello', 'hey',
      '早上好', '下午好', '晚上好', '在吗', '在不在',
    ];

    if (trimmedInput.length <= 12 && simpleGreetings.some(greeting => inputLower === greeting || inputLower.startsWith(`${greeting}呀`) || inputLower.startsWith(`${greeting}啊`))) {
      return false;
    }

    if (this.isLikelyDirectTask(trimmedInput)) {
      return false;
    }

    const complexityIndicators = [
      '多个', 'several', 'multiple', 'various',
      '先', '然后', 'first', 'then', 'after that',
      '分', '步骤', 'steps', 'phases',
      '并且', '同时', 'and also', 'also',
      '以及', 'plus', 'as well as',
      '需要完成', 'need to', 'should',
      '帮我', 'help me',
    ];

    let matchCount = 0;

    for (const indicator of complexityIndicators) {
      if (inputLower.includes(indicator)) {
        matchCount++;
      }
    }

    if (trimmedInput.length > 200 || matchCount >= 2) {
      return true;
    }

    if (trimmedInput.length <= 20 && matchCount === 0) {
      return false;
    }

    try {
      const response = await this.llm.generate([
        { role: 'system', content: '你是一个任务复杂度分析专家。判断用户任务是否复杂（需要多个步骤或多种工具）。简单回复 "是" 或 "否"。' },
        { role: 'user', content: `分析这个任务是否复杂：${input}` }
      ]);

      const result = response.toLowerCase().trim();

      const negativePatterns = [/^否[。！!]?$/, /^不是[。！!]?$/, /^不复杂[。！!]?$/, /^简单[。！!]?$/, /^no[.!]?$/, /^not complex[.!]?$/];
      if (negativePatterns.some(pattern => pattern.test(result))) {
        return false;
      }

      const positivePatterns = [/^是[。！!]?$/, /^复杂[。！!]?$/, /^需要规划[。！!]?$/, /^yes[.!]?$/, /^complex[.!]?$/];
      if (positivePatterns.some(pattern => pattern.test(result))) {
        return true;
      }

      return false;
    } catch {
      return matchCount >= 2;
    }
  }

  private isLikelyDirectTask(input: string): boolean {
    const directActionPatterns = [
      /^(?:@tool)\b/i,
      /^(?:请)?(?:帮我)?(?:读取|查看|打开|列出|搜索|查找|grep|find)\b/i,
      /(?:保存|导出|转成|生成|输出).*(?:pdf|word|docx)\b/i,
      /^(?:read_file|list_directory|search_files|glob|read_multiple_files|execute_command)\b/i,
    ];
    const multiStepPattern = /然后|再|接着|之后|同时|并且|并把|再把|先.+再|first.+then|and then|after that/i;

    if (multiStepPattern.test(input)) {
      return false;
    }

    if (!directActionPatterns.some(pattern => pattern.test(input))) {
      return false;
    }

    return /[\\/]|\.[a-z0-9]{1,8}\b|pdf\b|word\b|docx\b|目录|文件|关键词|内容|命令/i.test(input);
  }

  private isGenericPlan(plan: Plan, input: string): boolean {
    const normalizedInput = input.trim().toLowerCase();
    const genericMarkers = [
      '分析任务需求',
      '将任务拆分成清晰的步骤',
      '确定每个步骤需要的工具或操作',
      '开发一个网站应用',
      '分析数据并生成报告',
      '整理文件系统',
      '创建自动化工作流程',
      '或者其他任何复杂任务',
    ];

    if (plan.steps.length === 0) {
      return true;
    }

    const genericStepCount = plan.steps.filter(step => genericMarkers.includes(step.description.trim())).length;
    if (genericStepCount >= Math.max(2, Math.ceil(plan.steps.length / 2))) {
      return true;
    }

    if (normalizedInput.length <= 20 && plan.steps.length >= 3) {
      return true;
    }

    return false;
  }

  private async chatWithPlanning(input: string): Promise<string> {
    this.onEvent?.({ type: 'thinking', content: '分析任务复杂度，准备规划步骤...' });
    
    try {
      if (!this.planner) {
        return 'Planner not available, falling back to direct execution';
      }
      const plan = await this.planner.createPlan(input);

      if (this.isGenericPlan(plan, input)) {
        this.onEvent?.({ type: 'thinking', content: '规划结果过于通用，回退到直接对话响应。' });
        return this.generateResponse();
      }
      
      if (plan.neededSkills && plan.neededSkills.length > 0 && this.onSkillInstallNeeded) {
        console.log(chalk.yellow(`\n📦 检测到任务需要安装以下 Skills: ${plan.neededSkills.join(', ')}`));
        await this.onSkillInstallNeeded(plan.neededSkills);
      }
      
      let summary = `📋 **任务规划已创建**\n`;
      if (this.currentKnownGapNotice) {
        summary = `${this.currentKnownGapNotice}\n\n${summary}`;
      }
      summary += `**原任务**: ${plan.originalTask}\n\n`;
      summary += `**执行步骤** (${plan.steps.length} 步):\n`;
      
      for (let idx = 0; idx < plan.steps.length; idx++) {
        const step = plan.steps[idx];
        if (step) {
          summary += `${idx + 1}. ${step.description}\n`;
        }
      }
      summary += `\n请确认是否执行上述计划（回复 "是" 或 "否"）`;
      
      this.pendingConfirmation = {
        type: 'plan_execution',
        callback: () => {},
        plan,
        originalTask: input,
      };

      this.contextManager.addMessage({ role: 'assistant', content: summary });
      
      this.onEvent?.({ type: 'plan_summary', content: summary, plan });
      
      return summary;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`规划失败，回退到直接执行: ${errorMessage}`));
      return this.generateResponse();
    }
  }

  async executePlan(originalTask: string, plan: Plan): Promise<string> {
    const results: string[] = [];
    
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (!step) continue;
      
      const stepNum = i + 1;
      
      console.log(chalk.yellow(`\n🔄 执行步骤 ${stepNum}/${plan.steps.length}: ${step.description}`));
      this.onEvent?.({ type: 'thinking', content: `执行步骤 ${stepNum}: ${step.description}` });
      this.onEvent?.({
        type: 'plan_progress',
        content: `步骤开始: ${step.description}`,
        plan,
        planProgress: {
          stepId: step.id,
          stepDescription: step.description,
          stepIndex: i,
          totalSteps: plan.steps.length,
          status: 'started',
        },
      });
      
      try {
        const stepContext = this.buildPlanStepContext(originalTask, plan.steps.length, stepNum, step.description, results);
        let stepResult: string;

        if (step.toolCalls && step.toolCalls.length > 0) {
          stepResult = await this.executePlannedToolCalls(step, stepContext);
        } else {
          this.contextManager.addMessage({ role: 'user', content: stepContext });
          stepResult = await this.generateResponse();
        }

        this.planner?.completeStep(step.id, stepResult);
        this.onEvent?.({
          type: 'plan_progress',
          content: `步骤完成: ${step.description}`,
          plan,
          planProgress: {
            stepId: step.id,
            stepDescription: step.description,
            stepIndex: i,
            totalSteps: plan.steps.length,
            status: 'completed',
            result: stepResult,
          },
        });
        
        results.push(`[步骤 ${stepNum}] ${step.description}\n${stepResult}`);
        
        console.log(chalk.green(`✅ 步骤 ${stepNum} 完成`));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.planner?.failStep(step.id, errorMsg);
        this.onEvent?.({
          type: 'plan_progress',
          content: `步骤失败: ${step.description}`,
          plan,
          planProgress: {
            stepId: step.id,
            stepDescription: step.description,
            stepIndex: i,
            totalSteps: plan.steps.length,
            status: 'failed',
            result: errorMsg,
          },
        });
        results.push(`[步骤 ${stepNum}] 失败: ${errorMsg}`);
        console.log(chalk.red(`❌ 步骤 ${stepNum} 失败: ${errorMsg}`));
      }
    }
    
    await this.maybeLearnSkillCandidate(originalTask, plan, results);
    await this.maybeCaptureLearningTodo(originalTask, plan, results);
    return await this.synthesizeResults(originalTask, results);
  }

  private buildPlanStepContext(
    originalTask: string,
    totalSteps: number,
    stepNum: number,
    stepDescription: string,
    previousResults: string[],
  ): string {
    const previous = previousResults.length > 0 ? previousResults.join('\n---\n') : '暂无';
    return [
      '你正在执行一个已经确认的计划。只允许完成当前步骤，不要重写计划，不要扩展到其他步骤。',
      `原任务: ${originalTask}`,
      `当前步骤: ${stepNum}/${totalSteps}`,
      `步骤要求: ${stepDescription}`,
      `已完成步骤结果: ${previous}`,
      '如果当前步骤能直接得出结果，就直接给出当前步骤结果。',
    ].join('\n');
  }

  private async executePlannedToolCalls(step: PlanStep, stepContext: string): Promise<string> {
    const plannedCalls = step.toolCalls || [];
    const rawToolCalls: ToolCall[] = plannedCalls.map((toolCall, index) => ({
      id: `plan_${step.id}_${index + 1}`,
      type: 'function' as const,
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(this.resolvePlannedToolArgs(toolCall.args || {})),
      },
    }));

    const prepared = await this.prepareToolCallsForExecution(
      `${this.lastUserInput}\n${step.description}`,
      `按计划执行步骤工具：${step.description}`,
      rawToolCalls,
      false,
    );
    const assistantToolCalls = [...prepared.toolCalls, ...prepared.rejections.map(item => item.toolCall)];

    this.contextManager.addMessage({
      role: 'user',
      content: `${stepContext}\n本步骤必须优先执行计划中指定的工具调用。`,
    });

    this.contextManager.addMessage({
      role: 'assistant',
      content: `按计划执行步骤工具：${step.description}`,
      tool_calls: assistantToolCalls,
    });

    const toolOutputs: string[] = [];

    for (const rejected of prepared.rejections) {
      const result = createRejectedToolResult(rejected.toolCall.id, rejected.reason);
      const toolOutput = this.getToolResultText(result);
      this.onEvent?.({
        type: 'tool_result',
        content: toolOutput,
        toolResult: result,
      });
      this.contextManager.addMessage({
        role: 'tool',
        content: toolOutput,
        tool_call_id: rejected.toolCall.id,
        name: rejected.toolCall.function.name,
      });
      throw new Error(toolOutput || `${rejected.toolCall.function.name} 被 intent contract 拒绝`);
    }

    for (const toolCall of prepared.toolCalls) {
      this.toolCallCount++;
      this.onEvent?.({
        type: 'tool_call',
        content: `Calling tool: ${toolCall.function.name}`,
        toolCall,
      });

      const result = await this.executeToolCall(toolCall);
      const toolOutput = this.getToolResultText(result);
      if (result.is_error) {
        throw new Error(toolOutput || `${toolCall.function.name} 执行失败`);
      }
      toolOutputs.push(`[${toolCall.function.name}]\n${toolOutput || '(无输出)'}`);

      this.onEvent?.({
        type: 'tool_result',
        content: toolOutput,
        toolResult: result,
      });

      this.contextManager.addMessage({
        role: 'tool',
        content: toolOutput,
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
      });
    }

    const combined = toolOutputs.join('\n\n');
    const summary = combined.trim() || `步骤 ${step.description} 已按计划执行完成。`;
    this.contextManager.addMessage({ role: 'assistant', content: summary });
    return summary;
  }

  private resolvePlannedToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    const artifactOutputDir = getArtifactOutputDir({
      workspace: process.cwd(),
      artifactOutputDir: typeof this.config.artifactOutputDir === 'string' ? this.config.artifactOutputDir : undefined,
      documentOutputDir: typeof this.config.documentOutputDir === 'string' ? this.config.documentOutputDir : undefined,
    });

    return this.resolvePlaceholderValue(args, {
      workspace: process.cwd(),
      artifactOutputDir,
      lastAssistantText: this.getLatestAssistantText(),
    }) as Record<string, unknown>;
  }

  private resolvePlaceholderValue(
    value: unknown,
    runtime: { workspace: string; artifactOutputDir: string; lastAssistantText: string },
  ): unknown {
    if (typeof value === 'string') {
      return value
        .replace(/\$WORKSPACE/g, runtime.workspace)
        .replace(/\$ARTIFACT_OUTPUT_DIR/g, runtime.artifactOutputDir)
        .replace(/\$LAST_ASSISTANT_TEXT/g, runtime.lastAssistantText || '');
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolvePlaceholderValue(item, runtime));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, this.resolvePlaceholderValue(nested, runtime)]),
      );
    }

    return value;
  }

  private getLatestAssistantText(): string {
    const messages = this.contextManager.getMessages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== 'assistant') {
        continue;
      }
      const content = message.content?.trim();
      if (content) {
        return content;
      }
    }

    return '';
  }

  private async synthesizeResults(originalTask: string, stepResults: string[]): Promise<string> {
    const failedSteps = stepResults.filter(result => result.includes('失败')).length;
    const completedSteps = stepResults.length - failedSteps;
    const totalSteps = stepResults.length;
    const allSucceeded = failedSteps === 0 && totalSteps > 0;
    const partiallySucceeded = failedSteps > 0 && completedSteps > 0;

    let finalResponse = allSucceeded
      ? `## ✅ 任务完成\n\n`
      : partiallySucceeded
        ? `## ⚠️ 任务部分完成\n\n`
        : `## ❌ 任务失败\n\n`;
    finalResponse += `**原始任务**: ${originalTask}\n\n`;
    finalResponse += `**执行摘要**:\n\n`;
    
    for (let i = 0; i < stepResults.length; i++) {
      finalResponse += `### 步骤 ${i + 1}\n${stepResults[i]}\n\n`;
    }
    
    finalResponse += `---\n**完成进度**: ${completedSteps}/${totalSteps} 步骤成功完成`;
    if (!allSucceeded) {
      finalResponse += `\n**最终状态**: ${partiallySucceeded ? '部分完成，至少一个关键步骤失败。' : '执行失败，未达到任务要求。'}`;
    }

    await this.archiveTaskSummary(originalTask, stepResults, completedSteps, totalSteps, allSucceeded ? 'completed' : partiallySucceeded ? 'partial' : 'failed');
    
    this.onEvent?.({ type: 'response', content: finalResponse });
    
    return finalResponse;
  }

  private async maybeLearnSkillCandidate(originalTask: string, plan: Plan, stepResults: string[]): Promise<void> {
    if (!this.skillManager || typeof this.skillManager.maybeCreateCandidateFromExecution !== 'function') {
      return;
    }

    const completedSteps = stepResults.filter(result => !result.includes('失败')).length;
    try {
      const refinement = await this.assessSkillCandidateDraft(originalTask, plan, stepResults, completedSteps);
      const candidate = await this.skillManager.maybeCreateCandidateFromExecution({
        originalTask,
        stepDescriptions: plan.steps.map(step => step.description),
        stepResults,
        completedSteps,
        totalSteps: plan.steps.length,
        refinement,
      });

      if (!candidate) {
        return;
      }

      this.onEvent?.({
        type: 'skill_learning',
        content: `已基于本次成功任务生成候选 skill 草稿: ${candidate.name}`,
        skillLearning: {
          candidateName: candidate.name,
          candidatePath: candidate.path,
          sourceTask: candidate.sourceTask,
        },
      });
    } catch (error) {
      this.onEvent?.({
        type: 'thinking',
        content: `Skill learning skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async assessSkillCandidateDraft(
    originalTask: string,
    plan: Plan,
    stepResults: string[],
    completedSteps: number,
  ): Promise<SkillCandidateRefinement | undefined> {
    const fallback = this.buildFallbackSkillCandidateRefinement(originalTask, plan, stepResults, completedSteps);

    try {
      const response = await this.llm.generate([
        {
          role: 'system',
          content: [
            '你是 procedural skill reviewer。你的任务是在候选 skill 落盘前做一次自检与精炼。',
            '请判断这个成功任务是否值得沉淀成可复用 procedural skill，并输出 JSON。',
            '返回格式：',
            '{',
            '  "shouldCreate": true,',
            '  "confidence": 0.0,',
            '  "refinedDescription": "一句更稳定的技能描述",',
            '  "whenToUse": "适用任务描述",',
            '  "procedure": ["步骤1", "步骤2"],',
            '  "verification": ["验证点1", "验证点2"],',
            '  "tags": ["tag1", "tag2"],',
            '  "qualitySummary": "简短评估摘要",',
            '  "suggestedName": "skill name hint"',
            '}',
            '要求：',
            '- 如果流程过于一次性、环境偶然性太强或步骤不稳定，就 shouldCreate=false。',
            '- confidence 取值 0 到 1。',
            '- procedure 必须是可复用、抽象后的步骤，不要照抄原始日志。',
            '- 只返回 JSON。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `任务: ${originalTask}`,
            `完成进度: ${completedSteps}/${plan.steps.length}`,
            '计划步骤:',
            ...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
            '执行结果:',
            ...stepResults.map((result, index) => `${index + 1}. ${result.replace(/\s+/g, ' ').slice(0, 400)}`),
          ].join('\n'),
        },
      ]);

      const parsed = this.parseSkillCandidateRefinement(response);
      if (!parsed) {
        return fallback;
      }

      return {
        ...fallback,
        ...parsed,
        procedure: parsed.procedure && parsed.procedure.length > 0 ? parsed.procedure : fallback.procedure,
        verification: parsed.verification && parsed.verification.length > 0 ? parsed.verification : fallback.verification,
        tags: parsed.tags && parsed.tags.length > 0 ? parsed.tags : fallback.tags,
      };
    } catch {
      return fallback;
    }
  }

  private parseSkillCandidateRefinement(response: string): SkillCandidateRefinement | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    const raw = jsonMatch?.[1] ?? jsonMatch?.[2] ?? response;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        shouldCreate: typeof parsed.shouldCreate === 'boolean' ? parsed.shouldCreate : undefined,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
        refinedDescription: typeof parsed.refinedDescription === 'string' ? parsed.refinedDescription.trim() : undefined,
        whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse.trim() : undefined,
        procedure: Array.isArray(parsed.procedure) ? parsed.procedure.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined,
        verification: Array.isArray(parsed.verification) ? parsed.verification.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined,
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined,
        qualitySummary: typeof parsed.qualitySummary === 'string' ? parsed.qualitySummary.trim() : undefined,
        suggestedName: typeof parsed.suggestedName === 'string' ? parsed.suggestedName.trim() : undefined,
      };
    } catch {
      return null;
    }
  }

  private buildFallbackSkillCandidateRefinement(
    originalTask: string,
    plan: Plan,
    stepResults: string[],
    completedSteps: number,
  ): SkillCandidateRefinement {
    const shortenedTask = originalTask.replace(/\s+/g, ' ').trim();
    return {
      shouldCreate: completedSteps === plan.steps.length && plan.steps.length >= 2,
      confidence: completedSteps === plan.steps.length ? 0.68 : 0.4,
      refinedDescription: `Reusable draft skill for: ${shortenedTask.slice(0, 100)}`,
      whenToUse: shortenedTask,
      procedure: plan.steps.map(step => step.description),
      verification: [
        '确认输出物与本次任务结果一致。',
        '确认步骤不依赖一次性环境状态或手动上下文。',
      ],
      tags: this.extractProceduralTags(originalTask, plan.steps.map(step => step.description), stepResults),
      qualitySummary: 'Fallback self-review: completed workflow with reusable multi-step structure.',
    };
  }

  private extractProceduralTags(originalTask: string, stepDescriptions: string[], stepResults: string[]): string[] {
    const corpus = [originalTask, ...stepDescriptions, ...stepResults].join(' ').toLowerCase();
    const tags = new Set<string>();
    const tagRules: Array<[RegExp, string]> = [
      [/(日志|log)/i, 'logs'],
      [/(日报|report)/i, 'report'],
      [/(文档|docx|word|pdf|markdown|md)/i, 'document'],
      [/(搜索|查找|grep|find)/i, 'search'],
      [/(导出|输出|保存)/i, 'export'],
      [/(代码|code|typescript|javascript)/i, 'code'],
      [/(表格|excel|xlsx|csv)/i, 'spreadsheet'],
    ];

    for (const [pattern, tag] of tagRules) {
      if (pattern.test(corpus)) {
        tags.add(tag);
      }
    }

    return Array.from(tags).slice(0, 8);
  }

  private async maybeCaptureLearningTodo(originalTask: string, plan: Plan, stepResults: string[]): Promise<void> {
    if (!this.skillManager || typeof this.skillManager.addLearningTodo !== 'function') {
      return;
    }

    const failedResults = stepResults.filter(result => result.includes('失败'));
    if (failedResults.length === 0) {
      return;
    }

    const suggestion = await this.assessLearningTodo(originalTask, plan, stepResults);
    if (!suggestion.shouldTrack) {
      return;
    }

    try {
      const todo = await this.skillManager.addLearningTodo({
        sourceTask: originalTask,
        issueSummary: suggestion.issueSummary,
        suggestedSkill: suggestion.suggestedSkill,
        blockers: suggestion.blockers,
        nextActions: suggestion.nextActions,
        tags: suggestion.tags,
        confidence: suggestion.confidence,
      });

      this.onEvent?.({
        type: 'skill_learning_todo',
        content: `已记录待学习 skill todo: ${todo.suggestedSkill}`,
        skillLearningTodo: {
          todoId: todo.id,
          suggestedSkill: todo.suggestedSkill,
          sourceTask: todo.sourceTask,
        },
      });
    } catch (error) {
      this.onEvent?.({
        type: 'thinking',
        content: `Skill learning todo skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async assessLearningTodo(
    originalTask: string,
    plan: Plan,
    stepResults: string[],
  ): Promise<{
    shouldTrack: boolean;
    issueSummary: string;
    suggestedSkill: string;
    blockers: string[];
    nextActions: string[];
    tags: string[];
    confidence?: number;
  }> {
    const fallback = {
      shouldTrack: true,
      issueSummary: '任务在执行过程中存在未解决的步骤失败，适合沉淀为待学习 skill。',
      suggestedSkill: this.deriveSuggestedSkillName(originalTask),
      blockers: stepResults.filter(result => result.includes('失败')).map(result => result.replace(/\s+/g, ' ').slice(0, 180)),
      nextActions: ['分析失败步骤的缺口。', '确认是否需要新 skill 或补强现有 skill。', '复盘并抽象可复用流程。'],
      tags: this.extractProceduralTags(originalTask, plan.steps.map(step => step.description), stepResults),
      confidence: 0.74,
    };

    try {
      const response = await this.llm.generate([
        {
          role: 'system',
          content: [
            '你是 Hermes 风格的 skill gap reviewer。',
            '任务失败或未解决时，请判断是否值得加入待学习 skill todo。',
            '只返回 JSON：',
            '{',
            '  "shouldTrack": true,',
            '  "issueSummary": "问题摘要",',
            '  "suggestedSkill": "建议学习的 skill 名称或方向",',
            '  "blockers": ["阻塞点1"],',
            '  "nextActions": ["下一步1"],',
            '  "tags": ["tag1"],',
            '  "confidence": 0.0',
            '}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `任务: ${originalTask}`,
            '计划步骤:',
            ...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
            '步骤结果:',
            ...stepResults.map((result, index) => `${index + 1}. ${result.replace(/\s+/g, ' ').slice(0, 400)}`),
          ].join('\n'),
        },
      ]);

      const parsed = this.parseLearningTodoAssessment(response);
      return parsed || fallback;
    } catch {
      return fallback;
    }
  }

  private parseLearningTodoAssessment(response: string): {
    shouldTrack: boolean;
    issueSummary: string;
    suggestedSkill: string;
    blockers: string[];
    nextActions: string[];
    tags: string[];
    confidence?: number;
  } | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    const raw = jsonMatch?.[1] ?? jsonMatch?.[2] ?? response;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const suggestedSkill = typeof parsed.suggestedSkill === 'string' ? parsed.suggestedSkill.trim() : '';
      const issueSummary = typeof parsed.issueSummary === 'string' ? parsed.issueSummary.trim() : '';
      if (!suggestedSkill || !issueSummary) {
        return null;
      }

      return {
        shouldTrack: typeof parsed.shouldTrack === 'boolean' ? parsed.shouldTrack : true,
        issueSummary,
        suggestedSkill,
        blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [],
        nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      };
    } catch {
      return null;
    }
  }

  private deriveSuggestedSkillName(originalTask: string): string {
    return originalTask
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'learn-skill-gap';
  }

  private async archiveTaskSummary(
    originalTask: string,
    stepResults: string[],
    completedSteps: number,
    totalSteps: number,
    status: 'completed' | 'partial' | 'failed',
  ): Promise<void> {
    if (!this.memoryProvider) {
      this.onEvent?.({
        type: 'memory_sync',
        content: 'Memory provider 未启用，跳过长期归档。',
        memorySync: { backend: 'local', status: 'skipped', detail: 'provider_missing' },
      });
      return;
    }

    const summaryLines = stepResults
      .map(result => result.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 4);
    const entry = [
      `DATE:${new Date().toISOString().slice(0, 10)}`,
      `TASK:${originalTask}`,
      `STATUS:${status}`,
      `PROGRESS:${completedSteps}/${totalSteps}`,
      summaryLines.length > 0 ? `SUMMARY:${summaryLines.join(' | ')}` : undefined,
      'IMPORTANCE:★★★',
    ].filter(Boolean).join('\n');

    try {
      await this.memoryProvider.store({
        kind: 'task',
        title: originalTask,
        content: entry,
        metadata: {
          completedSteps,
          totalSteps,
          agentRole: this.agentRole || 'ai-agent-cli',
        },
      });
      this.onEvent?.({
        type: 'memory_sync',
        content: 'Memory provider 已归档本次任务摘要。',
        memorySync: { backend: this.memoryProvider.backend, status: 'archived', detail: 'task_summary' },
      });
    } catch (error) {
      this.onEvent?.({
        type: 'memory_sync',
        content: `Memory provider 归档失败: ${error instanceof Error ? error.message : String(error)}`,
        memorySync: {
          backend: this.memoryProvider.backend,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async generateResponse(): Promise<string> {
    this.iteration = 0;
    this.toolCallCount = 0;
    this.lastStopReason = 'completed';
    let fullResponse = '';

    while (this.iteration < this.maxIterations) {
      this.iteration++;
      
      if (this.isToolOverLimit()) {
        this.lastStopReason = 'tool_limit';
        console.log(chalk.yellow(`\n⚠️ 工具调用次数达到上限 (${this.maxToolCallsPerTurn})，强制结束当前响应`));
        break;
      }

      this.onEvent?.({ type: 'thinking', content: `Generating response... (iteration ${this.iteration})` });

      const allMessages = this.getMessagesForLLM();

      try {
        if (!this.llm.chatStream) {
          fullResponse = await this.llm.generate(allMessages);
          const parsedToolCalls = this.parseToolCalls(fullResponse);
          if (parsedToolCalls.length > 0) {
            this.setState('TOOL_CALLING');
            const cleanResponse = fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim() || 'Using tool...';
            const prepared = await this.prepareToolCallsForExecution(this.lastUserInput, cleanResponse, parsedToolCalls, true);
            const assistantToolCalls = [...prepared.toolCalls, ...prepared.rejections.map(item => item.toolCall)];
            const firstToolCall = assistantToolCalls[0];
            const assistantMsg: Message = { 
              role: 'assistant' as const, 
              content: cleanResponse,
            };
            if (firstToolCall) {
              assistantMsg.tool_calls = [{ id: firstToolCall.id, type: 'function' as const, function: firstToolCall.function }];
              if (assistantToolCalls.length > 1) {
                assistantMsg.tool_calls = assistantToolCalls.map(item => ({ id: item.id, type: 'function' as const, function: item.function }));
              }
            }
            this.contextManager.addMessage(assistantMsg);

            for (const rejected of prepared.rejections) {
              const result = createRejectedToolResult(rejected.toolCall.id, rejected.reason);
              const toolOutput = this.getToolResultText(result);
              this.onEvent?.({
                type: 'tool_result',
                content: toolOutput,
                toolResult: result,
              });
              this.contextManager.addMessage({
                role: 'tool',
                content: toolOutput,
                tool_call_id: rejected.toolCall.id,
                name: rejected.toolCall.function.name,
              });
            }

            for (const toolCall of prepared.toolCalls) {
              this.toolCallCount++;
              this.onEvent?.({
                type: 'tool_call',
                content: `Calling tool: ${toolCall.function.name}`,
                toolCall,
              });
              const result = await this.executeToolCall(toolCall);
              const toolOutput = this.getToolResultText(result);
              this.onEvent?.({
                type: 'tool_result',
                content: toolOutput,
                toolResult: result,
              });
              this.contextManager.addMessage({
                role: 'tool',
                content: toolOutput,
                tool_call_id: toolCall.id,
                name: toolCall.function.name,
              });
            }
            continue;
          }

          fullResponse = this.applyKnownGapNotice(fullResponse);
          this.contextManager.addMessage({ role: 'assistant', content: fullResponse });
          break;
        }

        const stream = this.llm.chatStream(allMessages);
        let accumulatedContent = '';
        let nativeToolCalls: ToolCall[] = [];

        for await (const chunk of stream) {
          accumulatedContent += chunk.content;
          this.onEvent?.({ type: 'response', content: chunk.content });
          
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            nativeToolCalls = chunk.toolCalls;
          }
        }

        fullResponse = accumulatedContent;

        const parsedToolCalls = this.parseToolCalls(fullResponse);
        const finalToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : parsedToolCalls;

        if (finalToolCalls.length > 0) {
          this.setState('TOOL_CALLING');
          let cleanResponse = fullResponse
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
            .trim();

          const prepared = await this.prepareToolCallsForExecution(this.lastUserInput, cleanResponse || 'Using tool...', finalToolCalls, true);
          const assistantToolCalls = [...prepared.toolCalls, ...prepared.rejections.map(item => item.toolCall)];

          if (cleanResponse || nativeToolCalls.length > 0 || assistantToolCalls.length > 0) {
            this.contextManager.addMessage({ 
              role: 'assistant', 
              content: cleanResponse || 'Using tool...',
              tool_calls: assistantToolCalls,
            });
          }

          for (const rejected of prepared.rejections) {
            const result = createRejectedToolResult(rejected.toolCall.id, rejected.reason);
            const toolOutput = this.getToolResultText(result);
            this.onEvent?.({
              type: 'tool_result',
              content: toolOutput,
              toolResult: result,
            });
            this.contextManager.addMessage({
              role: 'tool',
              content: toolOutput,
              tool_call_id: rejected.toolCall.id,
              name: rejected.toolCall.function.name,
            });
          }

          for (const toolCall of prepared.toolCalls) {
            this.toolCallCount++;
            this.onEvent?.({
              type: 'tool_call',
              content: `Calling tool: ${toolCall.function.name}`,
              toolCall,
            });

            const result = await this.executeToolCall(toolCall);
            const toolOutput = this.getToolResultText(result);
            
            this.onEvent?.({
              type: 'tool_result',
              content: toolOutput,
              toolResult: result,
            });

            this.contextManager.addMessage({
              role: 'tool',
              content: toolOutput,
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
            });
          }

          continue;
        }

        fullResponse = this.applyKnownGapNotice(fullResponse);
        this.contextManager.addMessage({ role: 'assistant', content: fullResponse });
        break;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.lastStopReason = 'error';
        this.onEvent?.({ type: 'error', content: errorMessage });
        this.contextManager.addMessage({ role: 'assistant', content: `Error: ${errorMessage}` });
        return this.applyKnownGapNotice(fullResponse || `Error occurred: ${errorMessage}`);
      }
    }

    if (this.iteration >= this.maxIterations) {
      this.lastStopReason = 'max_iterations';
      return this.applyKnownGapNotice('Maximum iterations reached. Please try a simpler task.');
    }

    return this.applyKnownGapNotice(fullResponse);
  }

  private async prepareKnownGapContext(input: string): Promise<void> {
    this.currentKnownGapNotice = '';
    this.currentKnownGapContext = '';

    if (!this.skillManager || typeof this.skillManager.searchLearningTodos !== 'function') {
      return;
    }

    try {
      const queries = this.buildKnownGapQueries(input);
      let strongest: SkillLearningTodoSearchResult | undefined;
      for (const query of queries) {
        const matches = await this.skillManager.searchLearningTodos(query, 2) as SkillLearningTodoSearchResult[];
        const candidate = matches.find(item => item.score >= 0.55);
        if (candidate && (!strongest || candidate.score > strongest.score)) {
          strongest = candidate;
        }
      }
      if (!strongest) {
        return;
      }

      this.currentKnownGapNotice = `这是已知能力缺口：${strongest.issueSummary}（todo: ${strongest.id}，建议 skill: ${strongest.suggestedSkill}）。`;
      this.currentKnownGapContext = [
        'Known skill gap detected for this task.',
        `Start by telling the user exactly this sentence: ${this.currentKnownGapNotice}`,
        'Then decide whether a truthful downgrade path exists. If a downgrade is viable, explain the downgrade briefly and execute it. If not, say the capability is currently unavailable.',
        `Known blockers: ${(strongest.blockers || []).join(' | ') || 'n/a'}`,
        `Suggested next actions: ${(strongest.nextActions || []).join(' | ') || 'n/a'}`,
      ].join('\n');
    } catch {
      this.currentKnownGapNotice = '';
      this.currentKnownGapContext = '';
    }
  }

  private buildKnownGapQueries(input: string): string[] {
    const stripped = input.replace(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|docx|pdf|xlsx))/gi, ' ');
    const formatTerms = Array.from(new Set((input.match(/docx|pdf|xlsx|markdown|md|txt|excel|word/gi) || []).map(item => item.toLowerCase())));
    return Array.from(new Set([
      input.trim(),
      stripped.replace(/\s+/g, ' ').trim(),
      formatTerms.join(' 转 '),
    ].filter(Boolean)));
  }

  private applyKnownGapNotice(response: string): string {
    const normalized = response.trim();
    if (!this.currentKnownGapNotice) {
      return normalized;
    }

    if (!normalized) {
      return this.currentKnownGapNotice;
    }

    if (normalized.startsWith(this.currentKnownGapNotice) || normalized.includes('这是已知能力缺口')) {
      return normalized;
    }

    return `${this.currentKnownGapNotice}\n\n${normalized}`;
  }

  private async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const { name, arguments: argsStr } = toolCall.function;
    
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr);
    } catch {
      return { tool_call_id: toolCall.id, output: 'Invalid JSON arguments', is_error: true };
    }

    args = this.resolvePlannedToolArgs(args);

    console.log(chalk.gray(`\n[TOOL] Executing: ${name}`));
    console.log(chalk.gray(`[TOOL] Args: ${JSON.stringify(args)}`));
    
    const toolPerm = getToolPermission(name);
    if (toolPerm) {
      const resource = extractResource(name, args) || toolPerm.resourceExtractor?.(args);
      const description = `${name}${resource ? ` on ${resource}` : ''}`;
      
      const granted = await permissionManager.requestPermission(
        toolPerm.permissionType,
        resource,
        description
      );
      
      if (!granted) {
        console.log(chalk.red(`[TOOL] Permission denied: ${name}`));
        return {
          tool_call_id: toolCall.id,
          output: `Permission denied: ${toolPerm.permissionType}${resource ? ` (${resource})` : ''}\n需要授权才能执行此操作。输入 /perm 查看权限设置。`,
          is_error: true,
        };
      }
    } else {
      const registeredTool = this.toolRegistry.getTool(name);
      if (registeredTool?.source === 'skill') {
        const granted = await permissionManager.requestPermission(
          'tool_execute',
          `skill_tool:${name}`,
          `Execute skill tool: ${name}`,
        );

        if (!granted) {
          console.log(chalk.red(`[TOOL] Permission denied: ${name}`));
          return {
            tool_call_id: toolCall.id,
            output: `Permission denied: tool_execute (skill_tool:${name})\n需要授权才能执行此技能工具。输入 /perm 查看权限设置。`,
            is_error: true,
          };
        }
      }
    }

    const result = await this.toolRegistry.execute(name, args);
    if (!result.is_error) {
      await this.rememberSuccessfulToolResult(name, args);
    }
    console.log(chalk.gray(`[TOOL] Result: ${this.getToolResultText(result).substring(0, 200) || '(empty)'}...`));
    return {
      ...result,
      tool_call_id: toolCall.id,
    };
  }

  private async rememberSuccessfulToolResult(name: string, args: Record<string, unknown>): Promise<void> {
    if (!this.memoryProvider) {
      return;
    }

    const remembered = this.extractOutputArtifact(name, args);
    if (!remembered) {
      return;
    }

    const { path, label, extension } = remembered;
    await this.memoryProvider.store({
      kind: 'project',
      key: 'last_output_file',
      title: 'last_output_file',
      content: `${label}: ${path}`,
      metadata: { path, toolName: name, extension },
    });

    if (extension) {
      await this.memoryProvider.store({
        kind: 'project',
        key: `last_${extension}_output_file`,
        title: `last_${extension}_output_file`,
        content: `${label}: ${path}`,
        metadata: { path, toolName: name, extension },
      });
    }
  }

  private extractOutputArtifact(name: string, args: Record<string, unknown>): { path: string; label: string; extension?: string } | null {
    const outputValue = this.getArtifactArgValue(name, args);
    if (typeof outputValue !== 'string' || !outputValue.trim()) {
      return null;
    }

    const resolvedPath = resolveOutputPath(outputValue, {
      workspace: process.cwd(),
      artifactOutputDir: typeof this.config.artifactOutputDir === 'string' ? this.config.artifactOutputDir : undefined,
      documentOutputDir: typeof this.config.documentOutputDir === 'string' ? this.config.documentOutputDir : undefined,
    });
    const extensionMatch = resolvedPath.match(/\.([a-z0-9]{1,8})$/i);
    const extension = extensionMatch?.[1]?.toLowerCase();
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '最近生成文件';

    return {
      path: resolvedPath,
      label: title,
      extension,
    };
  }

  private getArtifactArgValue(name: string, args: Record<string, unknown>): unknown {
    if (/^(write_file)$/i.test(name)) {
      return args.path;
    }

    if (/^(copy_file|move_file)$/i.test(name)) {
      return args.destination;
    }

    if (/txt_to_docx|minimax_docx_create_from_text/i.test(name)) {
      return args.output;
    }

    if (/txt_to_pdf|minimax_pdf_text_to_pdf/i.test(name)) {
      return args.out;
    }

    return null;
  }

  private getToolResultText(result: ToolResult): string {
    if (typeof result.output === 'string' && result.output.length > 0) {
      return result.output;
    }

    if (Array.isArray(result.content)) {
      return result.content
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n');
    }

    return '';
  }

  private async prepareToolCallsForExecution(
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ): Promise<{ contract: IntentContract; toolCalls: ToolCall[]; rejections: Array<{ toolCall: ToolCall; reason: string }> }> {
    const contract = await this.resolveIntentContract(userInput, assistantContent, toolCalls, useModelContract);
    const validation = validateToolCallsAgainstContract(contract, toolCalls, this.tools.map(tool => tool.name));

    if (validation.corrections.length > 0) {
      this.onEvent?.({
        type: 'thinking',
        content: `Intent contract 已校正工具调用：${validation.corrections.join('；')}`,
      });
    }

    if (validation.rejections.length > 0) {
      this.onEvent?.({
        type: 'thinking',
        content: `Intent contract 拒绝了 ${validation.rejections.length} 个不一致的工具调用。`,
      });
    }

    return {
      contract,
      toolCalls: validation.toolCalls,
      rejections: validation.rejections,
    };
  }

  private async resolveIntentContract(
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ): Promise<IntentContract> {
    const fallback = buildFallbackIntentContract(userInput, toolCalls);
    if (!useModelContract) {
      return fallback;
    }

    try {
      const response = await this.llm.generate([
        { role: 'system', content: TOOL_INTENT_CONTRACT_PROMPT },
        {
          role: 'user',
          content: [
            `用户请求: ${userInput}`,
            `assistant 当前输出: ${assistantContent}`,
            `拟调用工具: ${toolCalls.map(toolCall => `${toolCall.function.name} ${toolCall.function.arguments}`).join(' | ')}`,
          ].join('\n'),
        },
      ]);

      const parsed = parseIntentContractResponse(response);
      if (!parsed) {
        return fallback;
      }

      return {
        action: parsed.action || fallback.action,
        summary: parsed.summary || fallback.summary,
        targetFormat: parsed.targetFormat || fallback.targetFormat,
        sourceHint: parsed.sourceHint || fallback.sourceHint,
        confidence: parsed.confidence ?? fallback.confidence,
      };
    } catch {
      return fallback;
    }
  }

  private isMcpTool(name: string): boolean {
    const builtInTools = [
      'read_file', 'write_file', 'edit_file', 'delete_file',
      'copy_file', 'move_file', 'file_info',
      'list_directory', 'create_directory',
      'search_files', 'grep', 'execute_command',
      'glob', 'read_multiple_files',
      'get_current_time', 'calculate',
      'web_search', 'fetch_url', 'open_browser',
      'lsp_complete', 'lsp_diagnostics', 'lsp_definition',
      'repl', 'enter_plan_mode', 'exit_plan_mode',
      'enter_worktree', 'exit_worktree', 'verify_plan_execution',
      'todo_write', 'skill_config', 'config', 'sleep',
      'tencent_hot_news', 'tencent_search_news',
      'tencent_morning_news', 'tencent_evening_news',
    ];
    
    if (builtInTools.includes(name)) {
      return false;
    }
    
    return name.includes('_');
  }

  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const regex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      try {
        const jsonStr = match[1];
        if (!jsonStr) continue;
        const parsed = JSON.parse(jsonStr);
        if (parsed.name && parsed.arguments) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments),
            },
          });
        }
      } catch {
        continue;
      }
    }

    return toolCalls;
  }

  getMessages(): Message[] {
    return this.contextManager.getMessages();
  }

  appendMessage(message: Message): void {
    this.contextManager.addMessage(message);
  }

  appendMessages(messages: Message[]): void {
    for (const message of messages) {
      this.contextManager.addMessage(message);
    }
  }

  setMessages(messages: Message[]): void {
    this.contextManager.initialize(messages);
  }

  clearMessages(): void {
    this.contextManager.clear();
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async refreshTools(): Promise<void> {
    await this.initializeTools();
  }

  getToolCount(): number {
    return this.tools.length;
  }

  getContextStats(): any {
    return this.contextManager.getStats();
  }

  useLangChainFallback(query: string): Promise<string> {
    return this.contextManager.useLangChainFallback(query, this.contextManager.getMessages());
  }
}

export function createAgent(options: AgentOptions): Agent {
  return new Agent(options);
}
