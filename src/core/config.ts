import { promises as fs, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';
import { parse } from 'yaml';
import type { AgentConfig } from '../types/index.js';

export function getDefaultAppBaseDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return join(homeDir, '.ai-agent-cli');
}

function getDefaultArtifactOutputDir(): string {
  return join(getDefaultAppBaseDir(), 'outputs');
}

const memorySchema = z.object({
  backend: z.enum(['local', 'mempalace', 'hybrid']).default('hybrid'),
  recallLimit: z.number().int().min(1).max(20).default(6),
  enableSessionSync: z.boolean().default(true),
  enableAutoArchive: z.boolean().default(true),
});

const mcpServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const lspServerSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  rootPatterns: z.array(z.string()).optional(),
});

const sandboxSchema = z.object({
  enabled: z.boolean().default(true),
  allowedPaths: z.array(z.string()).optional(),
  deniedPaths: z.array(z.string()).optional(),
  timeout: z.number().default(30000),
  maxMemory: z.number().optional(),
});

const providerSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string(),
  temperature: z.number().default(0.7),
  maxTokens: z.number().default(4096),
  systemPrompt: z.string().optional(),
});

const deepseekAutoReasoningSchema = z.object({
  enabled: z.boolean().default(false),
  simpleTaskMaxChars: z.number().int().min(1).max(4000).default(120),
  simpleConversationMaxChars: z.number().int().min(100).max(500000).default(8000),
  preferReasonerForToolMessages: z.boolean().default(true),
  preferReasonerForPlanning: z.boolean().default(true),
  preferReasonerForLongContext: z.boolean().default(true),
});

const deepseekProviderSchema = providerSchema.extend({
  reasoningModel: z.string().default('deepseek-reasoner'),
  autoReasoning: deepseekAutoReasoningSchema.nullish(),
});

const routedProviderSchema = z.enum(['ollama', 'deepseek', 'kimi', 'glm', 'doubao', 'minimax', 'openai', 'claude', 'gemini']);

const hybridSchema = z.object({
  enabled: z.boolean().default(true),
  localProvider: routedProviderSchema.default('ollama'),
  remoteProvider: routedProviderSchema.default('deepseek'),
  simpleTaskMaxChars: z.number().int().min(1).max(1000).default(80),
  simpleConversationMaxChars: z.number().int().min(100).max(200000).default(6000),
  preferRemoteForToolMessages: z.boolean().default(true),
  localAvailabilityCacheMs: z.number().int().min(0).max(300000).default(15000),
});

const larkMorningNewsSchema = z.object({
  userId: z.string().optional(),
  chatId: z.string().optional(),
  schedule: z.string().default('0 8 * * *'),
  timezone: z.string().default('Asia/Shanghai'),
  saveOutput: z.boolean().default(true),
  title: z.string().optional(),
});

const larkWeatherSchema = z.object({
  chatId: z.string().optional(),
  city: z.string().optional(),
  schedule: z.string().default('0 9 * * *'),
  timezone: z.string().default('Asia/Shanghai'),
});

const larkRelaySchema = z.object({
  enabled: z.boolean().default(false),
  autoSubscribe: z.boolean().default(true),
  eventTypes: z.array(z.string()).default(['im.message.receive_v1']),
  compact: z.boolean().default(true),
  quiet: z.boolean().default(true),
  allowedChatIds: z.array(z.string()).optional(),
  allowedSenderIds: z.array(z.string()).optional(),
  allowCommands: z.boolean().default(false),
  cliBin: z.string().optional(),
});

const notificationsSchema = z.object({
  lark: z.object({
    morningNews: larkMorningNewsSchema.default({
      schedule: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      saveOutput: true,
    }),
    weather: larkWeatherSchema.default({
      schedule: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    }),
    relay: larkRelaySchema.default({
      enabled: false,
      autoSubscribe: true,
      eventTypes: ['im.message.receive_v1'],
      compact: true,
      quiet: true,
      allowCommands: false,
    }),
  }).optional(),
}).optional();

const configSchema = z.object({
  defaultProvider: z.string().default('ollama'),
  ollama: providerSchema.merge(z.object({ baseUrl: z.string().default('http://localhost:11434') })),
  deepseek: deepseekProviderSchema.optional(),
  kimi: providerSchema.optional(),
  glm: providerSchema.optional(),
  doubao: providerSchema.optional(),
  minimax: providerSchema.optional(),
  openai: providerSchema.optional(),
  claude: providerSchema.optional(),
  gemini: providerSchema.optional(),
  hybrid: hybridSchema.optional(),
  mcp: z.array(mcpServerSchema).optional(),
  lsp: z.array(lspServerSchema).optional(),
  sandbox: sandboxSchema.optional(),
  memory: memorySchema.optional(),
  appBaseDir: z.string().default(getDefaultAppBaseDir()),
  artifactOutputDir: z.string().default(getDefaultArtifactOutputDir()),
  documentOutputDir: z.string().optional(),
  workspace: z.string().default(process.cwd()),
  maxIterations: z.number().default(100),
  maxToolCallsPerTurn: z.number().int().min(1).max(200).default(10),
  autoContinueOnToolLimit: z.boolean().default(true),
  maxContinuationTurns: z.number().int().min(0).max(20).default(3),
  toolTimeout: z.number().default(60000),
  notifications: notificationsSchema,
});

export type ConfigSchema = z.infer<typeof configSchema>;

const defaultConfig: ConfigSchema = {
  defaultProvider: 'ollama',
  ollama: {
    enabled: true,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
  },
  appBaseDir: getDefaultAppBaseDir(),
  artifactOutputDir: getDefaultArtifactOutputDir(),
  workspace: process.cwd(),
  maxIterations: 100,
  maxToolCallsPerTurn: 10,
  autoContinueOnToolLimit: true,
  maxContinuationTurns: 3,
  toolTimeout: 60000,
  hybrid: {
    enabled: true,
    localProvider: 'ollama',
    remoteProvider: 'deepseek',
    simpleTaskMaxChars: 80,
    simpleConversationMaxChars: 6000,
    preferRemoteForToolMessages: true,
    localAvailabilityCacheMs: 15000,
  },
  notifications: {
    lark: {
      morningNews: {
        schedule: '0 8 * * *',
        timezone: 'Asia/Shanghai',
        saveOutput: true,
      },
      weather: {
        schedule: '0 9 * * *',
        timezone: 'Asia/Shanghai',
      },
      relay: {
        enabled: false,
        autoSubscribe: true,
        eventTypes: ['im.message.receive_v1'],
        compact: true,
        quiet: true,
        allowCommands: false,
      },
    },
  },
  deepseek: {
    enabled: false,
    model: 'deepseek-chat',
    reasoningModel: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com',
    temperature: 0.7,
    maxTokens: 4096,
    autoReasoning: {
      enabled: false,
      simpleTaskMaxChars: 120,
      simpleConversationMaxChars: 8000,
      preferReasonerForToolMessages: true,
      preferReasonerForPlanning: true,
      preferReasonerForLongContext: true,
    },
  },
  mcp: [],
  lsp: [],
  memory: {
    backend: 'hybrid',
    recallLimit: 6,
    enableSessionSync: true,
    enableAutoArchive: true,
  },
  sandbox: {
    enabled: true,
    timeout: 30000,
  },
};

class ConfigManager {
  private config: ConfigSchema;
  private configPath: string;

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.configPath = join(homeDir, '.ai-agent-cli', 'config.yaml');
    this.config = { ...defaultConfig };
    this.loadSync();
  }

  private loadSync(): void {
    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const parsed = parse(content);
      this.config = configSchema.parse(parsed);
    } catch (error) {
      this.config = { ...defaultConfig };
      console.warn(`[Config] Failed to load ${this.configPath}; falling back to defaults. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K] {
    return this.config[key];
  }

  set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void {
    this.config = { ...this.config, [key]: value };
  }

  getAll(): ConfigSchema {
    return this.config;
  }

  setAll(config: Partial<ConfigSchema>): void {
    this.config = { ...this.config, ...config };
  }

  getAgentConfig(): AgentConfig {
    return this.config as AgentConfig;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  async load(): Promise<void> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const { parse } = await import('yaml');
      const parsed = parse(content);
      this.config = configSchema.parse(parsed);
    } catch (error) {
      this.config = { ...defaultConfig };
      console.warn(`[Config] Failed to load ${this.configPath}; falling back to defaults. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async save(): Promise<void> {
    try {
      const dir = resolve(this.configPath, '..');
      await fs.mkdir(dir, { recursive: true });
      const { stringify } = await import('yaml');
      const content = stringify(this.config);
      await fs.writeFile(this.configPath, content, 'utf-8');
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  async loadFromFile(path: string): Promise<void> {
    try {
      const content = await fs.readFile(path, 'utf-8');
      const { parse } = await import('yaml');
      const parsed = parse(content);
      this.config = configSchema.parse(parsed);
    } catch (error) {
      throw new Error(`Failed to load config from ${path}: ${error}`);
    }
  }

  async saveToFile(path: string): Promise<void> {
    try {
      const { stringify } = await import('yaml');
      const content = stringify(this.config);
      await fs.writeFile(path, content, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to save config to ${path}: ${error}`);
    }
  }

  async savePartial(key: keyof ConfigSchema, value: any): Promise<void> {
    try {
      let content = '';
      try {
        content = await fs.readFile(this.configPath, 'utf-8');
      } catch {
        return;
      }
      const { parse, stringify } = await import('yaml');
      const existingConfig = parse(content) || {};
      
      existingConfig[key] = value;
      
      await fs.writeFile(this.configPath, stringify(existingConfig), 'utf-8');
      this.config = { ...this.config, [key]: value };
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }
}

export const configManager = new ConfigManager();
