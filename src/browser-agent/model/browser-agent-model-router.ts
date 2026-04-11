import { LLMFactory } from '../../llm/factory.js';
import type { LLMProvider, LLMProviderInterface } from '../../llm/types.js';
import type { AgentConfig, BrowserAgentConfig } from '../../types/index.js';
import { OllamaHealthCache } from './ollama-health-cache.js';

interface ResolvedBrowserAgentProvider {
  provider: Exclude<LLMProvider, 'hybrid'>;
  model: string;
}

export class BrowserAgentModelRouter {
  private readonly healthCache: OllamaHealthCache;

  constructor(private readonly config: AgentConfig, private readonly browserAgentConfig: BrowserAgentConfig) {
    this.healthCache = new OllamaHealthCache({
      healthUrl: browserAgentConfig.ollamaHealthCheckUrl || 'http://localhost:11434/api/tags',
      cacheMs: browserAgentConfig.ollamaHealthCacheMs || 15000,
    });
  }

  async createPlannerClient(): Promise<LLMProviderInterface> {
    const resolved = await this.resolveProvider(this.browserAgentConfig.plannerModel);
    return this.createClient(resolved.provider, resolved.model);
  }

  async createExtractorClient(): Promise<LLMProviderInterface> {
    const resolved = await this.resolveProvider(this.browserAgentConfig.extractorModel || this.browserAgentConfig.plannerModel);
    return this.createClient(resolved.provider, resolved.model);
  }

  private async resolveProvider(explicitModel?: string): Promise<ResolvedBrowserAgentProvider> {
    const preferredLocalProvider = this.browserAgentConfig.preferredLocalProvider || 'ollama';
    const fallbackProvider = this.browserAgentConfig.fallbackProvider === 'default'
      ? (this.config.defaultProvider || 'ollama')
      : (this.browserAgentConfig.fallbackProvider || this.config.defaultProvider || 'ollama');

    if (preferredLocalProvider === 'ollama' && await this.healthCache.isHealthy()) {
      return {
        provider: 'ollama',
        model: explicitModel || this.config.ollama?.model || 'llama3.2',
      };
    }

    const normalizedFallback = (fallbackProvider === 'hybrid' ? 'deepseek' : fallbackProvider) as Exclude<LLMProvider, 'hybrid'>;
    return {
      provider: normalizedFallback,
      model: explicitModel || this.getProviderModel(normalizedFallback),
    };
  }

  private getProviderModel(provider: Exclude<LLMProvider, 'hybrid'>): string {
    const providerConfig = this.config[provider];
    if (providerConfig && typeof providerConfig === 'object' && 'model' in providerConfig && typeof providerConfig.model === 'string') {
      return providerConfig.model;
    }

    if (provider === 'ollama') {
      return this.config.ollama?.model || 'llama3.2';
    }

    return 'deepseek-chat';
  }

  private createClient(provider: Exclude<LLMProvider, 'hybrid'>, model: string): LLMProviderInterface {
    const providerConfig = this.config[provider];
    const typedConfig = providerConfig && typeof providerConfig === 'object' ? providerConfig : {};

    return LLMFactory.create({
      provider,
      apiKey: 'apiKey' in typedConfig && typeof typedConfig.apiKey === 'string' ? typedConfig.apiKey : undefined,
      baseUrl: 'baseUrl' in typedConfig && typeof typedConfig.baseUrl === 'string' ? typedConfig.baseUrl : undefined,
      model,
      temperature: 'temperature' in typedConfig && typeof typedConfig.temperature === 'number' ? typedConfig.temperature : 0.2,
      maxTokens: 'maxTokens' in typedConfig && typeof typedConfig.maxTokens === 'number' ? typedConfig.maxTokens : 2048,
    });
  }
}
