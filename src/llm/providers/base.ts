import type { Message, Tool } from '../../types/index.js';
import type { LLMProviderInterface, LLMResponse, LLMStreamChunk } from '../types.js';

export abstract class BaseLLMClient implements LLMProviderInterface {
  abstract readonly provider: 'ollama' | 'deepseek' | 'kimi' | 'glm' | 'doubao' | 'minimax' | 'openai' | 'claude' | 'gemini';
  
  protected model: string;
  protected temperature: number;
  protected maxTokens?: number;
  protected tools: Tool[] = [];
  protected apiKey: string;
  protected baseUrl: string;

  constructor(config: {
    apiKey: string;
    model: string;
    baseUrl: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens;
  }

  abstract chat(messages: Message[]): Promise<LLMResponse>;
  
  async *chatStream(messages: Message[]): AsyncGenerator<LLMStreamChunk> {
    const response = await this.chat(messages);
    const content = response.content;
    
    for (let i = 0; i < content.length; i += 5) {
      yield {
        content: content.slice(i, i + 5),
        done: false,
      };
    }
    
    yield { content: '', done: true };
  }

  abstract generate(promptOrMessages: string | Message[]): Promise<string>;
  
  async *generateStream(promptOrMessages: string | Message[]): AsyncGenerator<LLMStreamChunk> {
    const result = await this.generate(promptOrMessages);
    
    for (let i = 0; i < result.length; i += 5) {
      yield {
        content: result.slice(i, i + 5),
        done: false,
      };
    }
    
    yield { content: '', done: true };
  }

  setTools(tools: Tool[]): void {
    this.tools = tools;
  }

  abstract checkConnection(): Promise<boolean>;
  
  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model;
  }

  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
  }
}
