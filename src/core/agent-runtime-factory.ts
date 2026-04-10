import chalk from 'chalk';
import type { Message, Tool, ToolCall, ToolResult } from '../types/index.js';
import type { LLMProviderInterface } from '../llm/types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { Planner, Plan, PlanStep } from './planner.js';
import type { ContextManager } from './context-manager.js';
import type { MemoryProvider } from './memory-provider.js';
import { getArtifactOutputDir } from '../utils/path-resolution.js';
import { ToolResultPostProcessor } from './tool-result-post-processor.js';
import { ToolCallPreparationPolicy } from './tool-call-preparation-policy.js';
import { ToolExecutionGuard } from './tool-execution-guard.js';
import { ToolCallRunner } from './tool-call-runner.js';
import { ToolCallConversationBridge } from './tool-call-conversation-bridge.js';
import { ToolCallResponseCoordinator } from './tool-call-response-coordinator.js';
import { ResponseStreamCollector } from './response-stream-collector.js';
import { FinalResponseAssembler } from './final-response-assembler.js';
import { ResponseTurnExecutor } from './response-turn-executor.js';
import { ResponseTurnProcessor } from './response-turn-processor.js';
import { KnownGapManager } from './known-gap-manager.js';
import { SkillLearningService } from './skill-learning-service.js';
import { PlannedToolArgsResolver } from './planned-tool-args-resolver.js';
import { PlanExecutionService, type PlanResumeState } from './plan-execution-service.js';
import { AgentInteractionService } from './agent-interaction-service.js';
import { AgentPlanningService } from './agent-planning-service.js';
import { TaskSynthesisService } from './task-synthesis-service.js';
import { AgentToolCallService } from './agent-tool-call-service.js';
import { AgentPlanRuntimeService } from './agent-plan-runtime-service.js';
import { AgentMessageViewService } from './agent-message-view-service.js';
import { AgentToolExecutionLogger } from './agent-tool-execution-logger.js';
import type { IntentResolver } from './intent-resolver.js';

interface AgentRuntimeEvent {
  type: string;
  content: string;
  [key: string]: unknown;
}

export interface AgentRuntimeFactoryOptions {
  llm: LLMProviderInterface;
  getToolRegistry: () => ToolRegistry;
  config: Record<string, unknown>;
  memoryProvider?: MemoryProvider;
  skillManager?: any;
  planner?: Planner;
  intentResolver?: IntentResolver;
  onSkillInstallNeeded?: (skills: string[]) => Promise<void>;
  agentRole?: string;
  contextManager: ContextManager;
  maxIterations: number;
  maxToolCallsPerTurn: number;
  getTools: () => Tool[];
  getLastReusableContent: () => string;
  setLastReusableContent: (content: string) => void;
  getLastUserInput: () => string;
  setLastUserInput: (input: string) => void;
  getRuntimeMemoryContext: () => string;
  onEvent?: (event: AgentRuntimeEvent) => void;
  setState: (state: 'IDLE' | 'THINKING' | 'TOOL_CALLING' | 'WAITING_CONFIRMATION' | 'RESPONDING') => void;
  setIteration: (iteration: number) => void;
  incrementToolCallCount: () => void;
  isToolOverLimit: () => boolean;
  setLastStopReason: (reason: 'completed' | 'tool_limit' | 'max_iterations' | 'error') => void;
  getSystemPrompt: () => string;
  addMessage: (message: Message) => void;
  getMessages: () => Message[];
  generateResponse: () => Promise<string>;
}

export interface AgentRuntimeComponents {
  responseTurnExecutor: ResponseTurnExecutor;
  knownGapManager: KnownGapManager;
  planRuntimeService: AgentPlanRuntimeService;
  toolExecutionLogger: AgentToolExecutionLogger;
  planExecutionService: PlanExecutionService;
  interactionService: AgentInteractionService;
  planningService: AgentPlanningService;
  taskSynthesisService: TaskSynthesisService;
  getMessagesForLLM: () => Message[];
}

export function createAgentRuntimeComponents(options: AgentRuntimeFactoryOptions): AgentRuntimeComponents {
  let interactionService!: AgentInteractionService;
  let planExecutionService!: PlanExecutionService;
  let planningService!: AgentPlanningService;
  const knownGapManager = new KnownGapManager(options.skillManager);
  const messageViewService = new AgentMessageViewService({
    getMessages: () => options.getMessages(),
    getSystemPrompt: () => options.getSystemPrompt(),
    getRuntimeMemoryContext: () => options.getRuntimeMemoryContext(),
    getKnownGapContext: () => knownGapManager.getContext(),
  });
  const plannedToolArgsResolver = new PlannedToolArgsResolver({
    workspace: process.cwd(),
    artifactOutputDir: getArtifactOutputDir({
      workspace: process.cwd(),
      artifactOutputDir: typeof options.config.artifactOutputDir === 'string' ? options.config.artifactOutputDir : undefined,
      documentOutputDir: typeof options.config.documentOutputDir === 'string' ? options.config.documentOutputDir : undefined,
    }),
    getMessages: () => options.getMessages(),
    getLastReusableContent: () => options.getLastReusableContent(),
  });
  const toolResultPostProcessor = new ToolResultPostProcessor({
    config: options.config,
    memoryProvider: options.memoryProvider,
  });
  const toolCallPreparationPolicy = new ToolCallPreparationPolicy({
    llm: options.llm,
    availableToolNames: () => options.getTools().map(tool => tool.name),
    onThinking: (content) => {
      options.onEvent?.({ type: 'thinking', content });
    },
  });
  const toolExecutionGuard = new ToolExecutionGuard(options.getToolRegistry());
  const toolCallService = new AgentToolCallService({
    resolvePlannedToolArgs: (args) => plannedToolArgsResolver.resolve(args),
    toolExecutionGuard: {
      authorize: (name, args) => new ToolExecutionGuard(options.getToolRegistry()).authorize(name, args),
    },
    toolRegistry: {
      execute: (name, args) => options.getToolRegistry().execute(name, args),
    },
    toolResultPostProcessor: {
      process: (name, args, result) => toolResultPostProcessor.process(name, args, result),
    },
    toolCallPreparationPolicy: {
      prepare: (userInput, assistantContent, toolCalls, useModelContract) => (
        toolCallPreparationPolicy.prepare(userInput, assistantContent, toolCalls, useModelContract)
      ),
    },
    setLastReusableContent: (content) => {
      options.setLastReusableContent(content);
    },
  });
  const toolExecutionLogger = new AgentToolExecutionLogger({
    getToolResultText: (result) => toolCallService.getToolResultText(result),
  });
  const toolCallRunner = new ToolCallRunner({
    executeToolCall: async (toolCall) => {
      const result = await toolCallService.executeToolCall(toolCall);
      toolExecutionLogger.logImmediateResult(result);
      return result;
    },
    getToolResultText: (result) => toolCallService.getToolResultText(result),
    incrementToolCallCount: () => {
      options.incrementToolCallCount();
    },
    onToolCall: (toolCall) => {
      options.onEvent?.({
        type: 'tool_call',
        content: `Calling tool: ${toolCall.function.name}`,
        toolCall,
      });
    },
    onToolResult: (result, toolOutput) => {
      options.onEvent?.({
        type: 'tool_result',
        content: toolOutput,
        toolResult: result,
      });
    },
    onToolMessage: (toolCall, toolOutput) => {
      options.addMessage({
        role: 'tool',
        content: toolOutput,
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
      });
    },
  });
  const toolCallConversationBridge = new ToolCallConversationBridge();
  const toolCallResponseCoordinator = new ToolCallResponseCoordinator({
    parseToolCalls: (content) => toolCallService.parseToolCalls(content),
    prepareToolCallsForExecution: (userInput, assistantContent, toolCalls, useModelContract) => (
      toolCallService.prepareToolCallsForExecution(userInput, assistantContent, toolCalls, useModelContract)
    ),
    conversationBridge: toolCallConversationBridge,
    addMessage: (message) => {
      options.addMessage(message);
    },
    enterToolCallingState: () => {
      options.setState('TOOL_CALLING');
    },
    runPreparedToolCalls: async (batch) => {
      await toolCallRunner.run(batch);
    },
  });
  const responseStreamCollector = new ResponseStreamCollector({
    onChunk: (chunk) => {
      options.onEvent?.({ type: 'response', content: chunk.content });
    },
  });
  const finalResponseAssembler = new FinalResponseAssembler({
    applyKnownGapNotice: (response) => knownGapManager.applyNotice(response),
    addMessage: (message) => {
      options.addMessage(message);
    },
  });
  const skillLearningService = new SkillLearningService({
    llm: options.llm,
    skillManager: options.skillManager,
    onSkillLearning: (candidate) => {
      options.onEvent?.({
        type: 'skill_learning',
        content: `已基于本次成功任务生成候选 skill 草稿: ${candidate.name}`,
        skillLearning: {
          candidateName: candidate.name,
          candidatePath: candidate.path,
          sourceTask: candidate.sourceTask,
        },
      });
    },
    onSkillLearningTodo: (todo) => {
      options.onEvent?.({
        type: 'skill_learning_todo',
        content: `已记录待学习 skill todo: ${todo.suggestedSkill}`,
        skillLearningTodo: {
          todoId: todo.id,
          suggestedSkill: todo.suggestedSkill,
          sourceTask: todo.sourceTask,
        },
      });
    },
    onSkip: (message) => {
      options.onEvent?.({ type: 'thinking', content: message });
    },
  });
  const taskSynthesisService = new TaskSynthesisService({
    memoryProvider: options.memoryProvider,
    agentRole: options.agentRole,
    onResponse: (content) => {
      options.onEvent?.({ type: 'response', content });
    },
    onMemorySync: (event) => {
      options.onEvent?.({
        type: 'memory_sync',
        content: event.content,
        memorySync: {
          backend: event.backend,
          status: event.status,
          detail: event.detail,
        },
      });
    },
  });
  const planRuntimeService = new AgentPlanRuntimeService({
    setPendingInteraction: (pending) => {
      interactionService.setPendingInteraction(pending);
    },
    addMessage: (message) => {
      options.addMessage(message);
    },
    setWaitingConfirmation: () => {
      options.setState('WAITING_CONFIRMATION');
    },
    setLastUserInput: (input) => {
      options.setLastUserInput(input);
    },
    executePlan: (originalTask, plan, startStepIndex, existingResults) => (
      planExecutionService.executePlan(originalTask, plan, startStepIndex, existingResults)
    ),
    resolvePlannedToolArgs: (args) => plannedToolArgsResolver.resolve(args),
    prepareToolCallsForExecution: (userInput, assistantContent, toolCalls, useModelContract) => (
      toolCallService.prepareToolCallsForExecution(userInput, assistantContent, toolCalls, useModelContract)
    ),
    createAssistantToolCallMessage: (assistantContent, batch) => toolCallConversationBridge.createAssistantToolCallMessage(assistantContent, batch),
    runPreparedToolCalls: async (batch) => toolCallRunner.run(batch, {
      throwOnRejection: true,
      throwOnToolError: true,
      collectOutputs: true,
    }),
  });
  planExecutionService = new PlanExecutionService({
    onStepStart: (plan, step, stepIndex, totalSteps) => {
      const stepNum = stepIndex + 1;
      console.log(chalk.yellow(`\n🔄 执行步骤 ${stepNum}/${totalSteps}: ${step.description}`));
      options.onEvent?.({ type: 'thinking', content: `执行步骤 ${stepNum}: ${step.description}` });
      options.onEvent?.({
        type: 'plan_progress',
        content: `步骤开始: ${step.description}`,
        plan,
        planProgress: {
          stepId: step.id,
          stepDescription: step.description,
          stepIndex,
          totalSteps,
          status: 'started',
        },
      });
    },
    onStepCompleted: (plan, step, stepIndex, totalSteps, result) => {
      options.planner?.completeStep(step.id, result);
      options.onEvent?.({
        type: 'plan_progress',
        content: `步骤完成: ${step.description}`,
        plan,
        planProgress: {
          stepId: step.id,
          stepDescription: step.description,
          stepIndex,
          totalSteps,
          status: 'completed',
          result,
        },
      });
      console.log(chalk.green(`✅ 步骤 ${stepIndex + 1} 完成`));
    },
    onStepFailed: (plan, step, stepIndex, totalSteps, errorMessage) => {
      options.onEvent?.({
        type: 'plan_progress',
        content: `步骤失败: ${step.description}`,
        plan,
        planProgress: {
          stepId: step.id,
          stepDescription: step.description,
          stepIndex,
          totalSteps,
          status: 'failed',
          result: errorMessage,
        },
      });
      console.log(chalk.red(`❌ 步骤 ${stepIndex + 1} 失败: ${errorMessage}`));
    },
    executePlannedToolCalls: (step, stepContext) => planRuntimeService.executePlannedToolCalls(step, stepContext),
    generateStepResponse: async (stepContext) => {
      options.addMessage({ role: 'user', content: stepContext });
      return options.generateResponse();
    },
    shouldPauseForUserInput: (errorMessage) => planRuntimeService.shouldPausePlanForUserInput(errorMessage),
    pausePlanForUserInput: (resumeState) => planRuntimeService.pausePlanForUserInput(resumeState),
    completePlannerStep: (stepId, result) => options.planner?.completeStep(stepId, result),
    failPlannerStep: (stepId, errorMessage) => options.planner?.failStep(stepId, errorMessage),
    processSkillLearning: (originalTask, plan, results) => skillLearningService.processExecution(originalTask, plan, results),
    synthesizeResults: (originalTask, results) => taskSynthesisService.synthesizeResults(originalTask, results),
  });
  interactionService = new AgentInteractionService({
    addUserMessage: (content) => {
      options.addMessage({ role: 'user', content });
    },
    addAssistantMessage: (content) => {
      options.addMessage({ role: 'assistant', content });
    },
    executePlan: (originalTask, plan) => planExecutionService.executePlan(originalTask, plan),
    resumePlanExecution: (resumeState, note) => planRuntimeService.resumePlanExecution(resumeState, note),
    chatWithPlanning: (input) => planningService.chatWithPlanning(input),
    setState: (state) => options.setState(state),
    setLastUserInput: (input) => {
      options.setLastUserInput(input);
    },
    getLastUserInput: () => options.getLastUserInput(),
  });
  planningService = new AgentPlanningService({
    llm: options.llm,
    planner: options.planner,
    intentResolver: options.intentResolver,
    generateDirectResponse: () => options.generateResponse(),
    onThinking: (content) => {
      options.onEvent?.({ type: 'thinking', content });
    },
    onPlanSummary: (summary, plan) => {
      options.onEvent?.({ type: 'plan_summary', content: summary, plan });
    },
    onSkillInstallNeeded: options.onSkillInstallNeeded,
    getKnownGapNotice: () => knownGapManager.getNotice(),
    setPendingInteraction: (pending) => {
      interactionService.setPendingInteraction(pending);
    },
    setWaitingConfirmation: () => {
      options.setState('WAITING_CONFIRMATION');
    },
    addAssistantMessage: (content) => {
      options.addMessage({ role: 'assistant', content });
    },
  });
  const responseTurnProcessor = new ResponseTurnProcessor({
    llm: options.llm,
    responseStreamCollector,
    toolCallResponseCoordinator,
    finalResponseAssembler,
  });
  const responseTurnExecutor = new ResponseTurnExecutor({
    maxIterations: options.maxIterations,
    isToolOverLimit: () => options.isToolOverLimit(),
    onToolLimit: () => {
      options.setLastStopReason('tool_limit');
      console.log(chalk.yellow(`\n⚠️ 工具调用次数达到上限 (${options.maxToolCallsPerTurn})，强制结束当前响应`));
    },
    onIterationStart: (iteration) => {
      options.setIteration(iteration);
      options.onEvent?.({ type: 'thinking', content: `Generating response... (iteration ${iteration})` });
    },
    getMessagesForLLM: () => messageViewService.getMessagesForLLM(),
    runTurn: (messages) => responseTurnProcessor.execute(messages, options.getLastUserInput()),
    finalizeError: (error, previousResponse) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      options.setLastStopReason('error');
      options.onEvent?.({ type: 'error', content: errorMessage });
      const finalizedError = finalResponseAssembler.finalizeError(errorMessage, previousResponse);
      options.addMessage({ role: 'assistant', content: finalizedError.assistantMessage });
      return finalizedError.returnValue;
    },
    finalizeMaxIterations: () => {
      options.setLastStopReason('max_iterations');
      return finalResponseAssembler.finalizeResponse('Maximum iterations reached. Please try a simpler task.');
    },
    finalizeCompletion: (response) => finalResponseAssembler.finalizeResponse(response),
  });

  return {
    responseTurnExecutor,
    knownGapManager,
    planRuntimeService,
    toolExecutionLogger,
    planExecutionService,
    interactionService,
    planningService,
    taskSynthesisService,
    getMessagesForLLM: () => messageViewService.getMessagesForLLM(),
  };
}