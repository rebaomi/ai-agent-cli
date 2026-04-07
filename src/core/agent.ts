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

export interface AgentOptions {
  llm: LLMProviderInterface;
  mcpManager?: MCPManager;
  lspManager?: LSPManager;
  sandbox?: Sandbox;
  builtInTools?: BuiltInTools;
  systemPrompt?: string;
  maxIterations?: number;
  planner?: Planner;
  onSkillInstallNeeded?: (skills: string[]) => Promise<void>;
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
  type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error' | 'plan_summary' | 'plan_progress' | 'write_confirmation' | 'memory_sync';
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
    backend: 'mempalace';
    status: 'archived' | 'failed' | 'skipped';
    detail?: string;
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
  private skillManager?: any;
  private assignedSkills?: Set<string>;
  private agentRole?: string;
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
    this.toolRegistry = createToolRegistry({
      builtInTools: this.builtInTools,
      mcpManager: this.mcpManager,
      skillManager: this.skillManager,
      skillContextFactory: this.skillManager ? () => ({
        workspace: process.cwd(),
        config: {},
        skillsDir: this.skillManager.getSkillsDir(),
      }) : undefined,
    });
    this.usingDefaultSystemPrompt = !options.systemPrompt;
    this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
    this.contextManager = createContextManager(options.contextConfig);
    this.maxIterations = options.maxIterations ?? 100;
    this.planner = options.planner;
    this.onSkillInstallNeeded = options.onSkillInstallNeeded;
    this.agentRole = options.agentRole;

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
      if (confirmed && this.pendingConfirmation.type === 'plan_execution' && this.pendingConfirmation.plan) {
        executionResult = await this.executePlan(this.pendingConfirmation.originalTask || 'task', this.pendingConfirmation.plan);
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
    this.setState('THINKING');
    this.contextManager.addMessage({ role: 'user', content: input });

    const isComplex = await this.detectComplexTask(input);

    if (isComplex) {
      return this.chatWithPlanning(input);
    }

    const response = await this.generateResponse();
    this.setState('RESPONDING');
    return response;
  }

  private getMessagesForLLM(): Message[] {
    const sanitizedMessages = this.sanitizeMessagesForLLM(this.contextManager.getMessages());

    return [
      { role: 'system' as const, content: this.systemPrompt },
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
    const complexityIndicators = [
      '多个', 'several', 'multiple', 'various',
      '先', '然后', 'first', 'then', 'after that',
      '分', '步骤', 'steps', 'phases',
      '并且', '同时', 'and also', 'also',
      '以及', 'plus', 'as well as',
      '需要完成', 'need to', 'should',
      '帮我', 'help me',
    ];

    const inputLower = input.toLowerCase();
    let matchCount = 0;

    for (const indicator of complexityIndicators) {
      if (inputLower.includes(indicator)) {
        matchCount++;
      }
    }

    if (input.length > 200 || matchCount >= 2) {
      return true;
    }

    try {
      const response = await this.llm.generate([
        { role: 'system', content: '你是一个任务复杂度分析专家。判断用户任务是否复杂（需要多个步骤或多种工具）。简单回复 "是" 或 "否"。' },
        { role: 'user', content: `分析这个任务是否复杂：${input}` }
      ]);

      const result = response.toLowerCase().trim();
      return result.includes('是') || result.includes('yes') || result.includes('complex');
    } catch {
      return matchCount >= 2;
    }
  }

  private async chatWithPlanning(input: string): Promise<string> {
    this.onEvent?.({ type: 'thinking', content: '分析任务复杂度，准备规划步骤...' });
    
    try {
      if (!this.planner) {
        return 'Planner not available, falling back to direct execution';
      }
      const plan = await this.planner.createPlan(input);
      
      if (plan.neededSkills && plan.neededSkills.length > 0 && this.onSkillInstallNeeded) {
        console.log(chalk.yellow(`\n📦 检测到任务需要安装以下 Skills: ${plan.neededSkills.join(', ')}`));
        await this.onSkillInstallNeeded(plan.neededSkills);
      }
      
      let summary = `📋 **任务规划已创建**\n`;
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
        const stepContext = `步骤 ${stepNum}/${plan.steps.length}: ${step.description}\n原任务: ${originalTask}\n已完成步骤结果: ${results.join('\n---\n')}`;
        
        this.contextManager.addMessage({ role: 'user', content: stepContext });
        
        const stepResult = await this.generateResponse();
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
    
    return await this.synthesizeResults(originalTask, results);
  }

  private async synthesizeResults(originalTask: string, stepResults: string[]): Promise<string> {
    let finalResponse = `## ✅ 任务完成\n\n`;
    finalResponse += `**原始任务**: ${originalTask}\n\n`;
    finalResponse += `**执行摘要**:\n\n`;
    
    for (let i = 0; i < stepResults.length; i++) {
      finalResponse += `### 步骤 ${i + 1}\n${stepResults[i]}\n\n`;
    }
    
    const completedSteps = stepResults.filter(r => !r.includes('失败')).length;
    const totalSteps = stepResults.length;
    
    finalResponse += `---\n**完成进度**: ${completedSteps}/${totalSteps} 步骤成功完成`;

    await this.archiveTaskToMemPalace(originalTask, stepResults, completedSteps, totalSteps);
    
    this.onEvent?.({ type: 'response', content: finalResponse });
    
    return finalResponse;
  }

  private async archiveTaskToMemPalace(
    originalTask: string,
    stepResults: string[],
    completedSteps: number,
    totalSteps: number,
  ): Promise<void> {
    const mempalaceClient = this.mcpManager.getClient('mempalace');
    if (!mempalaceClient) {
      this.onEvent?.({
        type: 'memory_sync',
        content: 'MemPalace 未连接，跳过长期归档。',
        memorySync: { backend: 'mempalace', status: 'skipped', detail: 'not_connected' },
      });
      return;
    }

    const hasDiaryTool = mempalaceClient.getTools().some(tool => tool.name === 'mempalace_diary_write');
    if (!hasDiaryTool) {
      this.onEvent?.({
        type: 'memory_sync',
        content: 'MemPalace 未提供 diary 工具，跳过长期归档。',
        memorySync: { backend: 'mempalace', status: 'skipped', detail: 'tool_missing' },
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
      `STATUS:completed`,
      `PROGRESS:${completedSteps}/${totalSteps}`,
      summaryLines.length > 0 ? `SUMMARY:${summaryLines.join(' | ')}` : undefined,
      'IMPORTANCE:★★★',
    ].filter(Boolean).join('\n');

    try {
      await this.mcpManager.callTool('mempalace', 'mempalace_diary_write', {
        agent_name: this.agentRole || 'ai-agent-cli',
        topic: 'completed_task',
        entry,
      });
      this.onEvent?.({
        type: 'memory_sync',
        content: 'MemPalace 已归档本次任务摘要。',
        memorySync: { backend: 'mempalace', status: 'archived', detail: 'diary_write' },
      });
    } catch (error) {
      this.onEvent?.({
        type: 'memory_sync',
        content: `MemPalace 归档失败: ${error instanceof Error ? error.message : String(error)}`,
        memorySync: {
          backend: 'mempalace',
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async generateResponse(): Promise<string> {
    this.iteration = 0;
    this.toolCallCount = 0;
    let fullResponse = '';

    while (this.iteration < this.maxIterations) {
      this.iteration++;
      
      if (this.isToolOverLimit()) {
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
            const firstToolCall = parsedToolCalls[0];
            const assistantMsg: Message = { 
              role: 'assistant' as const, 
              content: fullResponse.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim() || 'Using tool...',
            };
            if (firstToolCall) {
              assistantMsg.tool_calls = [{ id: firstToolCall.id, type: 'function' as const, function: firstToolCall.function }];
            }
            this.contextManager.addMessage(assistantMsg);
            for (const toolCall of parsedToolCalls) {
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

          if (cleanResponse || nativeToolCalls.length > 0) {
            this.contextManager.addMessage({ 
              role: 'assistant', 
              content: cleanResponse || 'Using tool...',
              tool_calls: finalToolCalls,
            });
          }

          for (const toolCall of finalToolCalls) {
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

        this.contextManager.addMessage({ role: 'assistant', content: fullResponse });
        break;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.onEvent?.({ type: 'error', content: errorMessage });
        this.contextManager.addMessage({ role: 'assistant', content: `Error: ${errorMessage}` });
        return fullResponse || `Error occurred: ${errorMessage}`;
      }
    }

    if (this.iteration >= this.maxIterations) {
      return 'Maximum iterations reached. Please try a simpler task.';
    }

    return fullResponse;
  }

  private async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const { name, arguments: argsStr } = toolCall.function;
    
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr);
    } catch {
      return { tool_call_id: toolCall.id, output: 'Invalid JSON arguments', is_error: true };
    }

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
    console.log(chalk.gray(`[TOOL] Result: ${this.getToolResultText(result).substring(0, 200) || '(empty)'}...`));
    return {
      ...result,
      tool_call_id: toolCall.id,
    };
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
