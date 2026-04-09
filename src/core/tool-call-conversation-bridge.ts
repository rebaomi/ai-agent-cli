import type { Message, ToolCall } from '../types/index.js';

export interface PreparedToolCallBatchLike {
  toolCalls: ToolCall[];
  rejections: Array<{ toolCall: ToolCall; reason: string }>;
}

export interface AssistantToolCallMessageOptions {
  fallbackContent?: string;
  omitIfEmpty?: boolean;
}

export class ToolCallConversationBridge {
  buildAssistantToolCalls(batch: PreparedToolCallBatchLike): ToolCall[] {
    return [...batch.toolCalls, ...batch.rejections.map(item => item.toolCall)];
  }

  createAssistantToolCallMessage(
    content: string,
    batch: PreparedToolCallBatchLike,
    options: AssistantToolCallMessageOptions = {},
  ): Message | null {
    const assistantToolCalls = this.buildAssistantToolCalls(batch);
    const normalizedContent = content.trim() || options.fallbackContent || '';

    if (options.omitIfEmpty && !normalizedContent && assistantToolCalls.length === 0) {
      return null;
    }

    const message: Message = {
      role: 'assistant',
      content: normalizedContent,
    };

    if (assistantToolCalls.length > 0) {
      message.tool_calls = assistantToolCalls;
    }

    return message;
  }
}