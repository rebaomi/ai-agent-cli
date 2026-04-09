import type { Message } from '../types/index.js';

export interface AgentMessageViewServiceOptions {
  getMessages: () => Message[];
  getSystemPrompt: () => string;
  getRuntimeMemoryContext: () => string;
  getKnownGapContext: () => string;
}

export class AgentMessageViewService {
  constructor(private readonly options: AgentMessageViewServiceOptions) {}

  getMessagesForLLM(): Message[] {
    const sanitizedMessages = this.sanitizeMessagesForLLM(this.options.getMessages());
    const runtimeSections = [this.options.getRuntimeMemoryContext(), this.options.getKnownGapContext()].filter(Boolean).join('\n\n');
    const runtimeContextMessage = runtimeSections
      ? [{ role: 'system' as const, content: `Runtime memory context:\n${runtimeSections}` }]
      : [];

    return [
      { role: 'system' as const, content: this.options.getSystemPrompt() },
      ...runtimeContextMessage,
      ...sanitizedMessages,
    ];
  }

  sanitizeMessagesForLLM(messages: Message[]): Message[] {
    const sanitized: Message[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }

      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        const requiredIds = new Set(
          message.tool_calls
            .map(toolCall => toolCall?.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        );

        const matchedTools: Message[] = [];
        let cursor = index + 1;
        while (cursor < messages.length && messages[cursor]?.role === 'tool') {
          const candidate = messages[cursor];
          if (!candidate) {
            cursor += 1;
            continue;
          }

          if (candidate.tool_call_id && requiredIds.has(candidate.tool_call_id)) {
            matchedTools.push(candidate);
          }
          cursor += 1;
        }

        const matchedIds = new Set(
          matchedTools
            .map(toolMessage => toolMessage.tool_call_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        );

        if (requiredIds.size > 0 && Array.from(requiredIds).every(id => matchedIds.has(id))) {
          sanitized.push(message, ...matchedTools);
        }

        index = cursor - 1;
        continue;
      }

      if (message.role === 'tool') {
        continue;
      }

      sanitized.push(message);
    }

    return sanitized;
  }
}