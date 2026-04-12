import type { Message, Tool, ToolCall, ToolResult } from '../types/index.js';
import type { LLMProviderInterface } from '../llm/types.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
import { Planner, Plan } from './planner.js';
import { ContextManager, createContextManager } from './context-manager.js';
import { createToolRegistry, ToolRegistry } from './tool-registry.js';
import { createTaskManager } from './task-manager.js';
import { createCronManager } from './cron-manager.js';
import type { MemoryProvider } from './memory-provider.js';
import { ResponseTurnExecutor } from './response-turn-executor.js';
import { KnownGapManager } from './known-gap-manager.js';
import { PlanExecutionService } from './plan-execution-service.js';
import { AgentInteractionService } from './agent-interaction-service.js';
import { AgentPlanningService } from './agent-planning-service.js';
import { TaskSynthesisService } from './task-synthesis-service.js';
import type { ToolExecutionEvent } from './tool-executor.js';
import { buildDefaultAgentSystemPrompt } from './agent-system-prompt.js';
import { createAgentRuntimeComponents } from './agent-runtime-factory.js';
import type { IntentResolver } from './intent-resolver.js';
import type { AgentGraphCheckpoint, AgentTaskBindingSnapshot, UnifiedAgentState } from '../types/index.js';
import type { PendingInteraction } from './agent-interaction-service.js';
import type { PermissionManager } from './permission-manager.js';

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
  intentResolver?: IntentResolver;
  permissionManager?: Pick<PermissionManager, 'getConfig' | 'isGranted'>;
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
    confidence?: number;
  };
  skillLearningTodo?: {
    todoId: string;
    suggestedSkill: string;
    sourceTask: string;
    occurrenceCount?: number;
    draftedCandidateName?: string;
  };
}

export type AgentState = 'IDLE' | 'THINKING' | 'TOOL_CALLING' | 'WAITING_CONFIRMATION' | 'RESPONDING';

export class Agent {
  private llm: LLMProviderInterface;
  private toolRegistry: ToolRegistry;
  private systemPrompt: string;
  private iteration = 0;
  private tools: Tool[] = [];
  private onEvent?: (event: AgentEvent) => void;
  private contextManager: ContextManager;
  private state: AgentState = 'IDLE';
  private lastUserInput: string = '';
  private toolCallCount = 0;
  private configuredMaxToolCallsPerTurn = 20;
  private maxToolCallsPerTurn = 20;
  private maxIterations = 100;
  private lastStopReason: 'completed' | 'tool_limit' | 'max_iterations' | 'error' = 'completed';
  private skillManager?: any;
  private assignedSkills?: Set<string>;
  private agentRole?: string;
  private responseTurnExecutor: ResponseTurnExecutor;
  private runtimeMemoryContext = '';
  private knownGapManager: KnownGapManager;
  private lastReusableContent = '';
  private planExecutionService: PlanExecutionService;
  private interactionService: AgentInteractionService;
  private planningService: AgentPlanningService;
  private taskSynthesisService: TaskSynthesisService;
  private getMessagesForLLMView: () => Message[];
  private resolvePlannedToolArgsView: (args: Record<string, unknown>) => Record<string, unknown>;
  private executeToolCallView: (toolCall: ToolCall) => Promise<ToolResult>;
  private isGenericPlanView: (plan: Plan, input: string) => boolean;
  private readonly usingDefaultSystemPrompt: boolean;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    const mcpManager = options.mcpManager ?? new MCPManager();
    const lspManager = options.lspManager ?? new LSPManager();
    const sandbox = options.sandbox ?? new Sandbox({
      enabled: true,
      allowedPaths: [process.cwd()],
      allowCommandExecution: true,
      allowBash: process.platform !== 'win32',
      allowPowerShell: process.platform === 'win32',
    });
    let builtInTools: BuiltInTools;
    if (options.builtInTools) {
      builtInTools = options.builtInTools;
    } else {
      const taskManager = createTaskManager();
      const cronManager = createCronManager();
      void taskManager.initialize();
      void cronManager.initialize();
      builtInTools = new BuiltInTools(sandbox, lspManager, {
        mcpManager,
        taskManager,
        cronManager,
      });
    }
    this.skillManager = options.skillManager;
    const config = options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : {};
    let logToolExecutionEvent: (event: ToolExecutionEvent) => void = () => {};
    this.toolRegistry = createToolRegistry({
      builtInTools,
      mcpManager,
      skillManager: this.skillManager,
      skillContextFactory: this.skillManager ? () => ({
        workspace: process.cwd(),
        config,
        skillsDir: this.skillManager.getSkillsDir(),
      }) : undefined,
      onExecutionEvent: (event) => logToolExecutionEvent(event),
    });
    this.usingDefaultSystemPrompt = !options.systemPrompt;
    this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
    this.contextManager = createContextManager(options.contextConfig);
    const maxIterations = options.maxIterations ?? 100;
    this.maxIterations = maxIterations;
    this.configuredMaxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 20;
    this.maxToolCallsPerTurn = this.configuredMaxToolCallsPerTurn;
    this.agentRole = options.agentRole;
    const runtimeComponents = createAgentRuntimeComponents({
      llm: this.llm,
      getToolRegistry: () => this.toolRegistry,
      config,
      memoryProvider: options.memoryProvider,
      skillManager: this.skillManager,
      planner: options.planner,
      intentResolver: options.intentResolver,
      permissionManager: options.permissionManager,
      onSkillInstallNeeded: options.onSkillInstallNeeded,
      agentRole: this.agentRole,
      contextManager: this.contextManager,
      maxIterations,
      maxToolCallsPerTurn: this.maxToolCallsPerTurn,
      getMaxToolCallsPerTurn: () => this.maxToolCallsPerTurn,
      getTools: () => this.tools,
      getLastReusableContent: () => this.lastReusableContent,
      setLastReusableContent: (content) => {
        this.lastReusableContent = content;
      },
      getLastUserInput: () => this.lastUserInput,
      setLastUserInput: (input) => {
        this.lastUserInput = input;
      },
      getRuntimeMemoryContext: () => this.runtimeMemoryContext,
      onEvent: (event) => {
        this.onEvent?.(event as AgentEvent);
      },
      setState: (state) => this.setState(state),
      setIteration: (iteration) => {
        this.iteration = iteration;
      },
      incrementToolCallCount: () => {
        this.toolCallCount++;
      },
      isToolOverLimit: () => this.isToolOverLimit(),
      setLastStopReason: (reason) => {
        this.lastStopReason = reason;
      },
      getSystemPrompt: () => this.systemPrompt,
      addMessage: (message) => {
        this.contextManager.addMessage(message);
      },
      getMessages: () => this.contextManager.getMessages(),
      generateResponse: () => this.generateResponse(),
      refreshTools: () => this.refreshTools(),
    });
    this.responseTurnExecutor = runtimeComponents.responseTurnExecutor;
    this.knownGapManager = runtimeComponents.knownGapManager;
    logToolExecutionEvent = (event) => runtimeComponents.toolExecutionLogger.logExecutionEvent(event);
    this.planExecutionService = runtimeComponents.planExecutionService;
    this.interactionService = runtimeComponents.interactionService;
    this.planningService = runtimeComponents.planningService;
    this.taskSynthesisService = runtimeComponents.taskSynthesisService;
    this.getMessagesForLLMView = runtimeComponents.getMessagesForLLM;
    this.resolvePlannedToolArgsView = runtimeComponents.resolvePlannedToolArgs;
    this.executeToolCallView = runtimeComponents.executeToolCall;
    this.isGenericPlanView = runtimeComponents.isGenericPlan;

    this.initializeTools();
  }

  setEventHandler(handler: (event: AgentEvent) => void): void {
    this.onEvent = handler;
  }

  setConfirmationCallback(type: 'plan_execution' | 'write_file', callback: (confirmed: boolean, params?: any) => void): void {
    this.interactionService.setConfirmationCallback(type, callback);
  }

  getConfirmationStatus(): { pending: boolean; type?: string; prompt?: string } {
    return this.interactionService.getConfirmationStatus();
  }

  getPendingInteractionDetails(): PendingInteraction | undefined {
    return this.interactionService.getPendingInteraction();
  }

  clearPendingInteraction(): void {
    this.interactionService.clearPendingInteraction();
  }

  restorePendingInteraction(pending: PendingInteraction): void {
    this.interactionService.setPendingInteraction(pending);
    this.setState('WAITING_CONFIRMATION');
  }

  shouldTreatPendingInputAsNewRequest(input: string): boolean {
    return this.interactionService.shouldTreatPendingInputAsNewRequest(input);
  }

  async confirmAction(confirmed: boolean, params?: any): Promise<string | undefined> {
    return this.interactionService.confirmAction(confirmed, params);
  }

  async respondToPendingInput(input: string): Promise<string | undefined> {
    return this.interactionService.respondToPendingInput(input);
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

  getUnifiedStateSnapshot(taskBinding?: AgentTaskBindingSnapshot, checkpoint?: AgentGraphCheckpoint): UnifiedAgentState {
    return {
      state: this.state,
      lastUserInput: this.lastUserInput,
      runtimeMemoryContext: this.runtimeMemoryContext || undefined,
      messages: this.getMessages(),
      taskBinding,
      pendingInteraction: this.interactionService.getPendingInteractionSnapshot(),
      planResume: this.interactionService.getPlanResumeSnapshot(),
      toolBudget: {
        iteration: this.iteration,
        toolCallCount: this.toolCallCount,
        maxToolCallsPerTurn: this.maxToolCallsPerTurn,
        maxIterations: this.maxIterations,
        lastStopReason: this.lastStopReason,
        needsContinuation: this.needsContinuation(),
      },
      checkpoint,
    };
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
    return buildDefaultAgentSystemPrompt({
      availableSkills: this.skillManager
      ? this.skillManager.getSkillDescriptions()
      : [],
      tools: this.tools,
    });
  }

  async chat(input: string): Promise<string> {
    return this.chatWithResolvedInput(input, input);
  }

  async chatWithResolvedInput(originalInput: string, effectiveInput: string): Promise<string> {
    this.lastUserInput = effectiveInput;
    this.maxToolCallsPerTurn = this.resolveDynamicToolBudget(effectiveInput);
    this.beginResponseTurn();
    this.contextManager.addMessage({ role: 'user', content: originalInput });
    await this.knownGapManager.prepare(effectiveInput);

    const ambiguousShortInputPrompt = this.planningService.buildAmbiguousShortInputPrompt(effectiveInput);
    if (ambiguousShortInputPrompt) {
      this.interactionService.setPendingInteraction({
        type: 'task_clarification',
        originalTask: effectiveInput,
        prompt: ambiguousShortInputPrompt,
      });
      this.contextManager.addMessage({ role: 'assistant', content: ambiguousShortInputPrompt });
      this.setState('WAITING_CONFIRMATION');
      return ambiguousShortInputPrompt;
    }

    const isComplex = await this.planningService.detectComplexTask(effectiveInput);

    if (isComplex) {
      const clarificationPrompt = this.interactionService.buildTaskClarificationPrompt(effectiveInput);
      if (clarificationPrompt) {
        this.interactionService.setPendingInteraction({
          type: 'task_clarification',
          originalTask: effectiveInput,
          prompt: clarificationPrompt,
        });
        this.contextManager.addMessage({ role: 'assistant', content: clarificationPrompt });
        this.setState('WAITING_CONFIRMATION');
        return clarificationPrompt;
      }
      return this.planningService.chatWithPlanning(effectiveInput);
    }

    const response = await this.generateResponse();
    this.setState(this.interactionService.getConfirmationStatus().pending ? 'WAITING_CONFIRMATION' : 'RESPONDING');
    return response;
  }

  async continueResponse(): Promise<string> {
    this.beginResponseTurn();
    const response = await this.generateResponse();
    this.setState(this.interactionService.getConfirmationStatus().pending ? 'WAITING_CONFIRMATION' : 'RESPONDING');
    return response;
  }

  async detectComplexTask(input: string): Promise<boolean> {
    return this.planningService.detectComplexTask(input);
  }

  isGenericPlan(plan: Plan, input: string): boolean {
    return this.isGenericPlanView(plan, input);
  }

  async executePlan(originalTask: string, plan: Plan, startStepIndex = 0, existingResults: string[] = []): Promise<string> {
    return this.planExecutionService.executePlan(originalTask, plan, startStepIndex, existingResults);
  }

  async synthesizeResults(originalTask: string, stepResults: string[]): Promise<string> {
    return this.taskSynthesisService.synthesizeResults(originalTask, stepResults);
  }

  private async generateResponse(): Promise<string> {
    this.resetExecutionState();
    return this.responseTurnExecutor.execute();
  }

  private beginResponseTurn(): void {
    this.resetExecutionState();
    this.setState('THINKING');
  }

  private resetExecutionState(): void {
    this.iteration = 0;
    this.toolCallCount = 0;
    this.lastStopReason = 'completed';
  }

  private resolveDynamicToolBudget(input: string): number {
    const normalized = input.trim();
    if (!normalized) {
      return this.configuredMaxToolCallsPerTurn;
    }

    const hasResearchIntent = /(搜索|查找|查询|检索|调研|搜集|资料|总结|整理|汇总|分析)/i.test(normalized);
    const hasExportIntent = /(导出|转换|转成|转为|保存成|保存为|生成).*(pdf|docx|word|ppt|pptx|xlsx|excel|文档|报告)|\b(pdf|docx|pptx|xlsx)\b/i.test(normalized);
    const hasDeliveryIntent = /(飞书|lark).*(发送|发(?:到|给|我)?|推送)|(?:发送|发(?:到|给|我)?|推送).*(飞书|lark)/i.test(normalized);
    const hasCodeWorkflowIntent = /(代码|修复|排查|调试|测试|构建|编译|lint|报错|error|bug|重构)/i.test(normalized);
    const hasExplicitToolWorkflowIntent = /(文件|目录|命令|浏览器|打开|读取|查看|保存|导出|飞书|搜索|测试)/i.test(normalized);

    if (hasResearchIntent && hasExportIntent && hasDeliveryIntent) {
      return Math.max(this.configuredMaxToolCallsPerTurn, 36);
    }

    if ((hasResearchIntent && hasDeliveryIntent) || (hasExportIntent && hasDeliveryIntent)) {
      return Math.max(this.configuredMaxToolCallsPerTurn, 30);
    }

    if (hasCodeWorkflowIntent) {
      return Math.max(this.configuredMaxToolCallsPerTurn, 28);
    }

    if (hasResearchIntent || hasExportIntent || hasDeliveryIntent) {
      return Math.max(this.configuredMaxToolCallsPerTurn, 24);
    }

    if (!hasExplicitToolWorkflowIntent) {
      return Math.min(this.configuredMaxToolCallsPerTurn, 12);
    }

    return this.configuredMaxToolCallsPerTurn;
  }

  getMessages(): Message[] {
    return this.contextManager.getMessages();
  }

  getMessagesForLLM(): Message[] {
    return this.getMessagesForLLMView();
  }

  resolvePlannedToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    return this.resolvePlannedToolArgsView(args);
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    return this.executeToolCallView(toolCall);
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
    this.lastReusableContent = '';
  }

  clearMessages(): void {
    this.contextManager.clear();
    this.lastReusableContent = '';
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
