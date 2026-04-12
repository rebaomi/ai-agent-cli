import type { Plan, PlanStep } from './planner.js';
import type { ReActStepExecutionResult, ReActStepState } from './react-step-runtime.js';

export interface PlanResumeState {
  originalTask: string;
  plan: Plan;
  nextStepIndex: number;
  results: string[];
  blockedStepDescription: string;
  blockedReason: string;
  currentStepState?: ReActStepState;
  resumeKind?: 'blocked' | 'checkpoint';
  checkpointStage?: 'step_execution' | 'step_result';
  checkpointStepIndex?: number;
  pendingStepResult?: string;
  checkpointPrompt?: string;
  skipStepOnReject?: boolean;
}

export interface PlanExecutionServiceOptions {
  onStepStart: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number) => void;
  onStepCompleted: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number, result: string) => void;
  onStepFailed: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number, errorMessage: string) => void;
  checkpointBeforeStepExecution?: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number) => Promise<{
    approved: boolean;
    prompt?: string;
    blockedReason?: string;
    skipStepOnReject?: boolean;
  }>;
  checkpointAfterStepExecution?: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number, stepResult: string) => Promise<{
    approved: boolean;
    prompt?: string;
    blockedReason?: string;
  }>;
  executeStepWithReAct: (
    originalTask: string,
    plan: Plan,
    step: PlanStep,
    stepIndex: number,
    totalSteps: number,
    previousResults: string[],
    stepContext: string,
    previousState?: ReActStepState,
  ) => Promise<ReActStepExecutionResult>;
  executePlannedToolCalls: (step: PlanStep, stepContext: string) => Promise<string>;
  generateStepResponse: (stepContext: string) => Promise<string>;
  shouldPauseForUserInput: (errorMessage: string) => boolean;
  pausePlanForUserInput: (resumeState: PlanResumeState) => string;
  completePlannerStep?: (stepId: string, result: string) => void;
  failPlannerStep?: (stepId: string, errorMessage: string) => void;
  processSkillLearning: (originalTask: string, plan: Plan, results: string[]) => Promise<void>;
  synthesizeResults: (originalTask: string, stepResults: string[]) => Promise<string>;
}

export class PlanExecutionService {
  constructor(private readonly options: PlanExecutionServiceOptions) {}

  async executePlan(
    originalTask: string,
    plan: Plan,
    startStepIndex = 0,
    existingResults: string[] = [],
    currentStepState?: ReActStepState,
    skipCurrentStep = false,
  ): Promise<string> {
    const results: string[] = [...existingResults];
    let shouldSkipCurrentStep = skipCurrentStep;

    for (let index = startStepIndex; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      if (!step) {
        continue;
      }

      if (shouldSkipCurrentStep) {
        const skippedMessage = `[步骤 ${index + 1}] ${step.description}\n已跳过：你拒绝执行当前高风险步骤。`;
        this.options.completePlannerStep?.(step.id, skippedMessage);
        this.options.onStepCompleted(plan, step, index, plan.steps.length, skippedMessage);
        results.push(skippedMessage);
        shouldSkipCurrentStep = false;
        continue;
      }

      const stepCheckpoint = await this.options.checkpointBeforeStepExecution?.(plan, step, index, plan.steps.length);
      if (stepCheckpoint && !stepCheckpoint.approved) {
        return this.options.pausePlanForUserInput({
          originalTask,
          plan,
          nextStepIndex: index,
          results,
          blockedStepDescription: step.description,
          blockedReason: stepCheckpoint.blockedReason || '当前步骤需要人工确认。',
          resumeKind: 'checkpoint',
          checkpointStage: 'step_execution',
          checkpointStepIndex: index,
          checkpointPrompt: stepCheckpoint.prompt,
          skipStepOnReject: stepCheckpoint.skipStepOnReject,
        });
      }

      const stepNum = index + 1;
      this.options.onStepStart(plan, step, index, plan.steps.length);

      try {
        const stepContext = this.buildPlanStepContext(originalTask, plan.steps.length, stepNum, step.description, results);
        const reactResult = await this.options.executeStepWithReAct(
          originalTask,
          plan,
          step,
          index,
          plan.steps.length,
          results,
          stepContext,
          index === startStepIndex ? currentStepState : undefined,
        );

        if (reactResult.status === 'paused') {
          const blockedMessage = this.options.pausePlanForUserInput({
            originalTask,
            plan,
            nextStepIndex: index,
            results,
            blockedStepDescription: step.description,
            blockedReason: reactResult.errorMessage || '当前步骤等待更多输入后继续。',
            currentStepState: reactResult.state,
            resumeKind: 'blocked',
          });
          this.options.onStepFailed(plan, step, index, plan.steps.length, reactResult.errorMessage || '步骤暂停');
          return blockedMessage;
        }

        if (reactResult.status === 'failed') {
          throw new Error(reactResult.errorMessage || '当前步骤执行失败');
        }

        const stepResult = reactResult.output || '';

        const resultCheckpoint = await this.options.checkpointAfterStepExecution?.(plan, step, index, plan.steps.length, stepResult);
        if (resultCheckpoint && !resultCheckpoint.approved) {
          return this.options.pausePlanForUserInput({
            originalTask,
            plan,
            nextStepIndex: index + 1,
            results,
            blockedStepDescription: step.description,
            blockedReason: resultCheckpoint.blockedReason || '当前步骤结果需要人工验收。',
            resumeKind: 'checkpoint',
            checkpointStage: 'step_result',
            checkpointStepIndex: index,
            pendingStepResult: stepResult,
            checkpointPrompt: resultCheckpoint.prompt,
          });
        }

        this.options.completePlannerStep?.(step.id, stepResult);
        this.options.onStepCompleted(plan, step, index, plan.steps.length, stepResult);
        results.push(`[步骤 ${stepNum}] ${step.description}\n${stepResult}`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (this.options.shouldPauseForUserInput(errorMessage)) {
          const blockedMessage = this.options.pausePlanForUserInput({
            originalTask,
            plan,
            nextStepIndex: index,
            results,
            blockedStepDescription: step.description,
            blockedReason: errorMessage,
            resumeKind: 'blocked',
          });
          this.options.onStepFailed(plan, step, index, plan.steps.length, errorMessage);
          return blockedMessage;
        }

        this.options.failPlannerStep?.(step.id, errorMessage);
        this.options.onStepFailed(plan, step, index, plan.steps.length, errorMessage);
        results.push(`[步骤 ${stepNum}] 失败: ${errorMessage}`);
        break;
      }
    }

    await this.options.processSkillLearning(originalTask, plan, results);
    return this.options.synthesizeResults(originalTask, results);
  }

  private buildPlanStepContext(
    originalTask: string,
    totalSteps: number,
    stepNum: number,
    stepDescription: string,
    previousResults: string[],
  ): string {
    const previous = previousResults.length > 0 ? previousResults.join('\n---\n') : '暂无';
    return [
      '你正在执行一个已经确认的计划。只允许完成当前步骤，不要重写计划，不要扩展到其他步骤。',
      `原任务: ${originalTask}`,
      `当前步骤: ${stepNum}/${totalSteps}`,
      `步骤要求: ${stepDescription}`,
      `已完成步骤结果: ${previous}`,
      '如果当前步骤能直接得出结果，就直接给出当前步骤结果。',
    ].join('\n');
  }
}