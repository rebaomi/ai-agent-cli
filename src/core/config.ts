import { promises as fs, readFileSync } from 'fs';
import { resolve, join } from 'path';
import { z } from 'zod';
import { parse } from 'yaml';
import type { AgentConfig } from '../types/index.js';

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

const configSchema = z.object({
  ollama: z.object({
    baseUrl: z.string().default('http://localhost:11434'),
    model: z.string().default('llama3.2'),
    temperature: z.number().default(0.7),
    maxTokens: z.number().default(4096),
    systemPrompt: z.string().optional(),
  }),
  mcp: z.array(mcpServerSchema).optional(),
  lsp: z.array(lspServerSchema).optional(),
  sandbox: sandboxSchema.optional(),
  workspace: z.string().default(process.cwd()),
  maxIterations: z.number().default(100),
  toolTimeout: z.number().default(60000),
});

export type ConfigSchema = z.infer<typeof configSchema>;

const defaultConfig: ConfigSchema = {
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    temperature: 0.7,
    maxTokens: 4096,
  },
  workspace: process.cwd(),
  maxIterations: 100,
  toolTimeout: 60000,
  mcp: [],
  lsp: [],
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
    } catch {
      // Use default config if file doesn't exist
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
    } catch {
      this.config = { ...defaultConfig };
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
}

export const configManager = new ConfigManager();
