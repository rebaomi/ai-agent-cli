import type { Message, ToolCall } from '../types/index.js';
import type { PlanStep } from './planner.js';
import type { PlanResumeState } from './plan-execution-service.js';
import type { IntentContract } from './tool-intent-contract.js';

export interface AgentPlanRuntimeServiceOptions {
  setPendingInteraction: (pending: {
    type: 'plan_resume';
    callback: () => void;
    originalTask: string;
    plan: PlanResumeState['plan'];
    prompt: string;
    resumeState: PlanResumeState;
  }) => void;
  addMessage: (message: Message) => void;
  setWaitingConfirmation: () => void;
  setLastUserInput: (input: string) => void;
  executePlan: (
    originalTask: string,
    plan: PlanResumeState['plan'],
    startStepIndex?: number,
    existingResults?: string[],
    currentStepState?: PlanResumeState['currentStepState'],
    skipCurrentStep?: boolean,
  ) => Promise<string>;
  resolvePlannedToolArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  prepareToolCallsForExecution: (
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ) => Promise<{ contract: IntentContract; toolCalls: ToolCall[]; rejections: Array<{ toolCall: ToolCall; reason: string }> }>;
  createAssistantToolCallMessage: (
    assistantContent: string,
    batch: { contract: IntentContract; toolCalls: ToolCall[]; rejections: Array<{ toolCall: ToolCall; reason: string }> },
  ) => Message | null;
  runPreparedToolCalls: (batch: { contract: IntentContract; toolCalls: ToolCall[]; rejections: Array<{ toolCall: ToolCall; reason: string }> }) => Promise<{ outputs: string[] }>;
}

export class AgentPlanRuntimeService {
  constructor(private readonly options: AgentPlanRuntimeServiceOptions) {}

  pausePlanForUserInput(resumeState: PlanResumeState): string {
    const message = resumeState.checkpointPrompt || [
      '## ⏸️ 任务已暂停',
      '',
      `当前阻塞步骤: ${resumeState.nextStepIndex + 1}. ${resumeState.blockedStepDescription}`,
      `阻塞原因: ${resumeState.blockedReason}`,
      '',
      '这不是一次性失败。我已保留当前计划和已完成结果。',
      '你可以先补权限、补路径、补输入资料或处理外部依赖，然后直接回复“继续”恢复执行。',
      '如果你想调整方案，也可以直接补充新要求，我会在恢复前带上这些信息。',
    ].join('\n');

    this.options.setPendingInteraction({
      type: 'plan_resume',
      callback: () => {},
      originalTask: resumeState.originalTask,
      plan: resumeState.plan,
      prompt: message,
      resumeState,
    });
    this.options.addMessage({ role: 'assistant', content: message });
    this.options.setWaitingConfirmation();
    return message;
  }

  async resumePlanExecution(
    resumeState: PlanResumeState,
    note?: string,
    options?: { skipCurrentStep?: boolean; acceptPendingStepResult?: boolean; retryCurrentStep?: boolean },
  ): Promise<string> {
    const resumedTask = note
      ? [resumeState.originalTask.trim(), `恢复执行前的用户补充: ${note.trim()}`].filter(Boolean).join('\n')
      : resumeState.originalTask;
    const existingResults = [...resumeState.results];
    let startStepIndex = resumeState.nextStepIndex;

    if (options?.acceptPendingStepResult && resumeState.pendingStepResult) {
      const stepNumber = (resumeState.checkpointStepIndex ?? resumeState.nextStepIndex) + 1;
      existingResults.push(`[步骤 ${stepNumber}] ${resumeState.blockedStepDescription}\n${resumeState.pendingStepResult}`);
    }

    if (options?.retryCurrentStep && typeof resumeState.checkpointStepIndex === 'number') {
      startStepIndex = resumeState.checkpointStepIndex;
    }

    this.options.setLastUserInput(resumedTask);
    return this.options.executePlan(
      resumedTask,
      resumeState.plan,
      startStepIndex,
      existingResults,
      resumeState.currentStepState,
      options?.skipCurrentStep,
    );
  }

  shouldPausePlanForUserInput(errorMessage: string): boolean {
    return /(permission denied|需要授权|权限不足|authorize|authorization|access denied)/i.test(errorMessage);
  }

  async executePlannedToolCalls(step: PlanStep, stepContext: string): Promise<string> {
    const plannedCalls = step.toolCalls || [];
    const rawToolCalls: ToolCall[] = plannedCalls.map((toolCall, index) => ({
      id: `plan_${step.id}_${index + 1}`,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(this.options.resolvePlannedToolArgs(toolCall.args || {})),
      },
    }));

    const prepared = await this.options.prepareToolCallsForExecution(
      step.description,
      `按计划执行步骤工具：${step.description}`,
      rawToolCalls,
      false,
    );
    this.options.addMessage({ role: 'user', content: `${stepContext}\n本步骤必须优先执行计划中指定的工具调用。` });

    const plannedAssistantMessage = this.options.createAssistantToolCallMessage(
      `按计划执行步骤工具：${step.description}`,
      prepared,
    );
    if (plannedAssistantMessage) {
      this.options.addMessage(plannedAssistantMessage);
    }

    const runResult = await this.options.runPreparedToolCalls(prepared);
    const combined = runResult.outputs.join('\n\n');
    const summary = combined.trim() || `步骤 ${step.description} 已按计划执行完成。`;
    this.options.addMessage({ role: 'assistant', content: summary });
    return summary;
  }
}