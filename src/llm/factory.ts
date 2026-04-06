import type { LLMProvider, LLMConfig, LLMProviderInterface } from './types.js';
import { OllamaClient } from '../ollama/client.js';
import { DeepSeekClient } from './providers/deepseek.js';
import { KimiClient } from './providers/kimi.js';
import { GLMClient } from './providers/glm.js';
import { DoubaoClient } from './providers/doubao.js';
import { MiniMaxClient } from './providers/minimax.js';
import { OpenAIClient } from './providers/openai.js';
import { ClaudeClient } from './providers/claude.js';
import { GeminiClient } from './providers/gemini.js';

export interface LLMFactoryOptions {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export class LLMFactory {
  private static instances: Map<string, LLMProviderInterface> = new Map();

  static create(options: LLMFactoryOptions): LLMProviderInterface {
    const key = `${options.provider}:${options.model}`;
    
    if (this.instances.has(key)) {
      return this.instances.get(key)!;
    }

    let client: LLMProviderInterface;

    switch (options.provider) {
      case 'ollama':
        client = new OllamaClient({
          baseUrl: options.baseUrl || 'http://localhost:11434',
          model: options.model,
          temperature: options.temperature,
        });
        break;

      case 'deepseek':
        client = new DeepSeekClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://api.deepseek.com',
          temperature: options.temperature,
        });
        break;

      case 'kimi':
        client = new KimiClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://api.moonshot.cn/v1',
          temperature: options.temperature,
        });
        break;

      case 'glm':
        client = new GLMClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
          temperature: options.temperature,
        });
        break;

      case 'doubao':
        client = new DoubaoClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
          temperature: options.temperature,
        });
        break;

      case 'minimax':
        client = new MiniMaxClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://api.minimax.chat/v',
          temperature: options.temperature,
        });
        break;

      case 'openai':
        client = new OpenAIClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://api.openai.com/v1',
          temperature: options.temperature,
        });
        break;

      case 'claude':
        client = new ClaudeClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://api.anthropic.com/v1',
          temperature: options.temperature,
        });
        break;

      case 'gemini':
        client = new GeminiClient({
          apiKey: options.apiKey || '',
          model: options.model,
          baseUrl: options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
          temperature: options.temperature,
        });
        break;

      default:
        throw new Error(`Unsupported provider: ${options.provider}`);
    }

    this.instances.set(key, client);
    return client;
  }

  static clearCache(): void {
    this.instances.clear();
  }

  static removeInstance(key: string): void {
    this.instances.delete(key);
  }
}

export function createLLMClient(config: LLMConfig): LLMProviderInterface {
  return LLMFactory.create({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  });
}
