import type { Message } from '../types/index.js';

export interface ResponseTurnIterationResult {
  response: string;
  continueLoop: boolean;
}

export interface ResponseTurnExecutorOptions {
  maxIterations: number;
  isToolOverLimit: () => boolean;
  onToolLimit: () => void;
  onIterationStart: (iteration: number) => void;
  getMessagesForLLM: () => Message[];
  runTurn: (messages: Message[]) => Promise<ResponseTurnIterationResult>;
  finalizeError: (error: unknown, previousResponse: string) => string;
  finalizeMaxIterations: () => string;
  finalizeCompletion: (response: string) => string;
}

export class ResponseTurnExecutor {
  constructor(private readonly options: ResponseTurnExecutorOptions) {}

  async execute(): Promise<string> {
    let iteration = 0;
    let fullResponse = '';

    while (iteration < this.options.maxIterations) {
      iteration += 1;
      this.options.onIterationStart(iteration);

      if (this.options.isToolOverLimit()) {
        this.options.onToolLimit();
        break;
      }

      try {
        const turnResult = await this.options.runTurn(this.options.getMessagesForLLM());
        fullResponse = turnResult.response;
        if (turnResult.continueLoop) {
          continue;
        }
        break;
      } catch (error) {
        return this.options.finalizeError(error, fullResponse);
      }
    }

    if (iteration >= this.options.maxIterations) {
      return this.options.finalizeMaxIterations();
    }

    return this.options.finalizeCompletion(fullResponse);
  }
}