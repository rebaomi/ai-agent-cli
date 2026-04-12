import type {
  AgentGraphMode,
  AgentCheckpointStatus,
  AgentGraphCheckpoint,
  AgentGraphNode,
  AgentGraphRoute,
  AgentGraphState,
  AGENT_GRAPH_STATE_SCHEMA_VERSION,
  ContextBusState,
  TASK_CONTEXT_SCHEMA_VERSION,
  AgentTaskBindingSnapshot,
  SessionTaskContextSnapshot,
  UnifiedAgentState,
} from '../types/index.js';
import {
  AGENT_GRAPH_STATE_SCHEMA_VERSION as AGENT_GRAPH_STATE_SCHEMA_VERSION_VALUE,
  TASK_CONTEXT_SCHEMA_VERSION as TASK_CONTEXT_SCHEMA_VERSION_VALUE,
} from '../types/index.js';

export interface TaskContextJsonPayload {
  schemaVersion: typeof TASK_CONTEXT_SCHEMA_VERSION_VALUE;
  mode: 'json';
  taskContext: SessionTaskContextSnapshot;
  graphState?: AgentGraphState;
  agentState?: UnifiedAgentState;
  contextBus?: ContextBusState;
}

export interface CreateAgentGraphStateOptions {
  mode: AgentGraphMode;
  route: AgentGraphRoute;
  originalInput: string;
  effectiveInput: string;
  taskBinding?: AgentTaskBindingSnapshot;
  checkpoint?: AgentGraphCheckpoint;
  agentState?: UnifiedAgentState;
  output?: string;
}

export interface TransitionAgentGraphStateOptions {
  summary?: string;
  metadata?: Record<string, unknown>;
  input?: string;
  output?: string;
  route?: AgentGraphRoute;
}

export function createAgentCheckpoint(
  node: AgentGraphNode,
  status: AgentCheckpointStatus,
  input?: string,
  summary?: string,
  metadata?: Record<string, unknown>,
): AgentGraphCheckpoint {
  return {
    node,
    status,
    input,
    summary,
    metadata,
    updatedAt: new Date().toISOString(),
  };
}

export function createAgentGraphState(options: CreateAgentGraphStateOptions): AgentGraphState {
  const checkpoint = options.checkpoint
    ?? createAgentCheckpoint(options.route === 'direct_action' ? 'direct_action' : 'plan', 'running', options.effectiveInput);
  const agentState = options.agentState ?? createEmptyUnifiedAgentState(options.taskBinding, checkpoint, options.effectiveInput);

  return {
    schemaVersion: AGENT_GRAPH_STATE_SCHEMA_VERSION_VALUE,
    mode: options.mode,
    route: options.route,
    originalInput: options.originalInput,
    effectiveInput: options.effectiveInput,
    currentNode: checkpoint.node,
    status: checkpoint.status,
    output: options.output,
    ...agentState,
    taskBinding: options.taskBinding ?? agentState.taskBinding,
    checkpoint,
  };
}

export function transitionAgentGraphState(
  state: AgentGraphState,
  node: AgentGraphNode,
  status: AgentCheckpointStatus,
  options: TransitionAgentGraphStateOptions = {},
): AgentGraphState {
  const checkpoint = createAgentCheckpoint(
    node,
    status,
    options.input ?? state.effectiveInput,
    options.summary,
    options.metadata,
  );

  return {
    ...state,
    route: options.route ?? state.route,
    currentNode: node,
    status,
    output: options.output ?? state.output,
    checkpoint,
  };
}

export function applyUnifiedAgentStateToGraph(
  state: AgentGraphState,
  agentState: UnifiedAgentState,
  options: { output?: string; route?: AgentGraphRoute } = {},
): AgentGraphState {
  const checkpoint = deriveCheckpointFromUnifiedAgentState(agentState);

  return {
    ...state,
    ...agentState,
    route: options.route ?? state.route,
    currentNode: checkpoint.node,
    status: checkpoint.status,
    output: options.output ?? state.output,
    checkpoint,
  };
}

export function buildTaskContextJsonPayload(
  taskContext: SessionTaskContextSnapshot,
  graphState?: AgentGraphState,
  agentState?: UnifiedAgentState,
  contextBus?: ContextBusState,
): TaskContextJsonPayload {
  return {
    schemaVersion: TASK_CONTEXT_SCHEMA_VERSION_VALUE,
    mode: 'json',
    taskContext,
    graphState,
    agentState,
    contextBus,
  };
}

export function deriveCheckpointFromUnifiedAgentState(state: UnifiedAgentState): AgentGraphCheckpoint {
  if (state.pendingInteraction?.type === 'task_clarification') {
    return createAgentCheckpoint('clarify', 'waiting', state.lastUserInput, '等待用户补充关键信息');
  }

  if (state.pendingInteraction?.type === 'plan_execution') {
    return createAgentCheckpoint('plan', 'waiting', state.lastUserInput, '计划已生成，等待用户确认执行');
  }

  if (state.pendingInteraction?.type === 'direct_action_execution') {
    return createAgentCheckpoint('direct_action', 'waiting', state.lastUserInput, 'direct action 已命中风险检查点，等待用户确认执行');
  }

  if (state.pendingInteraction?.type === 'tool_execution') {
    return createAgentCheckpoint('pause_for_input', 'waiting', state.lastUserInput, '预测到高风险工具调用，等待用户确认或修改后继续');
  }

  if (state.pendingInteraction?.type === 'skill_adoption') {
    return createAgentCheckpoint('pause_for_input', 'waiting', state.lastUserInput, '已生成高置信候选 skill，等待你确认是否自动转正并启用');
  }

  if (state.pendingInteraction?.type === 'plan_resume') {
    const reactStep = state.planResume?.reactStep;
    const reactSummary = reactStep
      ? `当前 ReAct 阶段: ${reactStep.phase}，已观察 ${reactStep.observationCount} 次，迭代 ${reactStep.iteration} 轮`
      : undefined;
    return createAgentCheckpoint(
      'pause_for_input',
      'waiting',
      state.lastUserInput,
      [state.planResume?.blockedReason || '计划执行暂停，等待恢复', reactSummary].filter(Boolean).join('；'),
    );
  }

  if (state.state === 'TOOL_CALLING') {
    return createAgentCheckpoint('execute_step', 'running', state.lastUserInput, '正在执行工具调用');
  }

  if (state.toolBudget.needsContinuation) {
    return createAgentCheckpoint('finalize', 'waiting', state.lastUserInput, '达到单轮工具上限，等待继续执行');
  }

  if (state.state === 'RESPONDING' || state.state === 'IDLE') {
    return createAgentCheckpoint('finalize', 'completed', state.lastUserInput, '当前回合已完成');
  }

  return createAgentCheckpoint('plan', 'running', state.lastUserInput, '正在分析与规划当前请求');
}

function createEmptyUnifiedAgentState(taskBinding: AgentTaskBindingSnapshot | undefined, checkpoint: AgentGraphCheckpoint, effectiveInput: string): UnifiedAgentState {
  return {
    state: 'IDLE',
    lastUserInput: effectiveInput,
    messages: [],
    taskBinding,
    toolBudget: {
      iteration: 0,
      toolCallCount: 0,
      maxToolCallsPerTurn: 0,
      maxIterations: 0,
      lastStopReason: 'completed',
      needsContinuation: false,
    },
    checkpoint,
  };
}