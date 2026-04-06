import { BaseLLMClient } from './base.js';
import type { Message } from '../../types/index.js';
import type { LLMResponse } from '../types.js';

export class MiniMaxClient extends BaseLLMClient {
  readonly provider = 'minimax' as const;

  async chat(messages: Message[]): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MiniMax API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    
    return {
      content: data.choices?.[0]?.messages?.[0]?.text || '',
      finishReason: data.choices?.[0]?.finish_reason,
      usage: data.usage,
    };
  }

  async generate(promptOrMessages: string | Message[]): Promise<string> {
    if (typeof promptOrMessages === 'string') {
      const response = await this.chat([
        { role: 'user', content: promptOrMessages }
      ]);
      return response.content;
    }
    return (await this.chat(promptOrMessages)).content;
  }

  async checkConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
