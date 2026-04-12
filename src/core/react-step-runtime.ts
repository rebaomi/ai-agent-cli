import type { Plan, PlanStep } from './planner.js';

export type ReActStepPhase = 'thought' | 'action' | 'observation' | 'reflection' | 'completed' | 'paused' | 'failed';

export interface ReActStepObservation {
  type: 'planned_tool' | 'dynamic_action' | 'error' | 'note';
  content: string;
  createdAt: string;
}

export interface ReActStepState {
  phase: ReActStepPhase;
  iteration: number;
  usedPlannedTools: boolean;
  lastThought?: string;
  lastInstruction?: string;
  finalResponse?: string;
  failureReason?: string;
  observations: ReActStepObservation[];
}

export interface ReActStepDecision {
  thought: string;
  action: 'investigate' | 'finalize' | 'pause' | 'fail';
  instruction?: string;
  finalResponse?: string;
  reason?: string;
}

export interface ReActStepExecutionInput {
  originalTask: string;
  plan: Plan;
  step: PlanStep;
  stepIndex: number;
  totalSteps: number;
  previousResults: string[];
  stepContext: string;
  previousState?: ReActStepState;
}

export interface ReActStepExecutionResult {
  status: 'completed' | 'paused' | 'failed';
  output?: string;
  errorMessage?: string;
  state: ReActStepState;
}

export interface ReActStepRuntimeOptions {
  maxIterations?: number;
  decideNextAction: (input: ReActStepExecutionInput, state: ReActStepState) => Promise<ReActStepDecision>;
  executePlannedToolCalls: (step: PlanStep, stepContext: string) => Promise<string>;
  executeDynamicAction: (prompt: string) => Promise<string>;
  generateStepResponse: (prompt: string) => Promise<string>;
  shouldPauseForUserInput: (errorMessage: string) => boolean;
  onStateNote?: (message: string) => void;
}

export class ReActStepRuntime {
  constructor(private readonly options: ReActStepRuntimeOptions) {}

  async execute(input: ReActStepExecutionInput): Promise<ReActStepExecutionResult> {
    const maxIterations = this.options.maxIterations ?? 6;
    const state = this.createInitialState(input.previousState);

    while (state.iteration < maxIterations) {
      if (!state.usedPlannedTools && input.step.toolCalls && input.step.toolCalls.length > 0) {
        state.phase = 'thought';
        state.lastThought = '当前步骤已有明确计划工具，优先执行计划内动作。';
        this.options.onStateNote?.(`ReAct 思考: ${state.lastThought}`);

        const plannedResult = await this.executeAction(state, async () => this.options.executePlannedToolCalls(input.step, input.stepContext), 'planned_tool');
        if (plannedResult.status !== 'continue') {
          return plannedResult.result;
        }

        state.usedPlannedTools = true;
        state.phase = 'reflection';
        continue;
      }

      state.phase = 'thought';
      const decision = await this.options.decideNextAction(input, state);
      state.lastThought = decision.thought.trim() || '基于当前观察决定下一步。';
      this.options.onStateNote?.(`ReAct 思考: ${state.lastThought}`);

      if (decision.action === 'finalize') {
        const finalResponse = decision.finalResponse?.trim()
          ? decision.finalResponse.trim()
          : await this.options.generateStepResponse(this.buildFinalizePrompt(input, state));
        state.phase = 'completed';
        state.finalResponse = finalResponse.trim();
        return {
          status: 'completed',
          output: state.finalResponse,
          state,
        };
      }

      if (decision.action === 'pause') {
        const reason = decision.reason?.trim() || '等待用户补充信息后继续执行该步骤。';
        state.phase = 'paused';
        state.failureReason = reason;
        return {
          status: 'paused',
          errorMessage: reason,
          state,
        };
      }

      if (decision.action === 'fail') {
        const reason = decision.reason?.trim() || '当前步骤无法继续执行。';
        state.phase = 'failed';
        state.failureReason = reason;
        return {
          status: 'failed',
          errorMessage: reason,
          state,
        };
      }

      const instruction = decision.instruction?.trim() || '执行当前步骤的下一个必要动作，并仅返回新的观察结果。';
      state.lastInstruction = instruction;
      const actionPrompt = this.buildDynamicActionPrompt(input, state, instruction);
      const dynamicResult = await this.executeAction(state, async () => this.options.executeDynamicAction(actionPrompt), 'dynamic_action');
      if (dynamicResult.status !== 'continue') {
        return dynamicResult.result;
      }

      state.phase = 'reflection';
    }

    const fallback = await this.options.generateStepResponse(this.buildFinalizePrompt(input, state));
    state.phase = 'completed';
    state.finalResponse = fallback.trim();
    return {
      status: 'completed',
      output: state.finalResponse,
      state,
    };
  }

  private createInitialState(previousState?: ReActStepState): ReActStepState {
    if (previousState) {
      return {
        ...previousState,
        observations: Array.isArray(previousState.observations) ? [...previousState.observations] : [],
      };
    }

    return {
      phase: 'thought',
      iteration: 0,
      usedPlannedTools: false,
      observations: [],
    };
  }

  private async executeAction(
    state: ReActStepState,
    run: () => Promise<string>,
    observationType: ReActStepObservation['type'],
  ): Promise<{ status: 'continue'; result?: undefined } | { status: 'return'; result: ReActStepExecutionResult }> {
    state.phase = 'action';
    state.iteration += 1;
    try {
      const output = (await run()).trim();
      state.phase = 'observation';
      state.observations.push({
        type: observationType,
        content: output || '动作已执行，但没有返回可见输出。',
        createdAt: new Date().toISOString(),
      });
      return { status: 'continue' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (this.options.shouldPauseForUserInput(errorMessage)) {
        state.phase = 'paused';
        state.failureReason = errorMessage;
        return {
          status: 'return',
          result: {
            status: 'paused',
            errorMessage,
            state,
          },
        };
      }

      state.phase = 'observation';
      state.observations.push({
        type: 'error',
        content: errorMessage,
        createdAt: new Date().toISOString(),
      });
      this.options.onStateNote?.(`ReAct 观察到错误: ${errorMessage}`);
      return { status: 'continue' };
    }
  }

  private buildDynamicActionPrompt(input: ReActStepExecutionInput, state: ReActStepState, instruction: string): string {
    return [
      '你正在执行一个 ReAct 步骤运行时中的单步动作。',
      '本轮只允许完成一个下一步动作；如果需要工具，可以调用工具，但不要试图完成整个任务。',
      '输出必须是这一次动作产生的新观察，不要重述整个步骤历史。',
      `原任务: ${input.originalTask}`,
      `计划步骤: ${input.stepIndex + 1}/${input.totalSteps} - ${input.step.description}`,
      `动作指令: ${instruction}`,
      `既有观察:\n${this.formatObservations(state)}`,
      `已完成步骤结果:\n${this.formatPreviousResults(input.previousResults)}`,
    ].join('\n');
  }

  private buildFinalizePrompt(input: ReActStepExecutionInput, state: ReActStepState): string {
    return [
      '请基于当前步骤的全部观察，给出该步骤的最终结果。',
      '只返回当前步骤结果，不要重写全计划，不要扩展到下一步。',
      `原任务: ${input.originalTask}`,
      `当前步骤: ${input.stepIndex + 1}/${input.totalSteps}`,
      `步骤要求: ${input.step.description}`,
      `观察记录:\n${this.formatObservations(state)}`,
      `已完成步骤结果:\n${this.formatPreviousResults(input.previousResults)}`,
    ].join('\n');
  }

  private formatObservations(state: ReActStepState): string {
    if (state.observations.length === 0) {
      return '暂无';
    }

    return state.observations
      .map((item, index) => `${index + 1}. [${item.type}] ${item.content}`)
      .join('\n---\n');
  }

  private formatPreviousResults(previousResults: string[]): string {
    return previousResults.length > 0 ? previousResults.join('\n---\n') : '暂无';
  }
}