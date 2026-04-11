import chalk from 'chalk';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';
import * as os from 'os';
import { configManager } from '../core/config.js';
import { createMemoryManager, MemoryManager } from '../core/memory.js';
import { createEnhancedMemoryManager, EnhancedMemoryManager } from '../core/memory-enhanced.js';
import { createSkillManager } from '../core/skills.js';
import { OllamaClient } from '../ollama/client.js';
import { LLMFactory } from '../llm/factory.js';
import type { LLMProvider, LLMProviderInterface } from '../llm/types.js';
import { HybridClient } from '../llm/providers/hybrid.js';
import { DeepSeekRouterClient } from '../llm/providers/deepseek-router.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
import { Agent, createAgent } from '../core/agent.js';
import type { AgentEvent } from '../core/agent.js';
import { createAgentFactory, createOrganization, loadOrganization, createReceptionAgent, ReceptionAgent } from '../core/organization/index.js';
import type { Organization } from '../core/organization/index.js';
import { createAgentCat, AgentCat } from '../core/companion/index.js';
import { UserProfileManager, userProfileManager } from '../core/user-profile.js';
import { ContentModerator, contentModerator } from '../core/content-moderator.js';
import { createDirectActionRouter, DirectActionRouter } from '../core/direct-action-router.js';
import { IntentResolver } from '../core/intent-resolver.js';
import { parseOnboardingInput } from '../core/onboarding.js';
import { PermissionManager, permissionManager } from '../core/permission-manager.js';
import { createPlanner } from '../core/planner.js';
import { createTaskManager, TaskManager } from '../core/task-manager.js';
import { createCronManager, CronManager } from '../core/cron-manager.js';
import { createMemoryProvider, type MemoryProvider } from '../core/memory-provider.js';
import { progressTracker } from '../utils/progress.js';
import { printSuccess, printError, printWarning, printInfo, createStreamingOutput, StreamingOutput } from '../utils/output.js';
import { normalizeDisplayText } from '../utils/text-repair.js';
import { getArtifactOutputDir, getDesktopPath } from '../utils/path-resolution.js';
import { extractObsidianVaultPath } from '../core/obsidian-config.js';
import { LarkRelayAgent, type LarkRelayMessage, type LarkRelayStatus } from '../lark/relay-agent.js';
import type { AgentInteractionMode, FunctionMode, LarkRelayConfig } from '../types/index.js';
import { BackgroundDaemonManager, type BackgroundDaemonStatus } from '../core/background-daemon.js';
import { APP_VERSION, buildCliLogo, getFullHelpText, getQuickHelpText, isFullHelpShortcut, isQuickHelpShortcut } from './cli-shell-text.js';
import { TerminalConfigEditor } from './config-editor.js';
import { SplitScreenRenderer } from './split-screen.js';
import { runBackgroundDaemonService } from './daemon-service.js';
import * as readline from 'readline';
import { BrowserWorkflowService } from '../browser-agent/workflows/browser-workflow-service.js';
import { buildBrowserWorkflowQuickFixDrafts } from '../browser-agent/workflows/browser-workflow-quick-fix.js';
import { buildTaskContextJsonPayload, createAgentCheckpoint, createAgentGraphState, deriveCheckpointFromUnifiedAgentState } from '../core/agent-graph-state.js';
import { createOllamaVisionService } from '../core/ollama-vision-service.js';
import { SessionTaskStackManager } from '../core/session-task-stack-manager.js';
import type { AgentGraphState, AgentTaskBindingSnapshot } from '../types/index.js';
import { ChatRouter } from '../core/chat-router.js';
import { TaskExecutorService } from '../core/task-executor-service.js';

const logo = buildCliLogo();

interface CLIOptions {
  ensureBackgroundDaemon?: boolean;
  runLocalCronScheduler?: boolean;
}

interface PendingLarkInlineReply {
  chatId?: string;
  senderId?: string;
  resolve: (answer: string) => void;
}

export class CLI {
  private static readonly SLASH_COMMANDS = [
    '/?', '/help', '/h', '/quit', '/exit', '/bye', '/q',
    '/clear', '/cls', '/history', '/hi', '/tools', '/t',
    '/config', '/c', '/model', '/m', '/workspace', '/w',
    '/reset', '/r', '/new', '/sessions', '/load', '/mcp',
    '/lsp', '/skill', '/skills', '/org', '/team', '/cat',
    '/progress', '/p', '/task-context', '/memory', '/templates', '/profile', '/news', '/relay', '/browser', '/mode', '/function', '/agent-mode', '/split',
    '/vision',
    '/wipe', '/perm', '/permission', '/cron', '/daemon',
  ];

  private agent?: Agent;
  private llm?: LLMProviderInterface;
  private currentProvider = 'ollama';
  private mcpManager: MCPManager;
  private lspManager: LSPManager;
  private memoryManager!: MemoryManager;
  private sandbox!: Sandbox;
  private skillManager: ReturnType<typeof createSkillManager>;
  private enhancedMemory?: EnhancedMemoryManager;
  private memoryProvider?: MemoryProvider;
  private builtInTools?: BuiltInTools;
  private workspace: string;
  private running = true;
  private cmdHistory: string[] = [];
  private historyIndex = -1;
  private streamingOutput?: StreamingOutput;
  private organization?: Organization;
  private organizationMode = false;
  private receptionAgent?: ReceptionAgent;
  private agentCat?: AgentCat;
  private userProfile?: UserProfileManager;
  private moderator?: ContentModerator;
  private permissionMgr?: PermissionManager;
  private directActionRouter?: DirectActionRouter;
  private intentResolver?: IntentResolver;
  private taskManager?: TaskManager;
  private cronManager?: CronManager;
  private isFirstInteraction = true;
  private awaitingOnboardingInput = false;
  private permissionHandlerSetup = false;
  private activePlannedTaskId?: string;
  private activeProgressDisplayTaskId?: string;
  private appBaseDir: string;
  private inputHistoryPath: string;
  private newsOutputDir: string;
  private sessionTaskStackDir: string;
  private larkRelay?: LarkRelayAgent;
  private inputQueue: Promise<void> = Promise.resolve();
  private readonly options: Required<CLIOptions>;
  private backgroundDaemon?: BackgroundDaemonManager;
  private stopBackgroundDaemonOnExit = false;
  private currentInputMode: 'cli' | 'feishu' = 'cli';
  private splitScreen?: SplitScreenRenderer;
  private lastProcessLogMessage = '';
  private readonly sessionTaskStack = new SessionTaskStackManager();
  private readonly chatRouter = new ChatRouter();
  private pendingDirectActionPreamble?: string;
  private lastGraphState?: AgentGraphState;
  private activeLarkReplyTarget?: LarkRelayMessage;
  private pendingLarkInlineReply?: PendingLarkInlineReply;

  constructor(options: CLIOptions = {}) {
    this.options = {
      ensureBackgroundDaemon: options.ensureBackgroundDaemon ?? false,
      runLocalCronScheduler: options.runLocalCronScheduler ?? false,
    };
    this.mcpManager = new MCPManager();
    this.lspManager = new LSPManager();
    this.skillManager = createSkillManager();
    this.workspace = process.cwd();
    this.appBaseDir = configManager.get('appBaseDir') || path.join(os.homedir(), '.ai-agent-cli');
    this.inputHistoryPath = path.join(this.appBaseDir, 'input-history.json');
    this.newsOutputDir = path.join(this.appBaseDir, 'outputs', 'tencent-news');
    this.sessionTaskStackDir = path.join(this.appBaseDir, 'runtime', 'session-task-stack');
    this.backgroundDaemon = new BackgroundDaemonManager(this.appBaseDir);
  }

  async initialize(): Promise<void> {
    console.log(chalk.cyan(logo));
    console.log(chalk.gray('Initializing...\n'));
    
    const config = configManager.getAgentConfig();
    this.workspace = config.workspace || this.workspace;
    this.applyGlobalPathsFromConfig(config);

    this.memoryManager = createMemoryManager();
    await this.memoryManager.initialize();
    printSuccess('Memory manager ready');
    const discardedPinnedSessionId = this.memoryManager.consumeDiscardedPinnedSessionId();
    if (discardedPinnedSessionId) {
      printInfo(`检测到跨天旧会话，已自动新建会话: ${discardedPinnedSessionId} -> ${this.memoryManager.getCurrentSessionId()}`);
    }
    await this.loadPersistedSessionTaskStack();

    await this.loadInputHistory();

    this.enhancedMemory = createEnhancedMemoryManager();
    await this.enhancedMemory.initialize();
    printSuccess('Enhanced memory ready');

    this.userProfile = userProfileManager;
    await this.userProfile.initialize();
    const profile = this.userProfile.getProfile();
    if (profile) {
      this.isFirstInteraction = false;
      this.awaitingOnboardingInput = false;
      printSuccess('User profile loaded');
      this.syncProfileToEnhancedMemory();
    } else {
      this.isFirstInteraction = true;
      this.awaitingOnboardingInput = true;
    }

    this.moderator = contentModerator;

    this.permissionMgr = permissionManager;
    await this.permissionMgr.initialize();
    this.setupPermissionHandler();

    this.taskManager = createTaskManager();
    await this.taskManager.initialize();
    printSuccess('Task manager ready');

    this.cronManager = createCronManager();
    await this.cronManager.initialize();
    printSuccess('Cron manager ready');

    if (this.options.ensureBackgroundDaemon && !this.options.runLocalCronScheduler) {
      await this.ensureBackgroundCronDaemon(true);
    }

    this.currentProvider = config.defaultProvider || 'ollama';
    
    this.llm = this.createLLMClient(config);
    this.intentResolver = new IntentResolver(this.llm);
    
    let connected = false;
    let connectionError = '';
    
    try {
      connected = await Promise.race([
        this.llm.checkConnection(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
      ]);
    } catch (error) {
      connectionError = error instanceof Error ? error.message : String(error);
      printWarning(`Failed to connect to ${this.currentProvider}: ${connectionError}`);
    }
    
    if (!connected) {
      if (this.currentProvider === 'ollama') {
        console.log(chalk.yellow('\n⚠️  Ollama 未连接'));
        console.log(chalk.cyan('  ┌─────────────────────────────────────────────┐'));
        console.log(chalk.cyan('  │  请在另一个终端运行以下命令启动 Ollama:       │'));
        console.log(chalk.cyan('  │                                             │'));
        console.log(chalk.cyan('  │  ') + chalk.bold('ollama serve') + chalk.cyan('                              │'));
        console.log(chalk.cyan('  │                                             │'));
        console.log(chalk.cyan('  │  如未安装 Ollama，请访问:                  │'));
        console.log(chalk.cyan('  │  https://ollama.ai                         │'));
        console.log(chalk.cyan('  │                                             │'));
        console.log(chalk.cyan('  │  下载模型: ollama pull qwen3.5:9b         │'));
        console.log(chalk.cyan('  └─────────────────────────────────────────────┘\n'));
      } else {
        console.log(chalk.yellow(`\n⚠️  ${this.currentProvider} 未连接: ${connectionError}`));
      }
    } else {
      printSuccess(`Connected to ${this.currentProvider} (${this.llm.getModel()})`);
    }

    const sandboxConfig = config.sandbox || { enabled: true, timeout: 30000 };
    if (!sandboxConfig.allowedPaths) {
      sandboxConfig.allowedPaths = [config.workspace || process.cwd()];
    }
    const artifactOutputDir = getArtifactOutputDir({
      workspace: this.workspace,
      artifactOutputDir: config.artifactOutputDir,
      documentOutputDir: config.documentOutputDir,
    });
    const desktopPath = getDesktopPath();
    const cronStoreDir = this.cronManager.getStoreDir();
    const obsidianVaultPath = extractObsidianVaultPath(config);
    for (const extraPath of [artifactOutputDir, desktopPath, cronStoreDir, obsidianVaultPath].filter(Boolean) as string[]) {
      if (!sandboxConfig.allowedPaths.includes(extraPath)) {
        sandboxConfig.allowedPaths.push(extraPath);
      }
    }
    const permConfig = this.permissionMgr.getConfig();
    for (const allowedPath of permConfig.allowedPaths) {
      if (!sandboxConfig.allowedPaths.includes(allowedPath)) {
        sandboxConfig.allowedPaths.push(allowedPath);
      }
    }
    this.sandbox = new Sandbox(sandboxConfig);
    await this.sandbox.initialize();
    printSuccess('Sandbox ready');
    printInfo(`当前 artifact 输出目录: ${artifactOutputDir}`);

    await this.skillManager.initialize();
    const skills = await this.skillManager.listSkills();
    if (skills.length > 0) {
      printSuccess(skills.length + ' skills loaded');
    }

    this.builtInTools = new BuiltInTools(this.sandbox, this.lspManager, {
      mcpManager: this.mcpManager,
      taskManager: this.taskManager,
      cronManager: this.cronManager,
      workspace: this.workspace,
      config: config as unknown as Record<string, unknown>,
    });
    printSuccess(this.builtInTools.getTools().length + ' built-in tools');
    this.configureCronRuntime();

    if (config.mcp && config.mcp.length > 0) {
      console.log(chalk.gray('Connecting to MCP servers...'));
      for (const mcpConfig of config.mcp) {
        try {
          await this.mcpManager.addServer(mcpConfig);
          printSuccess('MCP server: ' + mcpConfig.name);
        } catch (error) {
          printError('MCP server ' + mcpConfig.name + ': ' + (error instanceof Error ? error.message : String(error)));
        }
      }
    }

    if (this.enhancedMemory) {
      this.memoryProvider = createMemoryProvider({
        enhancedMemory: this.enhancedMemory,
        mcpManager: this.mcpManager,
        config: config.memory,
        skillManager: this.skillManager,
      });
      printSuccess(`Memory provider ready (${this.memoryProvider.backend})`);
      await this.memoryProvider.store({
        kind: 'project',
        key: 'artifact_output_dir',
        title: 'artifact_output_dir',
        content: artifactOutputDir,
      });
    }

    this.directActionRouter = createDirectActionRouter({
      builtInTools: this.builtInTools,
      skillManager: this.skillManager,
      permissionManager: this.permissionMgr!,
      workspace: this.workspace,
      config,
      getConversationMessages: () => this.agent?.getMessages() || this.memoryManager.getMessages(),
      memoryProvider: this.memoryProvider,
      intentResolver: this.intentResolver,
      onConversationPreamble: (message) => this.showDirectActionPreamble(message),
    });

    if (config.lsp && config.lsp.length > 0) {
      console.log(chalk.gray('Starting LSP servers...'));
      for (const lspConfig of config.lsp) {
        try {
          await this.lspManager.addServer(lspConfig, `file://${this.workspace}`);
          printSuccess('LSP server: ' + lspConfig.name);
        } catch (error) {
          printError('LSP server ' + lspConfig.name + ': ' + (error instanceof Error ? error.message : String(error)));
        }
      }
    }

    this.agent = createAgent({
      llm: this.llm!,
      mcpManager: this.mcpManager,
      lspManager: this.lspManager,
      sandbox: this.sandbox,
      builtInTools: this.builtInTools,
      skillManager: this.skillManager,
      maxIterations: config.maxIterations,
      maxToolCallsPerTurn: config.maxToolCallsPerTurn,
      planner: createPlanner({ llm: this.llm!, memoryProvider: this.memoryProvider, skillManager: this.skillManager }),
      intentResolver: this.intentResolver,
      memoryProvider: this.memoryProvider,
      config: config as unknown as Record<string, unknown>,
    });

    const restoredMessages = this.memoryManager.getMessages();
    if (restoredMessages.length > 0) {
      this.agent.setMessages(restoredMessages);
      await this.memoryProvider?.syncSession(restoredMessages);
      printInfo(`Resumed session: ${this.memoryManager.getCurrentSessionId()} (${restoredMessages.length} messages)`);
    }

    if (this.awaitingOnboardingInput) {
      await this.showWelcomeQuestions();
    }

    await this.restartLarkRelay(config);

    printInfo(`当前模式: input=${this.currentInputMode}, function=${this.getFunctionMode()}`);
    console.log(chalk.gray('\nType /? for commands, or ask me anything!\n'));
  }

  private setupPermissionHandler(): void {
    if (this.permissionHandlerSetup || !this.permissionMgr) return;
    this.permissionHandlerSetup = true;

    this.permissionMgr.onPermissionRequest(async (request) => {
      const prompt = this.permissionMgr!.showPermissionRequest(request);
      console.log(prompt);
      await this.sendPermissionPromptToActiveLarkTarget(prompt);

      const answer = await this.requestInlineApprovalAnswer();
      const result = this.permissionMgr!.parsePermissionAnswer(answer);

      if (result.granted) {
        if (result.permanent) {
          this.permissionMgr!.grantPermission(request.type, request.resource);
        } else if (result.expiresInMs) {
          this.permissionMgr!.grantPermission(request.type, request.resource, result.expiresInMs);
        }
      }

      return result.granted;
    });
  }

  async run(): Promise<void> {
    while (this.running) {
      try {
        const input = await this.prompt();
        if (!input) continue;

        await this.enqueueInput(input, 'cli', undefined, true);
      } catch (error) {
        if (error instanceof Error && error.message === 'Exit') {
          break;
        }
        printError('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  private prompt(): Promise<string> {
    const promptLabel = this.getPromptLabel();
    if (this.splitScreen?.isActive()) {
      return this.splitScreen.prompt(promptLabel).then((answer) => {
        const trimmed = answer.trim();
        if (trimmed.length > 0) {
          this.recordHistory(trimmed);
        }
        return trimmed;
      });
    }

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        historySize: 200,
        removeHistoryDuplicates: false,
        completer: (line: string) => this.completeInput(line),
      });

      const historyEnabledRl = rl as unknown as { history: string[] };
      historyEnabledRl.history = this.getReadlineHistory();
      rl.on('close', () => {});
      rl.question(chalk.blue(promptLabel), (answer) => {
        rl.close();

        const trimmed = answer.trim();
        if (trimmed.length > 0) {
          this.recordHistory(trimmed);
        }

        resolve(trimmed);
      });
    });
  }

  private getPromptLabel(): string {
    return `[${this.currentInputMode}|${this.getFunctionMode()}] > `;
  }

  private completeInput(line: string): [string[], string] {
    if (!line.startsWith('/')) {
      return [[], line];
    }

    const candidates = this.getCompletionCandidates(line);
    const matches = candidates
      .filter(command => command.startsWith(line))
      .sort((left, right) => left.localeCompare(right));

    return [matches.length > 0 ? matches : candidates, line];
  }

  private getCompletionCandidates(line: string): string[] {
    const trimmed = line.trimStart();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const command = tokens[0] || '';

    if (tokens.length <= 1 && !trimmed.endsWith(' ')) {
      return CLI.SLASH_COMMANDS;
    }

    const providers = ['ollama', 'deepseek', 'kimi', 'glm', 'doubao', 'minimax', 'openai', 'claude', 'gemini', 'hybrid'];
    const staticCandidates: Record<string, string[]> = {
      '/config': ['/config', '/config edit', '/config update', '/config reload'],
      '/c': ['/c', '/c edit', '/c update', '/c reload'],
      '/mode': ['/mode', '/mode status', '/mode switch cli', '/mode switch feishu'],
      '/function': ['/function', '/function status', '/function switch workflow', '/function switch chat'],
      '/agent-mode': ['/agent-mode', '/agent-mode status', '/agent-mode switch workflow', '/agent-mode switch chat'],
      '/split': ['/split', '/split on', '/split off', '/split of', '/split status'],
      '/relay': ['/relay status', '/relay start', '/relay stop', '/relay reconnect'],
      '/model': ['/model', '/model switch', ...providers.map(provider => `/model switch ${provider}`)],
      '/m': ['/m', '/model', '/model switch', ...providers.map(provider => `/model switch ${provider}`)],
      '/mcp': ['/mcp list', '/mcp tools', '/mcp check', '/mcp check mempalace', '/mcp check lark', '/mcp reconnect lark', '/mcp check obsidian'],
      '/lsp': ['/lsp list', '/lsp status'],
      '/skill': ['/skill list', '/skill ls', '/skill candidates', '/skill drafts', '/skill todos', '/skill adopt', '/skill adopt-from-todo', '/skill install', '/skill add', '/skill uninstall', '/skill remove', '/skill enable', '/skill disable'],
      '/skills': ['/skills list', '/skills candidates', '/skills adopt', '/skills adopt-from-todo', '/skills install', '/skills uninstall', '/skills enable', '/skills disable'],
      '/org': ['/org view', '/org load', '/org mode', '/org workflow', '/org help'],
      '/team': ['/team view', '/team load', '/team mode', '/team workflow', '/team help'],
      '/memory': ['/memory long', '/memory short', '/memory clear'],
      '/profile': ['/profile view', '/profile set job', '/profile set purpose', '/profile set interests', '/profile personality', '/profile style'],
      '/perm': [
        '/perm view', '/perm grant', '/perm revoke', '/perm revokeall',
        '/perm group', '/perm group grant', '/perm group revoke',
        '/perm audit', '/perm trust', '/perm allow', '/perm deny', '/perm auto', '/perm ask',
      ],
      '/permission': [
        '/permission view', '/permission grant', '/permission revoke', '/permission revokeall',
        '/permission group', '/permission group grant', '/permission group revoke',
        '/permission audit', '/permission trust', '/permission allow', '/permission deny', '/permission auto', '/permission ask',
      ],
      '/browser': ['/browser open https://example.com', '/browser run https://example.com', '/browser run https://example.com @actions.json --headed', '/browser run https://example.com @actions.json --browser edge', '/browser help'],
      '/vision': ['/vision analyze ./images', '/vision analyze ./images ./captures 请总结这些图片内容', '/vision analyze ./a.png ./b.png --model minicpm-v --limit 8', '/vision help'],
      '/cron': ['/cron list', '/cron create', '/cron create-news', '/cron create-news-lark', '/cron create-weather-lark', '/cron create-morning-feishu', '/cron create-morning-feishu-group', '/cron start', '/cron stop', '/cron run', '/cron delete', '/cron run-due'],
      '/daemon': ['/daemon status', '/daemon start', '/daemon stop', '/daemon restart'],
      '/news': ['/news hot', '/news search', '/news morning', '/news evening', '/news save hot', '/news save search', '/news save morning', '/news save evening', '/news push morning --chat-id oc_xxx', '/news push hot --chat-id oc_xxx --limit 5', '/news output-dir', '/news help'],
      '/load': ['/load'],
      '/workspace': ['/workspace'],
    };

    return staticCandidates[command] || CLI.SLASH_COMMANDS;
  }

  private getReadlineHistory(): string[] {
    return [...this.cmdHistory].reverse();
  }

  private recordHistory(input: string): void {
    const lastEntry = this.cmdHistory[this.cmdHistory.length - 1];
    if (lastEntry === input) {
      this.historyIndex = this.cmdHistory.length - 1;
      return;
    }

    this.cmdHistory.push(input);
    if (this.cmdHistory.length > 200) {
      this.cmdHistory = this.cmdHistory.slice(-200);
    }
    this.historyIndex = this.cmdHistory.length - 1;
    this.saveInputHistory().catch(() => {});
  }

  private async loadInputHistory(): Promise<void> {
    try {
      const raw = await fs.readFile(this.inputHistoryPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.cmdHistory = parsed.filter(item => typeof item === 'string').slice(-200);
        this.historyIndex = this.cmdHistory.length - 1;
      }
    } catch {
      this.cmdHistory = [];
      this.historyIndex = -1;
    }
  }

  private async saveInputHistory(): Promise<void> {
    await fs.mkdir(path.dirname(this.inputHistoryPath), { recursive: true });
    await fs.writeFile(this.inputHistoryPath, JSON.stringify(this.cmdHistory.slice(-200), null, 2), 'utf-8');
  }

  private async enqueueInput(
    input: string,
    source: 'cli' | 'lark',
    relayMessage?: LarkRelayMessage,
    allowCommands: boolean = false,
  ): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    const task = this.inputQueue.then(async () => {
      if (source === 'lark') {
        const sourceParts = [
          relayMessage?.chatId ? `chat=${relayMessage.chatId}` : undefined,
          relayMessage?.senderId ? `sender=${relayMessage.senderId}` : undefined,
        ]
          .filter(Boolean)
          .join(' | ');
        console.log();
        printInfo(`[Lark Relay] 收到手机端消息${sourceParts ? ` (${sourceParts})` : ''}`);
        console.log(chalk.gray(trimmed));

        if (this.currentInputMode !== 'feishu') {
          printInfo('[Mode] 当前为 cli 模式，已忽略这条飞书消息。');
          return;
        }
      }

      if (allowCommands && trimmed.startsWith('/')) {
        await this.handleCommand(trimmed);
        return;
      }

      if (source === 'cli' && this.currentInputMode === 'feishu') {
        printInfo('当前为 feishu 模式，命令行仅接收 / 命令。输入 /mode switch cli 可切回命令行交互。');
        return;
      }

      const previousLarkReplyTarget = this.activeLarkReplyTarget;
      this.activeLarkReplyTarget = source === 'lark' ? relayMessage : undefined;
      try {
        if (this.awaitingOnboardingInput) {
          await this.handleOnboardingInput(trimmed);
          return;
        }

        await this.handleMessage(trimmed);
      } finally {
        this.activeLarkReplyTarget = previousLarkReplyTarget;
      }
    });

    this.inputQueue = task.catch(() => {});
    await task;
  }

  private async restartLarkRelay(config: ReturnType<typeof configManager.getAgentConfig>, forceStart = false): Promise<boolean> {
    await this.stopLarkRelay();

    if (!forceStart && this.currentInputMode !== 'feishu') {
      return false;
    }

    const relayConfig = forceStart
      ? this.buildModeRelayConfig(config)
      : config.notifications?.lark?.relay;
    if (!relayConfig?.enabled || relayConfig.autoSubscribe === false) {
      return false;
    }

    this.larkRelay = new LarkRelayAgent(relayConfig);
    this.larkRelay.on('started', (summary: string) => {
      printSuccess(`Lark relay subscribed (${summary})`);
    });
    this.larkRelay.on('stderr', (message: string) => {
      if (!relayConfig.quiet) {
        printInfo(`[Lark Relay] ${message}`);
      }
    });
    this.larkRelay.on('stopped', (detail: string) => {
      printInfo(`[Lark Relay] stopped (${detail})`);
    });
    this.larkRelay.on('error', (error: Error) => {
      printWarning(`[Lark Relay] ${error.message}`);
    });
    this.larkRelay.on('message', (message: LarkRelayMessage) => {
      void (async () => {
        const enrichedMessage = await this.larkRelay?.materializeMessageResources(message) || message;
        const forwardedText = enrichedMessage.content.trim();
        if (!forwardedText) {
          return;
        }
        if (this.consumePendingLarkInlineReply(forwardedText, enrichedMessage)) {
          return;
        }
        await this.enqueueInput(forwardedText, 'lark', enrichedMessage, relayConfig.allowCommands === true);
      })();
    });

    try {
      await this.larkRelay.start();
      if (!this.larkRelay.isRunning()) {
        throw new Error('Lark relay exited shortly after startup');
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/another event \+subscribe instance is already running/i.test(message)) {
        printWarning('[Lark Relay] 检测到已有 event +subscribe 实例占用飞书长连接。请先关闭旧订阅进程，再让当前 CLI 接管手机端消息。');
      } else if (/exited shortly after startup/i.test(message)) {
        printWarning('[Lark Relay] 订阅进程启动后立即退出，当前不会自动接管飞书输入。常见原因是已有旧的 event +subscribe 实例仍在运行。');
      } else {
        printWarning(`[Lark Relay] subscribe failed: ${message}`);
      }
      await this.stopLarkRelay();
      return false;
    }
  }

  private async stopLarkRelay(): Promise<void> {
    if (!this.larkRelay) {
      return;
    }

    const relay = this.larkRelay;
    this.larkRelay = undefined;
    relay.removeAllListeners();
    await relay.stop();
  }

  private async handleModeCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase() || 'status';

    switch (subcommand) {
      case 'status':
        await this.showInputModeStatus();
        break;
      case 'switch': {
        const target = args[1]?.toLowerCase();
        if (target !== 'cli' && target !== 'feishu') {
          printInfo('用法: /mode status | /mode switch <cli|feishu>');
          return;
        }
        await this.switchInputMode(target);
        break;
      }
      default:
        printInfo('用法: /mode status | /mode switch <cli|feishu>');
        break;
    }
  }

  private async handleFunctionCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase() || 'status';

    switch (subcommand) {
      case 'status':
        this.showFunctionModeStatus();
        break;
      case 'switch': {
        const target = args[1]?.toLowerCase();
        if (target !== 'workflow' && target !== 'chat') {
          printInfo('用法: /function status | /function switch <workflow|chat>');
          return;
        }
        await this.switchFunctionMode(target);
        break;
      }
      default:
        printInfo('用法: /function status | /function switch <workflow|chat>');
        break;
    }
  }

  private async handleSplitCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase() || 'status';

    switch (subcommand) {
      case 'status':
        printInfo(`当前 split 状态: ${this.splitScreen?.isActive() ? 'on' : 'off'}`);
        break;
      case 'on':
        this.enableSplitMode();
        break;
      case 'off':
      case 'of':
        this.disableSplitMode();
        break;
      default:
        printInfo('用法: /split status | /split on | /split off');
        break;
    }
  }

  private enableSplitMode(): void {
    if (this.splitScreen?.isActive()) {
      printInfo('split 已开启。');
      return;
    }

    const renderer = new SplitScreenRenderer();
    renderer.open();
    this.splitScreen = renderer;
    console.log(chalk.cyan(logo));
    printSuccess('Split view enabled: 左侧显示输入与结果，右侧显示 Agent 处理过程。');
  }

  private disableSplitMode(): void {
    if (!this.splitScreen?.isActive()) {
      printInfo('split 当前未开启。');
      return;
    }

    this.splitScreen.close();
    this.splitScreen = undefined;
    console.clear();
    console.log(chalk.cyan(logo));
    printSuccess('Split view disabled');
  }

  private writeProcessLog(message: string): void {
    const repaired = normalizeDisplayText(message);
    const normalized = repaired.trim();
    if (!normalized || normalized === this.lastProcessLogMessage) {
      return;
    }
    this.lastProcessLogMessage = normalized;

    if (this.splitScreen?.isActive()) {
      this.splitScreen.appendRight(repaired);
      return;
    }

    console.log(repaired);
  }

  private formatProcessEventContent(content: string | undefined, fallback: string): string {
    const normalized = normalizeDisplayText(content || '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return fallback;
    }

    if (/^generating response/i.test(normalized)) {
      return '正在生成响应';
    }

    return normalized;
  }

  private async showInputModeStatus(): Promise<void> {
    console.log(chalk.bold('\nInput Mode\n'));
    console.log(`Current: ${this.currentInputMode}`);
    console.log(`CLI Input: ${this.currentInputMode === 'cli' ? 'enabled' : 'commands only'}`);
    console.log(`Feishu Input: ${this.currentInputMode === 'feishu' ? 'enabled' : 'disabled'}`);

    const relayStatus = await this.getRelayStatusAgent().getStatus();
    console.log(`Relay Running: ${relayStatus.running ? 'yes' : 'no'}`);
    if (relayStatus.externalOccupancy) {
      printWarning('[Mode] 检测到外部 event +subscribe 实例占用当前飞书长连接。');
    }
    console.log();
  }

  private showFunctionModeStatus(): void {
    const mode = this.getFunctionMode();
    const routingConfig = configManager.get('functionRouting');
    console.log(chalk.bold('\nFunction Mode\n'));
    console.log(`Current: ${mode}`);
    console.log(`Route: ${mode === 'workflow'
      ? 'workflow-first orchestration / direct action / checkpoint resume'
      : 'chat-first interaction with optional auto-switch back to workflow'}`);
    if (mode === 'workflow') {
      console.log('Behavior: default workflow mode; task execution is prioritized.');
    }
    if (mode === 'chat') {
      console.log('Behavior: explicit chat mode; when configured, saying you want workflow will auto-switch back.');
    }
    console.log(`Prefer Workflow: ${routingConfig?.preferWorkflow ? 'yes' : 'no'}`);
    console.log(`Chat -> Workflow Auto Switch: ${routingConfig?.allowAutoSwitchFromChatToWorkflow ? 'yes' : 'no'}`);
    console.log(`Pending Workflow State: ${this.sessionTaskStack.getCheckpoint() ? 'yes' : 'no'}`);
    console.log();
  }

  private async switchInputMode(target: 'cli' | 'feishu'): Promise<void> {
    if (target === this.currentInputMode) {
      printInfo(`当前已经是 ${target} 模式。`);
      return;
    }

    if (target === 'cli') {
      await this.stopLarkRelay();
      this.currentInputMode = 'cli';
      printSuccess('已切换到 cli 模式：命令行恢复接收普通需求，飞书输入已断开。');
      return;
    }

    const previousMode = this.currentInputMode;
    this.currentInputMode = 'feishu';

    const config = configManager.getAgentConfig();
    const started = await this.restartLarkRelay(config, true);
    if (!started) {
      this.currentInputMode = previousMode;
      printWarning('切换到 feishu 模式失败：当前未成功接管飞书订阅，仍保持 cli 模式。');
      return;
    }

    printSuccess('已切换到 feishu 模式：Agent 现在接收手机端飞书消息，命令行仅接收 / 命令。');
  }

  private async switchFunctionMode(target: FunctionMode, options: { resetTaskState?: boolean; announce?: boolean } = {}): Promise<void> {
    const current = this.getFunctionMode();
    if (current === target) {
      printInfo(`当前已经是 ${target} 模式。`);
      return;
    }

    const resetTaskState = options.resetTaskState ?? true;
    const announce = options.announce ?? true;
    const hadPendingInteraction = Boolean(this.agent?.getConfirmationStatus()?.pending);
    if (resetTaskState && hadPendingInteraction && this.agent) {
      this.agent.clearPendingInteraction();
    }

    if (resetTaskState) {
      this.sessionTaskStack.clear();
      this.lastGraphState = undefined;
      await this.persistSessionTaskStack();
    }

    configManager.set('functionMode', target);
    configManager.set('agentInteractionMode', target === 'chat' ? 'chat' : 'task');
    await configManager.savePartial('functionMode', target);

    if (announce) {
      printSuccess(`已切换到 ${target} 模式。`);
      if (target === 'chat') {
        printInfo('chat 模式会优先走对话路径；如果你明确说要切回 workflow，会自动切回去。');
      } else {
        printInfo('workflow 是默认模式，会优先走 direct action、checkpoint 和计划执行链路。');
        printInfo('进入计划后仍会先请求确认，再开始执行，避免误判时擅自开跑。');
      }
      if (resetTaskState && hadPendingInteraction) {
        printInfo('已清理未完成的待确认/待恢复任务状态，避免跨模式串线。');
      }
    }
  }

  private normalizeLegacyAgentModeArgs(args: string[]): string[] {
    if (args[0]?.toLowerCase() !== 'switch') {
      return args;
    }

    const target = args[1]?.toLowerCase();
    if (target === 'chat') {
      return ['switch', 'chat'];
    }
    if (target === 'task' || target === 'auto') {
      return ['switch', 'workflow'];
    }
    return args;
  }

  private getFunctionMode(): FunctionMode {
    const mode = configManager.get('functionMode');
    if (mode === 'chat' || mode === 'workflow') {
      return mode;
    }

    const legacyMode = configManager.get('agentInteractionMode');
    return legacyMode === 'chat' ? 'chat' : 'workflow';
  }

  private getAgentInteractionMode(): AgentInteractionMode {
    return this.getFunctionMode() === 'chat' ? 'chat' : 'task';
  }

  private buildModeRelayConfig(config: ReturnType<typeof configManager.getAgentConfig>): LarkRelayConfig {
    const relayConfig = config.notifications?.lark?.relay;
    return {
      ...relayConfig,
      enabled: true,
      autoSubscribe: relayConfig?.autoSubscribe ?? true,
      eventTypes: relayConfig?.eventTypes && relayConfig.eventTypes.length > 0
        ? relayConfig.eventTypes
        : ['im.message.receive_v1'],
      compact: relayConfig?.compact ?? true,
      quiet: relayConfig?.quiet ?? true,
      allowCommands: relayConfig?.allowCommands ?? false,
    };
  }

  private async handleRelayCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase() || 'status';

    switch (subcommand) {
      case 'status':
        await this.showRelayStatus();
        break;
      case 'start':
        await this.startLarkRelayFromCommand();
        break;
      case 'stop':
        await this.stopLarkRelayFromCommand();
        break;
      case 'reconnect':
        await this.reconnectLarkRelay();
        break;
      default:
        printInfo('用法: /relay status | /relay start | /relay stop | /relay reconnect');
        break;
    }
  }

  private async showRelayStatus(): Promise<void> {
    printInfo('[Lark Relay] 正在检测 relay 状态...');
    const relay = this.getRelayStatusAgent();
    const status = await relay.getStatus();

    console.log(chalk.bold('\nLark Relay Status:\n'));
    console.log(`  Enabled: ${status.enabled ? 'yes' : 'no'}`);
    console.log(`  Auto Subscribe: ${status.autoSubscribe ? 'yes' : 'no'}`);
    console.log(`  Running: ${status.running ? 'yes' : 'no'}`);
    console.log(`  Summary: ${status.summary || '(none)'}`);
    console.log(`  Current PID: ${status.currentPid || '(none)'}`);
    console.log(`  Managed PID: ${status.managedPid || '(none)'}`);
    console.log(`  External Occupancy: ${status.externalOccupancy ? 'yes' : 'no'}`);
    if (status.lastStartupError) {
      console.log(`  Last Startup Error: ${status.lastStartupError}`);
    }
    if (status.lastStopDetail) {
      console.log(`  Last Stop Detail: ${status.lastStopDetail}`);
    }

    if (status.subscribeProcesses.length > 0) {
      console.log(chalk.gray('\n  Subscribe Processes:'));
      for (const processInfo of status.subscribeProcesses) {
        console.log(`  - pid=${processInfo.pid} owner=${processInfo.owner} cmd=${processInfo.commandLine}`);
      }
    } else {
      console.log(chalk.gray('\n  Subscribe Processes: none'));
    }

    if (status.externalOccupancy) {
      printWarning('[Lark Relay] 检测到外部 event +subscribe 实例占用。当前 CLI 不会强抢长连接。');
    }

    console.log();
  }

  private async reconnectLarkRelay(): Promise<void> {
    if (this.currentInputMode !== 'feishu') {
      printInfo('[Lark Relay] 当前为 cli 模式。若要让 Agent 接管飞书输入，请使用 /mode switch feishu。');
      return;
    }

    const config = configManager.getAgentConfig();
    const relayConfig = this.buildModeRelayConfig(config);

    if (!relayConfig?.enabled) {
      printWarning('[Lark Relay] 当前配置未启用 relay。');
      return;
    }

    if (relayConfig.autoSubscribe === false) {
      printWarning('[Lark Relay] relay 已启用，但 autoSubscribe=false；当前不会自动订阅。');
      return;
    }

    const relay = this.getRelayStatusAgent();
    const before = await relay.getStatus();

    this.printRelayCommandSummary(before, 'reconnect');

    const confirmed = await this.confirmRelayReconnect(before);
    if (!confirmed) {
      printInfo('[Lark Relay] 已取消重连。');
      return;
    }

    await this.restartLarkRelay(config);

    const after = await this.getRelayStatusAgent().getStatus();
    if (after.running) {
      printSuccess('[Lark Relay] 重连完成，当前 CLI 已接管订阅。');
      return;
    }

    if (after.externalOccupancy) {
      printWarning('[Lark Relay] 重连后仍检测到外部实例占用，当前 CLI 尚未接管订阅。');
      return;
    }

    printWarning('[Lark Relay] 重连已执行，但 relay 仍未处于运行状态。可先用 /relay status 查看详情。');
  }

  private async startLarkRelayFromCommand(): Promise<void> {
    if (this.currentInputMode !== 'feishu') {
      printInfo('[Lark Relay] 当前为 cli 模式。若要让 Agent 接管飞书输入，请使用 /mode switch feishu。');
      return;
    }

    const config = configManager.getAgentConfig();
    const relayConfig = this.buildModeRelayConfig(config);

    if (!relayConfig?.enabled) {
      printWarning('[Lark Relay] 当前配置未启用 relay。');
      return;
    }

    if (relayConfig.autoSubscribe === false) {
      printWarning('[Lark Relay] relay 已启用，但 autoSubscribe=false；当前不会自动订阅。');
      return;
    }

    const status = await this.getRelayStatusAgent().getStatus();
    if (status.running) {
      printInfo('[Lark Relay] 当前 relay 已在运行。');
      return;
    }

    this.printRelayCommandSummary(status, 'start');
    await this.restartLarkRelay(config);

    const after = await this.getRelayStatusAgent().getStatus();
    if (after.running) {
      printSuccess('[Lark Relay] 启动完成，当前 CLI 已接管订阅。');
      return;
    }

    if (after.externalOccupancy) {
      printWarning('[Lark Relay] 启动失败，仍检测到外部实例占用。');
      return;
    }

    printWarning('[Lark Relay] 启动已执行，但 relay 仍未运行。可先用 /relay status 查看详情。');
  }

  private async stopLarkRelayFromCommand(): Promise<void> {
    const status = await this.getRelayStatusAgent().getStatus();
    if (!status.running) {
      printInfo('[Lark Relay] 当前 CLI 没有正在运行的 relay。');
      if (status.externalOccupancy) {
        printWarning('[Lark Relay] 仍检测到外部 subscribe 实例；/relay stop 不会停止外部进程。');
      }
      return;
    }

    await this.stopLarkRelay();
    printSuccess('[Lark Relay] 当前 CLI relay 已停止。');
  }

  private getRelayStatusAgent(): LarkRelayAgent {
    if (this.larkRelay) {
      return this.larkRelay;
    }

    return new LarkRelayAgent(configManager.getAgentConfig().notifications?.lark?.relay);
  }

  private async confirmRelayReconnect(status: LarkRelayStatus): Promise<boolean> {
    const warnings: string[] = [];
    if (status.running) {
      warnings.push('当前 relay 正在运行，此操作会先断开再重连');
    }
    if (status.externalOccupancy) {
      warnings.push('检测到外部 subscribe 实例，未先关闭时重连大概率失败');
    }

    for (const warning of warnings) {
      printWarning(`[Lark Relay] ${warning}`);
    }

    const answer = await this.promptInline('确认执行 relay 重连？输入 yes 继续: ');
    return /^(yes|y|是|确认|继续|ok)$/i.test(answer.trim());
  }

  private printRelayCommandSummary(status: LarkRelayStatus, action: 'start' | 'reconnect'): void {
    const externalProcesses = status.subscribeProcesses.filter(processInfo => processInfo.owner === 'external');
    const actionLabel = action === 'start' ? '启动' : '重连';

    if (status.running) {
      printInfo(`[Lark Relay] 当前 relay 正在运行 (pid=${status.currentPid || 'unknown'})，将执行${actionLabel}。`);
    }

    if (externalProcesses.length > 0) {
      printWarning(`[Lark Relay] 检测到 ${externalProcesses.length} 个外部 subscribe 实例:`);
      for (const processInfo of externalProcesses) {
        printWarning(`[Lark Relay] external pid=${processInfo.pid} ${processInfo.commandLine}`);
      }
    }
  }

  private promptInline(question: string): Promise<string> {
    if (this.splitScreen?.isActive()) {
      return this.splitScreen.prompt(question);
    }

    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.question(chalk.blue(question), (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  private async requestInlineApprovalAnswer(): Promise<string> {
    const relayTarget = this.activeLarkReplyTarget;
    if (this.currentInputMode === 'feishu' && relayTarget?.chatId) {
      return new Promise((resolve) => {
        this.pendingLarkInlineReply = {
          chatId: relayTarget.chatId,
          senderId: relayTarget.senderId,
          resolve: (answer: string) => {
            this.pendingLarkInlineReply = undefined;
            resolve(answer);
          },
        };
      });
    }

    return this.promptInline('> ');
  }

  private consumePendingLarkInlineReply(answer: string, message: LarkRelayMessage): boolean {
    const pendingReply = this.pendingLarkInlineReply;
    if (!pendingReply) {
      return false;
    }

    if (pendingReply.chatId && message.chatId && pendingReply.chatId !== message.chatId) {
      return false;
    }

    if (pendingReply.senderId && message.senderId && pendingReply.senderId !== message.senderId) {
      return false;
    }

    pendingReply.resolve(answer);
    return true;
  }

  private async sendPermissionPromptToActiveLarkTarget(prompt: string): Promise<void> {
    const normalizedPrompt = this.stripAnsiText(prompt).trim();
    if (!normalizedPrompt) {
      return;
    }

    await this.sendAssistantReplyToActiveLarkTarget(normalizedPrompt);
  }

  private stripAnsiText(text: string): string {
    return text.replace(/\u001B\[[0-9;]*m/g, '');
  }

  private async handleCommand(input: string): Promise<void> {
    const [command, ...args] = input.slice(1).split(/\s+/);
    if (!command) return;

    switch (command.toLowerCase()) {
      case '?':
      case '？？':
        this.showQuickHelp();
        break;
      case 'help':
      case 'h':
        this.showHelp();
        break;
      case 'quit':
      case 'exit':
      case 'bye':
      case 'q':
        console.log(chalk.gray('Goodbye!'));
        this.running = false;
        break;
      case 'clear':
      case 'cls':
        console.clear();
        console.log(chalk.cyan(logo));
        break;
      case 'history':
      case 'hi':
        this.showHistory();
        break;
      case 'tools':
      case 't':
        this.showTools();
        break;
      case 'config':
      case 'c':
        if (args[0] === 'update' || args[0] === 'reload') {
          await this.reloadRuntimeConfig();
        } else if (args[0] === 'edit') {
          await this.editConfigFile();
        } else {
          this.showConfig();
        }
        break;
      case 'mode':
        await this.handleModeCommand(args);
        break;
      case 'function':
        await this.handleFunctionCommand(args);
        break;
      case 'agent-mode':
        await this.handleFunctionCommand(this.normalizeLegacyAgentModeArgs(args));
        break;
      case 'split':
        await this.handleSplitCommand(args);
        break;
      case 'relay':
        await this.handleRelayCommand(args);
        break;
      case 'model':
      case 'm':
        if (args[0] === 'switch' && args[1]) {
          await this.switchProvider(args[1]);
        } else if (args[0]) {
          await this.changeModel(args[0]);
        } else {
          this.showModels();
        }
        break;
      case 'workspace':
      case 'w':
        if (args[0]) {
          this.workspace = args[0];
          printSuccess('Workspace set to: ' + this.workspace);
        } else {
          console.log(chalk.gray('Current workspace: ' + this.workspace));
        }
        break;
      case 'reset':
      case 'r':
        this.agent?.clearMessages();
        this.memoryManager.clearHistory();
        this.sessionTaskStack.clear();
        this.lastGraphState = undefined;
        void this.persistSessionTaskStack();
        printSuccess('Conversation reset.');
        break;
      case 'new':
        this.createNewSession();
        break;
      case 'sessions':
        await this.showSessions();
        break;
      case 'load':
        await this.loadSession(args[0]);
        break;
      case 'mcp':
        await this.handleMCPCommand(args);
        break;
      case 'lsp':
        await this.handleLSPCommand(args);
        break;
      case 'skill':
      case 'skills':
        await this.handleSkillCommand(args);
        break;
      case 'org':
      case 'team':
        await this.handleOrgCommand(args);
        break;
      case 'cat':
        this.handleCatCommand(args);
        break;
      case 'progress':
      case 'p':
        this.showProgress();
        break;
      case 'task-context':
        this.showTaskContext(args);
        break;
      case 'memory':
        this.handleMemoryCommand(args);
        break;
      case 'templates':
        await this.showTemplates();
        break;
      case 'profile':
        this.handleProfileCommand(args);
        break;
      case 'wipe':
        await this.wipeUserData();
        break;
      case 'perm':
      case 'permission':
        this.handlePermissionCommand(args);
        break;
      case 'cron':
        await this.handleCronCommand(args);
        break;
      case 'daemon':
        await this.handleDaemonCommand(args);
        break;
      case 'browser':
        await this.handleBrowserCommand(args);
        break;
      case 'vision':
        await this.handleVisionCommand(args);
        break;
      case 'news':
        await this.handleNewsCommand(args);
        break;
      default:
        console.log(chalk.yellow(`Unknown command: ${command}. Type /? for help.`));
    }
  }

  private async handleMessage(input: string): Promise<void> {
    const moderationResult = this.moderator?.moderateUserInput(input);
    if (moderationResult) {
      if (!moderationResult.allowed) {
        console.log(chalk.red('\n⚠️ 消息已被拦截\n'));
        return;
      }
      
      if (moderationResult.message) {
        console.log(chalk.yellow('\n' + moderationResult.message + '\n'));
      }
      
      this.moderator?.recordWarning(input, Boolean(moderationResult.message));
    }

    this.userProfile?.recordInteraction();

    const taskBinding = this.sessionTaskStack.resolveInput(input);
    if (this.organizationMode && this.organization) {
      await this.handleOrganizationMessage(input);
      return;
    }

    if (!this.llm) {
      printError(`${this.currentProvider} not connected. Please check your configuration.`);
      return;
    }

    if (!this.agent) {
      printError('Agent not initialized.');
      return;
    }

    console.log();
    this.streamingOutput = createStreamingOutput({ color: 'cyan', speed: 0 });
    
    this.agent.setEventHandler((event: AgentEvent) => {
      switch (event.type) {
        case 'thinking':
          this.writeProcessLog(`· ${this.formatProcessEventContent(event.content, 'Thinking...')}`);
          break;
        case 'tool_call':
          this.writeProcessLog(`🔧 ${this.formatProcessEventContent(event.content, '调用工具')}`);
          break;
        case 'tool_result':
          this.writeProcessLog('[工具结果]');
          if (event.toolResult?.is_error) {
            const marker = this.isBrowserSafetyToolResult(event.toolResult) ? '⚠' : '✗';
            this.writeProcessLog(`${marker} ${this.getToolResultDisplayText(event.toolResult) || 'Tool execution failed'}`);
          } else {
            const output = this.getToolResultDisplayText(event.toolResult);
            if (output.length > 0) {
              this.writeProcessLog('--- 工具输出 START ---');
              this.writeProcessLog(output);
              this.writeProcessLog('--- 工具输出 END ---');
            } else {
              this.writeProcessLog('(无输出)');
            }
          }
          break;
        case 'plan_summary':
          this.trackPlannedTask(event);
          this.writeProcessLog(`📋 ${this.formatProcessEventContent(event.content, '已生成计划')}`);
          break;
        case 'plan_progress':
          this.updateTrackedTaskFromPlanEvent(event);
          if (event.planProgress) {
            const verb = event.planProgress.status === 'started'
              ? '开始'
              : event.planProgress.status === 'completed'
                ? '完成'
                : '失败';
            this.writeProcessLog(`🪜 [${verb}] ${event.planProgress.stepDescription}`);
          }
          break;
        case 'response':
          this.completeTrackedTaskIfNeeded(event.content);
          break;
        case 'memory_sync':
          if (event.memorySync?.status === 'archived') {
            this.writeProcessLog(`[MemPalace] ${event.content}`);
          } else if (event.memorySync?.status === 'failed') {
            this.writeProcessLog(`⚠ [MemPalace] ${event.content}`);
          }
          break;
        case 'skill_learning':
          this.writeProcessLog(`${event.content}。可用 /skill candidates 查看，/skill adopt ${event.skillLearning?.candidateName || '<name>'} 转正启用。`);
          if (event.skillLearning?.candidatePath) {
            this.writeProcessLog(`候选草稿: ${event.skillLearning.candidatePath}`);
          }
          break;
        case 'skill_learning_todo':
          this.writeProcessLog(`${event.content}。可用 /skill todos 查看待学习清单。`);
          break;
        case 'error':
          this.failTrackedTask(event.content);
          this.writeProcessLog(`✗ ${event.content}`);
          break;
      }
    });

    try {
      const functionMode = this.getFunctionMode();
      if (functionMode === 'chat') {
        await this.handleChatModeMessage(input, taskBinding);
      } else {
        await this.handleTaskModeMessage(input, taskBinding);
      }
    } catch (error) {
      this.sessionTaskStack.recordTask({
        channel: 'agent',
        title: input.trim(),
        input,
        effectiveInput: taskBinding.effectiveInput,
        category: 'agent',
        status: 'failed',
        metadata: {
          ...(taskBinding.isFollowUp && taskBinding.boundTask
            ? { boundTaskId: taskBinding.boundTask.id, boundTaskTitle: taskBinding.boundTask.title }
            : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      });
      this.setTaskCheckpoint('finalize', 'failed', taskBinding.effectiveInput, error instanceof Error ? error.message : String(error), {
        route: 'agent',
      });
      this.lastGraphState = undefined;
      await this.persistSessionTaskStack();
      printError('Failed to get response: ' + (error instanceof Error ? error.message : String(error)));
    }
    
    console.log();
  }

  private async handleChatModeMessage(input: string, taskBinding: ReturnType<SessionTaskStackManager['resolveInput']>): Promise<void> {
    const agent = this.agent;
    if (!agent) {
      throw new Error('Agent not initialized.');
    }

    const config = configManager.getAgentConfig();
    const trimmed = input.trim();
    const functionSwitch = this.parseFunctionSwitchRequest(trimmed);
    if (functionSwitch?.target === 'workflow' && config.functionRouting?.allowAutoSwitchFromChatToWorkflow !== false) {
      await this.switchFunctionMode('workflow', { resetTaskState: false, announce: false });
      if (functionSwitch.remainingInput) {
        printInfo('检测到你要切回 workflow，已自动切换并继续按任务执行。');
        const nextBinding = this.sessionTaskStack.resolveInput(functionSwitch.remainingInput);
        await this.handleTaskModeMessage(functionSwitch.remainingInput, nextBinding);
      } else {
        printSuccess('已自动切换到 workflow 模式。');
      }
      return;
    }

    const confirmationStatus = agent.getConfirmationStatus();

    if (confirmationStatus.pending) {
      if (agent.shouldTreatPendingInputAsNewRequest(trimmed)) {
        agent.clearPendingInteraction();
        printInfo('检测到这是一个新的独立请求，已跳过上一条待补充状态。');
      } else {
        const normalizedInput = trimmed.toLowerCase();
        const isConfirmed = normalizedInput === '是' || normalizedInput === 'yes' || normalizedInput === 'y';
        const isRejected = normalizedInput === '否' || normalizedInput === 'no' || normalizedInput === 'n';
        let result: string | undefined;

        if (confirmationStatus.type === 'plan_execution' && (isConfirmed || isRejected)) {
          printInfo(isConfirmed ? '确认执行计划...' : '取消执行计划');
          result = await agent.confirmAction(isConfirmed);
          if (isRejected) {
            this.failTrackedTask('用户取消执行计划');
          }
        } else {
          printInfo('继续处理待补充信息...');
          result = await agent.respondToPendingInput(trimmed);
        }

        this.memoryManager.setMessages(agent.getMessages());
        await this.memoryProvider?.syncSession(agent.getMessages());
        if (result) {
          console.log(chalk.green('\nAssistant: '));
          await this.streamResponse(result);
          await this.sendAssistantReplyToActiveLarkTarget(result);
        }
        await this.sendPendingInteractionPromptToActiveLarkTarget(result);
        return;
      }
    }

    const recallLimit = configManager.get('memory')?.recallLimit || 6;
    const memoryContext = await this.memoryProvider?.buildContext(input, recallLimit);
    agent.setRuntimeMemoryContext(memoryContext || '');

    let response = await agent.chat(input);
    const autoContinueOnToolLimit = config.autoContinueOnToolLimit ?? true;
    const maxContinuationTurns = config.maxContinuationTurns ?? 3;
    let continuationTurns = 0;

    while (autoContinueOnToolLimit && agent.needsContinuation() && continuationTurns < maxContinuationTurns) {
      continuationTurns++;
      printInfo(`当前响应达到单轮工具上限，自动继续第 ${continuationTurns}/${maxContinuationTurns} 轮...`);
      const continuedResponse = await agent.continueResponse();
      if (continuedResponse.trim()) {
        response = response.trim() ? `${response.trim()}\n${continuedResponse.trim()}` : continuedResponse.trim();
      }
    }

    if (agent.needsContinuation()) {
      printWarning('当前任务在自动续跑后仍未完成。可直接回复“继续”，或切到 task 模式获得完整 workflow 控制。');
    }

    this.memoryManager.setMessages(agent.getMessages());
    await this.memoryProvider?.syncSession(agent.getMessages());
    this.streamingOutput?.clear();
    this.printHybridRouteSummary();
    console.log(chalk.green('\nAssistant: '));
    await this.streamResponse(response || '(无输出)');
    await this.sendAssistantReplyToActiveLarkTarget(response || '(无输出)');
    await this.sendPendingInteractionPromptToActiveLarkTarget(response || '(无输出)');
  }

  private async handleAutoModeMessage(input: string, taskBinding: ReturnType<SessionTaskStackManager['resolveInput']>): Promise<void> {
    const agent = this.agent;
    if (!agent) {
      throw new Error('Agent not initialized.');
    }

    const decision = await this.chatRouter.route({
      input,
      taskBinding,
      checkpoint: this.sessionTaskStack.getCheckpoint(),
      agent,
      policy: configManager.get('functionRouting'),
    });

    this.reportAutoRouteDecision(decision);

    if (decision.target === 'task') {
      if (decision.reason === 'workflow_request' || decision.reason === 'complex_task') {
        printInfo('这个需求稍复杂，我先整理步骤并推进执行，过程中会持续和你同步。');
      }
      await this.handleTaskModeMessage(input, taskBinding);
      return;
    }

    await this.handleChatModeMessage(input, taskBinding);
  }

  private async handleTaskModeMessage(input: string, taskBinding: ReturnType<SessionTaskStackManager['resolveInput']>): Promise<void> {
    const agent = this.agent;
    if (!agent) {
      throw new Error('Agent not initialized.');
    }

    const config = configManager.getAgentConfig();
    const executor = new TaskExecutorService({
      agent,
      directActionRouter: this.directActionRouter,
      permissionManager: this.permissionMgr,
      autoContinueOnToolLimit: config.autoContinueOnToolLimit ?? true,
      maxContinuationTurns: config.maxContinuationTurns ?? 3,
      memoryProvider: this.memoryProvider,
      recallLimit: configManager.get('memory')?.recallLimit || 6,
      onStateChange: async (graphState) => {
        await this.captureGraphState(graphState);
      },
    });

    this.pendingDirectActionPreamble = undefined;
    const result = await executor.executeTurn(
      input,
      this.toAgentTaskBindingSnapshot(taskBinding),
      this.sessionTaskStack.getCheckpoint(),
    );

    if (result.executionContext.shouldAnnounceWorkflow && result.executionContext.mode !== 'pending_interaction') {
      printInfo(result.executionContext.summary);
    }
    this.reportTaskExecutionPolicy(result.executionPolicy);

    for (const notice of result.notices) {
      if (notice.level === 'warning') {
        printWarning(notice.message);
      } else {
        printInfo(notice.message);
      }
    }

    if (result.route === 'direct_action' && result.directAction?.handled) {
      const directActionMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: input }];
      if (this.pendingDirectActionPreamble) {
        directActionMessages.push({ role: 'assistant', content: this.pendingDirectActionPreamble });
      }
      directActionMessages.push({ role: 'assistant', content: result.output || '(无输出)' });
      agent.appendMessages(directActionMessages);
      this.memoryManager.setMessages(agent.getMessages());
      await this.memoryProvider?.syncSession(agent.getMessages());

      if (result.taskRecord) {
        this.sessionTaskStack.recordTask(result.taskRecord);
      }
      await this.captureGraphState(result.graphState);
      await this.persistSessionTaskStack();
      await this.archiveDirectActionResult(input, result.directAction);

      if (result.directAction.title) {
        console.log(chalk.cyan(result.directAction.title));
      }
      if (result.directAction.isError) {
        printError(result.output || 'Direct action failed');
      } else {
        console.log(chalk.green('\nAssistant: '));
        await this.streamResponse(result.output || '(无输出)');
        await this.sendAssistantReplyToActiveLarkTarget(result.output || '(无输出)');
      }
      await this.sendPendingInteractionPromptToActiveLarkTarget(result.output || '(无输出)');
      return;
    }

    this.memoryManager.setMessages(agent.getMessages());
    await this.memoryProvider?.syncSession(agent.getMessages());
    if (result.taskRecord) {
      this.sessionTaskStack.recordTask(result.taskRecord);
    }
    await this.captureGraphState(result.graphState);
    await this.persistSessionTaskStack();
    this.streamingOutput?.clear();
    this.printHybridRouteSummary();
    if (result.output) {
      console.log(chalk.green('\nAssistant: '));
      await this.streamResponse(result.output);
      await this.sendAssistantReplyToActiveLarkTarget(result.output);
    }
    await this.sendPendingInteractionPromptToActiveLarkTarget(result.output);
  }

  private reportAutoRouteDecision(decision: { target: 'chat' | 'task'; reason: string; intent?: string }): void {
    if (configManager.get('functionRouting')?.announceRouteDecisions === false || decision.reason === 'social_chat') {
      return;
    }

    const detail = `[Router] auto -> ${decision.target} | reason=${decision.reason}${decision.intent ? ` | intent=${decision.intent}` : ''}`;
    if (this.splitScreen?.isActive()) {
      this.writeProcessLog(detail);
      return;
    }

    printInfo(detail);
  }

  private reportTaskExecutionPolicy(policy: {
    toolBudget: { toolCallCount: number; maxToolCallsPerTurn: number; maxIterations: number; lastStopReason: string };
    permissionStrategy: string;
    checkpointResumeHint?: string;
  }): void {
    const detail = `[Workflow Policy] budget=${policy.toolBudget.toolCallCount}/${policy.toolBudget.maxToolCallsPerTurn} | iterations=${policy.toolBudget.maxIterations} | permissions=${policy.permissionStrategy}${policy.checkpointResumeHint ? ` | resume=${policy.checkpointResumeHint}` : ''}`;
    if (this.splitScreen?.isActive()) {
      this.writeProcessLog(detail);
      return;
    }

    printInfo(detail);
  }

  private parseFunctionSwitchRequest(input: string): { target: FunctionMode; remainingInput?: string } | null {
    const routing = configManager.get('functionRouting');
    const normalized = input.trim();
    if (!normalized) {
      return null;
    }

    const workflowRemaining = this.matchModeSwitchPrefix(normalized, routing?.workflowSwitchKeywords || []);
    if (workflowRemaining !== null) {
      return { target: 'workflow', remainingInput: workflowRemaining || undefined };
    }

    const chatRemaining = this.matchModeSwitchPrefix(normalized, routing?.chatSwitchKeywords || []);
    if (chatRemaining !== null) {
      return { target: 'chat', remainingInput: chatRemaining || undefined };
    }

    return null;
  }

  private matchModeSwitchPrefix(input: string, keywords: string[]): string | null {
    const normalized = input.trim();
    const lowered = normalized.toLowerCase();

    for (const keyword of keywords) {
      const loweredKeyword = keyword.trim().toLowerCase();
      if (!lowered.startsWith(loweredKeyword)) {
        continue;
      }

      return normalized.slice(keyword.length).replace(/^[\s,:，。；;、-]+/, '').trim();
    }

    return null;
  }

  private async streamResponse(text: string): Promise<void> {
    const normalizedText = normalizeDisplayText(text);
    if (this.splitScreen?.isActive()) {
      this.splitScreen.appendLeft(normalizedText);
      return;
    }

    const output = createStreamingOutput({ color: 'cyan', speed: 5 });
    await output.stream(normalizedText);
  }

  private printHybridRouteSummary(): void {
    if (this.llm instanceof HybridClient) {
      const route = this.llm.getLastRouteSnapshot();
      if (!route) {
        return;
      }

      const parts = [
        `target=${route.target}`,
        `provider=${route.providerName}`,
        `reason=${route.reason}`,
      ];

      if (route.cacheStatus !== 'bypass') {
        parts.push(`cache=${route.cacheStatus}`);
      }

      if (route.fallbackReason) {
        parts.push(`fallback=${route.fallbackReason}`);
      }

      if (this.splitScreen?.isActive()) {
        this.writeProcessLog(`[Hybrid] ${parts.join(' | ')}`);
      } else {
        printInfo(`[Hybrid] ${parts.join(' | ')}`);
      }
      return;
    }

    if (this.llm instanceof DeepSeekRouterClient) {
      const route = this.llm.getLastRouteSnapshot();
      if (!route) {
        return;
      }

      if (this.splitScreen?.isActive()) {
        this.writeProcessLog(`[DeepSeek] target=${route.target} | model=${route.model} | reason=${this.describeDeepSeekRouteReason(route.reason)}`);
      } else {
        printInfo(`[DeepSeek] target=${route.target} | model=${route.model} | reason=${this.describeDeepSeekRouteReason(route.reason)}`);
      }
    }
  }

  private describeDeepSeekRouteReason(reason: string): string {
    switch (reason) {
      case 'workflow_planning':
        return 'workflow_planning';
      case 'troubleshooting':
        return 'troubleshooting';
      case 'architecture_design':
        return 'architecture_design';
      case 'stock_analysis':
        return 'stock_analysis';
      case 'long_form_summary':
        return 'long_form_summary';
      default:
        return reason;
    }
  }

  private async showWelcomeQuestions(): Promise<void> {
    console.log(chalk.bold('\n👋 欢迎使用 coolAI！\n'));
    console.log(chalk.gray('为了更好地为您服务，请告诉我一些关于您的信息：\n'));
    
    console.log(chalk.cyan('1. 您的工作是？') + chalk.gray(' (如：学生、程序员、产品经理、设计师...)'));
    console.log(chalk.cyan('2. 您主要用 coolAI 来做什么？') + chalk.gray(' (如：编程、写文章、数据处理、聊天...)'));
    console.log(chalk.cyan('3. 您喜欢什么样的交流风格？') + chalk.gray(' (专业/友好/幽默/温柔/活力)\n'));
    
    console.log(chalk.gray('可以直接输入您的回答，例如：'));
    console.log(chalk.gray('  "我是程序员，主要用来写代码和调试bug，喜欢幽默风格"\n'));
    
    console.log(chalk.gray('或者输入 ') + chalk.cyan('/profile') + chalk.gray(' 稍后设置\n'));
  }

  private async handleOnboardingInput(input: string): Promise<void> {
    this.awaitingOnboardingInput = false;
    this.isFirstInteraction = false;

    const onboarding = parseOnboardingInput(input);
    if (!this.userProfile?.getProfile()) {
      if (onboarding) {
        await this.userProfile?.createProfile(onboarding);
        printSuccess('已根据首条输入创建用户档案');
      } else {
        await this.userProfile?.createProfile();
        printInfo('已创建默认用户档案，可稍后用 /profile 补充信息');
      }
      this.syncProfileToEnhancedMemory();
      return;
    }

    if (onboarding) {
      await this.userProfile?.updateFromOnboarding(onboarding);
      printSuccess('已更新用户档案');
      this.syncProfileToEnhancedMemory();
    }
  }

  private syncProfileToEnhancedMemory(): void {
    if (!this.enhancedMemory || !this.userProfile) return;

    const profile = this.userProfile.getProfile();
    if (!profile) return;

    if (profile.job) {
      this.enhancedMemory.setUserPreference('job', profile.job);
    }
    if (profile.purpose) {
      this.enhancedMemory.setUserPreference('purpose', profile.purpose);
    }
    this.enhancedMemory.setUserPreference('personality', profile.preferences.personality);
    this.enhancedMemory.setUserPreference('communicationStyle', profile.preferences.communicationStyle);
  }

  private getToolResultDisplayText(toolResult?: { output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }): string {
    if (!toolResult) return '';
    if (toolResult.output) return normalizeDisplayText(toolResult.output);
    if (toolResult.content) {
      return normalizeDisplayText(toolResult.content
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text || '')
        .join('\n'));
    }
    return '';
  }

  private isBrowserSafetyToolResult(toolResult?: { is_error?: boolean; errorType?: string; statusCode?: string }): boolean {
    return toolResult?.errorType === 'browser_safety_abort' || toolResult?.statusCode === 'BROWSER_SAFETY_ABORTED';
  }

  private formatBrowserAgentResult(toolResult?: { output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }): { status?: string; text: string } {
    const output = this.getToolResultDisplayText(toolResult);
    if (!output) return { text: '' };

    try {
      const parsed = JSON.parse(output) as {
        status?: string;
        finalMessage?: string;
        safety?: { category?: string; stage?: string; matchedPolicy?: string; matchedTerms?: string[] };
        appliedWorkflows?: string[];
      };

      const lines: string[] = [];
      if (parsed.status) {
        lines.push(`status: ${parsed.status}`);
      }
      if (parsed.safety?.category) {
        lines.push(`category: ${parsed.safety.category}`);
      }
      if (parsed.safety?.stage) {
        lines.push(`stage: ${parsed.safety.stage}`);
      }
      if (parsed.safety?.matchedPolicy) {
        lines.push(`policy: ${parsed.safety.matchedPolicy}`);
      }
      if (parsed.safety?.matchedTerms?.length) {
        lines.push(`matched: ${parsed.safety.matchedTerms.join(', ')}`);
      }
      if (parsed.appliedWorkflows?.length) {
        lines.push(`workflows: ${parsed.appliedWorkflows.join(', ')}`);
      }
      if (parsed.finalMessage) {
        lines.push('message:');
        lines.push(parsed.finalMessage);
      }

      return { status: parsed.status, text: lines.length > 0 ? lines.join('\n') : output };
    } catch {
      return { text: output };
    }
  }

  private formatCronRunResult(toolResult?: { output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }): string {
    const output = this.getToolResultDisplayText(toolResult);
    if (!output) return '';

    try {
      const parsed = JSON.parse(output) as {
        job?: { id?: string; name?: string; tool?: string };
        workDir?: string;
        result?: { output?: string; is_error?: boolean };
      };

      const lines: string[] = [];
      if (parsed.job?.name) {
        lines.push(`job: ${parsed.job.name}`);
      } else if (parsed.job?.id) {
        lines.push(`job: ${parsed.job.id}`);
      }

      if (parsed.job?.tool) {
        lines.push(`tool: ${parsed.job.tool}`);
      }

      if (parsed.workDir) {
        lines.push(`workdir: ${parsed.workDir}`);
      }

      const runOutput = parsed.result?.output?.trim();
      if (runOutput) {
        lines.push('output:');
        lines.push(runOutput);
      }

      return lines.length > 0 ? lines.join('\n') : output;
    } catch {
      return output;
    }
  }

  private formatBrowserAutomationResult(toolResult?: { output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }): string {
    const output = this.getToolResultDisplayText(toolResult);
    if (!output) return '';

    try {
      const parsed = JSON.parse(output) as {
        browser?: string;
        title?: string;
        url?: string;
        actions?: Array<{ type?: string; selector?: string; text?: string; outputPath?: string }>;
      };

      const lines: string[] = [];
      if (parsed.browser) {
        lines.push(`browser: ${parsed.browser}`);
      }
      if (parsed.title) {
        lines.push(`title: ${parsed.title}`);
      }
      if (parsed.url) {
        lines.push(`url: ${parsed.url}`);
      }

      for (const action of parsed.actions || []) {
        if (action.outputPath) {
          lines.push(`screenshot: ${action.outputPath}`);
        }
        if (action.text) {
          lines.push('text:');
          lines.push(action.text.slice(0, 2000));
        }
      }

      return lines.length > 0 ? lines.join('\n') : output;
    } catch {
      return output;
    }
  }

  private resolveBrowserActionFile(inputPath: string): string {
    if (path.isAbsolute(inputPath)) {
      return inputPath;
    }

    const normalizedPath = inputPath.replace(/^actions[\\/]/i, '');
    return path.join(this.getBrowserActionsDir(), normalizedPath);
  }

  private getBrowserActionsDir(): string {
    return path.join(this.appBaseDir, 'actions');
  }

  private applyGlobalPathsFromConfig(config: { appBaseDir?: string }): void {
    this.appBaseDir = config.appBaseDir || path.join(os.homedir(), '.ai-agent-cli');
    this.inputHistoryPath = path.join(this.appBaseDir, 'input-history.json');
    this.newsOutputDir = path.join(this.appBaseDir, 'outputs', 'tencent-news');
    this.sessionTaskStackDir = path.join(this.appBaseDir, 'runtime', 'session-task-stack');
    this.backgroundDaemon = new BackgroundDaemonManager(this.appBaseDir);
  }

  private configureCronRuntime(): void {
    if (!this.cronManager) {
      return;
    }

    this.cronManager.setExecutor((toolName, args, job) => this.builtInTools!.executeToolForCronJob(toolName, args, job.name));
    this.cronManager.setNotifier(async ({ job, result }) => {
      const content = this.getToolResultDisplayText(result) || '(无输出)';
      console.log();
      console.log(chalk.magenta(`[Cron] ${job.name}`));
      if (result.is_error) {
        printError(content);
      } else {
        console.log(chalk.gray(`schedule: ${job.schedule} -> ${job.toolName}`));
        console.log(content);
      }
      console.log();
    });

    if (this.options.runLocalCronScheduler) {
      this.cronManager.start();
    }
  }

  private async ensureBackgroundCronDaemon(silent = false): Promise<BackgroundDaemonStatus | null> {
    if (this.options.runLocalCronScheduler || !this.backgroundDaemon) {
      return null;
    }

    const status = await this.backgroundDaemon.ensureRunning({
      configPath: configManager.getConfigPath(),
      workspace: this.workspace,
    });

    if (!silent) {
      printSuccess(`Background daemon ready${status.pid > 0 ? ` (pid=${status.pid})` : ''}`);
    }

    return status;
  }

  private async getCronSchedulerStatus(): Promise<{ running: boolean; mode: 'local' | 'daemon'; pid?: number }> {
    if (this.options.runLocalCronScheduler) {
      return {
        running: this.cronManager?.isRunning() ?? false,
        mode: 'local',
      };
    }

    const status = await this.backgroundDaemon?.getStatus();
    const schedulerRunning = status?.cronSchedulerRunning ?? status?.running ?? false;
    return {
      running: schedulerRunning,
      mode: 'daemon',
      pid: schedulerRunning ? status?.pid : undefined,
    };
  }

  async stopBackgroundDaemonIfRequested(): Promise<void> {
    if (!this.stopBackgroundDaemonOnExit) {
      return;
    }

    const stopped = await this.backgroundDaemon?.stop();
    if (stopped) {
      printSuccess('Background daemon stopped');
    } else {
      printInfo('Background daemon was not running');
    }
  }

  private async parseBrowserActions(rawInput?: string): Promise<Record<string, unknown>[]> {
    if (!rawInput) {
      return [];
    }

    const content = rawInput.startsWith('@')
      ? await fs.readFile(this.resolveBrowserActionFile(rawInput.slice(1)), 'utf-8')
      : rawInput;

    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new Error('浏览器动作必须是 JSON 数组');
    }

    return parsed as Record<string, unknown>[];
  }

  private trackPlannedTask(event: AgentEvent): void {
    if (!this.enhancedMemory || !event.plan) return;

    const stepDescriptions = event.plan.steps.map(step => step.description);
    const progress = this.enhancedMemory.createTaskProgress(event.plan.originalTask, stepDescriptions);
    this.activePlannedTaskId = progress.taskId;
    this.enhancedMemory.updateTaskProgress(progress.taskId, {
      status: 'in_progress',
      currentStep: stepDescriptions[0],
    });

    const displayTask = progressTracker.createTask(event.plan.originalTask, stepDescriptions);
    this.activeProgressDisplayTaskId = displayTask.taskId;
    progressTracker.startTask(displayTask.taskId);
    progressTracker.printProgress(displayTask);
  }

  private completeTrackedTaskIfNeeded(content: string): void {
    if (!this.enhancedMemory || !this.activePlannedTaskId) return;
    if (!content.startsWith('## ✅ 任务完成')) return;

    const task = this.enhancedMemory.getTaskProgress(this.activePlannedTaskId);
    if (!task) return;

    this.enhancedMemory.completeTask(this.activePlannedTaskId, content);
    this.enhancedMemory.updateTaskProgress(this.activePlannedTaskId, {
      completedSteps: [...task.completedSteps, ...task.pendingSteps],
      pendingSteps: [],
      currentStep: undefined,
    });

    if (this.activeProgressDisplayTaskId) {
      progressTracker.completeTask(content);
      this.activeProgressDisplayTaskId = undefined;
    }

    this.activePlannedTaskId = undefined;
  }

  private failTrackedTask(error: string): void {
    if (!this.enhancedMemory || !this.activePlannedTaskId) return;
    this.enhancedMemory.failTask(this.activePlannedTaskId, error);
    if (this.activeProgressDisplayTaskId) {
      const displayTask = progressTracker.getTask(this.activeProgressDisplayTaskId);
      const runningStep = displayTask?.steps[displayTask.currentStepIndex];
      if (runningStep) {
        progressTracker.failStep(runningStep.id, error);
      }
      this.activeProgressDisplayTaskId = undefined;
    }
    this.activePlannedTaskId = undefined;
  }

  private updateTrackedTaskFromPlanEvent(event: AgentEvent): void {
    if (!this.enhancedMemory || !this.activePlannedTaskId || !event.planProgress) return;

    const task = this.enhancedMemory.getTaskProgress(this.activePlannedTaskId);
    if (!task) return;

    const allSteps = Array.from(new Set([...task.completedSteps, ...task.pendingSteps]));
    const stepIndex = event.planProgress.stepIndex;
    const completedSteps = allSteps.filter((_, index) => index < stepIndex);
    const pendingSteps = allSteps.filter((_, index) => index >= stepIndex);
    const displayTask = this.activeProgressDisplayTaskId
      ? progressTracker.getTask(this.activeProgressDisplayTaskId)
      : undefined;
    const displayStep = displayTask?.steps[stepIndex];

    if (event.planProgress.status === 'started') {
      this.enhancedMemory.updateTaskProgress(this.activePlannedTaskId, {
        status: 'in_progress',
        currentStep: event.planProgress.stepDescription,
        completedSteps,
        pendingSteps,
      });
      if (displayStep) {
        progressTracker.startStep(displayStep.id);
      }
      return;
    }

    if (event.planProgress.status === 'completed') {
      this.enhancedMemory.updateTaskProgress(this.activePlannedTaskId, {
        status: 'in_progress',
        currentStep: pendingSteps[1],
        completedSteps: allSteps.filter((_, index) => index <= stepIndex),
        pendingSteps: allSteps.filter((_, index) => index > stepIndex),
      });
      if (displayStep) {
        progressTracker.completeStep(displayStep.id, event.planProgress.result);
      }
      return;
    }

    if (event.planProgress.status === 'failed') {
      this.enhancedMemory.updateTaskProgress(this.activePlannedTaskId, {
        status: 'failed',
        currentStep: event.planProgress.stepDescription,
        completedSteps,
        pendingSteps,
        error: event.planProgress.result,
      });
      if (displayStep) {
        progressTracker.failStep(displayStep.id, event.planProgress.result || '步骤失败');
      }
      this.activeProgressDisplayTaskId = undefined;
    }
  }

  private async handleOrganizationMessage(input: string): Promise<void> {
    if (!this.organization) {
      printError('Organization not loaded');
      return;
    }

    console.log(chalk.cyan('\n🏢 Organization Mode Active'));
    console.log(chalk.gray('Team: ' + this.organization.getConfig().name + '\n'));

    try {
      const response = await this.organization.processUserInput(input);
      if (this.agent) {
        this.agent.appendMessages([
          { role: 'user', content: input },
          { role: 'assistant', content: response },
        ]);
        this.memoryManager.setMessages(this.agent.getMessages());
      }
      this.streamingOutput?.clear();
      console.log(chalk.green('\n--- Result ---\n'));
      await this.streamResponse(response);
      await this.sendAssistantReplyToActiveLarkTarget(response);
    } catch (error) {
      printError('Organization processing failed: ' + (error instanceof Error ? error.message : String(error)));
    }

    console.log();
  }

  private handleCatCommand(args: string[]): void {
    const subcommand = args[0]?.toLowerCase();

    if (!this.agentCat) {
      this.agentCat = createAgentCat();
      this.agentCat.start();
    }

    switch (subcommand) {
      case 'status':
        this.showCatStatus();
        break;
      case 'water':
        this.agentCat.acknowledge('water');
        break;
      case 'rest':
        this.agentCat.acknowledge('eye_rest');
        break;
      case 'walk':
        this.agentCat.acknowledge('walk');
      case 'meal':
        this.agentCat.acknowledge('meal');
        console.log(chalk.gray('CLI 已退出，后台 daemon 保持运行。'));
      case 'interact':
        console.log(chalk.cyan(this.agentCat.interact()));
      case 'exit':
        console.log(chalk.gray('正在永久退出，后台 daemon 将一并停止。'));
        this.stopBackgroundDaemonOnExit = true;
        this.running = false;
        break;
        break;
      case 'stop':
        this.agentCat.stop();
        printSuccess('AgentCat stopped');
        break;
      case 'start':
        this.agentCat.start();
        printSuccess('AgentCat started');
        break;
      default:
        this.agentCat.showHelp();
    }
  }

  private showCatStatus(): void {
    if (!this.agentCat) {
      printInfo('AgentCat not started. Use /cat start to activate.');
      return;
    }

    const status = this.agentCat.getStatus();
    console.log(chalk.bold('\n🐱 AgentCat 状态:\n'));
    console.log(`  名字: ${status.name}`);
    console.log(`  心情: ${status.mood}`);
    console.log(`  状态: ${status.isActive ? chalk.green('活跃') : chalk.gray('休眠')}`);
    console.log(`  上次喝水: ${status.lastWater}`);
    console.log(`  上次休息: ${status.lastEyeRest}`);
    console.log(`  上次运动: ${status.lastWalk}`);
    console.log(`  互动次数: ${status.interactionCount}`);
    console.log();
  }

  private showProgress(): void {
    console.log(chalk.bold('\n📊 任务进度:\n'));

    if (!this.enhancedMemory) {
      console.log(chalk.gray('增强记忆尚未初始化，无法显示结构化进行中任务。'));
    } else {
      const activeTasks = this.enhancedMemory.getActiveTasks();
      if (activeTasks.length === 0) {
        console.log(chalk.gray('暂无进行中的任务'));
      } else {
        for (const task of activeTasks) {
          const statusColor = task.status === 'in_progress' ? chalk.yellow : 
                            task.status === 'completed' ? chalk.green : chalk.gray;
          console.log(chalk.cyan(`  ${task.description}`));
          console.log(`  进度: ${statusColor(task.progress + '%')}`);
          console.log(`  状态: ${statusColor(task.status)}`);
          if (task.currentStep) {
            console.log(`  当前: ${task.currentStep}`);
          }
          if (task.completedSteps.length > 0) {
            console.log(chalk.gray(`  已完成: ${task.completedSteps.join(', ')}`));
          }
          console.log();
        }
      }
    }

    this.printTaskContextSummary(false);
  }

  private showTaskContext(args: string[] = []): void {
    const mode = args[0]?.toLowerCase();
    if (mode === '--json' || mode === 'json') {
      const snapshot = this.sessionTaskStack.getContextSnapshot(10);
      const agentState = this.agent?.getUnifiedStateSnapshot(undefined, snapshot.checkpoint);
      const graphState = this.buildCurrentGraphState(agentState);
      console.log(JSON.stringify(buildTaskContextJsonPayload(snapshot, graphState, agentState), null, 2));
      return;
    }

    if (mode === 'inspect') {
      this.printTaskContextInspect();
      return;
    }

    this.printTaskContextSummary(true);
  }

  private printTaskContextSummary(includeHeader: boolean): void {
    const snapshot = this.sessionTaskStack.getContextSnapshot(5);
    if (includeHeader) {
      console.log(chalk.bold('\n🧭 任务上下文:\n'));
    } else {
      console.log(chalk.bold('\n🧭 任务栈上下文:\n'));
    }

    if (!snapshot.activeTask) {
      console.log(chalk.gray('当前还没有记录任务。'));
      return;
    }

    const activeTask = snapshot.activeTask;
    console.log(chalk.cyan('当前活跃目标'));
    console.log(`  ${activeTask.title}`);
    console.log(chalk.gray(`  channel=${activeTask.channel}, status=${activeTask.status}, category=${activeTask.category || activeTask.handlerName || 'unknown'}`));

    const activeBinding = snapshot.recentBindings.find(binding => binding.sourceTask.id === activeTask.id);
    if (activeBinding) {
      console.log(chalk.gray(`  绑定来源: ${activeBinding.targetTask?.title || activeBinding.targetTaskTitle || activeBinding.targetTaskId}`));
    }

    if (snapshot.bindableTask) {
      console.log(chalk.cyan('\n当前默认跟进锚点'));
      console.log(`  ${snapshot.bindableTask.title}`);
      console.log(chalk.gray(`  channel=${snapshot.bindableTask.channel}, status=${snapshot.bindableTask.status}`));
    }

    if (snapshot.checkpoint) {
      console.log(chalk.cyan('\n当前 checkpoint'));
      console.log(`  ${snapshot.checkpoint.node} | ${snapshot.checkpoint.status}`);
      if (snapshot.checkpoint.summary) {
        console.log(chalk.gray(`  ${snapshot.checkpoint.summary}`));
      }
    }

    if (snapshot.recentBindings.length > 0) {
      console.log(chalk.cyan('\n最近绑定关系'));
      for (const binding of snapshot.recentBindings) {
        console.log(`  ${binding.sourceTask.title}`);
        console.log(chalk.gray(`    ↳ ${binding.targetTask?.title || binding.targetTaskTitle || binding.targetTaskId}`));
      }
    }

    console.log(chalk.cyan('\n最近任务'));
    for (const task of snapshot.recentTasks) {
      console.log(`  - ${task.title}`);
      console.log(chalk.gray(`    ${task.channel} | ${task.status} | ${task.category || task.handlerName || 'unknown'}`));
    }
  }

  private printTaskContextInspect(): void {
    const snapshot = this.sessionTaskStack.getContextSnapshot(10);
    console.log(chalk.bold('\n🧭 任务上下文 Inspect:\n'));

    if (snapshot.recentTasks.length === 0) {
      console.log(chalk.gray('当前还没有记录任务。'));
      return;
    }

    snapshot.recentTasks.forEach((task, index) => {
      console.log(chalk.cyan(`${index + 1}. ${task.title}`));
      console.log(chalk.gray(`  id=${task.id}`));
      console.log(chalk.gray(`  channel=${task.channel}, status=${task.status}, category=${task.category || task.handlerName || 'unknown'}`));
      console.log(chalk.gray(`  input=${task.input}`));
      if (task.effectiveInput && task.effectiveInput !== task.input) {
        console.log(chalk.gray(`  effectiveInput=${task.effectiveInput}`));
      }
      if (task.metadata && Object.keys(task.metadata).length > 0) {
        console.log(chalk.gray(`  metadata=${JSON.stringify(task.metadata)}`));
      }
      console.log(chalk.gray(`  createdAt=${task.createdAt}`));
      console.log();
    });

    if (snapshot.checkpoint) {
      console.log(chalk.cyan('checkpoint'));
      console.log(chalk.gray(`  node=${snapshot.checkpoint.node}`));
      console.log(chalk.gray(`  status=${snapshot.checkpoint.status}`));
      console.log(chalk.gray(`  updatedAt=${snapshot.checkpoint.updatedAt}`));
      if (snapshot.checkpoint.summary) {
        console.log(chalk.gray(`  summary=${snapshot.checkpoint.summary}`));
      }
      if (snapshot.checkpoint.input) {
        console.log(chalk.gray(`  input=${snapshot.checkpoint.input}`));
      }
      if (snapshot.checkpoint.metadata && Object.keys(snapshot.checkpoint.metadata).length > 0) {
        console.log(chalk.gray(`  metadata=${JSON.stringify(snapshot.checkpoint.metadata)}`));
      }
      console.log();
    }
  }

  private getSessionTaskStackPath(sessionId = this.memoryManager.getCurrentSessionId()): string {
    return path.join(this.sessionTaskStackDir, `${sessionId}.json`);
  }

  private async loadPersistedSessionTaskStack(sessionId = this.memoryManager.getCurrentSessionId()): Promise<void> {
    await this.sessionTaskStack.loadFromFile(this.getSessionTaskStackPath(sessionId));
  }

  private async persistSessionTaskStack(sessionId = this.memoryManager.getCurrentSessionId()): Promise<void> {
    await this.sessionTaskStack.saveToFile(this.getSessionTaskStackPath(sessionId));
  }

  private async captureGraphState(graphState?: AgentGraphState): Promise<void> {
    this.lastGraphState = graphState;
    this.sessionTaskStack.setCheckpoint(graphState?.checkpoint);
    await this.persistSessionTaskStack();
  }

  private buildCurrentGraphState(agentState?: ReturnType<Agent['getUnifiedStateSnapshot']>): AgentGraphState | undefined {
    if (this.lastGraphState) {
      return this.lastGraphState;
    }

    if (!agentState) {
      return undefined;
    }

    const checkpoint = this.sessionTaskStack.getCheckpoint() ?? deriveCheckpointFromUnifiedAgentState(agentState);
    return createAgentGraphState({
      mode: checkpoint.node === 'resume' || checkpoint.node === 'pause_for_input' ? 'resume' : 'fresh',
      route: checkpoint.metadata?.route === 'direct_action' ? 'direct_action' : 'agent',
      originalInput: agentState.lastUserInput,
      effectiveInput: agentState.lastUserInput,
      checkpoint,
      agentState,
    });
  }

  private setTaskCheckpoint(
    node: 'direct_action' | 'clarify' | 'plan' | 'execute_step' | 'pause_for_input' | 'resume' | 'finalize',
    status: 'running' | 'waiting' | 'completed' | 'failed',
    input?: string,
    summary?: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.sessionTaskStack.setCheckpoint(createAgentCheckpoint(node, status, input, summary, metadata));
    this.lastGraphState = undefined;
    void this.persistSessionTaskStack();
  }

  private toAgentTaskBindingSnapshot(taskBinding: { isFollowUp: boolean; effectiveInput: string; boundTask?: AgentTaskBindingSnapshot['boundTask'] }): AgentTaskBindingSnapshot {
    return {
      isFollowUp: taskBinding.isFollowUp,
      effectiveInput: taskBinding.effectiveInput,
      boundTask: taskBinding.boundTask,
    };
  }

  private handleMemoryCommand(args: string[]): void {
    const subcommand = args[0]?.toLowerCase();

    if (!this.enhancedMemory) {
      this.enhancedMemory = createEnhancedMemoryManager();
    }

    switch (subcommand) {
      case 'long':
        this.showLongTermMemory();
        break;
      case 'short':
        this.showShortTermMemory(args[1]);
        break;
      case 'palace':
        this.handleMemoryPalaceCommand(args.slice(1));
        break;
      case 'clear':
        this.enhancedMemory.clearAllAgentShortTermMemory();
        printSuccess('Short-term memory cleared');
        break;
      default:
        console.log(chalk.bold('\n💾 记忆管理:\n'));
        console.log(chalk.cyan('/memory long') + '   ' + chalk.gray('查看长期记忆'));
        console.log(chalk.cyan('/memory short [agentId]') + '   ' + chalk.gray('查看短期记忆'));
        console.log(chalk.cyan('/memory palace') + '   ' + chalk.gray('查看记忆宫殿总览'));
        console.log(chalk.cyan('/memory palace room [roomId]') + '   ' + chalk.gray('查看房间陈列'));
        console.log(chalk.cyan('/memory palace go <roomId>') + '   ' + chalk.gray('切换当前房间'));
        console.log(chalk.cyan('/memory palace find <query>') + '   ' + chalk.gray('搜索记忆宫殿'));
        console.log(chalk.cyan('/memory clear') + '   ' + chalk.gray('清空短期记忆'));
        console.log();
    }
  }

  private showLongTermMemory(): void {
    if (!this.enhancedMemory) return;

    const memory = this.enhancedMemory.getLongTermMemory();
    console.log(chalk.bold('\n💾 长期记忆:\n'));
    
    if (Object.keys(memory.userPreferences).length > 0) {
      console.log(chalk.cyan('用户偏好:'));
      for (const [key, value] of Object.entries(memory.userPreferences)) {
        console.log(`  ${key}: ${JSON.stringify(value)}`);
      }
    }
    
    if (memory.knowledgeBase.length > 0) {
      console.log(chalk.cyan('\n知识库:'));
      memory.knowledgeBase.forEach(k => console.log(`  • ${k}`));
    }

    const projectEntries = Object.entries(memory.projectContext);
    if (projectEntries.length > 0) {
      console.log(chalk.cyan('\n项目上下文:'));
      for (const [key, value] of projectEntries.slice(-10)) {
        const rendered = typeof value === 'string' ? value : JSON.stringify(value);
        console.log(`  ${key}: ${rendered}`);
      }
    }

    if (memory.taskHistory.length > 0) {
      console.log(chalk.cyan('\n最近任务:'));
      for (const task of memory.taskHistory.slice(-10).reverse()) {
        const detail = task.result || task.error || task.currentStep || '';
        console.log(`  • ${task.description} ${chalk.gray(`[${task.status}]`)}`);
        if (detail) {
          console.log(chalk.gray(`    ${detail}`));
        }
      }
    }
    
    if (Object.keys(memory.organizationMemory).length > 0) {
      console.log(chalk.cyan('\n组织记忆:'));
      for (const [id, agent] of Object.entries(memory.organizationMemory)) {
        console.log(`  ${agent.agentName} (${agent.role}): ${agent.shortTerm.length} 条短期记忆`);
      }
    }

    const palace = this.enhancedMemory.getMemoryPalaceOverview();
    console.log(chalk.cyan('\n记忆宫殿:'));
    console.log(`  名称: ${palace.name}`);
    console.log(`  当前房间: ${palace.currentRoomId}`);
    console.log(`  房间数: ${palace.roomCount}`);
    console.log(`  记忆条目: ${palace.totalMemoryCount}`);
    
    console.log();
  }

  private async archiveDirectActionResult(input: string, directResult: { title?: string; output?: string; isError?: boolean }): Promise<void> {
    if (!this.memoryProvider || !this.shouldPersistDirectAction(input, directResult.title)) {
      return;
    }

    const normalizedInput = input.trim();
    const normalizedOutput = (directResult.output || '').trim();
    const status = directResult.isError ? 'failed' : 'completed';
    const summary = [
      `direct-action: ${directResult.title || 'direct action'}`,
      `request: ${normalizedInput}`,
      normalizedOutput ? `${directResult.isError ? 'error' : 'result'}: ${this.summarizeForLongTermMemory(normalizedOutput, 600)}` : undefined,
    ].filter(Boolean).join('\n');

    await this.memoryProvider.store({
      kind: 'task',
      title: normalizedInput,
      content: summary,
      metadata: {
        source: 'direct_action',
        status,
        result: directResult.isError ? undefined : this.summarizeForLongTermMemory(normalizedOutput, 600),
        error: directResult.isError ? this.summarizeForLongTermMemory(normalizedOutput, 600) : undefined,
        currentStep: directResult.title || 'direct action',
      },
    });
  }

  private shouldPersistDirectAction(input: string, title?: string): boolean {
    const normalized = `${title || ''}\n${input}`.toLowerCase();
    if (!normalized.trim()) {
      return false;
    }

    return !/(read_file|read_multiple_files|list_directory|search_files|glob|查看文件|读取文件|打开文件|列出目录|列出文件|搜索|查找|grep|find|source read)/i.test(normalized);
  }

  private summarizeForLongTermMemory(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
  }

  private handleMemoryPalaceCommand(args: string[]): void {
    if (!this.enhancedMemory) return;

    const subcommand = args[0]?.toLowerCase();

    switch (subcommand) {
      case undefined:
      case 'view':
      case 'overview': {
        const overview = this.enhancedMemory.getMemoryPalaceOverview();
        console.log(chalk.bold(`\n🏛️ ${overview.name}\n`));
        console.log(chalk.gray(`当前房间: ${overview.currentRoomId}`));
        console.log(chalk.gray(`总房间数: ${overview.roomCount}，总记忆条目: ${overview.totalMemoryCount}\n`));
        for (const room of overview.rooms) {
          console.log(chalk.cyan(`${room.id} · ${room.name}`));
          console.log(chalk.gray(`  区域: ${room.zone} | 记忆数: ${room.memoryCount}`));
          console.log(chalk.gray(`  出口: ${room.exits.join(', ') || '无'}`));
        }
        console.log();
        break;
      }
      case 'room': {
        const room = this.enhancedMemory.getMemoryPalaceRoom(args[1]);
        if (!room) {
          printError(`Unknown memory palace room: ${args[1] || '(current)'}`);
          return;
        }

        console.log(chalk.bold(`\n🏛️ ${room.name}\n`));
        for (const item of room.memories) {
          console.log(chalk.green(`• [${item.zone}] ${item.title}`));
          console.log(chalk.gray(`  ${item.content.slice(0, 200)}${item.content.length > 200 ? '...' : ''}`));
        }
        console.log();
        break;
      }
      case 'go': {
        const roomId = args[1];
        if (!roomId) {
          printError('Usage: /memory palace go <roomId>');
          return;
        }

        const moved = this.enhancedMemory.setCurrentPalaceRoom(roomId);
        if (!moved) {
          printError(`Unknown memory palace room: ${roomId}`);
          return;
        }

        printSuccess(`已进入记忆宫殿房间: ${roomId}`);
        this.handleMemoryPalaceCommand(['room', roomId]);
        break;
      }
      case 'find': {
        const query = args.slice(1).join(' ').trim();
        if (!query) {
          printError('Usage: /memory palace find <query>');
          return;
        }

        const results = this.enhancedMemory.searchMemoryPalace(query);
        console.log(chalk.bold(`\n🔎 搜索记忆宫殿: ${query}\n`));
        if (results.length === 0) {
          console.log(chalk.gray('未找到相关记忆。\n'));
          return;
        }

        for (const item of results.slice(0, 12)) {
          console.log(chalk.cyan(`  • ${item.title}`));
          console.log(chalk.gray(`    ${item.content.replace(/\n/g, ' ')}`));
          console.log(chalk.gray(`    tags: ${item.tags.join(', ') || '无'}`));
        }
        console.log();
        break;
      }
      default:
        printInfo('Usage: /memory palace [overview|room [roomId]|go <roomId>|find <query>]');
    }
  }

  private showShortTermMemory(agentId?: string): void {
    if (!this.enhancedMemory) return;

    if (!agentId) {
      const memory = this.enhancedMemory.getLongTermMemory();
      console.log(chalk.bold('\n📝 Agent 短期记忆:\n'));
      for (const [id, agent] of Object.entries(memory.organizationMemory)) {
        console.log(chalk.cyan(`${agent.agentName} (${id}):`));
        agent.shortTerm.slice(-5).forEach(m => {
          console.log(`  [${m.type}] ${m.content.slice(0, 50)}${m.content.length > 50 ? '...' : ''}`);
        });
        console.log();
      }
      return;
    }

    const memories = this.enhancedMemory.getAgentShortTermMemory(agentId);
    console.log(chalk.bold(`\n📝 ${agentId} 短期记忆:\n`));
    if (memories.length === 0) {
      console.log(chalk.gray('暂无记忆'));
    } else {
      memories.forEach(m => {
        console.log(`[${m.type}] ${m.content}`);
        console.log(chalk.gray(`  时间: ${new Date(m.timestamp).toLocaleString()}\n`));
      });
    }
  }

  private handleProfileCommand(args: string[]): void {
    const subcommand = args[0]?.toLowerCase();

    if (!this.userProfile) {
      printError('用户档案未初始化');
      return;
    }

    if (!this.userProfile.getProfile()) {
      console.log(chalk.cyan('\n👋 欢迎设置用户档案！\n'));
      console.log(chalk.gray('请告诉我一些关于您的信息：\n'));
      console.log(chalk.cyan('1. 您的工作是？') + chalk.gray(' (如：学生、程序员、产品经理...)'));
      console.log(chalk.cyan('2. 您主要用 coolAI 来做什么？') + chalk.gray(' (如：编程、写文章、数据处理...)'));
      console.log(chalk.cyan('3. 您喜欢什么性格？') + chalk.gray(' (专业/友好/幽默/温柔/活力)\n'));
      console.log(chalk.gray('直接输入您的信息，例如：'));
      console.log(chalk.gray('  我是程序员，主要用来写代码，喜欢幽默风格\n'));
      return;
    }

    switch (subcommand) {
      case 'view':
      case undefined:
        this.userProfile.printProfile();
        break;
      case 'set':
        this.setUserPreference(args);
        break;
      case 'personality':
        this.setPersonality(args[1]);
        break;
      case 'style':
        this.setCommunicationStyle(args[1]);
        break;
      default:
        console.log(`
${chalk.bold('用户档案命令:')}
${chalk.cyan('/profile')}            查看用户档案
${chalk.cyan('/profile set job')}   设置职业
${chalk.cyan('/profile set purpose')} 设置使用目的
${chalk.cyan('/profile personality [type]')} 设置性格 (professional/friendly/humorous/gentle/energetic)
${chalk.cyan('/profile style [type]')}  设置沟通风格 (concise/normal/detailed)
`);
    }
  }

  private setUserPreference(args: string[]): void {
    const key = args[1]?.toLowerCase();
    const value = args.slice(2).join(' ');

    if (!key || !value) {
      printError('Usage: /profile set <key> <value>');
      return;
    }

    if (key === 'job') {
      this.userProfile?.updateFromOnboarding({ job: value });
      printSuccess('职业已设置: ' + value);
    } else if (key === 'purpose') {
      this.userProfile?.updateFromOnboarding({ purpose: value });
      printSuccess('使用目的已设置: ' + value);
    } else if (key === 'interests') {
      const interests = value.split(',').map(s => s.trim()).filter(s => s);
      this.userProfile?.updateFromOnboarding({ interests });
      printSuccess('兴趣领域已设置: ' + interests.join(', '));
    }
  }

  private setPersonality(type?: string): void {
    if (!type) {
      console.log(chalk.gray('当前性格: ' + this.userProfile?.getProfile()?.preferences.personality));
      return;
    }

    const validTypes = ['professional', 'friendly', 'humorous', 'gentle', 'energetic'];
    if (!validTypes.includes(type)) {
      printError('Invalid type. Choose from: ' + validTypes.join(', '));
      return;
    }

    this.userProfile?.updatePreferences({ personality: type as any });
    printSuccess('性格已设置为: ' + type);
  }

  private setCommunicationStyle(style?: string): void {
    if (!style) {
      console.log(chalk.gray('当前风格: ' + this.userProfile?.getProfile()?.preferences.communicationStyle));
      return;
    }

    const validStyles = ['concise', 'normal', 'detailed'];
    if (!validStyles.includes(style)) {
      printError('Invalid style. Choose from: ' + validStyles.join(', '));
      return;
    }

    this.userProfile?.updatePreferences({ communicationStyle: style as any });
    printSuccess('沟通风格已设置为: ' + style);
  }

  private handlePermissionCommand(args: string[]): void {
    const subcommand = args[0]?.toLowerCase();

    if (!this.permissionMgr) {
      printError('Permission manager not initialized');
      return;
    }

    switch (subcommand) {
      case 'view':
      case undefined:
        this.permissionMgr.printPermissions();
        break;
      case 'grant':
        this.grantPermission(args[1], args[2], args[3]);
        break;
      case 'revoke':
        this.revokePermission(args[1], args[2]);
        break;
      case 'revokeall':
        this.permissionMgr.revokeAll();
        printSuccess('All permissions revoked');
        break;
      case 'group':
        this.handleGroupCommand(args[1], args[2]);
        break;
      case 'audit':
        const limit = parseInt(args[1] || '20');
        this.permissionMgr.printAuditLog(limit);
        break;
      case 'trust':
        if (args[1]) {
          this.permissionMgr.addTrustedCommand(args[1]);
          printSuccess('Added trusted command: ' + args[1]);
        }
        break;
      case 'allow':
        if (args[1]) {
          this.permissionMgr.addAllowedPath(args[1]);
          this.sandbox.addAllowedPath(args[1]);
          printSuccess('Added allowed path: ' + args[1]);
        }
        break;
      case 'deny':
        if (args[1]) {
          this.permissionMgr.addDeniedPath(args[1]);
          printSuccess('Added denied path: ' + args[1]);
        }
        break;
      case 'auto':
        const enabled = args[1]?.toLowerCase() === 'on';
        this.permissionMgr.setAutoGrantDangerous(enabled);
        printSuccess(`Auto-grant dangerous operations: ${enabled ? 'ON' : 'OFF'}`);
        break;
      case 'ask':
        const askEnabled = args[1]?.toLowerCase() !== 'off';
        this.permissionMgr.setAskForPermissions(askEnabled);
        printSuccess(`Ask for permissions: ${askEnabled ? 'ON' : 'OFF'}`);
        break;
      default:
        console.log(`
${chalk.bold('权限管理命令:')}
${chalk.cyan('/perm')}             查看权限设置
${chalk.cyan('/perm view')}        查看当前权限
${chalk.cyan('/perm grant')} <type> [resource] [10m|1h|24h] 授予权限(可选过期时间)
${chalk.cyan('/perm revoke')} <type> [resource] 撤销权限
${chalk.cyan('/perm revokeall')}    撤销所有权限
${chalk.cyan('/perm group')}        查看权限组
${chalk.cyan('/perm group grant')} <groupId> 授予权限组
${chalk.cyan('/perm group revoke')} <groupId> 撤销权限组
${chalk.cyan('/perm audit')} [n]    查看审计日志(默认20条)
${chalk.cyan('/perm trust')} <cmd>  添加可信命令
${chalk.cyan('/perm allow')} <path> 添加允许路径
${chalk.cyan('/perm deny')} <path>  添加禁止路径
${chalk.cyan('/perm auto')} [on|off] 自动授权危险操作
${chalk.cyan('/perm ask')} [on|off] 询问权限

${chalk.gray('权限类型:')}
  file_read, file_write, file_delete, file_copy, file_move
  directory_list, directory_create, command_execute
  network_request, browser_open, browser_automation, mcp_access, tool_execute
  env_read, process_list, clipboard_read, clipboard_write

${chalk.gray('权限组:')}
  file_ops - 基础文件操作(读写列表创建)
  file_dangerous - 危险文件操作(删除复制移动)
  network - 网络操作(请求和浏览器)
  system - 系统操作(命令执行环境进程)
`);
    }
  }

  private grantPermission(type?: string, resource?: string, expiresIn?: string): void {
    if (!type) {
      printError('Usage: /perm grant <type> [resource] [10m|1h|24h]');
      return;
    }

    const validTypes = ['file_read', 'file_write', 'file_delete', 'file_copy', 'file_move',
      'directory_list', 'directory_create', 'command_execute', 'network_request',
      'browser_open', 'browser_automation', 'mcp_access', 'tool_execute', 'env_read', 'process_list'];
    if (!validTypes.includes(type)) {
      printError('Invalid type. Choose from: ' + validTypes.join(', '));
      return;
    }

    let expiresMs: number | undefined;
    if (expiresIn) {
      const match = expiresIn.match(/^(\d+)(m|h|d)$/);
      if (match) {
        const numStr = match[1];
        const unit = match[2];
        if (numStr && unit) {
          const value = parseInt(numStr);
          if (unit === 'm') expiresMs = value * 60 * 1000;
          else if (unit === 'h') expiresMs = value * 60 * 60 * 1000;
          else if (unit === 'd') expiresMs = value * 24 * 60 * 60 * 1000;
        }
      }
    }

    this.permissionMgr?.grantPermission(type as any, resource, expiresMs);
    const expText = expiresMs ? ` (${expiresIn})` : ' (永久)';
    printSuccess(`Granted: ${type}${resource ? ` (${resource})` : ''}${expText}`);
  }

  private revokePermission(type?: string, resource?: string): void {
    if (!type) {
      printError('Usage: /perm revoke <type> [resource]');
      return;
    }

    this.permissionMgr?.revokePermission(type as any, resource);
    printSuccess(`Revoked: ${type}${resource ? ` (${resource})` : ''}`);
  }

  private handleGroupCommand(action?: string, groupId?: string): void {
    if (!action || action === 'list') {
      console.log(chalk.bold('\n📦 权限组\n'));
      const groups = this.permissionMgr?.getGroups() || [];
      for (const group of groups) {
        const hasAll = group.permissions.every(p => this.permissionMgr?.isGranted(p));
        const status = hasAll ? chalk.green('✓') : chalk.gray('○');
        console.log(`${status} ${chalk.cyan(group.id)} - ${group.name}`);
        console.log(chalk.gray(`   ${group.description}`));
        console.log(chalk.gray(`   权限: ${group.permissions.join(', ')}\n`));
      }
      return;
    }

    if (action === 'grant' && groupId) {
      this.permissionMgr?.grantGroup(groupId);
      printSuccess(`Granted group: ${groupId}`);
      return;
    }

    if (action === 'revoke' && groupId) {
      this.permissionMgr?.revokeGroup(groupId);
      printSuccess(`Revoked group: ${groupId}`);
      return;
    }

    printInfo('Usage: /perm group [list|grant <groupId>|revoke <groupId>]');
  }

  private createNewSession(): void {
    const oldSessionId = this.memoryManager.getCurrentSessionId();
    this.memoryManager.newSession();
    this.agent?.clearMessages();
    this.sessionTaskStack.clear();
    this.lastGraphState = undefined;
    void this.persistSessionTaskStack();
    
    console.log(chalk.bold('\n📝 新会话已创建\n'));
    console.log(`旧会话: ${chalk.gray(oldSessionId)}`);
    console.log(`新会话: ${chalk.cyan(this.memoryManager.getCurrentSessionId())}`);
    console.log(chalk.gray('\n旧会话已存档，可以随时通过 /load <id> 加载回\n'));
    
    const hasProfile = !!this.userProfile?.getProfile();
    this.isFirstInteraction = !hasProfile;
    this.awaitingOnboardingInput = !hasProfile;
  }

  private async wipeUserData(): Promise<void> {
    console.log(chalk.yellow('\n⚠️ 将清除所有用户数据:\n'));
    console.log('  - 用户画像');
    console.log('  - 当前对话历史');
    console.log('  - Agent 记忆\n');
    console.log('输入 ' + chalk.cyan('yes') + ' 确认清除: ');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    
    const answer = await new Promise<string>((resolve) => {
      rl.question('', (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    
    if (answer.toLowerCase() === 'yes') {
      await this.userProfile?.reset();
      this.syncProfileToEnhancedMemory();
      this.memoryManager.clearHistory();
      this.agent?.clearMessages();
      this.sessionTaskStack.clear();
      this.lastGraphState = undefined;
      await this.persistSessionTaskStack();
      this.isFirstInteraction = false;
      this.awaitingOnboardingInput = false;
      printSuccess('所有用户数据已清除');
    } else {
      printInfo('取消操作');
    }
  }

  private async showTemplates(): Promise<void> {
    const templateDir = path.join(process.cwd(), 'config', 'templates');
    
    try {
      const files = await fs.readdir(templateDir);
      const templates = files.filter(f => f.endsWith('.json'));
      
      console.log(chalk.bold('\n📁 组织架构模板:\n'));
      for (const template of templates) {
        const content = await fs.readFile(path.join(templateDir, template), 'utf-8');
        const config = JSON.parse(content);
        console.log(chalk.cyan(`  ${config.name}`) + chalk.gray(` - ${config.type}`));
        console.log(chalk.gray(`    ${config.description}`));
        console.log(chalk.gray(`    角色数: ${config.agents.length}`));
        console.log();
      }
    } catch (error) {
      printError('Failed to load templates: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private async showSessions(): Promise<void> {
    const sessions = await this.memoryManager.listSessions();
    console.log(chalk.bold('\nRecent Sessions:\n'));
    
    if (sessions.length === 0) {
      console.log(chalk.gray('No sessions found.'));
    } else {
      for (const session of sessions.slice(0, 10)) {
        const date = new Date(session.lastUpdated);
        const timeStr = date.toLocaleString();
        const current = session.id === this.memoryManager.getCurrentSessionId() ? chalk.green('(current)') : '';
        console.log(chalk.cyan(`  ${session.id}`) + ' ' + chalk.gray(`${session.messageCount} messages`) + ' ' + current);
        console.log(chalk.gray(`    Last: ${timeStr}`));
      }
    }
    console.log();
  }

  private async loadSession(sessionId?: string): Promise<void> {
    if (!sessionId) {
      console.log(chalk.yellow('Usage: /load <session-id>'));
      console.log(chalk.gray('Use /sessions to see available sessions.'));
      return;
    }
    
    const success = await this.memoryManager.loadSession(sessionId);
    if (success) {
      this.agent?.setMessages(this.memoryManager.getMessages());
      await this.loadPersistedSessionTaskStack(sessionId);
      this.lastGraphState = undefined;
      printSuccess('Loaded session: ' + sessionId);
    } else {
      printError('Session not found: ' + sessionId);
    }
  }

  private async showDirectActionPreamble(message: string): Promise<void> {
    if (this.getFunctionMode() === 'workflow') {
      this.pendingDirectActionPreamble = undefined;
      return;
    }

    this.pendingDirectActionPreamble = message;
    console.log(chalk.green('\nAssistant: '));
    await this.streamResponse(message);
    console.log();
  }

  private async sendAssistantReplyToActiveLarkTarget(text: string): Promise<void> {
    const relayMessage = this.activeLarkReplyTarget;
    const builtInTools = this.builtInTools;
    const normalizedText = text.trim();

    if (!relayMessage?.chatId || !builtInTools || !normalizedText) {
      return;
    }

    try {
      await builtInTools.executeTool('send_lark_message', {
        chatId: relayMessage.chatId,
        text: normalizedText,
      });
    } catch (error) {
      printWarning(`[Lark Relay] 回传最终结果失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async sendPendingInteractionPromptToActiveLarkTarget(alreadySentText?: string): Promise<void> {
    const prompt = this.agent?.getPendingInteractionDetails()?.prompt?.trim();
    if (!prompt) {
      return;
    }

    if (typeof alreadySentText === 'string' && alreadySentText.trim() === prompt) {
      return;
    }

    await this.sendAssistantReplyToActiveLarkTarget(prompt);
  }

  private createLLMClient(config: any): LLMProviderInterface {
    const provider = config.defaultProvider || 'ollama';
    
    switch (provider) {
      case 'ollama':
        if (!config.ollama?.enabled) {
          printWarning('Ollama not enabled, falling back to default config');
        }
        return LLMFactory.create({
          provider: 'ollama',
          baseUrl: config.ollama?.baseUrl || 'http://localhost:11434',
          model: config.ollama?.model || 'llama3.2',
          temperature: config.ollama?.temperature || 0.7,
          maxTokens: config.ollama?.maxTokens || 4096,
        });
        
      case 'deepseek':
        if (!config.deepseek?.enabled) {
          printWarning('DeepSeek not enabled in config');
        }
        return LLMFactory.create({
          provider: 'deepseek',
          apiKey: config.deepseek?.apiKey || '',
          baseUrl: config.deepseek?.baseUrl || 'https://api.deepseek.com',
          model: config.deepseek?.model || 'deepseek-chat',
          temperature: config.deepseek?.temperature || 0.7,
          maxTokens: config.deepseek?.maxTokens || 4096,
          deepseekRouting: config.deepseek?.reasoningModel ? {
            reasoningModel: config.deepseek.reasoningModel,
            autoReasoning: config.deepseek.autoReasoning,
          } : undefined,
        });
        
      case 'kimi':
        if (!config.kimi?.enabled) {
          printWarning('Kimi not enabled in config');
        }
        return LLMFactory.create({
          provider: 'kimi',
          apiKey: config.kimi?.apiKey || '',
          baseUrl: config.kimi?.baseUrl || 'https://api.moonshot.cn/v1',
          model: config.kimi?.model || 'moonshot-v1-8k',
          temperature: config.kimi?.temperature || 0.7,
        });
        
      case 'glm':
        return LLMFactory.create({
          provider: 'glm',
          apiKey: config.glm?.apiKey || '',
          baseUrl: config.glm?.baseUrl || 'https://open.bigmodel.cn/api/paas/v4',
          model: config.glm?.model || 'glm-4',
          temperature: config.glm?.temperature || 0.7,
        });
        
      case 'doubao':
        return LLMFactory.create({
          provider: 'doubao',
          apiKey: config.doubao?.apiKey || '',
          baseUrl: config.doubao?.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
          model: config.doubao?.model || 'doubao-pro',
          temperature: config.doubao?.temperature || 0.7,
        });
        
      case 'minimax':
        return LLMFactory.create({
          provider: 'minimax',
          apiKey: config.minimax?.apiKey || '',
          baseUrl: config.minimax?.baseUrl || 'https://api.minimax.chat/v1',
          model: config.minimax?.model || 'MiniMax-Text-01',
          temperature: config.minimax?.temperature || 0.7,
        });
        
      case 'openai':
        return LLMFactory.create({
          provider: 'openai',
          apiKey: config.openai?.apiKey || '',
          baseUrl: config.openai?.baseUrl || 'https://api.openai.com/v1',
          model: config.openai?.model || 'gpt-4',
          temperature: config.openai?.temperature || 0.7,
        });
        
      case 'claude':
        return LLMFactory.create({
          provider: 'claude',
          apiKey: config.claude?.apiKey || '',
          baseUrl: config.claude?.baseUrl || 'https://api.anthropic.com',
          model: config.claude?.model || 'claude-sonnet-4-20250514',
          temperature: config.claude?.temperature || 0.7,
        });
        
      case 'gemini':
        return LLMFactory.create({
          provider: 'gemini',
          apiKey: config.gemini?.apiKey || '',
          baseUrl: config.gemini?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta',
          model: config.gemini?.model || 'gemini-2.0-flash',
          temperature: config.gemini?.temperature || 0.7,
        });

      case 'hybrid':
        return LLMFactory.create({
          provider: 'hybrid',
          model: 'hybrid-router',
          hybrid: {
            localProvider: config.hybrid?.localProvider || 'ollama',
            remoteProvider: config.hybrid?.remoteProvider || 'deepseek',
            localModel: config[config.hybrid?.localProvider || 'ollama']?.model,
            remoteModel: config[config.hybrid?.remoteProvider || 'deepseek']?.model,
            simpleTaskMaxChars: config.hybrid?.simpleTaskMaxChars || 80,
            simpleConversationMaxChars: config.hybrid?.simpleConversationMaxChars || 6000,
            preferRemoteForToolMessages: config.hybrid?.preferRemoteForToolMessages ?? true,
            localAvailabilityCacheMs: config.hybrid?.localAvailabilityCacheMs ?? 15000,
          },
        });
        
      default:
        printWarning(`Unknown provider ${provider}, using ollama`);
        return LLMFactory.create({
          provider: 'ollama',
          baseUrl: 'http://localhost:11434',
          model: 'llama3.2',
        });
    }
  }

  private showQuickHelp(): void {
    console.log(getQuickHelpText());
  }

  private showHelp(): void {
    console.log(getFullHelpText());
  }

  private async handleBrowserCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    if (!this.builtInTools) {
      printError('Built-in tools not initialized');
      return;
    }

    switch (subcommand) {
      case 'open': {
        const url = args[1];
        if (!url) {
          printError('Usage: /browser open <url>');
          return;
        }

        const result = await this.builtInTools.executeTool('open_browser', { url, browser: 'chrome' });
        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to open browser');
        } else {
          printSuccess(`Chrome opened: ${url}`);
        }
        break;
      }
      case 'run': {
        const url = args[1];
        if (!url) {
          printError('Usage: /browser run <url> [actionsJson|@actions.json] [--headed] [--timeout <ms>] [--browser <chrome|edge|chromium>]');
          return;
        }

        let browser: 'chrome' | 'edge' | 'chromium' = 'chrome';
        let headless = true;
        let timeoutMs = 15000;
        const actionTokens: string[] = [];

        for (let index = 2; index < args.length; index += 1) {
          const token = args[index];
          if (!token) continue;

          if (token === '--headed') {
            headless = false;
            continue;
          }

          if (token === '--headless') {
            headless = true;
            continue;
          }

          if (token === '--timeout') {
            const nextValue = args[index + 1];
            const parsedTimeout = Number(nextValue);
            if (!nextValue || !Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
              printError('Invalid --timeout value');
              return;
            }
            timeoutMs = parsedTimeout;
            index += 1;
            continue;
          }

          if (token === '--browser') {
            const nextValue = args[index + 1]?.toLowerCase();
            if (nextValue !== 'chrome' && nextValue !== 'edge' && nextValue !== 'chromium') {
              printError('Invalid --browser value, use chrome, edge, or chromium');
              return;
            }
            browser = nextValue;
            index += 1;
            continue;
          }

          actionTokens.push(token);
        }

        try {
          const actions = await this.parseBrowserActions(actionTokens.join(' ').trim() || undefined);
          const result = await this.builtInTools.executeTool('browser_automate', {
            url,
            actions,
            browser,
            headless,
            timeoutMs,
          });

          if (result.is_error) {
            if (this.isBrowserSafetyToolResult(result)) {
              printWarning(this.getToolResultDisplayText(result) || 'Browser automation stopped by safety guard');
            } else {
              printError(this.getToolResultDisplayText(result) || 'Failed to automate browser');
            }
          } else {
            printSuccess(`Browser automation finished: ${url}`);
            console.log(this.formatBrowserAutomationResult(result));
          }
        } catch (error) {
          printError(error instanceof Error ? error.message : String(error));
        }
        break;
      }
      case 'agent':
      case 'smart': {
        const taskTokens: string[] = [];
        let startUrl: string | undefined;
        let maxSteps: number | undefined;
        let workflow: string | undefined;

        for (let index = 1; index < args.length; index += 1) {
          const token = args[index];
          if (!token) {
            continue;
          }

          if (token === '--url') {
            startUrl = args[index + 1];
            index += 1;
            continue;
          }

          if (token === '--max-steps') {
            const nextValue = Number(args[index + 1]);
            if (!Number.isFinite(nextValue) || nextValue <= 0) {
              printError('Invalid --max-steps value');
              return;
            }
            maxSteps = nextValue;
            index += 1;
            continue;
          }

          if (token === '--workflow') {
            workflow = args[index + 1];
            index += 1;
            continue;
          }

          taskTokens.push(token);
        }

        const goal = taskTokens.join(' ').trim();
        if (!goal) {
          printError('Usage: /browser agent <goal> [--url <startUrl>] [--max-steps <n>] [--workflow <file>]');
          return;
        }

        const result = await this.builtInTools.executeTool('browser_agent_run', {
          goal,
          startUrl,
          maxSteps,
          workflow,
        });

        const browserAgentResult = this.formatBrowserAgentResult(result);

        if (result.is_error) {
          printError(browserAgentResult.text || 'Failed to run browser agent');
        } else if (browserAgentResult.status === 'safety_blocked') {
          printWarning(browserAgentResult.text || 'Browser agent stopped by safety guard');
        } else {
          printSuccess('Browser agent started');
          console.log(browserAgentResult.text);
        }
        break;
      }
      case 'workflow': {
        await this.handleBrowserWorkflowCommand(args.slice(1));
        break;
      }
      case 'help':
      default:
        console.log(`
${chalk.bold('Browser Commands:')}

${chalk.cyan('/browser open')} <url>
  用 Chrome 打开网页

${chalk.cyan('/browser run')} <url> [actionsJson|@actions.json] [--headed] [--timeout <ms>] [--browser <chrome|edge|chromium>]
  默认用 Chrome，通过 Playwright 打开网页并执行动作

${chalk.cyan('/browser agent')} <goal> [--url <startUrl>] [--max-steps <n>] [--workflow <file>]
  运行智能浏览器代理，支持读取 browser-workflows 目录下的 Markdown 流程文件来简化特定网页任务

${chalk.cyan('/browser workflow list')}
  列出当前 browser-workflows 目录中的所有 Markdown 流程文件

${chalk.cyan('/browser workflow inspect')} <file>
  查看某个 Markdown 流程文件解析后的结构，包括 match、steps、preferred selectors、fallback actions、done conditions

${chalk.cyan('/browser workflow lint')} [file]
  校验 workflow schema，并输出 error/warning，避免手写 Markdown 静默失效
  加上 --json 可输出稳定 machine-readable 结构
  加上 --quick-fix 可输出基于 suggestion 的 quick fix 草案

${chalk.cyan('/browser workflow new')} <name> [--url <startUrl>] [--match <pattern1,pattern2>]
  生成新的 browser workflow Markdown 模板，便于后续定制站点流程

${chalk.gray('动作示例:')}
  [{"type":"click","selector":"text=登录"},{"type":"fill","selector":"input[name=q]","value":"AI Agent CLI"},{"type":"press","selector":"input[name=q]","key":"Enter"},{"type":"wait_for_selector","selector":"#search"},{"type":"extract_text","selector":"body"},{"type":"screenshot","path":"browser/search.png"}]
  [{"type":"evaluate_script","script":"window.scrollTo(0, document.body.scrollHeight)","expectResult":{"type":"void"}},{"type":"call_userscript_api","api":"UserscriptBridge.collectResults","args":["AI Agent CLI"],"expectResult":{"type":"array","shape":"{ title: string; url: string }","description":"search results"}},{"type":"toggle_userscript_mode","enabled":false}]

${chalk.gray('更稳妥的用法:')}
  /browser run https://example.com @actions.json --headed
  /browser agent 帮我打开招聘网站并总结前 3 个前端岗位 --url https://example.com
  /browser agent summary current page --workflow browser-workflows/example-summary.md
  /browser workflow list
  /browser workflow inspect browser-workflows/example-summary.md
  /browser workflow lint browser-workflows/example-summary.md
  /browser workflow new boss-zhipin-search --url https://www.zhipin.com --match zhipin.com
`);
        break;
    }
  }

  private async handleVisionCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();
    switch (subcommand) {
      case 'analyze': {
        let parsedInput: { targets: string[]; prompt?: string; model?: string; limit?: number } | null;
        try {
          parsedInput = this.parseVisionAnalyzeArgs(args.slice(1));
        } catch (error) {
          printError(error instanceof Error ? error.message : String(error));
          return;
        }
        if (!parsedInput) {
          printError('Usage: /vision analyze <fileOrDir> [moreFilesOrDirs...] [prompt...] [--model <name>] [--limit <n>]');
          return;
        }
        const { targets, prompt, model, limit } = parsedInput;

        const config = configManager.getAgentConfig();
        if (!config.ollama?.enabled) {
          printError('Ollama 未启用，无法使用 /vision。');
          return;
        }

        const visionService = createOllamaVisionService({
          workspace: this.workspace,
          appBaseDir: this.appBaseDir,
          artifactOutputDir: config.artifactOutputDir,
          documentOutputDir: config.documentOutputDir,
          ollamaConfig: config.ollama,
        });

        try {
          printInfo(`使用 ${model || config.ollama.visionModel || 'minicpm-v'} 分析图片目标...`);
          const result = await visionService.analyzeTargets({
            targets,
            prompt,
            model,
            maxImages: limit,
          });

          if (this.agent) {
            this.agent.appendMessages([
              {
                role: 'user',
                content: `请分析图片目标 ${result.resolvedTargets.join(', ')}\n文件数: ${result.imageCount}\n要求: ${result.prompt}`,
              },
              {
                role: 'assistant',
                content: result.response,
              },
            ]);
            this.memoryManager.setMessages(this.agent.getMessages());
            await this.memoryProvider?.syncSession(this.agent.getMessages());
          }

          console.log(chalk.bold('\n🖼️ 图片分析结果\n'));
          console.log(chalk.gray(`模型: ${result.model}`));
          console.log(chalk.gray(`目标: ${result.resolvedTargets.join(', ')}`));
          console.log(chalk.gray(`图片数: ${result.imageCount}`));
          console.log(chalk.green('\nAssistant: '));
          await this.streamResponse(result.response);
          console.log();
        } catch (error) {
          printError(error instanceof Error ? error.message : String(error));
        }
        break;
      }
      case 'help':
      default:
        console.log(`
${chalk.bold('Vision Commands:')}

${chalk.cyan('/vision analyze')} <fileOrDir> [moreFilesOrDirs...] [prompt...] [--model <name>] [--limit <n>]
  使用 Ollama 多模态模型分析一个或多个文件/目录中的图片，默认走 ollama.visionModel 或 minicpm-v

${chalk.gray('示例:')}
  /vision analyze ./screenshots
  /vision analyze ./screenshots ./captures 请检查这些页面截图里的报错和异常状态
  /vision analyze ./captures/home.png ./captures/error.png --model minicpm-v --limit 8
`);
        break;
    }
  }

  private parseVisionAnalyzeArgs(args: string[]): { targets: string[]; prompt?: string; model?: string; limit?: number } | null {
    const targets: string[] = [];
    const promptTokens: string[] = [];
    let model: string | undefined;
    let limit: number | undefined;
    let promptStarted = false;

    for (let index = 0; index < args.length; index += 1) {
      const token = args[index];
      if (!token) {
        continue;
      }

      if (token === '--model') {
        model = args[index + 1];
        index += 1;
        continue;
      }

      if (token === '--limit') {
        const parsed = Number(args[index + 1]);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error('Invalid --limit value');
        }
        limit = parsed;
        index += 1;
        continue;
      }

      if (!promptStarted && this.isLikelyVisionTarget(token)) {
        targets.push(token);
        continue;
      }

      promptStarted = true;
      promptTokens.push(token);
    }

    if (targets.length === 0) {
      return null;
    }

    return {
      targets,
      prompt: promptTokens.join(' ').trim() || undefined,
      model,
      limit,
    };
  }

  private isLikelyVisionTarget(token: string): boolean {
    return /^[a-z]:[\\/]/i.test(token)
      || /^(?:\.{1,2}[\\/]|[\\/])/.test(token)
      || /[\\/]/.test(token)
      || /\.(?:png|jpg|jpeg|webp|gif|bmp)$/i.test(token);
  }

  private async handleBrowserWorkflowCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();
    const service = this.createBrowserWorkflowService();

    switch (subcommand) {
      case 'list': {
        const resolution = await service.listWorkflows();
        console.log(chalk.bold(`\nBrowser Workflows (${resolution.workflowDir})\n`));
        if (resolution.workflows.length === 0) {
          console.log(chalk.gray('No browser workflows found.'));
          if (resolution.lintResults && resolution.lintResults.length > 0) {
            this.printBrowserWorkflowLintSummary(resolution.lintResults);
          }
          return;
        }

        for (const workflow of resolution.workflows) {
          const lint = resolution.lintResults?.find(item => item.filePath === workflow.sourcePath);
          const errorCount = lint?.issues.filter(issue => issue.severity === 'error').length || 0;
          const warningCount = lint?.issues.filter(issue => issue.severity === 'warning').length || 0;
          console.log(`${chalk.cyan(workflow.name)} ${chalk.gray(`priority=${workflow.priority}`)}`);
          console.log(chalk.gray(`  file: ${workflow.sourcePath}`));
          if (workflow.startUrl) {
            console.log(chalk.gray(`  startUrl: ${workflow.startUrl}`));
          }
          if (workflow.matchPatterns.length > 0) {
            console.log(chalk.gray(`  match: ${workflow.matchPatterns.join(', ')}`));
          }
          console.log(chalk.gray(`  steps=${workflow.steps.length}, selectors=${Object.keys(workflow.preferredSelectors).length}, fallbacks=${Object.keys(workflow.fallbackActions).length}, done=${workflow.doneConditions.length}, phaseOverrides=${Object.keys(workflow.phaseConfigurations).length}`));
          if (errorCount > 0 || warningCount > 0) {
            console.log(chalk.gray(`  lint: errors=${errorCount}, warnings=${warningCount}`));
          }
          console.log(chalk.gray(`  ${workflow.description}`));
        }
        const invalidReports = (resolution.lintResults || []).filter(item => !item.valid && !resolution.workflows.some(workflow => workflow.sourcePath === item.filePath));
        if (invalidReports.length > 0) {
          console.log(chalk.yellow('\nInvalid workflow files:'));
          this.printBrowserWorkflowLintSummary(invalidReports);
        }
        return;
      }
      case 'inspect': {
        const target = args[1];
        if (!target) {
          printError('Usage: /browser workflow inspect <file>');
          return;
        }

        const workflow = await service.inspectWorkflow(target);
        console.log(chalk.bold(`\nBrowser Workflow: ${workflow.name}\n`));
        console.log(chalk.gray(`file: ${workflow.sourcePath}`));
        console.log(chalk.gray(`description: ${workflow.description}`));
        if (workflow.startUrl) {
          console.log(chalk.gray(`startUrl: ${workflow.startUrl}`));
        }
        if (workflow.matchPatterns.length > 0) {
          console.log(chalk.gray(`match: ${workflow.matchPatterns.join(', ')}`));
        }
        if (workflow.whenToUse) {
          console.log(`\n${chalk.bold('When to Use')}`);
          console.log(workflow.whenToUse);
        }
        this.printBrowserWorkflowListSection('Steps', workflow.steps);
        this.printBrowserWorkflowListSection('Hints', workflow.hints);
        this.printBrowserWorkflowListSection('Success', workflow.successCriteria);
        this.printBrowserWorkflowMapSection('Selector Slots', workflow.selectorSlots);
        this.printBrowserWorkflowMapSection('Preferred Selectors', workflow.preferredSelectors);
        this.printBrowserWorkflowMapSection('Fallback Actions', workflow.fallbackActions);
        this.printBrowserWorkflowListSection('Done Conditions', workflow.doneConditions);
        this.printBrowserWorkflowPhaseSections(workflow.phaseConfigurations);
        if (typeof workflow.maxRetries === 'number') {
          console.log(`\n${chalk.bold('Max Retries')}`);
          console.log(String(workflow.maxRetries));
        }
        this.printBrowserWorkflowLintResult(await service.lintWorkflow(target));
        return;
      }
      case 'lint': {
        const jsonMode = args.includes('--json');
        const quickFixMode = args.includes('--quick-fix') || args.includes('--fix');
        const target = args.find((item, index) => index > 0 && item !== '--json' && item !== '--quick-fix' && item !== '--fix');
        if (target) {
          const result = await service.lintWorkflow(target);
          if (jsonMode) {
            const payload = quickFixMode
              ? { lint: result, quickFixes: buildBrowserWorkflowQuickFixDrafts([result]) }
              : result;
            console.log(JSON.stringify(payload, null, 2));
          } else {
            this.printBrowserWorkflowLintResult(result);
            if (quickFixMode) {
              this.printBrowserWorkflowQuickFixDrafts(buildBrowserWorkflowQuickFixDrafts([result]));
            }
          }
          return;
        }

        const summary = await service.lintWorkflows();
        if (jsonMode) {
          const payload = quickFixMode
            ? { lint: summary, quickFixes: buildBrowserWorkflowQuickFixDrafts(summary.results) }
            : summary;
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        console.log(chalk.bold(`\nBrowser Workflow Lint (${summary.workflowDir})\n`));
        if (summary.results.length === 0) {
          console.log(chalk.gray('No browser workflows found.'));
          return;
        }
        console.log(chalk.gray(`files=${summary.counts.files}, valid=${summary.counts.valid}, invalid=${summary.counts.invalid}, errors=${summary.counts.errors}, warnings=${summary.counts.warnings}`));
        this.printBrowserWorkflowLintSummary(summary.results);
        if (quickFixMode) {
          this.printBrowserWorkflowQuickFixDrafts(buildBrowserWorkflowQuickFixDrafts(summary.results));
        }
        return;
      }
      case 'new': {
        const target = args[1];
        if (!target) {
          printError('Usage: /browser workflow new <name> [--url <startUrl>] [--match <pattern1,pattern2>]');
          return;
        }

        let startUrl: string | undefined;
        let matchPatterns: string[] | undefined;

        for (let index = 2; index < args.length; index += 1) {
          const token = args[index];
          if (!token) {
            continue;
          }

          if (token === '--url') {
            startUrl = args[index + 1];
            index += 1;
            continue;
          }

          if (token === '--match') {
            matchPatterns = (args[index + 1] || '').split(',').map(item => item.trim()).filter(Boolean);
            index += 1;
          }
        }

        const created = await service.createWorkflowTemplate(target, {
          startUrl,
          match: matchPatterns,
        });
        printSuccess(`Browser workflow created: ${created.filePath}`);
        return;
      }
      case undefined:
      case 'help':
      default:
        console.log(`
${chalk.bold('Browser Workflow Commands:')}

${chalk.cyan('/browser workflow list')}
  列出所有 browser workflow Markdown 文件

${chalk.cyan('/browser workflow inspect')} <file>
  查看某个 workflow 的解析结构

${chalk.cyan('/browser workflow lint')} [file]
  校验 workflow schema 并输出 lint 结果
  加上 --json 输出 machine-readable JSON
  加上 --quick-fix 输出 quick fix 草案

${chalk.cyan('/browser workflow new')} <name> [--url <startUrl>] [--match <pattern1,pattern2>]
  创建新的 workflow 模板文件
`);
        return;
    }
  }

  private createBrowserWorkflowService(): BrowserWorkflowService {
    const config = configManager.getAgentConfig();
    return new BrowserWorkflowService({
      workspace: this.workspace,
      appBaseDir: config.appBaseDir,
      workflowDir: config.browserAgent?.workflowDir,
      autoMatch: config.browserAgent?.autoMatchWorkflows,
    });
  }

  private printBrowserWorkflowListSection(title: string, items: string[]): void {
    if (items.length === 0) {
      return;
    }

    console.log(`\n${chalk.bold(title)}`);
    for (const item of items) {
      console.log(`- ${item}`);
    }
  }

  private printBrowserWorkflowMapSection(title: string, values: Record<string, string[]>): void {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    console.log(`\n${chalk.bold(title)}`);
    for (const [key, items] of entries) {
      console.log(`${key}:`);
      for (const item of items) {
        console.log(`- ${item}`);
      }
    }
  }

  private printBrowserWorkflowPhaseSections(values: Partial<Record<'unknown' | 'landing' | 'search-input' | 'search-results' | 'detail' | 'form', {
    phase: string;
    steps: string[];
    hints: string[];
    successCriteria: string[];
    selectorSlots: Record<string, string[]>;
    preferredSelectors: Record<string, string[]>;
    fallbackActions: Record<string, string[]>;
    doneConditions: string[];
  }>>): void {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      return;
    }

    console.log(`\n${chalk.bold('Phase Overrides')}`);
    for (const [phase, config] of entries) {
      if (!config) {
        continue;
      }
      console.log(chalk.cyan(`- ${phase}`));
      if (config.steps.length > 0) {
        console.log(chalk.gray('  steps:'));
        for (const item of config.steps) {
          console.log(`    - ${item}`);
        }
      }
      if (config.hints.length > 0) {
        console.log(chalk.gray('  hints:'));
        for (const item of config.hints) {
          console.log(`    - ${item}`);
        }
      }
      if (config.successCriteria.length > 0) {
        console.log(chalk.gray('  success:'));
        for (const item of config.successCriteria) {
          console.log(`    - ${item}`);
        }
      }
      if (Object.keys(config.selectorSlots).length > 0) {
        console.log(chalk.gray('  selectorSlots:'));
        for (const [key, items] of Object.entries(config.selectorSlots)) {
          console.log(`    ${key}: ${items.join(' | ')}`);
        }
      }
      if (Object.keys(config.preferredSelectors).length > 0) {
        console.log(chalk.gray('  preferredSelectors:'));
        for (const [key, items] of Object.entries(config.preferredSelectors)) {
          console.log(`    ${key}: ${items.join(' | ')}`);
        }
      }
      if (Object.keys(config.fallbackActions).length > 0) {
        console.log(chalk.gray('  fallbackActions:'));
        for (const [key, items] of Object.entries(config.fallbackActions)) {
          console.log(`    ${key}: ${items.join(' | ')}`);
        }
      }
      if (config.doneConditions.length > 0) {
        console.log(chalk.gray(`  doneConditions: ${config.doneConditions.join(' | ')}`));
      }
    }
  }

  private printBrowserWorkflowLintSummary(results: Array<{ filePath: string; workflowName?: string; valid: boolean; issueCounts?: { errors: number; warnings: number }; issues: Array<{ severity: 'error' | 'warning'; message: string; code: string; phase?: string; heading?: string; suggestion?: { summary: string } }> }>): void {
    for (const result of results) {
      const errorCount = result.issueCounts?.errors ?? result.issues.filter(issue => issue.severity === 'error').length;
      const warningCount = result.issueCounts?.warnings ?? result.issues.filter(issue => issue.severity === 'warning').length;
      const label = result.workflowName || path.basename(result.filePath);
      const status = result.valid ? chalk.green('valid') : chalk.red('invalid');
      console.log(`${status} ${chalk.cyan(label)} ${chalk.gray(result.filePath)}`);
      console.log(chalk.gray(`  errors=${errorCount}, warnings=${warningCount}`));
      for (const issue of result.issues) {
        const marker = issue.severity === 'error' ? chalk.red('error') : chalk.yellow('warning');
        const qualifiers = [issue.phase ? `phase=${issue.phase}` : '', issue.heading ? `heading=${issue.heading}` : ''].filter(Boolean).join(', ');
        console.log(`  - ${marker} [${issue.code}] ${issue.message}${qualifiers ? chalk.gray(` (${qualifiers})`) : ''}`);
        if (issue.suggestion?.summary) {
          console.log(chalk.gray(`    fix: ${issue.suggestion.summary}`));
        }
      }
    }
  }

  private printBrowserWorkflowLintResult(result: { filePath: string; workflowName?: string; valid: boolean; issueCounts?: { errors: number; warnings: number }; issues: Array<{ severity: 'error' | 'warning'; message: string; code: string; phase?: string; heading?: string; suggestion?: { summary: string } }> }): void {
    console.log(chalk.bold(`\nWorkflow Lint: ${result.workflowName || path.basename(result.filePath)}\n`));
    this.printBrowserWorkflowLintSummary([result]);
  }

  private printBrowserWorkflowQuickFixDrafts(drafts: Array<{ code: string; severity: 'error' | 'warning'; summary: string; example?: string; count: number; files: string[]; phase?: string; heading?: string }>): void {
    console.log(chalk.bold('\nWorkflow Quick Fix Drafts\n'));
    if (drafts.length === 0) {
      console.log(chalk.gray('No quick-fix suggestions available.'));
      return;
    }

    drafts.forEach((draft, index) => {
      const marker = draft.severity === 'error' ? chalk.red('error') : chalk.yellow('warning');
      const qualifiers = [draft.phase ? `phase=${draft.phase}` : '', draft.heading ? `heading=${draft.heading}` : ''].filter(Boolean).join(', ');
      console.log(`${index + 1}. ${marker} [${draft.code}] x${draft.count} ${draft.summary}${qualifiers ? chalk.gray(` (${qualifiers})`) : ''}`);
      if (draft.files.length > 0) {
        console.log(chalk.gray(`   files: ${draft.files.join(', ')}`));
      }
      if (draft.example) {
        console.log(chalk.gray('   example:'));
        for (const line of draft.example.split(/\r?\n/)) {
          console.log(chalk.gray(`     ${line}`));
        }
      }
    });
  }

  private async handleNewsCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    if (!this.builtInTools) {
      printError('Built-in tools not initialized');
      return;
    }

    switch (subcommand) {
      case undefined:
      case 'help':
        console.log(`
${chalk.bold('Tencent News Commands:')}
${chalk.cyan('/news hot')} [limit]             查看热榜新闻
${chalk.cyan('/news search')} <keyword> [limit] 搜索相关新闻
${chalk.cyan('/news morning')}                  查看早报
${chalk.cyan('/news evening')}                  查看晚报
${chalk.cyan('/news save hot')} [limit]        保存热榜到本地输出目录
${chalk.cyan('/news save search')} <keyword> [limit] 保存搜索结果到本地输出目录
${chalk.cyan('/news save morning')}             保存早报到本地输出目录
${chalk.cyan('/news save evening')}             保存晚报到本地输出目录
${chalk.cyan('/news push')} <type> [flags]      抓取新闻并发送到飞书
${chalk.cyan('/news output-dir')}               查看本地输出目录

${chalk.gray('示例:')}
${chalk.gray('/news hot 5')}
${chalk.gray('/news search AI 5')}
${chalk.gray('/news morning')}
${chalk.gray('/news save hot 10')}
${chalk.gray('/news push morning --save')}
`);
        return;
      case 'output-dir':
        console.log();
        console.log(chalk.cyan('Tencent News Output Directory'));
        console.log(this.newsOutputDir);
        console.log();
        return;
      case 'save':
      case 'export': {
        await this.handleNewsSaveCommand(args.slice(1));
        return;
      }
      case 'push': {
        const parsed = this.parseNewsPushArgs(args.slice(1));
        if (!parsed) {
          printError('Usage: /news push <morning|evening|hot|search> [--chat-id <oc_xxx>] [--limit <n>] [--keyword <text>] [--title <text>] [--save] [--dry-run] [--timezone <Asia/Shanghai>]\n默认接收目标读取 notifications.lark.morningNews.chatId');
          return;
        }

        const result = await this.builtInTools.executeTool('push_news_to_lark', parsed);
        this.displayDirectToolResult(result, '飞书新闻推送');
        return;
      }
      case 'hot': {
        const limit = Number.parseInt(args[1] || '10', 10);
        const result = await this.builtInTools.executeTool('tencent_hot_news', {
          limit: Number.isFinite(limit) && limit > 0 ? limit : 10,
        });
        this.displayDirectToolResult(result, '腾讯热榜');
        return;
      }
      case 'search': {
        const limitCandidate = args[args.length - 1];
        const parsedLimit = limitCandidate ? Number.parseInt(limitCandidate, 10) : Number.NaN;
        const hasNumericLimit = Number.isFinite(parsedLimit);
        const keyword = args.slice(1, hasNumericLimit ? -1 : undefined).join(' ').trim();

        if (!keyword) {
          printError('Usage: /news search <keyword> [limit]');
          return;
        }

        const result = await this.builtInTools.executeTool('tencent_search_news', {
          keyword,
          limit: hasNumericLimit && parsedLimit > 0 ? parsedLimit : 10,
        });
        this.displayDirectToolResult(result, `腾讯新闻搜索: ${keyword}`);
        return;
      }
      case 'morning': {
        const result = await this.builtInTools.executeTool('tencent_morning_news', {});
        this.displayDirectToolResult(result, '腾讯早报');
        return;
      }
      case 'evening': {
        const result = await this.builtInTools.executeTool('tencent_evening_news', {});
        this.displayDirectToolResult(result, '腾讯晚报');
        return;
      }
      default:
        printError('Usage: /news [hot [limit]|search <keyword> [limit]|morning|evening|save <subcommand>|push <type> [flags]|output-dir|help]');
    }
  }

  private parseNewsPushArgs(args: string[]): {
    newsType: 'hot' | 'search' | 'morning' | 'evening';
    chatId?: string;
    keyword?: string;
    limit?: number;
    title?: string;
    timezone?: string;
    saveOutput?: boolean;
    dryRun?: boolean;
  } | null {
    const newsType = args[0]?.toLowerCase();
    if (!newsType || !['hot', 'search', 'morning', 'evening'].includes(newsType)) {
      return null;
    }

    const flags = this.parseCliFlags(args.slice(1));
    let chatId = flags['chat-id'];
    if (flags['user-id']) {
      return null;
    }

    if (!chatId) {
      const configuredTarget = this.getDefaultLarkNewsTarget();
      chatId = configuredTarget?.chatId;
      if (!chatId) {
        return null;
      }
    }

    const parsed = {
      newsType: newsType as 'hot' | 'search' | 'morning' | 'evening',
      chatId,
      keyword: flags.keyword,
      limit: flags.limit ? Number.parseInt(flags.limit, 10) : undefined,
      title: flags.title,
      timezone: flags.timezone,
      saveOutput: flags.save === 'true',
      dryRun: flags['dry-run'] === 'true',
    };

    if (parsed.newsType === 'search' && !parsed.keyword) {
      return null;
    }

    return parsed;
  }

  private parseCliFlags(args: string[]): Record<string, string> {
    const parsed: Record<string, string> = {};
    let index = 0;
    while (index < args.length) {
      const token = args[index];
      if (!token || !token.startsWith('--')) {
        index += 1;
        continue;
      }

      const key = token.slice(2).toLowerCase();
      const values: string[] = [];
      index += 1;
      while (index < args.length) {
        const current = args[index];
        if (!current || current.startsWith('--')) {
          break;
        }
        values.push(current);
        index += 1;
      }

      parsed[key] = values.length > 0 ? values.join(' ') : 'true';
    }

    return parsed;
  }

  private async handleNewsSaveCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    if (!this.builtInTools) {
      printError('Built-in tools not initialized');
      return;
    }

    switch (subcommand) {
      case 'hot': {
        const limit = Number.parseInt(args[1] || '10', 10);
        const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 10;
        const result = await this.builtInTools.executeTool('tencent_hot_news', { limit: safeLimit });
        await this.displayAndMaybePersistNewsResult(result, '腾讯热榜', 'hot', undefined, safeLimit);
        return;
      }
      case 'search': {
        const limitCandidate = args[args.length - 1];
        const parsedLimit = limitCandidate ? Number.parseInt(limitCandidate, 10) : Number.NaN;
        const hasNumericLimit = Number.isFinite(parsedLimit);
        const keyword = args.slice(1, hasNumericLimit ? -1 : undefined).join(' ').trim();

        if (!keyword) {
          printError('Usage: /news save search <keyword> [limit]');
          return;
        }

        const safeLimit = hasNumericLimit && parsedLimit > 0 ? parsedLimit : 10;
        const result = await this.builtInTools.executeTool('tencent_search_news', { keyword, limit: safeLimit });
        await this.displayAndMaybePersistNewsResult(result, `腾讯新闻搜索: ${keyword}`, 'search', keyword, safeLimit);
        return;
      }
      case 'morning': {
        const result = await this.builtInTools.executeTool('tencent_morning_news', {});
        await this.displayAndMaybePersistNewsResult(result, '腾讯早报', 'morning');
        return;
      }
      case 'evening': {
        const result = await this.builtInTools.executeTool('tencent_evening_news', {});
        await this.displayAndMaybePersistNewsResult(result, '腾讯晚报', 'evening');
        return;
      }
      default:
        printError('Usage: /news save [hot [limit]|search <keyword> [limit]|morning|evening]');
    }
  }

  private async displayAndMaybePersistNewsResult(
    result: { is_error?: boolean; output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> },
    title: string,
    newsType: 'hot' | 'search' | 'morning' | 'evening',
    keyword?: string,
    limit?: number,
  ): Promise<void> {
    this.displayDirectToolResult(result, title);

    if (result.is_error) {
      return;
    }

    const output = this.getToolResultDisplayText(result);
    if (output.length === 0) {
      return;
    }

    const filePath = await this.saveNewsOutput({
      newsType,
      content: output,
      keyword,
      limit,
    });

    await this.memoryProvider?.store({
      kind: 'project',
      key: 'last_output_file',
      title: 'last_output_file',
      content: `腾讯新闻输出: ${filePath}`,
      metadata: { path: filePath, newsType },
    });
    await this.memoryProvider?.store({
      kind: 'project',
      key: 'last_txt_output_file',
      title: 'last_txt_output_file',
      content: `腾讯新闻输出: ${filePath}`,
      metadata: { path: filePath, newsType },
    });

    printSuccess(`已保存到本地输出目录: ${filePath}`);
  }

  private async saveNewsOutput(input: {
    newsType: 'hot' | 'search' | 'morning' | 'evening';
    content: string;
    keyword?: string;
    limit?: number;
  }): Promise<string> {
    await fs.mkdir(this.newsOutputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
    const baseName = this.buildNewsOutputBaseName(input.newsType, input.keyword);
    const fileName = `${baseName}_${timestamp}.txt`;
    const filePath = path.join(this.newsOutputDir, fileName);
    const header = [
      `Title: ${baseName}`,
      `Type: ${input.newsType}`,
      input.keyword ? `Keyword: ${input.keyword}` : undefined,
      input.limit ? `Limit: ${input.limit}` : undefined,
      `GeneratedAt: ${new Date().toISOString()}`,
      '',
    ].filter(Boolean).join('\n');

    await fs.writeFile(filePath, `${header}${input.content}`.trim() + '\n', 'utf-8');
    return filePath;
  }

  private buildNewsOutputBaseName(newsType: 'hot' | 'search' | 'morning' | 'evening', keyword?: string): string {
    const sanitizedKeyword = keyword
      ? `_${keyword.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}`
      : '';

    switch (newsType) {
      case 'hot':
        return '腾讯新闻热榜';
      case 'search':
        return `腾讯新闻搜索${sanitizedKeyword}`;
      case 'morning':
        return '腾讯新闻早报';
      case 'evening':
        return '腾讯新闻晚报';
    }
  }

  private displayDirectToolResult(result: { is_error?: boolean; errorType?: string; statusCode?: string; output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }, title: string): void {
    console.log();
    console.log(chalk.cyan(title));
    const output = this.getToolResultDisplayText(result);
    if (result.is_error) {
      if (this.isBrowserSafetyToolResult(result)) {
        printWarning(output || `${title} 已因安全策略停止`);
      } else {
        printError(output || `${title} 调用失败`);
      }
      console.log();
      return;
    }

    if (output.length > 0) {
      console.log(output);
    } else {
      console.log(chalk.gray('(无输出)'));
    }
    console.log();
  }

  private async handleCronCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    if (!this.cronManager || !this.builtInTools) {
      printError('Cron manager not initialized');
      return;
    }

    switch (subcommand) {
      case undefined:
      case 'list': {
        const jobs = this.cronManager.listJobs();
        const schedulerStatus = await this.getCronSchedulerStatus();
        console.log(chalk.bold('\nCron Jobs:\n'));
        console.log(chalk.gray(`scheduler: ${schedulerStatus.running ? 'running' : 'stopped'}${schedulerStatus.mode === 'daemon' ? ` (background${schedulerStatus.pid ? ` pid=${schedulerStatus.pid}` : ''})` : ' (local)'}`));
        console.log();
        if (jobs.length === 0) {
          console.log(chalk.gray('No cron jobs found.'));
        } else {
          for (const job of jobs) {
            const workDir = this.cronManager.getJobWorkDir(job.name);
            console.log(chalk.cyan(`  • ${job.name}`) + chalk.gray(` (${job.id})`));
            console.log(`    status: ${job.enabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
            console.log(`    schedule: ${job.schedule}`);
            console.log(`    tool: ${job.toolName}`);
            console.log(chalk.gray(`    workdir: ${workDir}`));
            if (job.description) {
              console.log(chalk.gray(`    ${job.description}`));
            }
            if (job.nextRunAt) {
              console.log(chalk.gray(`    next: ${new Date(job.nextRunAt).toLocaleString()}`));
            }
            console.log();
          }
        }
        break;
      }
      case 'start': {
        const idOrName = args[1];
        if (!idOrName && !this.options.runLocalCronScheduler) {
          const status = await this.ensureBackgroundCronDaemon();
          printSuccess(`Background cron daemon started${status?.pid ? ` (pid=${status.pid})` : ''}`);
          break;
        }

        const result = await this.builtInTools.executeTool('cron_start', idOrName ? { idOrName } : {});
        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to start cron');
        } else if (idOrName) {
          printSuccess(`Cron job enabled: ${idOrName}`);
          if (!this.options.runLocalCronScheduler) {
            await this.ensureBackgroundCronDaemon(true);
          }
        } else {
          printSuccess('Cron scheduler started');
        }
        break;
      }
      case 'stop': {
        const idOrName = args[1];
        if (!idOrName && !this.options.runLocalCronScheduler) {
          const stopped = await this.backgroundDaemon?.stop();
          if (stopped) {
            printSuccess('Background cron daemon stopped');
          } else {
            printInfo('Background cron daemon was not running');
          }
          break;
        }

        const result = await this.builtInTools.executeTool('cron_stop', idOrName ? { idOrName } : {});
        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to stop cron');
        } else if (idOrName) {
          printSuccess(`Cron job disabled: ${idOrName}`);
        } else {
          printSuccess('Cron scheduler stopped');
        }
        break;
      }
      case 'run': {
        const idOrName = args[1];
        if (!idOrName) {
          printError('Usage: /cron run <idOrName>');
          return;
        }

        const result = await this.builtInTools.executeTool('cron_run', { idOrName });
        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to run cron job');
        } else {
          printSuccess(`Cron job executed: ${idOrName}`);
          console.log(this.formatCronRunResult(result));
        }
        break;
      }
      case 'create': {
        const name = args[1];
        const parsed = this.parseCronCreateArgs(args.slice(2));

        if (!name || !parsed) {
          printError('Usage: /cron create <name> <schedule> <tool> [jsonArgs]');
          return;
        }

        const { schedule, tool, rawArgs } = parsed;

        let parsedArgs: Record<string, unknown> = {};
        if (rawArgs) {
          try {
            parsedArgs = JSON.parse(rawArgs);
          } catch {
            printError('Invalid JSON args for /cron create');
            return;
          }
        }

        const result = await this.builtInTools.executeTool('cron_create', {
          name,
          schedule,
          tool,
          args: parsedArgs,
        });

        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to create cron job');
        } else {
          printSuccess(`Cron job created: ${name}`);
          console.log(this.getToolResultDisplayText(result));
          if (!this.options.runLocalCronScheduler) {
            await this.ensureBackgroundCronDaemon(true);
          }
        }
        break;
      }
      case 'create-news': {
        const name = args[1];
        const newsType = args[2]?.toLowerCase();
        const parsed = this.parseCronNewsArgs(args.slice(3));

        if (!name || !newsType || !parsed) {
          printError('Usage: /cron create-news <name> <morning|evening|hot> <schedule> [timezone]');
          return;
        }

        const { schedule, timezone } = parsed;

        const mapping: Record<string, { tool: string; args?: Record<string, unknown>; description: string }> = {
          morning: { tool: 'tencent_morning_news', description: 'Tencent morning news push' },
          evening: { tool: 'tencent_evening_news', description: 'Tencent evening news push' },
          hot: { tool: 'tencent_hot_news', args: { limit: 10 }, description: 'Tencent hot news push' },
        };

        const preset = mapping[newsType];
        if (!preset) {
          printError('Unknown news type. Use morning, evening, or hot.');
          return;
        }

        const result = await this.builtInTools.executeTool('cron_create', {
          name,
          schedule,
          tool: preset.tool,
          args: preset.args || {},
          description: preset.description,
          timezone,
        });

        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to create news cron job');
        } else {
          printSuccess(`News cron job created: ${name}`);
          console.log(this.getToolResultDisplayText(result));
        }
        break;
      }
      case 'create-news-lark': {
        const name = args[1];
        const newsType = args[2]?.toLowerCase();
        const parsed = this.parseCronNewsLarkArgs(args.slice(3));

        if (!name || !newsType || !parsed) {
          printError('Usage: /cron create-news-lark <name> <morning|evening|hot|search> <schedule> [--chat-id <oc_xxx>] [--limit <n>] [--keyword <text>] [--title <text>] [--save] [--timezone <Asia/Shanghai>]\n默认接收目标读取 notifications.lark.morningNews.chatId');
          return;
        }

        if (!['morning', 'evening', 'hot', 'search'].includes(newsType)) {
          printError('Unknown news type. Use morning, evening, hot, or search.');
          return;
        }

        const result = await this.builtInTools.executeTool('cron_create', {
          name,
          schedule: parsed.schedule,
          tool: 'push_news_to_lark',
          args: {
            newsType,
            ...parsed.toolArgs,
          },
          description: `Tencent ${newsType} news to Lark`,
          timezone: parsed.timezone,
        });

        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to create Lark news cron job');
        } else {
          printSuccess(`Lark news cron job created: ${name}`);
          console.log(this.getToolResultDisplayText(result));
        }
        break;
      }
      case 'create-weather-lark': {
        const name = args[1];
        const parsed = this.parseCronWeatherLarkArgs(args.slice(2));

        if (!name || !parsed) {
          printError('Usage: /cron create-weather-lark <name> <schedule> [--city <城市>] [--chat-id <oc_xxx>] [--timezone <Asia/Shanghai>]\n默认接收目标读取 notifications.lark.weather.chatId 或 notifications.lark.morningNews.chatId');
          return;
        }

        const result = await this.builtInTools.executeTool('cron_create', {
          name,
          schedule: parsed.schedule,
          tool: 'push_weather_to_lark',
          args: parsed.toolArgs,
          description: `Daily weather to Lark${parsed.toolArgs.city ? ` (${String(parsed.toolArgs.city)})` : ''}`,
          timezone: parsed.timezone,
        });

        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to create Lark weather cron job');
        } else {
          printSuccess(`Lark weather cron job created: ${name}`);
          console.log(this.getToolResultDisplayText(result));
        }
        break;
      }
      case 'create-morning-feishu': {
        printError('create-morning-feishu 已废弃。push_news_to_lark 仅支持群聊 chatId，请改用 /cron create-morning-feishu-group [oc_xxx]');
        break;
      }
      case 'create-morning-feishu-group': {
        await this.createPresetMorningFeishuCron('group', args[1]);
        break;
      }
      case 'delete': {
        const idOrName = args[1];
        if (!idOrName) {
          printError('Usage: /cron delete <idOrName>');
          return;
        }

        const result = await this.builtInTools.executeTool('cron_delete', { idOrName });
        if (result.is_error) {
          printError(this.getToolResultDisplayText(result) || 'Failed to delete cron job');
        } else {
          printSuccess(`Cron job deleted: ${idOrName}`);
        }
        break;
      }
      case 'run-due': {
        await this.cronManager.runDueJobs(new Date());
        printSuccess('Triggered due cron jobs check');
        break;
      }
      case 'help':
      default:
        console.log(`
${chalk.bold('Cron Commands:')}
${chalk.cyan('/cron')}                         查看 cron 列表
${chalk.cyan('/cron list')}                    列出 cron 任务
${chalk.cyan('/cron create')} <name> <schedule> <tool> [jsonArgs]
${chalk.cyan('/cron create-news')} <name> <morning|evening|hot> <schedule> [timezone]
${chalk.cyan('/cron create-news-lark')} <name> <type> <schedule> [flags]
${chalk.cyan('/cron create-weather-lark')} <name> <schedule> [flags]
${chalk.cyan('/cron create-morning-feishu')}                已废弃，请改用 group 版本
${chalk.cyan('/cron create-morning-feishu-group')} [oc_xxx]
${chalk.cyan('/cron start')} [idOrName]       启动后台调度器或启用指定任务
${chalk.cyan('/cron stop')} [idOrName]        停止后台调度器或停用指定任务
${chalk.cyan('/cron run')} <idOrName>         立即强制执行指定任务一次
${chalk.cyan('/cron delete')} <idOrName>      删除 cron 任务
${chalk.cyan('/cron run-due')}                立即检查当前到期任务

${chalk.gray('示例:')}
${chalk.gray('/cron create-news morning-brief morning 0 8 * * * Asia/Shanghai')}
${chalk.gray('/cron create hot-news 0 9 * * * tencent_hot_news {"limit":5}')}
${chalk.gray('/cron create-news-lark morning-feishu morning 0 8 * * * --save')}
${chalk.gray('/cron create-weather-lark daily-weather 0 9 * * * --city 北京')}
${chalk.gray('/cron create-morning-feishu-group oc_xxx')}
${chalk.gray('/cron create-morning-feishu-group')}
`);
    }
  }

  private async handleDaemonCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase() || 'status';

    if (this.options.runLocalCronScheduler) {
      if (subcommand === 'status' || subcommand === 'help') {
        console.log(chalk.bold('\nBackground Daemon:\n'));
        console.log(chalk.gray('当前 CLI 运行在本地 cron 模式，未使用后台 daemon。'));
        console.log(chalk.gray('可用 /cron list 查看当前调度器状态。'));
        console.log();
        return;
      }

      printInfo('当前启用了本地 cron 调度模式，/daemon start|stop|restart 不适用。');
      return;
    }

    switch (subcommand) {
      case 'status': {
        const status = await this.backgroundDaemon?.getStatus();
        if (!status) {
          printError('Background daemon manager not initialized');
          return;
        }

        console.log(chalk.bold('\nBackground Daemon:\n'));
        console.log(`  Running: ${status.running ? chalk.green('yes') : chalk.yellow('no')}`);
        console.log(`  PID: ${status.running ? status.pid : '(none)'}`);
        console.log(`  Started: ${status.startedAt ? new Date(status.startedAt).toLocaleString() : '(unknown)'}`);
        const schedulerKnown = typeof status.cronSchedulerRunning === 'boolean';
        const schedulerRunning = status.cronSchedulerRunning ?? status.running;
        console.log(`  Scheduler: ${schedulerRunning ? chalk.green('running') : chalk.yellow('stopped')}${schedulerKnown ? '' : chalk.gray(' (legacy state, inferred)')}`);
        console.log(`  Config: ${status.configPath || '(none)'}`);
        console.log(`  Workspace: ${status.workspace || '(none)'}`);
        console.log(`  Log: ${status.logFile}`);

        if ((status.mcpServers?.length || 0) > 0) {
          console.log(chalk.cyan('  MCP:'));
          for (const server of status.mcpServers || []) {
            const statusText = server.status === 'connected' ? chalk.green('connected') : chalk.red('failed');
            console.log(`    - ${server.name}: ${statusText}${server.detail ? ` (${server.detail})` : ''}`);
          }
        }

        if ((status.lspServers?.length || 0) > 0) {
          console.log(chalk.cyan('  LSP:'));
          for (const server of status.lspServers || []) {
            const statusText = server.status === 'connected' ? chalk.green('connected') : chalk.red('failed');
            console.log(`    - ${server.name}: ${statusText}${server.detail ? ` (${server.detail})` : ''}`);
          }
        }

        console.log();
        break;
      }
      case 'start': {
        const status = await this.ensureBackgroundCronDaemon();
        printSuccess(`Background daemon started${status?.pid ? ` (pid=${status.pid})` : ''}`);
        break;
      }
      case 'stop': {
        const stopped = await this.backgroundDaemon?.stop();
        if (stopped) {
          printSuccess('Background daemon stopped');
        } else {
          printInfo('Background daemon was not running');
        }
        break;
      }
      case 'restart': {
        await this.backgroundDaemon?.stop();
        const status = await this.ensureBackgroundCronDaemon();
        printSuccess(`Background daemon restarted${status?.pid ? ` (pid=${status.pid})` : ''}`);
        break;
      }
      case 'help':
      default:
        console.log(`
${chalk.bold('Daemon Commands:')}
${chalk.cyan('/daemon')}                         查看后台 daemon 状态
${chalk.cyan('/daemon status')}                  显示后台 daemon 状态、PID、日志路径
${chalk.cyan('/daemon start')}                   启动后台 daemon
${chalk.cyan('/daemon stop')}                    停止后台 daemon
${chalk.cyan('/daemon restart')}                 重启后台 daemon
`);
    }
  }

  private async createPresetMorningFeishuCron(targetType: 'group', overrideTarget?: string): Promise<void> {
    if (!this.builtInTools) {
      printError('Built-in tools not initialized');
      return;
    }

    const preset = this.getMorningFeishuPreset(targetType, overrideTarget);
    if (!preset) {
      printError('Missing target. 请传入参数，或在配置文件中设置 notifications.lark.morningNews.chatId');
      return;
    }

    const result = await this.builtInTools.executeTool('cron_create', {
      name: preset.name,
      schedule: preset.schedule,
      tool: 'push_news_to_lark',
      args: preset.toolArgs,
      description: preset.description,
      timezone: preset.timezone,
    });

    if (result.is_error) {
      printError(this.getToolResultDisplayText(result) || 'Failed to create preset morning Lark cron job');
      return;
    }

    printSuccess(`Morning Lark cron job created: ${preset.name}`);
    console.log(this.getToolResultDisplayText(result));
  }

  private getMorningFeishuPreset(targetType: 'group', overrideTarget?: string): {
    name: string;
    schedule: string;
    timezone?: string;
    description: string;
    toolArgs: Record<string, unknown>;
  } | null {
    const config = configManager.getAll();
    const morningNews = config.notifications?.lark?.morningNews;
    const target = (overrideTarget || morningNews?.chatId || '').trim();
    if (!target) {
      return null;
    }

    const schedule = morningNews?.schedule || '0 8 * * *';
    const timezone = morningNews?.timezone || 'Asia/Shanghai';
    const saveOutput = morningNews?.saveOutput ?? true;
    const title = morningNews?.title;
    const toolArgs: Record<string, unknown> = {
      newsType: 'morning',
      timezone,
    };

    toolArgs.chatId = target;

    if (saveOutput) {
      toolArgs.saveOutput = true;
    }
    if (title) {
      toolArgs.title = title;
    }

    return {
      name: 'morning-feishu-group',
      schedule,
      timezone,
      description: 'Tencent morning news to configured Lark group',
      toolArgs,
    };
  }

  private parseCronNewsLarkArgs(args: string[]): { schedule: string; timezone?: string; toolArgs: Record<string, unknown> } | null {
    if (args.length === 0) {
      return null;
    }

    let schedule = '';
    let rest: string[] = [];
    if (args[0]?.startsWith('@')) {
      schedule = this.normalizeCronToken(args[0]);
      rest = args.slice(1);
    } else if (args.length >= 5) {
      schedule = this.normalizeCronToken(args.slice(0, 5).join(' '));
      rest = args.slice(5);
    } else {
      return null;
    }

    const flags = this.parseCliFlags(rest);
    let chatId = flags['chat-id'];
    if (flags['user-id']) {
      return null;
    }

    if (!chatId) {
      const configuredTarget = this.getDefaultLarkNewsTarget();
      chatId = configuredTarget?.chatId;
      if (!chatId) {
        return null;
      }
    }

    const toolArgs: Record<string, unknown> = {};
    if (chatId) {
      toolArgs.chatId = chatId;
    }
    if (flags.keyword) {
      toolArgs.keyword = flags.keyword;
    }
    if (flags.limit) {
      const parsedLimit = Number.parseInt(flags.limit, 10);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        toolArgs.limit = parsedLimit;
      }
    }
    if (flags.title) {
      toolArgs.title = flags.title;
    }
    if (flags.save === 'true') {
      toolArgs.saveOutput = true;
    }
    if (flags.timezone) {
      toolArgs.timezone = flags.timezone;
    }

    return {
      schedule,
      timezone: flags.timezone,
      toolArgs,
    };
  }

  private parseCronWeatherLarkArgs(args: string[]): { schedule: string; timezone?: string; toolArgs: Record<string, unknown> } | null {
    if (args.length === 0) {
      return null;
    }

    let schedule = '';
    let rest: string[] = [];
    if (args[0]?.startsWith('@')) {
      schedule = this.normalizeCronToken(args[0]);
      rest = args.slice(1);
    } else if (args.length >= 5) {
      schedule = this.normalizeCronToken(args.slice(0, 5).join(' '));
      rest = args.slice(5);
    } else {
      return null;
    }

    const flags = this.parseCliFlags(rest);
    const defaults = this.getDefaultLarkWeatherTarget();
    const chatId = flags['chat-id'] || defaults?.chatId;
    if (!chatId) {
      return null;
    }

    const toolArgs: Record<string, unknown> = { chatId };
    if (flags.city) {
      toolArgs.city = flags.city;
    } else if (defaults?.city) {
      toolArgs.city = defaults.city;
    }
    if (flags.timezone) {
      toolArgs.timezone = flags.timezone;
    } else if (defaults?.timezone) {
      toolArgs.timezone = defaults.timezone;
    }

    return {
      schedule,
      timezone: typeof toolArgs.timezone === 'string' ? toolArgs.timezone : undefined,
      toolArgs,
    };
  }

  private getDefaultLarkNewsTarget(): { chatId?: string } | null {
    const morningNews = configManager.getAll().notifications?.lark?.morningNews;
    const chatId = morningNews?.chatId?.trim();

    if (chatId) {
      return { chatId };
    }

    return null;
  }

  private getDefaultLarkWeatherTarget(): { chatId?: string; city?: string; timezone?: string } | null {
    const lark = configManager.getAll().notifications?.lark;
    const weather = lark?.weather;
    const morningNews = lark?.morningNews;
    const chatId = weather?.chatId?.trim() || morningNews?.chatId?.trim();
    if (!chatId) {
      return null;
    }

    return {
      chatId,
      city: weather?.city?.trim(),
      timezone: weather?.timezone?.trim() || morningNews?.timezone?.trim(),
    };
  }

  async runCronDaemon(runOnce = false): Promise<void> {
    if (!this.cronManager) {
      throw new Error('Cron manager not initialized');
    }

    const jobs = this.cronManager.listJobs();
    console.log(chalk.bold('\nCron Runner\n'));
    console.log(chalk.gray(`Loaded ${jobs.length} cron job(s).`));
    if (jobs.length > 0) {
      for (const job of jobs) {
        console.log(chalk.cyan(`  • ${job.name}`) + chalk.gray(` -> ${job.toolName} @ ${job.schedule}`));
      }
    }
    console.log();

    await this.cronManager.runDueJobs(new Date());
    if (runOnce) {
      return;
    }

    console.log(chalk.gray('Cron daemon is running. Press Ctrl+C to stop.\n'));
    return new Promise(() => {});
  }

  private parseCronCreateArgs(args: string[]): { schedule: string; tool: string; rawArgs: string } | null {
    if (args.length < 2) {
      return null;
    }

    if (args[0]?.startsWith('@')) {
      const schedule = args[0];
      const tool = args[1];
      if (!schedule || !tool) {
        return null;
      }

      return {
        schedule: this.normalizeCronToken(schedule),
        tool,
        rawArgs: args.slice(2).join(' ').trim(),
      };
    }

    if (args.length < 6) {
      return null;
    }

    const schedule = args.slice(0, 5).join(' ');
    const tool = args[5];
    if (!tool) {
      return null;
    }

    return {
      schedule: this.normalizeCronToken(schedule),
      tool,
      rawArgs: args.slice(6).join(' ').trim(),
    };
  }

  private parseCronNewsArgs(args: string[]): { schedule: string; timezone?: string } | null {
    if (args.length === 0) {
      return null;
    }

    if (args[0]?.startsWith('@')) {
      return {
        schedule: this.normalizeCronToken(args[0]),
        timezone: args[1],
      };
    }

    if (args.length < 5) {
      return null;
    }

    return {
      schedule: this.normalizeCronToken(args.slice(0, 5).join(' ')),
      timezone: args[5],
    };
  }

  private normalizeCronToken(value: string): string {
    return value.replace(/^['"]|['"]$/g, '');
  }

  private showHistory(): void {
    console.log(chalk.bold('\nCommand History:\n'));
    this.cmdHistory.forEach((cmd, i) => {
      console.log(chalk.gray(`${i + 1}. ${cmd}`));
    });
    console.log();
  }

  private showTools(): void {
    if (!this.agent) return;
    
    console.log(chalk.bold(`\nAvailable Tools (${this.agent.getToolCount()}):\n`));
    
    const tools = this.builtInTools?.getTools() ?? [];
    for (const tool of tools) {
      console.log(chalk.cyan(`  • ${tool.name}`) + chalk.gray(` - ${tool.description.split('.')[0]}`));
    }
    
    console.log();
  }

  private showConfig(): void {
    const config = configManager.getAll();
    console.log(chalk.bold('\nCurrent Configuration:\n'));
    console.log(`  Path: ${configManager.getConfigPath()}`);
    console.log(`  App Base Dir: ${config.appBaseDir}`);
    console.log(`  Browser Actions Dir: ${path.join(config.appBaseDir || path.join(os.homedir(), '.ai-agent-cli'), 'actions')}`);
    console.log(`  Workspace: ${config.workspace}`);
    console.log(chalk.gray('Ollama:'));
    console.log(`  URL: ${config.ollama.baseUrl}`);
    console.log(`  Model: ${config.ollama.model}`);
    console.log(`  Temperature: ${config.ollama.temperature}`);
    console.log(chalk.gray('\nSandbox:'));
    console.log(`  Enabled: ${config.sandbox?.enabled ?? true}`);
    console.log(`  Timeout: ${config.sandbox?.timeout ?? 30000}ms`);
    console.log(chalk.gray('\nMemory:'));
    console.log(`  Session: ${this.memoryManager.getCurrentSessionId()}`);
    console.log(`  Messages: ${this.memoryManager.getMessages().length}`);
    console.log(chalk.gray('\nNotifications:'));
    console.log(`  Morning Lark User: ${config.notifications?.lark?.morningNews?.userId || '(not set)'}`);
    console.log(`  Morning Lark Group: ${config.notifications?.lark?.morningNews?.chatId || '(not set)'}`);
    console.log(`  Morning Schedule: ${config.notifications?.lark?.morningNews?.schedule || '0 8 * * *'}`);
    console.log(`  Morning Timezone: ${config.notifications?.lark?.morningNews?.timezone || 'Asia/Shanghai'}`);
    console.log(`  Relay Enabled: ${config.notifications?.lark?.relay?.enabled ? 'yes' : 'no'}`);
    console.log(`  Relay Auto Subscribe: ${config.notifications?.lark?.relay?.autoSubscribe === false ? 'no' : 'yes'}`);
    console.log(`  Relay Event Types: ${(config.notifications?.lark?.relay?.eventTypes || ['im.message.receive_v1']).join(', ')}`);
    if (config.hybrid?.enabled) {
      console.log(chalk.gray('\nHybrid Routing:'));
      console.log(`  Local Provider: ${config.hybrid.localProvider}`);
      console.log(`  Remote Provider: ${config.hybrid.remoteProvider}`);
      console.log(`  Simple Task Max Chars: ${config.hybrid.simpleTaskMaxChars || 80}`);
      console.log(`  Simple Conversation Max Chars: ${config.hybrid.simpleConversationMaxChars || 6000}`);
      console.log(`  Local Availability Cache: ${config.hybrid.localAvailabilityCacheMs || 15000}ms`);
    }
    console.log();
  }

  private async editConfigFile(): Promise<void> {
    const editor = new TerminalConfigEditor({
      filePath: configManager.getConfigPath(),
      title: 'AI Agent CLI Config Editor',
    });

    try {
      const result = await editor.edit();
      console.clear();
      console.log(chalk.cyan(logo));

      if (result.saved) {
        printSuccess(`Config saved: ${configManager.getConfigPath()}`);
        await this.reloadRuntimeConfig();
      } else {
        printInfo('Config editor closed without saving.');
      }
    } catch (error) {
      console.clear();
      console.log(chalk.cyan(logo));
      printError(`Config editor failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async reloadRuntimeConfig(): Promise<void> {
    const configPath = configManager.getConfigPath();
    const previousMessages = this.agent?.getMessages() || this.memoryManager.getMessages();

    try {
      await configManager.loadFromFile(configPath);
    } catch (error) {
      printError(`Config reload failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const config = configManager.getAgentConfig();
    this.currentProvider = config.defaultProvider || 'ollama';
    this.workspace = config.workspace || this.workspace;
    this.applyGlobalPathsFromConfig(config);

    try {
      await this.rebuildRuntimeFromConfig(config, previousMessages);
      const connected = this.llm ? await this.llm.checkConnection().catch(() => false) : false;
      if (connected) {
        printSuccess(`Config reloaded from ${configPath}`);
        printInfo(`当前 provider: ${this.currentProvider} (${this.llm?.getModel() || 'unknown'})`);
      } else {
        printWarning(`Config reloaded from ${configPath}，但 ${this.currentProvider} 当前未连接`);
      }
    } catch (error) {
      printError(`Runtime refresh failed after config reload: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async saveAndReloadRuntimeConfig(): Promise<boolean> {
    const configPath = configManager.getConfigPath();
    const previousMessages = this.agent?.getMessages() || this.memoryManager.getMessages();

    await configManager.saveToFile(configPath);
    await configManager.loadFromFile(configPath);

    const config = configManager.getAgentConfig();
    this.currentProvider = config.defaultProvider || 'ollama';
    this.workspace = config.workspace || this.workspace;
    this.applyGlobalPathsFromConfig(config);
    await this.rebuildRuntimeFromConfig(config, previousMessages);

    return this.llm ? await this.llm.checkConnection().catch(() => false) : false;
  }

  private async rebuildRuntimeFromConfig(config: any, messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }>): Promise<void> {
    const sandboxConfig = config.sandbox || { enabled: true, timeout: 30000 };
    if (!sandboxConfig.allowedPaths) {
      sandboxConfig.allowedPaths = [config.workspace || this.workspace || process.cwd()];
    }

    const artifactOutputDir = getArtifactOutputDir({
      workspace: this.workspace,
      appBaseDir: config.appBaseDir,
      artifactOutputDir: config.artifactOutputDir,
      documentOutputDir: config.documentOutputDir,
    });
    const desktopPath = getDesktopPath();
    const obsidianVaultPath = extractObsidianVaultPath(config);
    for (const extraPath of [artifactOutputDir, desktopPath, obsidianVaultPath].filter(Boolean) as string[]) {
      if (!sandboxConfig.allowedPaths.includes(extraPath)) {
        sandboxConfig.allowedPaths.push(extraPath);
      }
    }
    const permConfig = this.permissionMgr?.getConfig();
    for (const allowedPath of permConfig?.allowedPaths || []) {
      if (!sandboxConfig.allowedPaths.includes(allowedPath)) {
        sandboxConfig.allowedPaths.push(allowedPath);
      }
    }

    this.sandbox = new Sandbox(sandboxConfig);
    await this.sandbox.initialize();

    this.llm = this.createLLMClient(config);
    this.intentResolver = new IntentResolver(this.llm);

    if (this.enhancedMemory) {
      this.memoryProvider = createMemoryProvider({
        enhancedMemory: this.enhancedMemory,
        mcpManager: this.mcpManager,
        config: config.memory,
        skillManager: this.skillManager,
      });
    }

    this.builtInTools = new BuiltInTools(this.sandbox, this.lspManager, {
      mcpManager: this.mcpManager,
      taskManager: this.taskManager,
      cronManager: this.cronManager,
      workspace: this.workspace,
      config: config as unknown as Record<string, unknown>,
    });

    this.cronManager?.setExecutor((toolName, args) => this.builtInTools!.executeTool(toolName, args));
    this.cronManager?.setNotifier(async ({ job, result }) => {
      const content = this.getToolResultDisplayText(result) || '(无输出)';
      console.log();
      console.log(chalk.magenta(`[Cron] ${job.name}`));
      if (result.is_error) {
        printError(content);
      } else {
        console.log(chalk.gray(`schedule: ${job.schedule} -> ${job.toolName}`));
        console.log(content);
      }
      console.log();
    });

    if (this.options.ensureBackgroundDaemon && !this.options.runLocalCronScheduler) {
      await this.ensureBackgroundCronDaemon(true);
    }

    await this.reloadConfiguredMCPServers(config);
    await this.reloadConfiguredLSPServers(config);

    this.directActionRouter = createDirectActionRouter({
      builtInTools: this.builtInTools,
      skillManager: this.skillManager,
      permissionManager: this.permissionMgr!,
      workspace: this.workspace,
      config,
      getConversationMessages: () => this.agent?.getMessages() || this.memoryManager.getMessages(),
      memoryProvider: this.memoryProvider,
      intentResolver: this.intentResolver,
      onConversationPreamble: (message) => this.showDirectActionPreamble(message),
    });

    this.agent = createAgent({
      llm: this.llm!,
      mcpManager: this.mcpManager,
      lspManager: this.lspManager,
      sandbox: this.sandbox,
      builtInTools: this.builtInTools,
      skillManager: this.skillManager,
      maxIterations: config.maxIterations,
      maxToolCallsPerTurn: config.maxToolCallsPerTurn,
      planner: createPlanner({ llm: this.llm!, memoryProvider: this.memoryProvider, skillManager: this.skillManager }),
      intentResolver: this.intentResolver,
      memoryProvider: this.memoryProvider,
      config: config as unknown as Record<string, unknown>,
    });

    if (messages.length > 0) {
      this.agent.setMessages(messages);
      this.memoryManager.setMessages(messages);
      await this.memoryProvider?.syncSession(messages);
    }

    await this.restartLarkRelay(config);
  }

  private async reloadConfiguredMCPServers(config: any): Promise<void> {
    await this.mcpManager.disconnectAll();

    for (const mcpConfig of config.mcp || []) {
      try {
        await this.mcpManager.addServer(mcpConfig);
      } catch (error) {
        printWarning(`MCP server ${mcpConfig.name} reload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async reloadConfiguredLSPServers(config: any): Promise<void> {
    await this.lspManager.disconnectAll();

    for (const lspConfig of config.lsp || []) {
      try {
        await this.lspManager.addServer(lspConfig, `file://${this.workspace}`);
      } catch (error) {
        printWarning(`LSP server ${lspConfig.name} reload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private showModels(): void {
    const config = configManager.getAll();
    console.log(chalk.bold('\nAvailable Models:\n'));
    
    const providers = [
      { name: 'Ollama', config: config.ollama, enabled: config.ollama.enabled },
      { name: 'DeepSeek', config: config.deepseek, enabled: config.deepseek?.enabled },
      { name: 'Kimi', config: config.kimi, enabled: config.kimi?.enabled },
      { name: 'GLM', config: config.glm, enabled: config.glm?.enabled },
      { name: 'Doubao', config: config.doubao, enabled: config.doubao?.enabled },
      { name: 'MiniMax', config: config.minimax, enabled: config.minimax?.enabled },
      { name: 'OpenAI', config: config.openai, enabled: config.openai?.enabled },
      { name: 'Claude', config: config.claude, enabled: config.claude?.enabled },
      { name: 'Gemini', config: config.gemini, enabled: config.gemini?.enabled },
      { name: 'Hybrid', config: config.hybrid, enabled: config.hybrid?.enabled },
    ];

    const defaultProvider = config.defaultProvider;
    
    for (const provider of providers) {
      if (provider.config?.enabled) {
        const isDefault = provider.name.toLowerCase() === defaultProvider;
        const marker = isDefault ? chalk.green(' (默认)') : '';
        console.log(`${chalk.cyan(provider.name)}${marker}`);
        if ('model' in provider.config) {
          console.log(`  Model: ${provider.config.model}`);
          if ('reasoningModel' in provider.config && provider.config.reasoningModel) {
            console.log(`  Reasoning: ${provider.config.reasoningModel}`);
          }
          if (provider.config.baseUrl) {
            console.log(`  URL: ${provider.config.baseUrl}`);
          }
        }
        if ('localProvider' in provider.config) {
          console.log(`  Local: ${provider.config.localProvider}`);
          console.log(`  Remote: ${provider.config.remoteProvider}`);
          console.log(`  Cache TTL: ${provider.config.localAvailabilityCacheMs || 15000}ms`);
        }
        console.log();
      }
    }

    console.log(chalk.gray('Use /model <provider> <model> to switch'));
    console.log();
  }

  private async changeModel(model: string): Promise<void> {
    if (!this.llm) return;
    
    try {
      this.llm.setModel(model);
      const connected = await this.llm.checkConnection();
      if (connected) {
        printSuccess('Model changed to: ' + model);
      } else {
        printError('Failed to verify model. Please ensure the model is available.');
      }
    } catch (error) {
      printError('Error: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private async switchProvider(provider: string): Promise<void> {
    const normalizedProvider = provider.toLowerCase();
    const currentConfig = configManager.getAgentConfig();
    const supportedProviders: LLMProvider[] = ['ollama', 'deepseek', 'kimi', 'glm', 'doubao', 'minimax', 'openai', 'claude', 'gemini', 'hybrid'];

    if (!supportedProviders.includes(normalizedProvider as LLMProvider)) {
      printError(`Provider not found: ${provider}. Use /model to see available providers.`);
      return;
    }

    const providerKey = normalizedProvider as LLMProvider;
    const providerConfig = currentConfig[providerKey];

    if (!providerConfig) {
      printError(`Provider not found: ${provider}. Use /model to see available providers.`);
      return;
    }

    try {
      if (normalizedProvider === 'deepseek') {
        const existingDeepSeek = currentConfig.deepseek;
        configManager.set('deepseek', {
          enabled: true,
          baseUrl: existingDeepSeek?.baseUrl || 'https://api.deepseek.com',
          apiKey: existingDeepSeek?.apiKey,
          model: existingDeepSeek?.model || 'deepseek-chat',
          reasoningModel: existingDeepSeek?.reasoningModel || 'deepseek-reasoner',
          temperature: existingDeepSeek?.temperature ?? 0.7,
          maxTokens: existingDeepSeek?.maxTokens ?? 4096,
          systemPrompt: existingDeepSeek?.systemPrompt,
          autoReasoning: {
            enabled: true,
            simpleTaskMaxChars: existingDeepSeek?.autoReasoning?.simpleTaskMaxChars ?? 120,
            simpleConversationMaxChars: existingDeepSeek?.autoReasoning?.simpleConversationMaxChars ?? 8000,
            preferReasonerForToolMessages: existingDeepSeek?.autoReasoning?.preferReasonerForToolMessages ?? true,
            preferReasonerForPlanning: existingDeepSeek?.autoReasoning?.preferReasonerForPlanning ?? true,
            preferReasonerForLongContext: existingDeepSeek?.autoReasoning?.preferReasonerForLongContext ?? true,
          },
        });
      } else if (!providerConfig.enabled) {
        printError(`Provider "${provider}" is disabled. Please enable it in config first.`);
        return;
      }

      configManager.set('defaultProvider', normalizedProvider);
      const connected = await this.saveAndReloadRuntimeConfig();

      if (connected) {
        if (normalizedProvider === 'deepseek') {
          printSuccess(`Switched to provider: ${normalizedProvider} (${this.llm?.getModel() || 'unknown'})`);
          printInfo('DeepSeek auto reasoning 已启用：将同时使用 deepseek-chat 和 deepseek-reasoner，并根据复杂度自动切换。');
        } else {
          printSuccess(`Switched to provider: ${normalizedProvider} (${this.llm?.getModel() || 'unknown'})`);
        }
      } else {
        if (normalizedProvider === 'deepseek') {
          printWarning(`Switched to ${normalizedProvider} and enabled auto reasoning, but connection failed.`);
        } else {
          printWarning(`Switched to ${normalizedProvider}, but connection failed.`);
        }
      }
    } catch (error) {
      printError('Error: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private async handleMCPCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    switch (subcommand) {
      case 'list':
        console.log(chalk.bold('\nMCP Servers:\n'));
        const serverNames = this.mcpManager.getServerNames();
        if (serverNames.length === 0) {
          console.log(chalk.gray('No MCP servers connected.'));
        } else {
          for (const serverName of serverNames) {
            console.log(chalk.cyan(`  • ${serverName}`));
          }
        }
        console.log();
        break;
      case 'tools':
        console.log(chalk.bold('\nMCP Tools:\n'));
        const tools = await this.mcpManager.listAllTools();
        if (tools.length === 0) {
          console.log(chalk.gray('No MCP tools available.'));
        } else {
          for (const { server, tool } of tools) {
            console.log(chalk.cyan(`  [${server}] ${tool.name}`) + chalk.gray(` - ${tool.description}`));
          }
        }
        console.log();
        break;
      case 'check':
      case 'status':
        await this.checkMCPServer(args[1]?.toLowerCase() || 'mempalace');
        break;
      case 'reconnect':
      case 'reload':
        await this.reconnectMCPServer(args[1]?.toLowerCase());
        break;
      default:
        console.log(chalk.yellow('Usage: /mcp [list|tools|check|status|reconnect]'));
    }
  }

  private async reconnectMCPServer(serverName?: string): Promise<void> {
    const targetName = serverName || 'lark';
    const config = configManager.getAll();
    const serverConfig = config.mcp?.find(item => item.name.toLowerCase() === targetName);

    console.log(chalk.bold(`\nMCP Reconnect: ${targetName}\n`));

    if (!serverConfig) {
      printError(`MCP server not configured: ${targetName}`);
      console.log();
      return;
    }

    try {
      await this.mcpManager.removeServer(serverConfig.name);
      await this.mcpManager.addServer(serverConfig);
      printSuccess(`Reconnected MCP server: ${serverConfig.name}`);
      console.log();
    } catch (error) {
      printError(`Reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
      console.log();
      return;
    }

    await this.checkMCPServer(serverConfig.name.toLowerCase());
  }

  private async checkMCPServer(serverName: string): Promise<void> {
    const client = this.mcpManager.getClient(serverName);

    console.log(chalk.bold(`\nMCP Check: ${serverName}\n`));

    if (!client) {
      console.log(chalk.red(`Server not connected: ${serverName}`));
      console.log();
      return;
    }

    const tools = client.getTools();
    console.log(chalk.green(`Connected: ${serverName}`));
    console.log(`Tools: ${tools.length}`);

    if (serverName === 'mempalace') {
      try {
        const result = await this.mcpManager.callTool('mempalace', 'mempalace_status', {});
        const output = this.getToolResultDisplayText(result);
        if (output.length > 0) {
          console.log();
          console.log(output);
        }
      } catch (error) {
        printWarning(`MemPalace status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (serverName === 'lark') {
      try {
        const result = await this.mcpManager.callTool('lark', 'auth_status', { verify: true });
        const output = this.getToolResultDisplayText(result);
        if (output.length > 0) {
          console.log();
          console.log(output);
        }
      } catch (error) {
        printWarning(`Lark auth status failed: ${error instanceof Error ? error.message : String(error)}`);
        printInfo('Try: /mcp reconnect lark');
      }
    } else if (tools.length > 0) {
      console.log();
      for (const tool of tools.slice(0, 10)) {
        console.log(chalk.cyan(`  • ${tool.name}`) + chalk.gray(` - ${tool.description}`));
      }
      if (tools.length > 10) {
        console.log(chalk.gray(`  ... and ${tools.length - 10} more tools`));
      }
    }

    console.log();
  }

  private async handleLSPCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    switch (subcommand) {
      case 'list':
        console.log(chalk.bold('\nLSP Servers:\n'));
        console.log(chalk.gray('No LSP servers configured.'));
        console.log();
        break;
      case 'status':
        console.log(chalk.bold('\nLSP Status:\n'));
        console.log(chalk.gray('No LSP servers connected.'));
        console.log();
        break;
      default:
        console.log(chalk.yellow('Usage: /lsp [list|status]'));
    }
  }

  private async handleSkillCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();
    const skillName = args[1];

    switch (subcommand) {
      case 'list':
      case 'ls':
        console.log(chalk.bold('\nInstalled Skills:\n'));
        const skills = await this.skillManager.listSkills();
        if (skills.length === 0) {
          console.log(chalk.gray('No skills installed. Use /skill install <source> to add one.'));
        } else {
          for (const skill of skills) {
            const status = skill.enabled ? chalk.green('✓') : chalk.gray('○');
            console.log(`${status} ${chalk.cyan(skill.name)} ${chalk.gray(`v${skill.version}`)}`);
            if (skill.description) {
              console.log(chalk.gray(`  ${skill.description}`));
            }
          }
        }
        console.log();
        break;

      case 'candidates':
      case 'drafts': {
        console.log(chalk.bold('\nSkill Candidates:\n'));
        const candidates = await this.skillManager.listSkillCandidates();
        if (candidates.length === 0) {
          console.log(chalk.gray('No learned skill candidates yet. Complex successful tasks will create drafts here.'));
        } else {
          for (const candidate of candidates) {
            console.log(`${chalk.yellow('•')} ${chalk.cyan(candidate.name)} ${chalk.gray(candidate.createdAt)}`);
            if (candidate.description) {
              console.log(chalk.gray(`  ${candidate.description}`));
            }
            if (candidate.sourceTask) {
              console.log(chalk.gray(`  source: ${candidate.sourceTask}`));
            }
          }
        }
        console.log();
        break;
      }

      case 'todos': {
        console.log(chalk.bold('\nSkill Learning Todos:\n'));
        const todos = await this.skillManager.listLearningTodos();
        if (todos.length === 0) {
          console.log(chalk.gray('No pending learning todos. Unresolved tasks will add items here.'));
        } else {
          for (const todo of todos) {
            console.log(`${chalk.yellow('•')} ${chalk.cyan(todo.suggestedSkill)} ${chalk.gray(todo.createdAt)} ${chalk.gray(`[${todo.id}]`)}`);
            console.log(chalk.gray(`  task: ${todo.sourceTask}`));
            console.log(chalk.gray(`  issue: ${todo.issueSummary}`));
            if (todo.nextActions.length > 0) {
              console.log(chalk.gray(`  next: ${todo.nextActions.join(' | ')}`));
            }
            if (todo.draftedCandidateName) {
              console.log(chalk.gray(`  draft: ${todo.draftedCandidateName} (${todo.draftedAt || 'unknown time'})`));
            } else {
              console.log(chalk.gray(`  hint: /skill adopt-from-todo ${todo.id}`));
            }
          }
        }
        console.log();
        break;
      }

      case 'adopt':
        if (!skillName) {
          console.log(chalk.yellow('Usage: /skill adopt <candidate-name>'));
          return;
        }
        try {
          await this.skillManager.adoptCandidate(skillName);
          printSuccess('Skill candidate adopted and enabled: ' + skillName);
        } catch (error) {
          printError('Failed to adopt candidate: ' + (error instanceof Error ? error.message : String(error)));
        }
        break;

      case 'adopt-from-todo':
        if (!skillName) {
          console.log(chalk.yellow('Usage: /skill adopt-from-todo <todo-id|suggested-skill>'));
          return;
        }
        try {
          const candidate = await this.skillManager.createCandidateFromTodo(skillName);
          printSuccess(`Learning todo converted into candidate draft: ${candidate.name}`);
          console.log(chalk.gray(`草稿路径: ${candidate.path}`));
          console.log(chalk.gray(`下一步可执行: /skill adopt ${candidate.name}`));
        } catch (error) {
          printError('Failed to create candidate from todo: ' + (error instanceof Error ? error.message : String(error)));
        }
        break;

      case 'install':
      case 'add':
        if (!skillName) {
          console.log(chalk.yellow('Usage: /skill install <source>'));
          console.log(chalk.gray('  Sources:'));
          console.log(chalk.gray('    npm:package-name'));
          console.log(chalk.gray('    github:owner/repo'));
          console.log(chalk.gray('    ./local/path'));
          return;
        }
        try {
          printInfo(`Installing skill from: ${skillName}...`);
          await this.skillManager.installSkill(skillName);
          printSuccess('Skill installed: ' + skillName);
        } catch (error) {
          printError('Failed to install: ' + (error instanceof Error ? error.message : String(error)));
        }
        break;

      case 'uninstall':
      case 'remove':
        if (!skillName) {
          console.log(chalk.yellow('Usage: /skill uninstall <name>'));
          return;
        }
        try {
          await this.skillManager.uninstallSkill(skillName);
          printSuccess('Skill uninstalled: ' + skillName);
        } catch (error) {
          printError('Failed to uninstall: ' + (error instanceof Error ? error.message : String(error)));
        }
        break;

      case 'enable':
        if (!skillName) {
          console.log(chalk.yellow('Usage: /skill enable <name>'));
          return;
        }
        this.skillManager.enableSkill(skillName);
        printSuccess('Skill enabled: ' + skillName);
        break;

      case 'disable':
        if (!skillName) {
          console.log(chalk.yellow('Usage: /skill disable <name>'));
          return;
        }
        this.skillManager.disableSkill(skillName);
        printSuccess('Skill disabled: ' + skillName);
        break;

      default:
        console.log(chalk.yellow('Usage: /skill [list|candidates|todos|adopt|adopt-from-todo|install|uninstall|enable|disable]'));
    }
  }

  private async handleOrgCommand(args: string[]): Promise<void> {
    const subcommand = args[0]?.toLowerCase();

    switch (subcommand) {
      case 'view':
      case 'v':
        this.viewOrganization();
        break;
      case 'load':
        await this.loadOrganization(args[1]);
        break;
      case 'mode':
        this.toggleOrganizationMode(args[1]);
        break;
      case 'workflow':
      case 'w':
        this.viewWorkflow();
        break;
      case 'help':
        this.showOrgHelp();
        break;
      default:
        this.showOrgHelp();
    }
  }

  private viewOrganization(): void {
    if (!this.organization) {
      console.log(chalk.yellow('No organization loaded. Use /org load <config-file> to load one.'));
      return;
    }
    this.organization.printOrganization();
  }

  private async loadOrganization(configPath?: string): Promise<void> {
    if (!this.llm) {
      printError('LLM not initialized');
      return;
    }

    const defaultConfigPath = path.join(os.homedir(), '.ai-agent-cli', 'organization.json');
    const targetPath = configPath || defaultConfigPath;

    try {
      await fs.access(targetPath);
    } catch {
      console.log(chalk.cyan('Creating default organization...'));
      const examplePath = path.join(process.cwd(), 'config', 'organization.example.json');
      try {
        await fs.copyFile(examplePath, defaultConfigPath);
        console.log(chalk.green(`Default organization config created at: ${defaultConfigPath}`));
        console.log(chalk.gray('Please edit this file to customize your team structure.'));
        return;
      } catch {
        printError('Failed to create default organization config');
        return;
      }
    }

    try {
      const factory = createAgentFactory({
        llm: this.llm!,
        mcpManager: this.mcpManager,
        lspManager: this.lspManager,
        sandbox: this.sandbox,
      });

      this.organization = await loadOrganization(targetPath, factory);
      printSuccess(`Organization loaded: ${this.organization.getConfig().name}`);
      this.organization.printOrganization();
      this.organizationMode = true;
    } catch (error) {
      printError('Failed to load organization: ' + (error instanceof Error ? error.message : String(error)));
    }
  }

  private toggleOrganizationMode(mode?: string): void {
    if (mode === 'on') {
      if (!this.organization) {
        console.log(chalk.yellow('No organization loaded. Use /org load first.'));
        return;
      }
      this.organizationMode = true;
      printSuccess('Organization mode enabled');
    } else if (mode === 'off') {
      this.organizationMode = false;
      printSuccess('Organization mode disabled');
    } else {
      const status = this.organizationMode ? chalk.green('ON') : chalk.gray('OFF');
      console.log(chalk.bold('\nOrganization Mode:') + ` ${status}`);
      if (this.organization) {
        console.log(`Team: ${chalk.cyan(this.organization.getConfig().name)}`);
        console.log(`Agents: ${this.organization.getMembers().length}`);
      } else {
        console.log(chalk.gray('No organization loaded.'));
      }
      console.log();
      console.log(chalk.gray('Usage: /org mode [on|off]'));
    }
  }

  private viewWorkflow(): void {
    if (!this.organization) {
      console.log(chalk.yellow('No organization loaded.'));
      return;
    }
    this.organization.printWorkflow();
  }

  private showOrgHelp(): void {
    console.log(`
${chalk.bold('Organization Commands:')}

${chalk.cyan('/org view')}        ${chalk.gray('Show organization structure')}
${chalk.cyan('/org load')} [path] ${chalk.gray('Load organization config (default: ~/.ai-agent-cli/organization.json)')}
${chalk.cyan('/org mode')} [on|off] ${chalk.gray('Enable/disable organization mode')}
${chalk.cyan('/org workflow')}    ${chalk.gray('Show workflow configuration')}
${chalk.cyan('/org help')}        ${chalk.gray('Show this help')}

${chalk.bold('Organization Roles:')}
  • orchestrator  ${chalk.gray('- Task decomposition expert')}
  • dispatcher    ${chalk.gray('- Task distribution expert')}
  • executor      ${chalk.gray('- Task execution expert')}
  • supervisor    ${chalk.gray('- Decision supervision expert')}
  • tester        ${chalk.gray('- Acceptance testing expert')}
  • fallback      ${chalk.gray('- Backup specialist')}
`);
  }

  async shutdown(): Promise<void> {
    this.cronManager?.stop();
    await this.stopLarkRelay();
    await this.mcpManager.disconnectAll();
    await this.lspManager.disconnectAll();
    await this.sandbox.cleanup();
    this.splitScreen?.close();
    this.splitScreen = undefined;
  }
}

export async function runCLI(): Promise<void> {
  const startupShortcut = process.argv[2];
  if (isQuickHelpShortcut(startupShortcut)) {
    console.log(getQuickHelpText());
    return;
  }

  if (isFullHelpShortcut(startupShortcut)) {
    console.log(getFullHelpText());
    return;
  }

  const program = new Command();
  
  program
    .name('ai-agent')
    .description('AI Agent CLI with MCP, Ollama, LSP and Skills support')
    .version(APP_VERSION)
    .option('-c, --config <path>', 'Path to configuration file')
    .option('-m, --model <name>', 'Model to use')
    .option('-w, --workspace <path>', 'Workspace directory')
    .option('--daemon-service', 'Run internal background daemon service')
    .option('--cron-daemon', 'Run only the cron scheduler in the foreground')
    .option('--cron-once', 'Run a single due-jobs check and exit')
    .parse(process.argv);

  const options = program.opts();
  
  if (options.config) {
    await configManager.loadFromFile(options.config);
  }

  if (options.model) {
    configManager.set('ollama', { ...configManager.get('ollama'), model: options.model });
  }

  if (options.workspace) {
    configManager.set('workspace', options.workspace);
  }

  if (options.daemonService) {
    await runBackgroundDaemonService();
    return;
  }

  const cli = new CLI({
    ensureBackgroundDaemon: !options.cronDaemon && !options.cronOnce,
    runLocalCronScheduler: Boolean(options.cronDaemon || options.cronOnce),
  });
  
  process.on('SIGINT', async () => {
    console.log(chalk.gray('\nShutting down...'));
    await cli.shutdown();
    process.exit(0);
  });

  await cli.initialize();
  if (options.cronOnce) {
    await cli.runCronDaemon(true);
    await cli.shutdown();
    return;
  }

  if (options.cronDaemon) {
    await cli.runCronDaemon(false);
    return;
  }

  await cli.run();
  await cli.stopBackgroundDaemonIfRequested();
  await cli.shutdown();
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runCLI().catch(err => {
    printError('Fatal error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
