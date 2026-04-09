import type { LLMProviderInterface, LLMStreamChunk } from '../llm/types.js';
import type { Message } from '../types/index.js';
import type { FinalResponseAssembler } from './final-response-assembler.js';
import type { ResponseStreamCollector } from './response-stream-collector.js';
import type { ToolCallResponseCoordinator } from './tool-call-response-coordinator.js';

export interface ResponseTurnProcessorResult {
  response: string;
  continueLoop: boolean;
}

export interface ResponseTurnProcessorOptions {
  llm: Pick<LLMProviderInterface, 'generate' | 'chatStream'>;
  responseStreamCollector: Pick<ResponseStreamCollector, 'collect'>;
  toolCallResponseCoordinator: Pick<ToolCallResponseCoordinator, 'coordinate'>;
  finalResponseAssembler: Pick<FinalResponseAssembler, 'finalizeResponse'>;
}

export class ResponseTurnProcessor {
  constructor(private readonly options: ResponseTurnProcessorOptions) {}

  async execute(allMessages: Message[], userInput: string): Promise<ResponseTurnProcessorResult> {
    if (!this.options.llm.chatStream) {
      return this.executeNonStreamingTurn(allMessages, userInput);
    }

    return this.executeStreamingTurn(allMessages, userInput, this.options.llm.chatStream(allMessages));
  }

  private async executeNonStreamingTurn(allMessages: Message[], userInput: string): Promise<ResponseTurnProcessorResult> {
    const fullResponse = await this.options.llm.generate(allMessages);
    const coordinated = await this.options.toolCallResponseCoordinator.coordinate({
      userInput,
      responseContent: fullResponse,
      prepareFallbackContent: 'Using tool...',
    });

    if (coordinated.handled) {
      return { response: fullResponse, continueLoop: true };
    }

    return {
      response: this.options.finalResponseAssembler.finalizeResponse(fullResponse, true),
      continueLoop: false,
    };
  }

  private async executeStreamingTurn(
    allMessages: Message[],
    userInput: string,
    stream: AsyncGenerator<LLMStreamChunk>,
  ): Promise<ResponseTurnProcessorResult> {
    const collected = await this.options.responseStreamCollector.collect(stream);
    const fullResponse = collected.content;

    const coordinated = await this.options.toolCallResponseCoordinator.coordinate({
      userInput,
      responseContent: fullResponse,
      nativeToolCalls: collected.nativeToolCalls,
      prepareFallbackContent: 'Using tool...',
      assistantMessageOptions: {
        fallbackContent: collected.nativeToolCalls.length > 0 ? 'Using tool...' : undefined,
        omitIfEmpty: true,
      },
    });

    if (coordinated.handled) {
      return { response: fullResponse, continueLoop: true };
    }

    return {
      response: this.options.finalResponseAssembler.finalizeResponse(fullResponse, true),
      continueLoop: false,
    };
  }
}