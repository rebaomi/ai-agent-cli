import type { MemoryProvider } from './memory-provider.js';
import type { DirectActionRouter } from './direct-action-router.js';
import type { Agent } from './agent.js';
import { createAgentGraphRunner } from './agent-graph-runner.js';
import type { AgentGraphCheckpoint, AgentGraphState, AgentTaskBindingSnapshot } from '../types/index.js';
import type { AgentGraphTurnResult } from './agent-graph-runner.js';
import type { PermissionManager } from './permission-manager.js';

export interface TaskExecutorServiceOptions {
  agent: Agent;
  directActionRouter?: DirectActionRouter;
  memoryProvider?: MemoryProvider;
  permissionManager?: Pick<PermissionManager, 'getConfig'>;
  recallLimit: number;
  autoContinueOnToolLimit: boolean;
  maxContinuationTurns: number;
  onStateChange?: (graphState: AgentGraphState) => Promise<void> | void;
}

export interface TaskExecutionContext {
  mode: 'fresh_task' | 'follow_up_task' | 'pending_interaction' | 'checkpoint_resume';
  isResuming: boolean;
  shouldAnnounceWorkflow: boolean;
  summary: string;
}

export interface TaskExecutorTurnResult extends AgentGraphTurnResult {
  executionContext: TaskExecutionContext;
  executionPolicy: {
    toolBudget: {
      toolCallCount: number;
      maxToolCallsPerTurn: number;
      maxIterations: number;
      lastStopReason: 'completed' | 'tool_limit' | 'max_iterations' | 'error';
    };
    permissionStrategy: 'auto_grant_dangerous' | 'ask_dangerous' | 'deny_dangerous' | 'unknown';
    checkpointResumeHint?: string;
  };
}

export class TaskExecutorService {
  constructor(private readonly options: TaskExecutorServiceOptions) {}

  describeExecutionContext(taskBinding: AgentTaskBindingSnapshot, checkpoint?: AgentGraphCheckpoint): TaskExecutionContext {
    if (this.options.agent.getConfirmationStatus().pending) {
      return {
        mode: 'pending_interaction',
        isResuming: true,
        shouldAnnounceWorkflow: true,
        summary: '继续处理上一条待确认或待补充的任务流程。',
      };
    }

    if (checkpoint) {
      return {
        mode: 'checkpoint_resume',
        isResuming: true,
        shouldAnnounceWorkflow: true,
        summary: '从上一次中断的工作流检查点恢复执行。',
      };
    }

    if (taskBinding.isFollowUp) {
      return {
        mode: 'follow_up_task',
        isResuming: false,
        shouldAnnounceWorkflow: true,
        summary: '沿用上一任务上下文继续推进当前工作流。',
      };
    }

    return {
      mode: 'fresh_task',
      isResuming: false,
      shouldAnnounceWorkflow: false,
      summary: '按新的任务请求启动工作流执行。',
    };
  }

  async executeTurn(input: string, taskBinding: AgentTaskBindingSnapshot, checkpoint?: AgentGraphCheckpoint): Promise<TaskExecutorTurnResult> {
    const executionContext = this.describeExecutionContext(taskBinding, checkpoint);
    const executionPolicy = this.describeExecutionPolicy(taskBinding, checkpoint, executionContext);
    const runner = createAgentGraphRunner({
      agent: this.options.agent,
      directActionRouter: this.options.directActionRouter,
      autoContinueOnToolLimit: this.options.autoContinueOnToolLimit,
      maxContinuationTurns: this.options.maxContinuationTurns,
      getMemoryContext: async (originalInput, effectiveInput) => {
        return this.options.memoryProvider?.buildContext(originalInput || effectiveInput, this.options.recallLimit) || '';
      },
      onStateChange: this.options.onStateChange,
    });

    const turnResult = await runner.runTurn({
      input,
      taskBinding,
      checkpoint,
    });

    return {
      ...turnResult,
      executionContext,
      executionPolicy,
    };
  }

  private describeExecutionPolicy(
    taskBinding: AgentTaskBindingSnapshot,
    checkpoint: AgentGraphCheckpoint | undefined,
    executionContext: TaskExecutionContext,
  ): TaskExecutorTurnResult['executionPolicy'] {
    const snapshot = this.options.agent.getUnifiedStateSnapshot(taskBinding, checkpoint);
    const permissionConfig = this.options.permissionManager?.getConfig();
    const permissionStrategy = permissionConfig
      ? permissionConfig.autoGrantDangerous
        ? 'auto_grant_dangerous'
        : permissionConfig.askForPermissions
          ? 'ask_dangerous'
          : 'deny_dangerous'
      : 'unknown';

    return {
      toolBudget: {
        toolCallCount: snapshot.toolBudget.toolCallCount,
        maxToolCallsPerTurn: snapshot.toolBudget.maxToolCallsPerTurn,
        maxIterations: snapshot.toolBudget.maxIterations,
        lastStopReason: snapshot.toolBudget.lastStopReason,
      },
      permissionStrategy,
      checkpointResumeHint: executionContext.isResuming ? executionContext.summary : undefined,
    };
  }
}