import type { Message } from '../types/index.js';

export interface FinalResponseAssemblerOptions {
  applyKnownGapNotice: (response: string) => string;
  addMessage: (message: Message) => void;
}

export interface FinalizedErrorResponse {
  assistantMessage: string;
  returnValue: string;
}

export class FinalResponseAssembler {
  constructor(private readonly options: FinalResponseAssemblerOptions) {}

  finalizeResponse(response: string, persist: boolean = false): string {
    const finalized = this.options.applyKnownGapNotice(response);
    if (persist) {
      this.options.addMessage({ role: 'assistant', content: finalized });
    }
    return finalized;
  }

  finalizeError(errorMessage: string, previousResponse: string): FinalizedErrorResponse {
    return {
      assistantMessage: `Error: ${errorMessage}`,
      returnValue: this.finalizeResponse(previousResponse || `Error occurred: ${errorMessage}`),
    };
  }
}