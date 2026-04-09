import type { Plan } from './planner.js';
import type { AgentState } from './agent.js';
import type { PlanResumeState } from './plan-execution-service.js';

export type PendingInteractionType = 'plan_execution' | 'write_file' | 'task_clarification' | 'plan_resume';

export interface PendingInteraction {
  type: PendingInteractionType;
  callback?: (confirmed: boolean, params?: any) => void;
  plan?: Plan;
  originalTask?: string;
  prompt?: string;
  resumeState?: PlanResumeState;
}

export interface AgentInteractionServiceOptions {
  addUserMessage: (content: string) => void;
  addAssistantMessage: (content: string) => void;
  executePlan: (originalTask: string, plan: Plan) => Promise<string>;
  resumePlanExecution: (resumeState: PlanResumeState, note?: string) => Promise<string>;
  chatWithPlanning: (input: string) => Promise<string>;
  setState: (state: AgentState) => void;
  setLastUserInput: (input: string) => void;
  getLastUserInput: () => string;
}

export class AgentInteractionService {
  private pendingConfirmation?: PendingInteraction;

  constructor(private readonly options: AgentInteractionServiceOptions) {}

  setConfirmationCallback(type: 'plan_execution' | 'write_file', callback: (confirmed: boolean, params?: any) => void): void {
    this.pendingConfirmation = { type, callback };
  }

  getConfirmationStatus(): { pending: boolean; type?: string; prompt?: string } {
    return {
      pending: !!this.pendingConfirmation,
      type: this.pendingConfirmation?.type,
      prompt: this.pendingConfirmation?.prompt,
    };
  }

  setPendingInteraction(pending: PendingInteraction): void {
    this.pendingConfirmation = pending;
  }

  async confirmAction(confirmed: boolean, params?: any): Promise<string | undefined> {
    let executionResult: string | undefined;
    const pending = this.pendingConfirmation;

    if (!pending) {
      return undefined;
    }

    this.options.addUserMessage(confirmed ? '是' : '否');

    if (confirmed && pending.type === 'plan_execution' && pending.plan) {
      executionResult = await this.options.executePlan(pending.originalTask || 'task', pending.plan);
      if (executionResult) {
        this.options.addAssistantMessage(executionResult);
      }
    } else if (confirmed && pending.type === 'plan_resume' && pending.resumeState) {
      executionResult = await this.options.resumePlanExecution(pending.resumeState, typeof params?.note === 'string' ? params.note : undefined);
      if (executionResult) {
        this.options.addAssistantMessage(executionResult);
      }
    } else if (!confirmed && pending.type === 'plan_execution') {
      this.options.addAssistantMessage('已取消执行当前计划。');
    } else if (!confirmed && pending.type === 'plan_resume') {
      executionResult = '已暂停当前计划。等你补齐权限、路径或其他前置条件后，直接回复“继续”或补充新要求，我会从中断步骤继续。';
      this.options.addAssistantMessage(executionResult);
    }

    pending.callback?.(confirmed, params);
    if (this.pendingConfirmation === pending) {
      this.pendingConfirmation = undefined;
      this.options.setState('IDLE');
    }

    return executionResult;
  }

  async respondToPendingInput(input: string): Promise<string | undefined> {
    const pending = this.pendingConfirmation;
    if (!pending) {
      return undefined;
    }

    const trimmed = input.trim();
    this.options.addUserMessage(trimmed);

    if (pending.type === 'task_clarification' && pending.originalTask) {
      this.pendingConfirmation = undefined;
      this.options.setState('THINKING');
      const clarifiedTask = this.mergeTaskWithUserInput(pending.originalTask, trimmed, '用户补充的关键信息');
      this.options.setLastUserInput(clarifiedTask);
      return this.options.chatWithPlanning(clarifiedTask);
    }

    if (pending.type === 'plan_execution') {
      if (this.isAffirmative(trimmed)) {
        return this.confirmAction(true);
      }
      if (this.isNegative(trimmed)) {
        return this.confirmAction(false);
      }

      this.pendingConfirmation = undefined;
      this.options.setState('THINKING');
      const refinedTask = this.mergeTaskWithUserInput(pending.originalTask || pending.plan?.originalTask || this.options.getLastUserInput(), trimmed, '用户对执行计划的补充要求');
      this.options.setLastUserInput(refinedTask);
      return this.options.chatWithPlanning(refinedTask);
    }

    if (pending.type === 'plan_resume' && pending.resumeState) {
      if (this.isNegative(trimmed)) {
        return this.confirmAction(false);
      }
      return this.confirmAction(true, {
        note: this.isResumeSignal(trimmed) ? undefined : trimmed,
      });
    }

    if (pending.type === 'write_file') {
      if (this.isAffirmative(trimmed)) {
        return this.confirmAction(true);
      }
      if (this.isNegative(trimmed)) {
        return this.confirmAction(false);
      }
    }

    return undefined;
  }

  buildTaskClarificationPrompt(input: string): string | null {
    const trimmed = input.trim();
    const missing: string[] = [];

    if (trimmed.length < 18 || /(处理一下|搞一下|看一下|弄一下|帮我做|帮我处理)$/i.test(trimmed)) {
      missing.push('你真正要交付的目标');
    }

    if (/(导出|生成|输出|保存|写入)/.test(trimmed) && !/(docx|word|pdf|md|txt|json|xlsx|ppt|目录|路径|文件名|输出到)/i.test(trimmed)) {
      missing.push('输出格式或输出位置');
    }

    if (/(修改|修复|优化|重构|调整)/.test(trimmed) && !/(文件|目录|模块|命令|接口|页面|脚本|功能|仓库)/.test(trimmed)) {
      missing.push('具体改哪一块');
    }

    if (missing.length === 0) {
      return null;
    }

    return [
      '在开始规划前，我还缺少一些关键信息。',
      `请补充：${missing.join('、')}。`,
      '如果有优先级、截止时间、验收标准或不能碰的范围，也一起说，我会按补充后的信息继续规划。',
    ].join('\n');
  }

  private mergeTaskWithUserInput(originalTask: string, userInput: string, label: string): string {
    return [originalTask.trim(), `${label}: ${userInput.trim()}`].filter(Boolean).join('\n');
  }

  private isAffirmative(input: string): boolean {
    return /^(是|好|好的|可以|继续|继续执行|确认|yes|y|ok|okay|go|continue)$/i.test(input.trim());
  }

  private isNegative(input: string): boolean {
    return /^(否|不|不用|先不要|取消|暂停|no|n|cancel|stop)$/i.test(input.trim());
  }

  private isResumeSignal(input: string): boolean {
    return /^(继续|继续执行|恢复|resume|continue|go)$/i.test(input.trim());
  }
}