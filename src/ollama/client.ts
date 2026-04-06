import EventSource from 'eventsource';
import type { LLMConfig, Message, Tool, ToolCall, ToolResult } from '../types/index.js';

export interface OllamaGenerateOptions {
  system?: string;
  template?: string;
  context?: number[];
  stream?: boolean;
  raw?: boolean;
  images?: string[];
}

export interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
  context?: number[];
  totalDuration?: number;
  loadDuration?: number;
  promptEvalCount?: number;
  promptEvalDuration?: number;
  evalCount?: number;
  evalDuration?: number;
}

export interface OllamaTags {
  models: Array<{
    name: string;
    model: string;
    modifiedAt: string;
    size: number;
  }>;
}

export interface OllamaShow {
  license?: string;
  modelfile?: string;
  parameters?: string;
    template?: string;
  system?: string;
  details?: {
    family: string;
    families: string[];
    format: string;
    parameterSize: string;
    quantizationLevel: string;
  };
}

export class OllamaClient {
  readonly provider: 'ollama' = 'ollama';
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private systemPrompt: string;
  private tools: Tool[] = [];

  constructor(config: LLMConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.model = config.model;
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens ?? 4096;
    this.systemPrompt = config.systemPrompt ?? '';
    if (config.tools) {
      this.tools = config.tools;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  setTools(tools: Tool[]): void {
    this.tools = tools;
  }

  async checkConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<OllamaTags['models']> {
    const response = await fetch(`${this.baseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }
    const data = await response.json() as OllamaTags;
    return data.models;
  }

  async showModel(model?: string): Promise<OllamaShow> {
    const modelName = model ?? this.model;
    const response = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });
    if (!response.ok) {
      throw new Error(`Failed to show model: ${response.statusText}`);
    }
    return response.json() as Promise<OllamaShow>;
  }

  async *generateStream(
    messages: Message[],
    options: OllamaGenerateOptions = {}
  ): AsyncGenerator<OllamaResponse, void, unknown> {
    const requestBody = this.buildRequestBody(messages, { ...options, stream: true });
    
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Generation failed: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line) as OllamaResponse;
            yield data;
            if (data.done) return;
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    }
  }

  async generate(messages: Message[], options: OllamaGenerateOptions = {}): Promise<string> {
    const requestBody = this.buildRequestBody(messages, { ...options, stream: false });
    
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Generation failed: ${response.statusText}`);
    }

    const data = await response.json() as OllamaResponse;
    return data.response;
  }

  async chat(messages: Message[]): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const requestBody = this.buildChatRequestBody(messages);
    
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Chat failed: ${response.statusText}`);
    }

    const data = await response.json() as {
      message: { content: string; tool_calls?: ToolCall[] };
      done: boolean;
    };

    return {
      content: data.message.content,
      toolCalls: data.message.tool_calls,
    };
  }

  async *chatStream(
    messages: Message[]
  ): AsyncGenerator<{ content: string; done: boolean; toolCalls?: ToolCall[] }, void, unknown> {
    const lastMessage = messages[messages.length - 1];
    const systemMessages = messages.filter(m => m.role === 'system');
    const systemPrompt = systemMessages.map(m => m.content).join('\n');

    const requestBody = {
      model: this.model,
      prompt: lastMessage?.content || '',
      system: systemPrompt || this.systemPrompt,
      stream: true,
      options: {
        temperature: this.temperature,
        num_predict: this.maxTokens,
      },
    };

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Chat stream failed: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.trim()) {
          try {
            const data = JSON.parse(line) as {
              response: string;
              done: boolean;
            };
            yield {
              content: data.response,
              done: data.done,
            };
            if (data.done) return;
          } catch {
            // Skip invalid JSON lines
          }
        }
      }
    }
  }

  private buildRequestBody(messages: Message[], options: OllamaGenerateOptions & { stream: boolean }) {
    const lastMessage = messages[messages.length - 1];
    const systemMessages = messages.filter(m => m.role === 'system');
    const system = options.system ?? systemMessages.map(m => m.content).join('\n');

    return {
      model: this.model,
      prompt: lastMessage?.content ?? '',
      system,
      template: options.template,
      context: options.context,
      stream: options.stream,
      raw: options.raw,
      images: options.images,
      options: {
        temperature: this.temperature,
        num_predict: this.maxTokens,
      },
    };
  }

  private buildChatRequestBody(messages: Message[], stream = false) {
    const formattedMessages = messages.map(m => {
      const msg: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      if (m.tool_calls) {
        msg.tool_calls = m.tool_calls;
      }
      if (m.tool_call_id) {
        msg.tool_call_id = m.tool_call_id;
      }
      if (m.name) {
        msg.name = m.name;
      }
      return msg;
    });

    const body: Record<string, unknown> = {
      model: this.model,
      messages: formattedMessages,
      stream,
      options: {
        temperature: this.temperature,
        num_predict: this.maxTokens,
      },
    };

    if (this.tools.length > 0) {
      body.tools = this.tools;
    }

    return body;
  }
}

export function createOllamaClient(config: LLMConfig): OllamaClient {
  return new OllamaClient(config);
}
