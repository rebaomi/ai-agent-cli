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
  visionModel: z.string().optional(),
  visionMaxImages: z.number().int().min(1).max(64).optional(),
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

const browserAgentObserveSchema = z.object({
  useScreenshotByDefault: z.boolean().default(false),
  forceScreenshotAfterFailures: z.number().int().min(0).max(10).default(2),
  fullPageScreenshot: z.boolean().default(false),
  maxDomNodes: z.number().int().min(20).max(2000).default(120),
  maxTextChars: z.number().int().min(200).max(20000).default(4000),
});

const browserAgentOptimizationSchema = z.object({
  enableStateCache: z.boolean().default(true),
  enableDiffObservation: z.boolean().default(true),
  enableRuleFastPath: z.boolean().default(true),
  enableActionBatching: z.boolean().default(true),
});

const browserAgentSafetyKeywordPolicySchema = z.object({
  global: z.array(z.string()).default([]),
  financial: z.array(z.string()).default([]),
  privacy: z.array(z.string()).default([]),
  illegal: z.array(z.string()).default([]),
});

const browserAgentSafetyDomainPolicySchema = z.object({
  name: z.string().optional(),
  match: z.array(z.string()).min(1),
  allowKeywords: browserAgentSafetyKeywordPolicySchema.optional(),
  blockKeywords: browserAgentSafetyKeywordPolicySchema.optional(),
  blockFinancialActions: z.boolean().optional(),
  blockPrivacyActions: z.boolean().optional(),
  blockIllegalActions: z.boolean().optional(),
});

const browserAgentSafetySchema = z.object({
  enabled: z.boolean().default(true),
  blockFinancialActions: z.boolean().default(true),
  blockPrivacyActions: z.boolean().default(true),
  blockIllegalActions: z.boolean().default(true),
  allowKeywords: browserAgentSafetyKeywordPolicySchema.default({
    global: [],
    financial: [],
    privacy: [],
    illegal: [],
  }),
  blockKeywords: browserAgentSafetyKeywordPolicySchema.default({
    global: [],
    financial: [],
    privacy: [],
    illegal: [],
  }),
  domainPolicies: z.array(browserAgentSafetyDomainPolicySchema).default([]),
});

const browserAgentDebugSchema = z.object({
  saveTrace: z.boolean().default(true),
  saveScreenshotsOnFailure: z.boolean().default(true),
});

const browserAgentUserscriptSchema = z.object({
  paths: z.array(z.string()).default([]),
  inline: z.array(z.string()).default([]),
  runAt: z.enum(['document-start', 'document-end']).default('document-end'),
  enabled: z.boolean().default(true),
});

const browserScriptResultMismatchStrategySchema = z.enum(['record-only', 'warn', 'hard-fail']);

const browserAgentSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['off', 'hybrid', 'smart']).default('smart'),
  browser: z.enum(['chrome', 'edge', 'chromium']).default('chrome'),
  headless: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(300000).default(15000),
  userDataDir: z.string().optional(),
  executablePath: z.string().optional(),
  extensionPaths: z.array(z.string()).default([]),
  initScriptPaths: z.array(z.string()).default([]),
  initScripts: z.array(z.string()).default([]),
  pageScriptPaths: z.array(z.string()).default([]),
  pageScripts: z.array(z.string()).default([]),
  userscripts: browserAgentUserscriptSchema.default({
    paths: [],
    inline: [],
    runAt: 'document-end',
    enabled: true,
  }),
  workflowDir: z.string().default('browser-workflows'),
  autoMatchWorkflows: z.boolean().default(true),
  preferredLocalProvider: z.literal('ollama').default('ollama'),
  fallbackProvider: z.enum(['default', 'deepseek', 'kimi', 'glm', 'doubao', 'minimax', 'openai', 'claude', 'gemini']).default('default'),
  ollamaHealthCheckUrl: z.string().default('http://localhost:11434/api/tags'),
  ollamaHealthCacheMs: z.number().int().min(0).max(300000).default(15000),
  plannerModel: z.string().default('qwen3.5:7b'),
  extractorModel: z.string().default('qwen3.5:3b'),
  visionProvider: z.enum(['default', 'ollama', 'deepseek', 'kimi', 'glm', 'doubao', 'minimax', 'openai', 'claude', 'gemini']).default('default'),
  expectResultMismatchStrategy: browserScriptResultMismatchStrategySchema.default('warn'),
  maxSteps: z.number().int().min(1).max(100).default(20),
  maxActionsPerPlan: z.number().int().min(1).max(10).default(3),
  observe: browserAgentObserveSchema.default({
    useScreenshotByDefault: false,
    forceScreenshotAfterFailures: 2,
    fullPageScreenshot: false,
    maxDomNodes: 120,
    maxTextChars: 4000,
  }),
  optimization: browserAgentOptimizationSchema.default({
    enableStateCache: true,
    enableDiffObservation: true,
    enableRuleFastPath: true,
    enableActionBatching: true,
  }),
  safety: browserAgentSafetySchema.default({
    enabled: true,
    blockFinancialActions: true,
    blockPrivacyActions: true,
    blockIllegalActions: true,
    allowKeywords: {
      global: [],
      financial: [],
      privacy: [],
      illegal: [],
    },
    blockKeywords: {
      global: [],
      financial: [],
      privacy: [],
      illegal: [],
    },
    domainPolicies: [],
  }),
  debug: browserAgentDebugSchema.default({
    saveTrace: true,
    saveScreenshotsOnFailure: true,
  }),
});

const directActionConversationModeSchema = z.object({
  enabled: z.boolean().default(true),
  preambleThreshold: z.number().int().min(0).max(10).default(2),
});

const directActionSchema = z.object({
  conversationMode: directActionConversationModeSchema.default({
    enabled: true,
    preambleThreshold: 2,
  }),
});

const functionModeSchema = z.enum(['chat', 'workflow']);

const functionRoutingSchema = z.object({
  preferWorkflow: z.boolean().default(true),
  allowAutoSwitchFromChatToWorkflow: z.boolean().default(true),
  announceRouteDecisions: z.boolean().default(true),
  socialChatKeywords: z.array(z.string()).default(['你好', '您好', 'hi', 'hello', 'hey', '在吗', '嗨']),
  knowledgeChatKeywords: z.array(z.string()).default(['你是谁', '介绍一下', '解释一下', '为什么', '怎么看', '是什么', 'explain', 'what is', 'who are you']),
  directActionKeywords: z.array(z.string()).default(['读取', '查看', '打开', '搜索', '查找', '列出', '导出', '发送', '保存', '转换', '运行', '执行', '文件', '目录', '飞书', 'lark', '命令']),
  workflowKeywords: z.array(z.string()).default(['先', '然后', '接着', '之后', '并且', '并把', '整理', '分析', '总结', '规划', '拆解', '周报', 'workflow']),
  workflowSwitchKeywords: z.array(z.string()).default(['switch workflow', '切换workflow', '切到workflow', '切换到workflow', '切换到工作流', '切到工作流', '进入workflow', '进入工作流', '用workflow']),
  chatSwitchKeywords: z.array(z.string()).default(['switch chat', '切换chat', '切到chat', '切换到chat', '切换到聊天', '切到聊天', '进入chat']),
});

const agentInteractionModeSchema = z.enum(['auto', 'chat', 'task']);

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
  downloadAttachments: z.boolean().default(true),
  receiveDir: z.string().default(join(getDefaultAppBaseDir(), 'feishuReceive')),
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
  browserAgent: browserAgentSchema.optional(),
  mcp: z.array(mcpServerSchema).optional(),
  lsp: z.array(lspServerSchema).optional(),
  sandbox: sandboxSchema.optional(),
  memory: memorySchema.optional(),
  directAction: directActionSchema.optional(),
  functionMode: functionModeSchema.default('workflow'),
  functionRouting: functionRoutingSchema.default({
    preferWorkflow: true,
    allowAutoSwitchFromChatToWorkflow: true,
    announceRouteDecisions: true,
    socialChatKeywords: ['你好', '您好', 'hi', 'hello', 'hey', '在吗', '嗨'],
    knowledgeChatKeywords: ['你是谁', '介绍一下', '解释一下', '为什么', '怎么看', '是什么', 'explain', 'what is', 'who are you'],
    directActionKeywords: ['读取', '查看', '打开', '搜索', '查找', '列出', '导出', '发送', '保存', '转换', '运行', '执行', '文件', '目录', '飞书', 'lark', '命令'],
    workflowKeywords: ['先', '然后', '接着', '之后', '并且', '并把', '整理', '分析', '总结', '规划', '拆解', '周报', 'workflow'],
    workflowSwitchKeywords: ['switch workflow', '切换workflow', '切到workflow', '切换到workflow', '切换到工作流', '切到工作流', '进入workflow', '进入工作流', '用workflow'],
    chatSwitchKeywords: ['switch chat', '切换chat', '切到chat', '切换到chat', '切换到聊天', '切到聊天', '进入chat'],
  }),
  agentInteractionMode: agentInteractionModeSchema.default('auto'),
  appBaseDir: z.string().default(getDefaultAppBaseDir()),
  artifactOutputDir: z.string().default(getDefaultArtifactOutputDir()),
  documentOutputDir: z.string().optional(),
  workspace: z.string().default(process.cwd()),
  maxIterations: z.number().default(100),
  maxToolCallsPerTurn: z.number().int().min(1).max(200).default(20),
  autoContinueOnToolLimit: z.boolean().default(true),
  maxContinuationTurns: z.number().int().min(0).max(20).default(5),
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
    visionModel: 'minicpm-v',
    visionMaxImages: 12,
    temperature: 0.7,
    maxTokens: 4096,
  },
  appBaseDir: getDefaultAppBaseDir(),
  artifactOutputDir: getDefaultArtifactOutputDir(),
  workspace: process.cwd(),
  maxIterations: 100,
  maxToolCallsPerTurn: 20,
  autoContinueOnToolLimit: true,
  maxContinuationTurns: 5,
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
  directAction: {
    conversationMode: {
      enabled: true,
      preambleThreshold: 2,
    },
  },
  functionMode: 'workflow',
  functionRouting: {
    preferWorkflow: true,
    allowAutoSwitchFromChatToWorkflow: true,
    announceRouteDecisions: true,
    socialChatKeywords: ['你好', '您好', 'hi', 'hello', 'hey', '在吗', '嗨'],
    knowledgeChatKeywords: ['你是谁', '介绍一下', '解释一下', '为什么', '怎么看', '是什么', 'explain', 'what is', 'who are you'],
    directActionKeywords: ['读取', '查看', '打开', '搜索', '查找', '列出', '导出', '发送', '保存', '转换', '运行', '执行', '文件', '目录', '飞书', 'lark', '命令'],
    workflowKeywords: ['先', '然后', '接着', '之后', '并且', '并把', '整理', '分析', '总结', '规划', '拆解', '周报', 'workflow'],
    workflowSwitchKeywords: ['switch workflow', '切换workflow', '切到workflow', '切换到workflow', '切换到工作流', '切到工作流', '进入workflow', '进入工作流', '用workflow'],
    chatSwitchKeywords: ['switch chat', '切换chat', '切到chat', '切换到chat', '切换到聊天', '切到聊天', '进入chat'],
  },
  agentInteractionMode: 'auto',
  browserAgent: {
    enabled: true,
    mode: 'smart',
    browser: 'chrome',
    headless: true,
    timeoutMs: 15000,
    extensionPaths: [],
    initScriptPaths: [],
    initScripts: [],
    pageScriptPaths: [],
    pageScripts: [],
    userscripts: {
      paths: [],
      inline: [],
      runAt: 'document-end',
      enabled: true,
    },
    workflowDir: 'browser-workflows',
    autoMatchWorkflows: true,
    preferredLocalProvider: 'ollama',
    fallbackProvider: 'default',
    ollamaHealthCheckUrl: 'http://localhost:11434/api/tags',
    ollamaHealthCacheMs: 15000,
    plannerModel: 'qwen3.5:7b',
    extractorModel: 'qwen3.5:3b',
    visionProvider: 'default',
    expectResultMismatchStrategy: 'warn',
    maxSteps: 20,
    maxActionsPerPlan: 3,
    observe: {
      useScreenshotByDefault: false,
      forceScreenshotAfterFailures: 2,
      fullPageScreenshot: false,
      maxDomNodes: 120,
      maxTextChars: 4000,
    },
    optimization: {
      enableStateCache: true,
      enableDiffObservation: true,
      enableRuleFastPath: true,
      enableActionBatching: true,
    },
    safety: {
      enabled: true,
      blockFinancialActions: true,
      blockPrivacyActions: true,
      blockIllegalActions: true,
      allowKeywords: {
        global: [],
        financial: [],
        privacy: [],
        illegal: [],
      },
      blockKeywords: {
        global: [],
        financial: [],
        privacy: [],
        illegal: [],
      },
      domainPolicies: [],
    },
    debug: {
      saveTrace: true,
      saveScreenshotsOnFailure: true,
    },
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
        downloadAttachments: true,
        receiveDir: join(getDefaultAppBaseDir(), 'feishuReceive'),
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
