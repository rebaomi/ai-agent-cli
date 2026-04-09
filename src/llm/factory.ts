import type { LLMProvider, LLMConfig, LLMProviderInterface } from './types.js';
import { OllamaClient } from '../ollama/client.js';
import { DeepSeekClient } from './providers/deepseek.js';
import { DeepSeekRouterClient } from './providers/deepseek-router.js';
import { KimiClient } from './providers/kimi.js';
import { GLMClient } from './providers/glm.js';
import { DoubaoClient } from './providers/doubao.js';
import { MiniMaxClient } from './providers/minimax.js';
import { OpenAIClient } from './providers/openai.js';
import { ClaudeClient } from './providers/claude.js';
import { GeminiClient } from './providers/gemini.js';
import { HybridClient } from './providers/hybrid.js';

export interface LLMFactoryOptions {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  deepseekRouting?: {
    reasoningModel?: string;
    autoReasoning?: {
      enabled?: boolean;
      simpleTaskMaxChars?: number;
      simpleConversationMaxChars?: number;
      preferReasonerForToolMessages?: boolean;
      preferReasonerForPlanning?: boolean;
      preferReasonerForLongContext?: boolean;
    };
  };
  hybrid?: {
    localProvider: Exclude<LLMProvider, 'hybrid'>;
    remoteProvider: Exclude<LLMProvider, 'hybrid'>;
    localModel?: string;
    remoteModel?: string;
    simpleTaskMaxChars?: number;
    simpleConversationMaxChars?: number;
    preferRemoteForToolMessages?: boolean;
    localAvailabilityCacheMs?: number;
  };
}

export class LLMFactory {
  private static instances: Map<string, LLMProviderInterface> = new Map();

  static create(options: LLMFactoryOptions): LLMProviderInterface {
    const key = options.provider === 'hybrid'
      ? `${options.provider}:${options.hybrid?.localProvider}:${options.hybrid?.localModel || ''}:${options.hybrid?.remoteProvider}:${options.hybrid?.remoteModel || ''}`
      : options.provider === 'deepseek'
        ? `${options.provider}:${options.model}:${options.deepseekRouting?.reasoningModel || ''}:${options.deepseekRouting?.autoReasoning?.enabled ? 'auto' : 'manual'}`
        : `${options.provider}:${options.model}`;
    
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
        if (options.deepseekRouting?.reasoningModel) {
          client = new DeepSeekRouterClient({
            apiKey: options.apiKey || '',
            primaryModel: options.model,
            reasoningModel: options.deepseekRouting.reasoningModel,
            baseUrl: options.baseUrl || 'https://api.deepseek.com',
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            autoReasoning: options.deepseekRouting.autoReasoning,
          });
        } else {
          client = new DeepSeekClient({
            apiKey: options.apiKey || '',
            model: options.model,
            baseUrl: options.baseUrl || 'https://api.deepseek.com',
            temperature: options.temperature,
          });
        }
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

      case 'hybrid': {
        const hybrid = options.hybrid;
        if (!hybrid) {
          throw new Error('Hybrid provider requires hybrid options');
        }

        client = new HybridClient({
          localProviderName: hybrid.localProvider,
          remoteProviderName: hybrid.remoteProvider,
          localProvider: this.create({
            provider: hybrid.localProvider,
            model: hybrid.localModel || 'llama3.2',
          }),
          remoteProvider: this.create({
            provider: hybrid.remoteProvider,
            model: hybrid.remoteModel || 'deepseek-chat',
          }),
          simpleTaskMaxChars: hybrid.simpleTaskMaxChars,
          simpleConversationMaxChars: hybrid.simpleConversationMaxChars,
          preferRemoteForToolMessages: hybrid.preferRemoteForToolMessages,
          localAvailabilityCacheMs: hybrid.localAvailabilityCacheMs,
        });
        break;
      }

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
