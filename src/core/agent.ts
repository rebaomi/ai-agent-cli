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
  private toolRegistry: ToolRegistry;
  private systemPrompt: string;
  private iteration = 0;
  private tools: Tool[] = [];
  private onEvent?: (event: AgentEvent) => void;
  private contextManager: ContextManager;
  private state: AgentState = 'IDLE';
  private lastUserInput: string = '';
  private toolCallCount = 0;
  private maxToolCallsPerTurn = 10;
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
  private readonly usingDefaultSystemPrompt: boolean;

  constructor(options: AgentOptions) {
    this.llm = options.llm;
    const mcpManager = options.mcpManager ?? new MCPManager();
    const lspManager = options.lspManager ?? new LSPManager();
    const sandbox = options.sandbox ?? new Sandbox({ enabled: true });
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
    this.maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 10;
    this.agentRole = options.agentRole;
    const runtimeComponents = createAgentRuntimeComponents({
      llm: this.llm,
      getToolRegistry: () => this.toolRegistry,
      config,
      memoryProvider: options.memoryProvider,
      skillManager: this.skillManager,
      planner: options.planner,
      onSkillInstallNeeded: options.onSkillInstallNeeded,
      agentRole: this.agentRole,
      contextManager: this.contextManager,
      maxIterations,
      maxToolCallsPerTurn: this.maxToolCallsPerTurn,
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
    });
    this.responseTurnExecutor = runtimeComponents.responseTurnExecutor;
    this.knownGapManager = runtimeComponents.knownGapManager;
    logToolExecutionEvent = (event) => runtimeComponents.toolExecutionLogger.logExecutionEvent(event);
    this.planExecutionService = runtimeComponents.planExecutionService;
    this.interactionService = runtimeComponents.interactionService;
    this.planningService = runtimeComponents.planningService;
    this.taskSynthesisService = runtimeComponents.taskSynthesisService;
    this.getMessagesForLLMView = runtimeComponents.getMessagesForLLM;

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
    this.lastUserInput = input;
    this.beginResponseTurn();
    this.contextManager.addMessage({ role: 'user', content: input });
    await this.knownGapManager.prepare(input);

    const isComplex = await this.planningService.detectComplexTask(input);

    if (isComplex) {
      const clarificationPrompt = this.interactionService.buildTaskClarificationPrompt(input);
      if (clarificationPrompt) {
        this.interactionService.setPendingInteraction({
          type: 'task_clarification',
          originalTask: input,
          prompt: clarificationPrompt,
        });
        this.contextManager.addMessage({ role: 'assistant', content: clarificationPrompt });
        this.setState('WAITING_CONFIRMATION');
        return clarificationPrompt;
      }
      return this.planningService.chatWithPlanning(input);
    }

    const response = await this.generateResponse();
    this.setState('RESPONDING');
    return response;
  }

  async continueResponse(): Promise<string> {
    this.beginResponseTurn();
    const response = await this.generateResponse();
    this.setState('RESPONDING');
    return response;
  }

  async detectComplexTask(input: string): Promise<boolean> {
    return this.planningService.detectComplexTask(input);
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

  getMessages(): Message[] {
    return this.contextManager.getMessages();
  }

  getMessagesForLLM(): Message[] {
    return this.getMessagesForLLMView();
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
