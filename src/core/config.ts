import { promises as fs, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';
import { parse } from 'yaml';
import type { AgentConfig } from '../types/index.js';

function getDefaultArtifactOutputDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return join(homeDir, '.ai-agent-cli', 'outputs');
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

const larkMorningNewsSchema = z.object({
  userId: z.string().optional(),
  chatId: z.string().optional(),
  schedule: z.string().default('0 8 * * *'),
  timezone: z.string().default('Asia/Shanghai'),
  saveOutput: z.boolean().default(true),
  title: z.string().optional(),
});

const notificationsSchema = z.object({
  lark: z.object({
    morningNews: larkMorningNewsSchema.default({
      schedule: '0 8 * * *',
      timezone: 'Asia/Shanghai',
      saveOutput: true,
    }),
  }).optional(),
}).optional();

const configSchema = z.object({
  defaultProvider: z.string().default('ollama'),
  ollama: providerSchema.merge(z.object({ baseUrl: z.string().default('http://localhost:11434') })),
  deepseek: providerSchema.optional(),
  kimi: providerSchema.optional(),
  glm: providerSchema.optional(),
  doubao: providerSchema.optional(),
  minimax: providerSchema.optional(),
  openai: providerSchema.optional(),
  claude: providerSchema.optional(),
  gemini: providerSchema.optional(),
  mcp: z.array(mcpServerSchema).optional(),
  lsp: z.array(lspServerSchema).optional(),
  sandbox: sandboxSchema.optional(),
  memory: memorySchema.optional(),
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
  artifactOutputDir: getDefaultArtifactOutputDir(),
  workspace: process.cwd(),
  maxIterations: 100,
  maxToolCallsPerTurn: 10,
  autoContinueOnToolLimit: true,
  maxContinuationTurns: 3,
  toolTimeout: 60000,
  notifications: {
    lark: {
      morningNews: {
        schedule: '0 8 * * *',
        timezone: 'Asia/Shanghai',
        saveOutput: true,
      },
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
