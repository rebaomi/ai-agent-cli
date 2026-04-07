import { promises as fs } from 'fs';
import { join } from 'path';
import { Message } from '../types/index.js';

export interface MemoryLevel {
  name: 'working' | 'summary' | 'vector';
  priority: number;
  maxTokens: number;
}

export interface ContextConfig {
  maxWorkingTokens: number;
  maxSummaryTokens: number;
  maxVectorEntries: number;
  enableSummary: boolean;
  enableVector: boolean;
  useLangChainFallback: boolean;
  langChainConfig?: {
    provider: string;
    apiKey?: string;
  };
}

const DEFAULT_CONFIG: ContextConfig = {
  maxWorkingTokens: 8000,
  maxSummaryTokens: 4000,
  maxVectorEntries: 100,
  enableSummary: true,
  enableVector: false,
  useLangChainFallback: false,
};

export class ContextManager {
  private config: ContextConfig;
  private workingMemory: Message[] = [];
  private summaryMemory: Message[] = [];
  private vectorStore: Array<{ embedding: number[]; message: Message; timestamp: number }> = [];
  private totalTokenCount = 0;
  private messagePairMap: Map<string, { assistant: Message; tool: Message | null }> = new Map();

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): ContextConfig {
    return this.config;
  }

  setConfig(config: Partial<ContextConfig>): void {
    this.config = { ...this.config, ...config };
  }

  initialize(messages?: Message[]): void {
    this.clear();

    if (messages) {
      this.workingMemory = this.removeOrphanToolMessages(messages);
      this.totalTokenCount = this.workingMemory.reduce(
        (sum, message) => sum + this.estimateTokens(message.content),
        0,
      );
      this.rebuildMessagePairs();
    }
  }

  private rebuildMessagePairs(): void {
    this.messagePairMap.clear();

    for (const msg of this.workingMemory) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          if (toolCall?.id) {
            this.messagePairMap.set(toolCall.id, { assistant: msg, tool: null });
          }
        }
      } else if (msg.role === 'tool') {
        const pairId = msg.tool_call_id;
        if (pairId && this.messagePairMap.has(pairId)) {
          const pair = this.messagePairMap.get(pairId)!;
          pair.tool = msg;
        }
      }
    }
  }

  addMessage(message: Message): void {
    if (message.role === 'assistant' && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall?.id) {
          this.messagePairMap.set(toolCall.id, { assistant: message, tool: null });
        }
      }
    }

    if (message.role === 'tool' && message.tool_call_id) {
      const pair = this.messagePairMap.get(message.tool_call_id);
      if (pair) {
        pair.tool = message;
      }
    }

    this.workingMemory.push(message);
    this.workingMemory = this.removeOrphanToolMessages(this.workingMemory);
    this.rebuildMessagePairs();
    this.totalTokenCount += this.estimateTokens(message.content);
    this.totalTokenCount = this.workingMemory.reduce(
      (sum, item) => sum + this.estimateTokens(item.content),
      0,
    );

    if (this.shouldCompress()) {
      this.compress();
    }
  }

  getMessages(): Message[] {
    const allMessages: Message[] = [];

    if (this.config.enableSummary && this.summaryMemory.length > 0) {
      allMessages.push(...this.summaryMemory);
    }

    allMessages.push(...this.workingMemory);

    return allMessages;
  }

  private shouldCompress(): boolean {
    return this.totalTokenCount > this.config.maxWorkingTokens + this.config.maxSummaryTokens;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private compress(): void {
    if (this.config.enableSummary && this.totalTokenCount > this.config.maxWorkingTokens) {
      this.createSummary();
    }

    const targetTokens = this.config.maxWorkingTokens;
    while (this.totalTokenCount > targetTokens && this.workingMemory.length > 1) {
      const removed = this.workingMemory.shift();
      if (removed) {
        this.totalTokenCount -= this.estimateTokens(removed.content);
      }
      const normalized = this.removeOrphanToolMessages(this.workingMemory);
      if (normalized.length !== this.workingMemory.length) {
        this.workingMemory = normalized;
        this.totalTokenCount = this.workingMemory.reduce(
          (sum, message) => sum + this.estimateTokens(message.content),
          0,
        );
      }
    }

    this.rebuildMessagePairs();
  }

  private createSummary(): void {
    if (this.workingMemory.length < 4) return;

    const recentMessages = this.workingMemory.slice(-10);
    const summaryText = this.generateSummary(recentMessages);

    const summaryMessage: Message = {
      role: 'system',
      content: `[对话摘要 - 前 ${recentMessages.length} 条消息]\n${summaryText}`,
    };

    this.summaryMemory = [summaryMessage];
    this.workingMemory = this.removeOrphanToolMessages(this.workingMemory.slice(-5));
    this.totalTokenCount = this.workingMemory.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    this.rebuildMessagePairs();
  }

  private removeOrphanToolMessages(messages: Message[]): Message[] {
    const validToolCallIds = new Set<string>();
    const normalized: Message[] = [];

    for (const message of messages) {
      if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          if (toolCall?.id) {
            validToolCallIds.add(toolCall.id);
          }
        }
        normalized.push(message);
        continue;
      }

      if (message.role === 'tool') {
        if (message.tool_call_id && validToolCallIds.has(message.tool_call_id)) {
          normalized.push(message);
        }
        continue;
      }

      normalized.push(message);
    }

    return normalized;
  }

  private generateSummary(messages: Message[]): string {
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
    const assistantMessages = messages.filter(m => m.role === 'assistant').map(m => m.content);

    return `用户请求: ${userMessages.slice(-2).join('; ') || 'N/A'}\n助手回复: ${assistantMessages.slice(-2).join('; ') || 'N/A'}`;
  }

  addToVectorStore(message: Message): void {
    if (!this.config.enableVector) return;
    if (this.vectorStore.length >= this.config.maxVectorEntries) {
      this.vectorStore.shift();
    }

    const embedding = this.simpleEmbedding(message.content);
    this.vectorStore.push({
      embedding,
      message,
      timestamp: Date.now(),
    });
  }

  private simpleEmbedding(text: string): number[] {
    const hash = this.hashCode(text);
    const embedding = new Array(384).fill(0);
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] = Math.sin(hash * (i + 1)) * Math.PI;
    }
    return embedding;
  }

  private hashCode(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return hash;
  }

  searchVectorStore(query: string, topK = 3): Message[] {
    if (!this.config.enableVector || this.vectorStore.length === 0) return [];

    const queryEmbedding = this.simpleEmbedding(query);
    const scores: Array<{ message: Message; score: number }> = [];

    for (const entry of this.vectorStore) {
      const score = this.cosineSimilarity(queryEmbedding, entry.embedding);
      scores.push({ message: entry.message, score });
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).map(s => s.message);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i] ?? 0;
      const bv = b[i] ?? 0;
      dotProduct += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB) + 0.0001);
  }

  async useLangChainFallback(query: string, messages: Message[]): Promise<string> {
    throw new Error('LangChain fallback not implemented. Configure langChainConfig first.');
  }

  getStats(): {
    workingMessages: number;
    summaryMessages: number;
    vectorEntries: number;
    totalTokens: number;
    messagePairs: number;
  } {
    return {
      workingMessages: this.workingMemory.length,
      summaryMessages: this.summaryMemory.length,
      vectorEntries: this.vectorStore.length,
      totalTokens: this.totalTokenCount,
      messagePairs: this.messagePairMap.size,
    };
  }

  clear(): void {
    this.workingMemory = [];
    this.summaryMemory = [];
    this.vectorStore = [];
    this.totalTokenCount = 0;
    this.messagePairMap.clear();
  }
}

export function createContextManager(config?: Partial<ContextConfig>): ContextManager {
  return new ContextManager(config);
}