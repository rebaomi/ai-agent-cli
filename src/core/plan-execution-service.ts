import type { Plan, PlanStep } from './planner.js';

export interface PlanResumeState {
  originalTask: string;
  plan: Plan;
  nextStepIndex: number;
  results: string[];
  blockedStepDescription: string;
  blockedReason: string;
}

export interface PlanExecutionServiceOptions {
  onStepStart: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number) => void;
  onStepCompleted: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number, result: string) => void;
  onStepFailed: (plan: Plan, step: PlanStep, stepIndex: number, totalSteps: number, errorMessage: string) => void;
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

  async executePlan(originalTask: string, plan: Plan, startStepIndex = 0, existingResults: string[] = []): Promise<string> {
    const results: string[] = [...existingResults];

    for (let index = startStepIndex; index < plan.steps.length; index++) {
      const step = plan.steps[index];
      if (!step) {
        continue;
      }

      const stepNum = index + 1;
      this.options.onStepStart(plan, step, index, plan.steps.length);

      try {
        const stepContext = this.buildPlanStepContext(originalTask, plan.steps.length, stepNum, step.description, results);
        const stepResult = step.toolCalls && step.toolCalls.length > 0
          ? await this.options.executePlannedToolCalls(step, stepContext)
          : await this.options.generateStepResponse(stepContext);

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