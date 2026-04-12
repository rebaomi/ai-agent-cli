import type { PermissionType } from './permission-manager.js';
import type { Plan, PlanStep } from './planner.js';
import type { ToolCall } from '../types/index.js';
import type { WorkflowCheckpointConfig } from '../types/index.js';
import {
  buildStepCheckpointPrompt,
  buildStepResultCheckpointPrompt,
  buildToolCheckpointPrompt,
  summarizeStepCheckpointRisks,
  summarizeToolCallCheckpointRisks,
  type StepCheckpointRiskSummary,
} from './checkpoint-risk.js';

export type CheckpointType = 'after_plan' | 'before_step_execution';

export interface CheckpointResult {
  approved: boolean;
  prompt?: string;
  blockedReason?: string;
  skipStepOnReject?: boolean;
  riskSummary?: StepCheckpointRiskSummary;
}

export interface CheckpointManagerOptions {
  permissionManager?: {
    getConfig?: () => { autoGrantDangerous?: boolean; askForPermissions?: boolean };
    isGranted?: (type: PermissionType, resource?: string) => boolean;
  };
  checkpoints?: WorkflowCheckpointConfig;
}

export class CheckpointManager {
  constructor(private readonly options: CheckpointManagerOptions = {}) {}

  async checkpointBeforeStepExecution(plan: Plan, step: PlanStep, stepIndex: number): Promise<CheckpointResult> {
    if (!this.requiresStepExecutionApproval()) {
      return { approved: true };
    }

    const summary = summarizeStepCheckpointRisks(step);
    if (!summary.hasRiskyActions && !summary.hasOutboundDelivery) {
      return { approved: true };
    }

    const missingPermission = summary.items.some((item) => {
      const permissionType = this.mapRiskToPermission(item.kind);
      if (!permissionType) {
        return true;
      }
      const permissionConfig = this.options.permissionManager?.getConfig?.();
      if (permissionConfig?.autoGrantDangerous) {
        return false;
      }
      if (typeof this.options.permissionManager?.isGranted === 'function') {
        return !this.options.permissionManager.isGranted(permissionType);
      }
      return true;
    });

    if (!missingPermission) {
      return { approved: true };
    }

    return {
      approved: false,
      blockedReason: '当前高风险步骤需要你确认后才能继续执行。',
      prompt: buildStepCheckpointPrompt(step, summary, stepIndex, plan.steps.length),
      skipStepOnReject: true,
      riskSummary: summary,
    };
  }

  async checkpointAfterStepExecution(plan: Plan, step: PlanStep, stepIndex: number, stepResult: string): Promise<CheckpointResult> {
    if (!this.requiresStepResultApproval()) {
      return { approved: true };
    }

    const summary = summarizeStepCheckpointRisks(step);
    if (!summary.hasRiskyActions && !summary.hasOutboundDelivery) {
      return { approved: true };
    }

    return {
      approved: false,
      blockedReason: '当前步骤结果需要你验收后才能进入下一步。',
      prompt: buildStepResultCheckpointPrompt(step, summary, stepIndex, plan.steps.length, stepResult),
      riskSummary: summary,
    };
  }

  async checkpointBeforeDynamicToolExecution(originalInput: string, toolCalls: ToolCall[]): Promise<CheckpointResult> {
    if (!this.requiresStepExecutionApproval()) {
      return { approved: true };
    }

    const summary = summarizeToolCallCheckpointRisks(toolCalls);
    if (!summary.hasRiskyActions && !summary.hasOutboundDelivery) {
      return { approved: true };
    }

    const missingPermission = summary.items.some((item) => {
      const permissionType = this.mapRiskToPermission(item.kind);
      if (!permissionType) {
        return true;
      }
      const permissionConfig = this.options.permissionManager?.getConfig?.();
      if (permissionConfig?.autoGrantDangerous) {
        return false;
      }
      if (typeof this.options.permissionManager?.isGranted === 'function') {
        return !this.options.permissionManager.isGranted(permissionType);
      }
      return true;
    });

    if (!missingPermission) {
      return { approved: true };
    }

    return {
      approved: false,
      blockedReason: '当前预测到的工具调用涉及高风险动作，需要你确认后再执行。',
      prompt: buildToolCheckpointPrompt(originalInput, summary),
    };
  }

  private requiresStepExecutionApproval(): boolean {
    if (this.options.checkpoints?.enabled === false) {
      return false;
    }
    if (typeof this.options.checkpoints?.stepExecutionApproval === 'boolean') {
      return this.options.checkpoints.stepExecutionApproval;
    }
    return this.options.checkpoints?.riskyStepApproval !== false;
  }

  private requiresStepResultApproval(): boolean {
    if (this.options.checkpoints?.enabled === false) {
      return false;
    }
    return this.options.checkpoints?.stepResultApproval === true;
  }

  private mapRiskToPermission(kind: StepCheckpointRiskSummary['items'][number]['kind']): PermissionType | undefined {
    switch (kind) {
      case 'command_execute':
        return 'command_execute';
      case 'file_write':
        return 'file_write';
      case 'file_delete':
        return 'file_delete';
      case 'browser_open':
        return 'browser_open';
      case 'browser_automation':
        return 'browser_automation';
      case 'network_request':
      case 'outbound_delivery':
      case 'external_workflow':
        return 'network_request';
      default:
        return undefined;
    }
  }
}