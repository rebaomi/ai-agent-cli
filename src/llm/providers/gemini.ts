import { BaseLLMClient } from './base.js';
import type { Message } from '../../types/index.js';
import type { LLMResponse } from '../types.js';

export class GeminiClient extends BaseLLMClient {
  readonly provider = 'gemini' as const;

  async chat(messages: Message[]): Promise<LLMResponse> {
    const systemMessage = messages.find(m => m.role === 'system');
    const chatMessages = messages.filter(m => m.role !== 'system');

    const contents = chatMessages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const response = await fetch(
      `${this.baseUrl}/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents,
          systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
          generationConfig: {
            temperature: this.temperature,
            maxOutputTokens: this.maxTokens,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    
    return {
      content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      finishReason: data.candidates?.[0]?.finishReason,
      usage: data.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount,
        completionTokens: data.usageMetadata.candidatesTokenCount,
        totalTokens: data.usageMetadata.totalTokenCount,
      } : undefined,
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
      const response = await fetch(
        `${this.baseUrl}/models?key=${this.apiKey}`
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
