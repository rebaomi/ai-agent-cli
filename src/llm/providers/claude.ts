import { BaseLLMClient } from './base.js';
import type { Message } from '../../types/index.js';
import type { LLMResponse } from '../types.js';

export class ClaudeClient extends BaseLLMClient {
  readonly provider = 'claude' as const;

  async chat(messages: Message[]): Promise<LLMResponse> {
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens || 4096,
        temperature: this.temperature,
        system: systemMessage?.content,
        messages: chatMessages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    
    return {
      content: data.content?.[0]?.text || '',
      finishReason: data.stop_reason,
      usage: {
        promptTokens: data.usage?.input_tokens || 0,
        completionTokens: data.usage?.output_tokens || 0,
        totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
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
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
