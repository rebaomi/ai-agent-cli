import type { Message, Tool, ToolCall } from '../types/index.js';

export type LLMProvider = 'ollama' | 'deepseek' | 'kimi' | 'glm' | 'doubao' | 'minimax' | 'openai' | 'claude' | 'gemini' | 'hybrid';

export interface LLMConfig {
  provider: LLMProvider;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  toolCalls?: ToolCall[];
}

export interface LLMStreamChunk {
  content: string;
  done: boolean;
  toolCalls?: ToolCall[];
}

export interface LLMProviderInterface {
  readonly provider: LLMProvider;
  
  chat(messages: Message[]): Promise<LLMResponse>;
  chatStream?(messages: Message[]): AsyncGenerator<LLMStreamChunk>;
  generate(promptOrMessages: string | Message[]): Promise<string>;
  generateStream?(promptOrMessages: string | Message[]): AsyncGenerator<LLMStreamChunk | any>;
  
  setTools(tools: Tool[]): void;
  checkConnection(): Promise<boolean>;
  getModel(): string;
  setModel(model: string): void;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: LLMProvider;
  description: string;
  contextLength: number;
  supportsTools: boolean;
  isLocal: boolean;
  pricing?: {
    input: number;
    output: number;
  };
}

export const KNOWN_MODELS: ModelInfo[] = [
  { id: 'qwen3.5:9b', name: 'Qwen 3.5 9B', provider: 'ollama', description: '通义千问', contextLength: 32768, supportsTools: true, isLocal: true },
  { id: 'llama3.2', name: 'Llama 3.2', provider: 'ollama', description: 'Meta 开源模型', contextLength: 128000, supportsTools: true, isLocal: true },
  
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', description: '深度求索', contextLength: 64000, supportsTools: true, isLocal: false, pricing: { input: 0.001, output: 0.002 } },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', provider: 'deepseek', description: '深度求索思考模式', contextLength: 64000, supportsTools: true, isLocal: false },
  { id: 'deepseek-coder', name: 'DeepSeek Coder', provider: 'deepseek', description: '代码专用', contextLength: 160000, supportsTools: true, isLocal: false },
  
  { id: 'moonshot-v1-8k', name: 'Moonshot V1 8K', provider: 'kimi', description: '月之暗面 Kimi', contextLength: 8000, supportsTools: true, isLocal: false, pricing: { input: 0.003, output: 0.006 } },
  { id: 'moonshot-v1-32k', name: 'Moonshot V1 32K', provider: 'kimi', description: 'Kimi 长文本', contextLength: 32000, supportsTools: true, isLocal: false },
  { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', provider: 'kimi', description: 'Kimi 超长文本', contextLength: 128000, supportsTools: true, isLocal: false },
  
  { id: 'glm-4', name: 'GLM-4', provider: 'glm', description: '智谱 GLM-4', contextLength: 128000, supportsTools: true, isLocal: false, pricing: { input: 0.001, output: 0.002 } },
  { id: 'glm-4-flash', name: 'GLM-4 Flash', provider: 'glm', description: 'GLM-4 快速版', contextLength: 128000, supportsTools: true, isLocal: false },
  
  { id: 'doubao-pro-32k', name: 'Doubao Pro 32K', provider: 'doubao', description: '字节豆包 Pro', contextLength: 32000, supportsTools: true, isLocal: false },
  { id: 'doubao-lite-32k', name: 'Doubao Lite 32K', provider: 'doubao', description: '字节豆包 Lite', contextLength: 32000, supportsTools: true, isLocal: false },
  
  { id: 'abab6.5s-chat', name: 'MiniMax ABAB 6.5S', provider: 'minimax', description: '稀宇科技', contextLength: 245000, supportsTools: true, isLocal: false },
  
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', description: 'OpenAI 最新模型', contextLength: 128000, supportsTools: true, isLocal: false, pricing: { input: 0.005, output: 0.015 } },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', description: 'OpenAI 轻量版', contextLength: 128000, supportsTools: true, isLocal: false, pricing: { input: 0.00015, output: 0.0006 } },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', description: 'OpenAI 高性能', contextLength: 128000, supportsTools: true, isLocal: false },
  
  { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', provider: 'claude', description: 'Anthropic 最新', contextLength: 200000, supportsTools: true, isLocal: false, pricing: { input: 0.003, output: 0.015 } },
  { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'claude', description: 'Anthropic 轻量', contextLength: 200000, supportsTools: true, isLocal: false, pricing: { input: 0.0008, output: 0.004 } },
  
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', description: 'Google 最新', contextLength: 1000000, supportsTools: true, isLocal: false, pricing: { input: 0, output: 0 } },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini', description: 'Google 高性能', contextLength: 2000000, supportsTools: true, isLocal: false },
];

export function getModelsByProvider(provider: LLMProvider): ModelInfo[] {
  return KNOWN_MODELS.filter(m => m.provider === provider);
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return KNOWN_MODELS.find(m => m.id === modelId);
}
