import type { LLMStreamChunk } from '../llm/types.js';
import type { ToolCall } from '../types/index.js';

export interface CollectedStreamResponse {
  content: string;
  nativeToolCalls: ToolCall[];
}

export interface ResponseStreamCollectorOptions {
  onChunk?: (chunk: LLMStreamChunk) => void;
}

export class ResponseStreamCollector {
  constructor(private readonly options: ResponseStreamCollectorOptions = {}) {}

  async collect(stream: AsyncGenerator<LLMStreamChunk>): Promise<CollectedStreamResponse> {
    let content = '';
    let nativeToolCalls: ToolCall[] = [];

    for await (const chunk of stream) {
      content += chunk.content;
      this.options.onChunk?.(chunk);

      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        nativeToolCalls = chunk.toolCalls;
      }
    }

    return {
      content,
      nativeToolCalls,
    };
  }
}