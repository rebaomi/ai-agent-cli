import type { Message, Tool } from '../../types/index.js';
import type { LLMProviderInterface, LLMResponse, LLMStreamChunk, LLMProvider } from '../types.js';

export interface HybridClientOptions {
  localProvider: LLMProviderInterface;
  remoteProvider: LLMProviderInterface;
  localProviderName: Exclude<LLMProvider, 'hybrid'>;
  remoteProviderName: Exclude<LLMProvider, 'hybrid'>;
  simpleTaskMaxChars?: number;
  simpleConversationMaxChars?: number;
  preferRemoteForToolMessages?: boolean;
  localAvailabilityCacheMs?: number;
}

export interface HybridRouteSnapshot {
  target: 'local' | 'remote';
  providerName: Exclude<LLMProvider, 'hybrid'>;
  reason: 'simple_task' | 'complex_task' | 'tool_messages' | 'system_prompt';
  cacheStatus: 'hit' | 'miss' | 'bypass';
  fallbackReason?: 'local_unavailable' | 'local_runtime_error';
  timestamp: number;
}

export class HybridClient implements LLMProviderInterface {
  readonly provider = 'hybrid' as const;

  private tools: Tool[] = [];
  private simpleTaskMaxChars: number;
  private simpleConversationMaxChars: number;
  private preferRemoteForToolMessages: boolean;
  private localAvailabilityCacheMs: number;
  private localAvailabilityCache?: { available: boolean; expiresAt: number };
  private lastRouteSnapshot?: HybridRouteSnapshot;

  constructor(private readonly options: HybridClientOptions) {
    this.simpleTaskMaxChars = options.simpleTaskMaxChars ?? 80;
    this.simpleConversationMaxChars = options.simpleConversationMaxChars ?? 6000;
    this.preferRemoteForToolMessages = options.preferRemoteForToolMessages ?? true;
    this.localAvailabilityCacheMs = options.localAvailabilityCacheMs ?? 15000;
  }

  getLastRouteSnapshot(): HybridRouteSnapshot | undefined {
    return this.lastRouteSnapshot ? { ...this.lastRouteSnapshot } : undefined;
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    const client = this.pickClientForMessages(messages);
    return this.executeWithRemoteFallback(client, activeClient => activeClient.chat(messages));
  }

  async *chatStream(messages: Message[]): AsyncGenerator<LLMStreamChunk> {
    const client = await this.resolveClientWithRemoteFallback(this.pickClientForMessages(messages));
    if (client.chatStream) {
      let yielded = false;
      try {
        for await (const chunk of client.chatStream(messages)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (yielded || client !== this.options.localProvider) {
          throw error;
        }

        if (this.options.remoteProvider.chatStream) {
          yield* this.options.remoteProvider.chatStream(messages);
          return;
        }

        const response = await this.options.remoteProvider.chat(messages);
        yield { content: response.content, done: true, toolCalls: response.toolCalls };
        return;
      }
    }

    try {
      const response = await client.chat(messages);
      yield { content: response.content, done: true, toolCalls: response.toolCalls };
      return;
    } catch (error) {
      if (client !== this.options.localProvider) {
        throw error;
      }

      const response = await this.options.remoteProvider.chat(messages);
      yield { content: response.content, done: true, toolCalls: response.toolCalls };
      return;
    }
  }

  async generate(promptOrMessages: string | Message[]): Promise<string> {
    const client = this.pickClient(promptOrMessages);
    return this.executeWithRemoteFallback(client, activeClient => activeClient.generate(promptOrMessages));
  }

  async *generateStream(promptOrMessages: string | Message[]): AsyncGenerator<LLMStreamChunk> {
    const client = await this.resolveClientWithRemoteFallback(this.pickClient(promptOrMessages));
    if (client.generateStream) {
      let yielded = false;
      try {
        for await (const chunk of client.generateStream(promptOrMessages)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (yielded || client !== this.options.localProvider) {
          throw error;
        }

        if (this.options.remoteProvider.generateStream) {
          yield* this.options.remoteProvider.generateStream(promptOrMessages);
          return;
        }

        yield { content: await this.options.remoteProvider.generate(promptOrMessages), done: true };
        return;
      }
    }

    try {
      yield { content: await client.generate(promptOrMessages), done: true };
      return;
    } catch (error) {
      if (client !== this.options.localProvider) {
        throw error;
      }

      yield { content: await this.options.remoteProvider.generate(promptOrMessages), done: true };
      return;
    }
  }

  setTools(tools: Tool[]): void {
    this.tools = tools;
    this.options.localProvider.setTools(tools);
    this.options.remoteProvider.setTools(tools);
  }

  async checkConnection(): Promise<boolean> {
    const [localOk, remoteOk] = await Promise.all([
      this.options.localProvider.checkConnection().catch(() => false),
      this.options.remoteProvider.checkConnection().catch(() => false),
    ]);
    return localOk || remoteOk;
  }

  getModel(): string {
    return `hybrid(local=${this.options.localProviderName}:${this.options.localProvider.getModel()}, remote=${this.options.remoteProviderName}:${this.options.remoteProvider.getModel()})`;
  }

  setModel(model: string): void {
    if (model.startsWith('local:')) {
      this.options.localProvider.setModel(model.slice('local:'.length));
      return;
    }

    if (model.startsWith('remote:')) {
      this.options.remoteProvider.setModel(model.slice('remote:'.length));
      return;
    }
  }

  private pickClient(promptOrMessages: string | Message[]): LLMProviderInterface {
    if (typeof promptOrMessages === 'string') {
      return this.pickClientForPrompt(promptOrMessages);
    }
    return this.pickClientForMessages(promptOrMessages);
  }

  private pickClientForMessages(messages: Message[]): LLMProviderInterface {
    const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || '';
    const systemHints = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);

    if (this.preferRemoteForToolMessages && messages.some(message => message.role === 'tool' || (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0))) {
      this.recordRoute('remote', 'tool_messages', 'bypass');
      return this.options.remoteProvider;
    }

    if (this.requiresRemoteBySystemPrompt(systemHints)) {
      this.recordRoute('remote', 'system_prompt', 'bypass');
      return this.options.remoteProvider;
    }

    if (this.isSimpleTask(latestUser, totalChars)) {
      this.recordRoute('local', 'simple_task', 'miss');
      return this.options.localProvider;
    }

    this.recordRoute('remote', 'complex_task', 'bypass');
    return this.options.remoteProvider;
  }

  private pickClientForPrompt(prompt: string): LLMProviderInterface {
    if (this.requiresRemoteBySystemPrompt(prompt)) {
      this.recordRoute('remote', 'system_prompt', 'bypass');
      return this.options.remoteProvider;
    }

    if (this.isSimpleTask(prompt, prompt.length)) {
      this.recordRoute('local', 'simple_task', 'miss');
      return this.options.localProvider;
    }

    this.recordRoute('remote', 'complex_task', 'bypass');
    return this.options.remoteProvider;
  }

  private async executeWithRemoteFallback<T>(client: LLMProviderInterface, operation: (activeClient: LLMProviderInterface) => Promise<T>): Promise<T> {
    const resolvedClient = await this.resolveClientWithRemoteFallback(client);

    try {
      return await operation(resolvedClient);
    } catch (error) {
      if (resolvedClient !== this.options.localProvider) {
        throw error;
      }

      this.updateLocalAvailabilityCache(false);
      this.setFallbackReason('local_runtime_error');
      return operation(this.options.remoteProvider);
    }
  }

  private async resolveClientWithRemoteFallback(client: LLMProviderInterface): Promise<LLMProviderInterface> {
    if (client !== this.options.localProvider) {
      return client;
    }

    const { available: localAvailable, cacheStatus } = await this.isClientAvailable(this.options.localProvider);
    this.updateCacheStatus(cacheStatus);
    if (localAvailable) {
      return this.options.localProvider;
    }

    this.setFallbackReason('local_unavailable');
    return this.options.remoteProvider;
  }

  private async isClientAvailable(client: LLMProviderInterface): Promise<{ available: boolean; cacheStatus: 'hit' | 'miss' }> {
    const now = Date.now();
    if (this.localAvailabilityCache && this.localAvailabilityCache.expiresAt > now) {
      return { available: this.localAvailabilityCache.available, cacheStatus: 'hit' };
    }

    try {
      const available = await client.checkConnection();
      this.updateLocalAvailabilityCache(available);
      return { available, cacheStatus: 'miss' };
    } catch {
      this.updateLocalAvailabilityCache(false);
      return { available: false, cacheStatus: 'miss' };
    }
  }

  private updateLocalAvailabilityCache(available: boolean): void {
    this.localAvailabilityCache = {
      available,
      expiresAt: Date.now() + this.localAvailabilityCacheMs,
    };
  }

  private recordRoute(target: 'local' | 'remote', reason: HybridRouteSnapshot['reason'], cacheStatus: HybridRouteSnapshot['cacheStatus']): void {
    this.lastRouteSnapshot = {
      target,
      providerName: target === 'local' ? this.options.localProviderName : this.options.remoteProviderName,
      reason,
      cacheStatus,
      timestamp: Date.now(),
    };
  }

  private updateCacheStatus(cacheStatus: 'hit' | 'miss'): void {
    if (!this.lastRouteSnapshot) {
      return;
    }

    this.lastRouteSnapshot = {
      ...this.lastRouteSnapshot,
      cacheStatus,
    };
  }

  private setFallbackReason(fallbackReason: HybridRouteSnapshot['fallbackReason']): void {
    if (!this.lastRouteSnapshot) {
      return;
    }

    this.lastRouteSnapshot = {
      ...this.lastRouteSnapshot,
      target: 'remote',
      providerName: this.options.remoteProviderName,
      fallbackReason,
      timestamp: Date.now(),
    };
  }

  private requiresRemoteBySystemPrompt(content: string): boolean {
    return /(任务规划专家|tool intent contract parser|procedural skill reviewer|任务复杂度分析专家|只返回 JSON|复杂任务|plan|planner|intent contract)/i.test(content);
  }

  private isSimpleTask(latestUser: string, totalChars: number): boolean {
    const trimmed = latestUser.trim();
    if (!trimmed) {
      return false;
    }

    if (totalChars > this.simpleConversationMaxChars || trimmed.length > this.simpleTaskMaxChars) {
      return false;
    }

    const complexIndicators = [
      '多个', '同时', '然后', '接着', '最后', '步骤', '规划', '分析', '总结后', '并发送', '发送到', '导出', '生成文档',
      'multi', 'multiple', 'then', 'after that', 'step', 'plan', 'analyze', 'compare', 'summarize',
    ];
    if (complexIndicators.some(indicator => trimmed.toLowerCase().includes(indicator.toLowerCase()))) {
      return false;
    }

    const directPatterns = [
      /^(你好|您好|嗨|hi|hello|hey)$/i,
      /^(解释|说明|翻译|润色|改写|总结|概括|列出|回答|查一下|介绍一下).{0,40}$/,
      /^(what|who|when|where|why|how)\b.{0,60}$/i,
    ];
    return directPatterns.some(pattern => pattern.test(trimmed));
  }
}
