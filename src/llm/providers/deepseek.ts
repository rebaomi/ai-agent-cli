import { BaseLLMClient } from './base.js';
import type { Message, ToolCall } from '../../types/index.js';
import type { LLMResponse, LLMStreamChunk } from '../types.js';

export class DeepSeekClient extends BaseLLMClient {
  readonly provider = 'deepseek' as const;

  async chat(messages: Message[]): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => {
          const msg: any = {
            role: m.role,
            content: m.content,
          };
          if (m.role === 'tool') {
            msg.tool_call_id = m.tool_call_id;
            if (m.name) msg.name = m.name;
          }
          if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            msg.tool_calls = m.tool_calls;
          }
          return msg;
        }),
        tools: this.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const data = await response.json() as any;
    const message = data.choices[0]?.message;
    
    return {
      content: message?.content || '',
      finishReason: data.choices[0]?.finish_reason,
      usage: data.usage,
      toolCalls: message?.tool_calls ? message.tool_calls.map((tc: any) => ({
        id: tc.id,
        type: tc.type,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })) : undefined,
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

  override async *chatStream(messages: Message[]): AsyncGenerator<LLMStreamChunk> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(m => {
          const msg: any = {
            role: m.role,
            content: m.content,
          };
          if (m.role === 'tool') {
            msg.tool_call_id = m.tool_call_id;
            if (m.name) msg.name = m.name;
          }
          if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
            msg.tool_calls = m.tool_calls;
          }
          return msg;
        }),
        tools: this.tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.input_schema,
          },
        })),
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let toolCalls: ToolCall[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        
        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield { content: '', done: true, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices[0]?.delta;
          
          if (delta?.content) {
            yield { content: delta.content, done: false };
          }
          
          if (delta?.tool_calls) {
            for (const tc of (delta.tool_calls as any[])) {
              const toolIndex = typeof tc.index === 'number' ? tc.index : toolCalls.length;
              const existing = toolCalls[toolIndex];
              const func = tc.function as any;
              const functionName = String(func?.name || existing?.function.name || '');
              const functionArgs = String(func?.arguments || '');
              const toolId = String(tc.id || existing?.id || `call_${Date.now()}_${toolIndex}`);
              
              if (existing) {
                existing.id = toolId;
                existing.function.name = functionName || existing.function.name;
                existing.function.arguments = (existing.function.arguments || '') + functionArgs;
              } else {
                toolCalls[toolIndex] = {
                  id: toolId,
                  type: 'function' as const,
                  function: {
                    name: functionName,
                    arguments: functionArgs,
                  },
                };
              }
            }
          }
        } catch {
          // skip parse errors
        }
      }
    }
    yield { content: '', done: true, toolCalls: toolCalls.length > 0 ? toolCalls.filter(Boolean) : undefined };
  }
}
