import type { Agent } from './agent.js';
import type { DirectActionResult, DirectActionRouter } from './direct-action-router.js';
import type { SessionTaskRecordInput } from './session-task-stack-manager.js';
import type { PendingInteraction } from './agent-interaction-service.js';
import type { PlanResumeState } from './plan-execution-service.js';
import type { Plan } from './planner.js';
import type {
  AgentGraphCheckpoint,
  AgentGraphState,
  AgentTaskBindingSnapshot,
  UnifiedAgentState,
} from '../types/index.js';
import {
  applyUnifiedAgentStateToGraph,
  createAgentGraphState,
  transitionAgentGraphState,
} from './agent-graph-state.js';

export interface AgentGraphRunnerOptions {
  agent: Agent;
  directActionRouter?: DirectActionRouter;
  autoContinueOnToolLimit?: boolean;
  maxContinuationTurns?: number;
  autoConfirmPlanExecution?: boolean;
  getMemoryContext?: (input: string, effectiveInput: string) => Promise<string>;
  onStateChange?: (state: AgentGraphState) => Promise<void> | void;
}

export interface AgentGraphTurnInput {
  input: string;
  taskBinding: AgentTaskBindingSnapshot;
  checkpoint?: AgentGraphCheckpoint;
}

export interface AgentGraphNotice {
  level: 'info' | 'warning';
  message: string;
}

export interface AgentGraphTurnResult {
  graphState: AgentGraphState;
  checkpoint: AgentGraphCheckpoint;
  route: 'direct_action' | 'agent';
  output?: string;
  directAction?: DirectActionResult;
  notices: AgentGraphNotice[];
  taskRecord?: SessionTaskRecordInput;
  skippedPendingAsNewRequest?: boolean;
}

export class AgentGraphRunner {
  constructor(private readonly options: AgentGraphRunnerOptions) {}

  async runTurn(input: AgentGraphTurnInput): Promise<AgentGraphTurnResult> {
    const pendingStatus = this.options.agent.getConfirmationStatus();
    const checkpointRoute = this.getCheckpointRoute(input.checkpoint);
    let graphState = this.createBaseState(input, pendingStatus.pending || input.checkpoint ? 'resume' : 'fresh', checkpointRoute);

    if (input.checkpoint && this.shouldRestoreFromCheckpoint(input.checkpoint, pendingStatus.pending)) {
      return this.runCheckpointTurn(input, graphState, input.checkpoint, pendingStatus.pending);
    }

    if (pendingStatus.pending) {
      return this.runPendingTurn(input, graphState);
    }

    return this.runFreshTurn(input, graphState);
  }

  private async runCheckpointTurn(
    input: AgentGraphTurnInput,
    graphState: AgentGraphState,
    checkpoint: AgentGraphCheckpoint,
    hasPendingInteraction: boolean,
  ): Promise<AgentGraphTurnResult> {
    switch (checkpoint.node) {
      case 'clarify':
        return this.restoreClarifyTurn(input, graphState, checkpoint, hasPendingInteraction);
      case 'plan':
        return this.restorePlanTurn(input, graphState, checkpoint, hasPendingInteraction);
      case 'pause_for_input':
      case 'resume':
      case 'execute_step':
        return this.restoreResumeTurn(input, graphState, checkpoint, hasPendingInteraction);
      case 'finalize':
        if (checkpoint.status === 'waiting') {
          return this.restoreContinuationTurn(input, graphState, checkpoint);
        }
        return this.runFreshTurn(input, graphState);
      case 'direct_action':
      default:
        return this.runFreshTurn(input, graphState);
    }
  }

  private async runFreshTurn(input: AgentGraphTurnInput, graphState: AgentGraphState): Promise<AgentGraphTurnResult> {
    const notices: AgentGraphNotice[] = [];
    graphState = await this.transition(graphState, 'direct_action', 'running', {
      summary: '尝试 direct action 路由',
      metadata: {
        isFollowUp: input.taskBinding.isFollowUp,
        boundTaskId: input.taskBinding.boundTask?.id,
      },
      input: input.input,
      route: 'direct_action',
    });

    const directAction = await this.options.directActionRouter?.tryHandle(input.input, input.taskBinding);
    if (directAction?.handled) {
      graphState = await this.transition(graphState, 'finalize', directAction.isError ? 'failed' : 'completed', {
        summary: directAction.isError ? 'direct action 执行失败' : 'direct action 已完成',
        metadata: {
          route: 'direct_action',
          handlerName: directAction.handlerName,
          category: directAction.category,
        },
        input: input.input,
        output: directAction.output,
        route: 'direct_action',
      });

      return {
        graphState,
        checkpoint: graphState.checkpoint!,
        route: 'direct_action',
        output: directAction.output,
        directAction,
        notices,
        taskRecord: {
          channel: 'direct_action',
          title: directAction.title || input.input.trim(),
          input: input.input,
          effectiveInput: input.taskBinding.effectiveInput,
          category: directAction.category,
          handlerName: directAction.handlerName,
          status: directAction.isError ? 'failed' : 'completed',
          metadata: {
            ...(input.taskBinding.isFollowUp && input.taskBinding.boundTask
              ? { boundTaskId: input.taskBinding.boundTask.id, boundTaskTitle: input.taskBinding.boundTask.title }
              : {}),
            ...(directAction.metadata || {}),
          },
        },
      };
    }

    const response = await this.runAgentTurn(input, graphState, notices);
    return {
      ...response,
      taskRecord: {
        channel: 'agent',
        title: input.input.trim(),
        input: input.input,
        effectiveInput: input.taskBinding.effectiveInput,
        category: 'agent',
        status: 'completed',
        metadata: input.taskBinding.isFollowUp && input.taskBinding.boundTask
          ? { boundTaskId: input.taskBinding.boundTask.id, boundTaskTitle: input.taskBinding.boundTask.title }
          : undefined,
      },
    };
  }

  private async runPendingTurn(input: AgentGraphTurnInput, graphState: AgentGraphState): Promise<AgentGraphTurnResult> {
    const notices: AgentGraphNotice[] = [];
    if (this.options.agent.shouldTreatPendingInputAsNewRequest(input.input)) {
      this.options.agent.clearPendingInteraction();
      notices.push({ level: 'info', message: '检测到这是一个新的独立请求，已跳过上一条待补充状态。' });
      graphState = await this.transition(graphState, 'finalize', 'completed', {
        summary: '旧等待态已跳过，转为新请求',
        metadata: { restartedAsNewRequest: true },
        input: input.input,
        route: 'agent',
      });
      const freshState = this.createBaseState(input, 'fresh', 'direct_action');
      const freshResult = await this.runFreshTurn(input, freshState);
      return {
        ...freshResult,
        notices: [...notices, ...freshResult.notices],
        skippedPendingAsNewRequest: true,
      };
    }

    const pending = this.options.agent.getConfirmationStatus();
    const normalizedInput = input.input.trim().toLowerCase();
    const isConfirmed = normalizedInput === '是' || normalizedInput === 'yes' || normalizedInput === 'y';
    const isRejected = normalizedInput === '否' || normalizedInput === 'no' || normalizedInput === 'n';
    let output: string | undefined;

    if (pending.type === 'plan_execution' && (isConfirmed || isRejected)) {
      graphState = await this.transition(graphState, isConfirmed ? 'resume' : 'finalize', isConfirmed ? 'running' : 'failed', {
        summary: isConfirmed ? '用户确认继续执行计划' : '用户取消执行计划',
        metadata: { pendingType: pending.type },
        input: input.input,
        route: 'agent',
      });
      if (isConfirmed) {
        graphState = await this.transition(graphState, 'execute_step', 'running', {
          summary: '进入计划执行',
          metadata: { pendingType: pending.type },
          input: input.input,
          route: 'agent',
        });
      }
      output = await this.options.agent.confirmAction(isConfirmed);
    } else {
      graphState = await this.transition(graphState, 'resume', 'running', {
        summary: '继续处理待补充输入',
        metadata: { pendingType: pending.type },
        input: input.input,
        route: 'agent',
      });

      if (pending.type === 'plan_resume') {
        graphState = await this.transition(graphState, 'execute_step', 'running', {
          summary: '恢复执行中断计划',
          metadata: { pendingType: pending.type },
          input: input.input,
          route: 'agent',
        });
      }

      output = await this.options.agent.respondToPendingInput(input.input);
    }

    const unifiedState = this.options.agent.getUnifiedStateSnapshot(input.taskBinding, graphState.checkpoint);
    graphState = await this.applyAgentState(graphState, unifiedState, output);

    return {
      graphState,
      checkpoint: graphState.checkpoint!,
      route: 'agent',
      output,
      notices,
    };
  }

  private async runAgentTurn(input: AgentGraphTurnInput, graphState: AgentGraphState, notices: AgentGraphNotice[]): Promise<AgentGraphTurnResult> {
    const memoryContext = await this.options.getMemoryContext?.(input.input, input.taskBinding.effectiveInput);
    this.options.agent.setRuntimeMemoryContext(memoryContext || '');
    graphState = await this.transition(graphState, 'plan', 'running', {
      summary: '进入 agent 主流程',
      metadata: {
        isFollowUp: input.taskBinding.isFollowUp,
        boundTaskId: input.taskBinding.boundTask?.id,
      },
      input: input.taskBinding.effectiveInput,
      route: 'agent',
    });

    let response = await this.options.agent.chatWithResolvedInput(input.input, input.taskBinding.effectiveInput);
    let unifiedState = this.options.agent.getUnifiedStateSnapshot(input.taskBinding, graphState.checkpoint);
    graphState = await this.applyAgentState(graphState, unifiedState, response);

    const pendingInteraction = this.options.agent.getPendingInteractionDetails();
    if (this.options.autoConfirmPlanExecution && pendingInteraction?.type === 'plan_execution') {
      notices.push({
        level: 'info',
        message: 'task 模式已自动确认计划，继续执行编排步骤。',
      });
      graphState = await this.transition(graphState, 'resume', 'running', {
        summary: 'task 模式自动确认计划执行',
        metadata: { pendingType: pendingInteraction.type, autoConfirmed: true },
        input: input.taskBinding.effectiveInput,
        route: 'agent',
      });
      graphState = await this.transition(graphState, 'execute_step', 'running', {
        summary: '自动进入计划执行',
        metadata: { pendingType: pendingInteraction.type, autoConfirmed: true },
        input: input.taskBinding.effectiveInput,
        route: 'agent',
      });
      const executionResponse = await this.options.agent.confirmAction(true);
      if (executionResponse?.trim()) {
        response = executionResponse.trim();
      }
      unifiedState = this.options.agent.getUnifiedStateSnapshot(input.taskBinding, graphState.checkpoint);
      graphState = await this.applyAgentState(graphState, unifiedState, response);
    }

    const autoContinueOnToolLimit = this.options.autoContinueOnToolLimit ?? true;
    const maxContinuationTurns = this.options.maxContinuationTurns ?? 3;
    let continuationTurns = 0;
    while (autoContinueOnToolLimit && this.options.agent.needsContinuation() && continuationTurns < maxContinuationTurns) {
      continuationTurns += 1;
      notices.push({
        level: 'info',
        message: `当前响应达到单轮工具上限，自动继续第 ${continuationTurns}/${maxContinuationTurns} 轮...`,
      });
      graphState = await this.transition(graphState, 'execute_step', 'running', {
        summary: '达到单轮工具上限，继续执行',
        metadata: { continuationTurns },
        input: input.taskBinding.effectiveInput,
        route: 'agent',
      });
      const continuedResponse = await this.options.agent.continueResponse();
      if (continuedResponse.trim()) {
        response = response.trim() ? `${response.trim()}\n${continuedResponse.trim()}` : continuedResponse.trim();
      }
      unifiedState = this.options.agent.getUnifiedStateSnapshot(input.taskBinding, graphState.checkpoint);
      graphState = await this.applyAgentState(graphState, unifiedState, response);
    }

    if (this.options.agent.needsContinuation()) {
      notices.push({
        level: 'warning',
        message: '当前任务在自动续跑后仍未完成。可直接回复“继续”，或调大 maxToolCallsPerTurn / maxContinuationTurns。',
      });
    }

    return {
      graphState,
      checkpoint: graphState.checkpoint!,
      route: 'agent',
      output: response,
      notices,
    };
  }

  private createBaseState(input: AgentGraphTurnInput, mode: 'fresh' | 'resume', route: 'direct_action' | 'agent'): AgentGraphState {
    const agentState = this.options.agent.getUnifiedStateSnapshot(input.taskBinding, input.checkpoint);
    return createAgentGraphState({
      mode,
      route,
      originalInput: input.input,
      effectiveInput: input.taskBinding.effectiveInput,
      taskBinding: input.taskBinding,
      checkpoint: input.checkpoint,
      agentState,
    });
  }

  private async transition(
    state: AgentGraphState,
    node: AgentGraphState['currentNode'],
    status: AgentGraphState['status'],
    options: Parameters<typeof transitionAgentGraphState>[3],
  ): Promise<AgentGraphState> {
    const nextState = this.enrichGraphStateForRestore(transitionAgentGraphState(state, node, status, options));
    await this.options.onStateChange?.(nextState);
    return nextState;
  }

  private async applyAgentState(state: AgentGraphState, agentState: UnifiedAgentState, output?: string): Promise<AgentGraphState> {
    const nextState = this.enrichGraphStateForRestore(applyUnifiedAgentStateToGraph(state, agentState, {
      output,
      route: 'agent',
    }));
    await this.options.onStateChange?.(nextState);
    return nextState;
  }

  private shouldRestoreFromCheckpoint(checkpoint: AgentGraphCheckpoint | undefined, hasPendingInteraction: boolean): boolean {
    if (!checkpoint) {
      return false;
    }

    if (hasPendingInteraction) {
      return checkpoint.node !== 'direct_action';
    }

    if (checkpoint.status === 'completed' && checkpoint.node === 'finalize') {
      return false;
    }

    return checkpoint.node !== 'direct_action' || checkpoint.status !== 'completed';
  }

  private getCheckpointRoute(checkpoint?: AgentGraphCheckpoint): 'direct_action' | 'agent' {
    return checkpoint?.metadata?.route === 'direct_action' ? 'direct_action' : 'agent';
  }

  private async restoreClarifyTurn(
    input: AgentGraphTurnInput,
    graphState: AgentGraphState,
    checkpoint: AgentGraphCheckpoint,
    hasPendingInteraction: boolean,
  ): Promise<AgentGraphTurnResult> {
    const notices: AgentGraphNotice[] = [];
    if (!hasPendingInteraction) {
      this.options.agent.restorePendingInteraction({
        type: 'task_clarification',
        originalTask: this.getCheckpointOriginalTask(checkpoint, input.taskBinding.effectiveInput),
        prompt: checkpoint.summary || '等待用户补充关键信息',
      });
      notices.push({ level: 'info', message: '已根据 checkpoint 恢复到 clarify 节点，继续接收补充信息。' });
    }

    const result = await this.runPendingTurn(input, graphState);
    return { ...result, notices: [...notices, ...result.notices] };
  }

  private async restorePlanTurn(
    input: AgentGraphTurnInput,
    graphState: AgentGraphState,
    checkpoint: AgentGraphCheckpoint,
    hasPendingInteraction: boolean,
  ): Promise<AgentGraphTurnResult> {
    const notices: AgentGraphNotice[] = [];
    if (!hasPendingInteraction) {
      const restoredPlan = this.getCheckpointPlan(checkpoint);
      const originalTask = this.getCheckpointOriginalTask(checkpoint, input.taskBinding.effectiveInput);
      if (restoredPlan) {
        this.options.agent.restorePendingInteraction({
          type: 'plan_execution',
          originalTask,
          plan: restoredPlan,
          prompt: checkpoint.summary || '计划已生成，等待用户确认执行',
          callback: () => {},
        });
        notices.push({ level: 'info', message: '已根据 checkpoint 恢复到 plan 节点，继续等待计划确认。' });
      } else {
        notices.push({ level: 'warning', message: 'checkpoint 中缺少计划载荷，已按原任务重新规划。' });
        await this.options.agent.chatWithResolvedInput(originalTask, originalTask);
      }
    }

    const result = await this.runPendingTurn(input, graphState);
    return { ...result, notices: [...notices, ...result.notices] };
  }

  private async restoreResumeTurn(
    input: AgentGraphTurnInput,
    graphState: AgentGraphState,
    checkpoint: AgentGraphCheckpoint,
    hasPendingInteraction: boolean,
  ): Promise<AgentGraphTurnResult> {
    const notices: AgentGraphNotice[] = [];
    if (!hasPendingInteraction) {
      const resumeState = this.getCheckpointResumeState(checkpoint);
      if (resumeState) {
        this.options.agent.restorePendingInteraction({
          type: 'plan_resume',
          originalTask: resumeState.originalTask,
          plan: resumeState.plan,
          prompt: checkpoint.summary || this.buildResumePrompt(resumeState),
          resumeState,
          callback: () => {},
        });
        notices.push({ level: 'info', message: '已根据 checkpoint 恢复到 pause/resume 节点，继续等待恢复执行。' });
      } else {
        notices.push({ level: 'warning', message: 'checkpoint 中缺少可恢复的执行上下文，已回退到重新规划。' });
        const result = await this.runAgentTurn(input, graphState, notices);
        return result;
      }
    }

    const result = await this.runPendingTurn(input, graphState);
    return { ...result, notices: [...notices, ...result.notices] };
  }

  private async restoreContinuationTurn(
    input: AgentGraphTurnInput,
    graphState: AgentGraphState,
    checkpoint: AgentGraphCheckpoint,
  ): Promise<AgentGraphTurnResult> {
    const notices: AgentGraphNotice[] = [];
    if (checkpoint.metadata?.continuation !== true) {
      notices.push({ level: 'warning', message: 'checkpoint 未标记为 continuation，已按新请求重新执行。' });
      const result = await this.runFreshTurn(input, graphState);
      return { ...result, notices: [...notices, ...result.notices] };
    }

    const memoryContext = await this.options.getMemoryContext?.(input.input, input.taskBinding.effectiveInput);
    this.options.agent.setRuntimeMemoryContext(memoryContext || '');
    graphState = await this.transition(graphState, 'execute_step', 'running', {
      summary: '根据 finalize(waiting) checkpoint 恢复继续执行',
      metadata: { continuation: true },
      input: input.taskBinding.effectiveInput,
      route: 'agent',
    });
    const output = await this.options.agent.continueResponse();
    const unifiedState = this.options.agent.getUnifiedStateSnapshot(input.taskBinding, graphState.checkpoint);
    graphState = await this.applyAgentState(graphState, unifiedState, output);
    notices.push({ level: 'info', message: '已根据 checkpoint 恢复到 continuation 节点，继续执行未完成响应。' });
    return {
      graphState,
      checkpoint: graphState.checkpoint!,
      route: 'agent',
      output,
      notices,
    };
  }

  private enrichGraphStateForRestore(state: AgentGraphState): AgentGraphState {
    const checkpoint = state.checkpoint;
    if (!checkpoint) {
      return state;
    }

    const pending = this.options.agent.getPendingInteractionDetails();
    const metadata: Record<string, unknown> = {
      ...(checkpoint.metadata || {}),
      route: state.route,
    };

    if (pending?.originalTask) {
      metadata.originalTask = pending.originalTask;
    }
    if (pending?.type) {
      metadata.pendingType = pending.type;
    }
    if (pending?.plan) {
      metadata.plan = pending.plan;
    }
    if (pending?.resumeState) {
      metadata.resumeState = pending.resumeState;
    }
    if (state.currentNode === 'finalize' && state.status === 'waiting' && state.toolBudget.needsContinuation) {
      metadata.continuation = true;
      metadata.lastStopReason = state.toolBudget.lastStopReason;
    }

    return {
      ...state,
      checkpoint: {
        ...checkpoint,
        metadata,
      },
    };
  }

  private getCheckpointOriginalTask(checkpoint: AgentGraphCheckpoint, fallback: string): string {
    const originalTask = checkpoint.metadata?.originalTask;
    return typeof originalTask === 'string' && originalTask.trim().length > 0
      ? originalTask
      : (checkpoint.input || fallback);
  }

  private getCheckpointPlan(checkpoint: AgentGraphCheckpoint): Plan | undefined {
    const plan = checkpoint.metadata?.plan;
    return this.isPlan(plan) ? plan : undefined;
  }

  private getCheckpointResumeState(checkpoint: AgentGraphCheckpoint): PlanResumeState | undefined {
    const resumeState = checkpoint.metadata?.resumeState;
    return this.isPlanResumeState(resumeState) ? resumeState : undefined;
  }

  private buildResumePrompt(resumeState: PlanResumeState): string {
    return [
      '## ⏸️ 任务已暂停',
      '',
      `当前阻塞步骤: ${resumeState.nextStepIndex + 1}. ${resumeState.blockedStepDescription}`,
      `阻塞原因: ${resumeState.blockedReason}`,
      '',
      '你可以直接回复“继续”恢复执行，或补充新的约束后继续。',
    ].join('\n');
  }

  private isPlan(value: unknown): value is Plan {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return Array.isArray(candidate.steps) && typeof candidate.originalTask === 'string';
  }

  private isPlanResumeState(value: unknown): value is PlanResumeState {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.originalTask === 'string'
      && this.isPlan(candidate.plan)
      && typeof candidate.nextStepIndex === 'number'
      && Array.isArray(candidate.results)
      && typeof candidate.blockedStepDescription === 'string'
      && typeof candidate.blockedReason === 'string';
  }
}

export function createAgentGraphRunner(options: AgentGraphRunnerOptions): AgentGraphRunner {
  return new AgentGraphRunner(options);
}