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
import type { LLMProviderInterface } from '../llm/types.js';
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
import { parseOnboardingInput } from '../core/onboarding.js';
import { PermissionManager, permissionManager } from '../core/permission-manager.js';
import { Planner } from '../core/planner.js';
import { createTaskManager, TaskManager } from '../core/task-manager.js';
import { createCronManager, CronManager } from '../core/cron-manager.js';
import { progressTracker } from '../utils/progress.js';
import { printSuccess, printError, printWarning, printInfo, createStreamingOutput, StreamingOutput } from '../utils/output.js';
import * as readline from 'readline';

const logo = `
╔═══════════════════════════════════════════════════╗
║           AI Agent CLI v1.3.0                     ║
║   Your intelligent coding assistant                 ║
╚═══════════════════════════════════════════════════╝
`;

export class CLI {
  private static readonly SLASH_COMMANDS = [
    '/?', '/help', '/h', '/quit', '/exit', '/bye', '/q',
    '/clear', '/cls', '/history', '/hi', '/tools', '/t',
    '/config', '/c', '/model', '/m', '/workspace', '/w',
    '/reset', '/r', '/new', '/sessions', '/load', '/mcp',
    '/lsp', '/skill', '/skills', '/org', '/team', '/cat',
    '/progress', '/p', '/memory', '/templates', '/profile', '/news',
    '/wipe', '/perm', '/permission', '/cron',
  ];

  private agent?: Agent;
  private llm?: LLMProviderInterface;
  private currentProvider = 'ollama';
  private mcpManager: MCPManager;
  private lspManager: LSPManager;
  private sandbox!: Sandbox;
  private skillManager: ReturnType<typeof createSkillManager>;
  private memoryManager!: MemoryManager;
  private enhancedMemory?: EnhancedMemoryManager;
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
  private taskManager?: TaskManager;
  private cronManager?: CronManager;
  private isFirstInteraction = true;
  private awaitingOnboardingInput = false;
  private permissionHandlerSetup = false;
  private activePlannedTaskId?: string;
  private activeProgressDisplayTaskId?: string;
  private inputHistoryPath: string;

  constructor() {
    this.mcpManager = new MCPManager();
    this.lspManager = new LSPManager();
    this.skillManager = createSkillManager();
    this.workspace = process.cwd();
    this.inputHistoryPath = path.join(os.homedir(), '.ai-agent-cli', 'input-history.json');
  }

  async initialize(): Promise<void> {
    console.log(chalk.cyan(logo));
    console.log(chalk.gray('Initializing...\n'));
    
    const config = configManager.getAgentConfig();

    this.memoryManager = createMemoryManager();
    await this.memoryManager.initialize();
    printSuccess('Memory manager ready');

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

    this.currentProvider = config.defaultProvider || 'ollama';
    
    this.llm = this.createLLMClient(config);
    
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
    const permConfig = this.permissionMgr.getConfig();
    for (const allowedPath of permConfig.allowedPaths) {
      if (!sandboxConfig.allowedPaths.includes(allowedPath)) {
        sandboxConfig.allowedPaths.push(allowedPath);
      }
    }
    this.sandbox = new Sandbox(sandboxConfig);
    await this.sandbox.initialize();
    printSuccess('Sandbox ready');

    await this.skillManager.initialize();
    const skills = await this.skillManager.listSkills();
    if (skills.length > 0) {
      printSuccess(skills.length + ' skills loaded');
    }

    this.builtInTools = new BuiltInTools(this.sandbox, this.lspManager, {
      mcpManager: this.mcpManager,
      taskManager: this.taskManager,
      cronManager: this.cronManager,
    });
    printSuccess(this.builtInTools.getTools().length + ' built-in tools');

    this.cronManager.setExecutor((toolName, args) => this.builtInTools!.executeTool(toolName, args));
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
    this.cronManager.start();

    this.directActionRouter = createDirectActionRouter({
      builtInTools: this.builtInTools,
      skillManager: this.skillManager,
      permissionManager: this.permissionMgr,
      workspace: this.workspace,
      config,
    });

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
      planner: new Planner({ llm: this.llm! }),
    });

    const restoredMessages = this.memoryManager.getMessages();
    if (restoredMessages.length > 0) {
      this.agent.setMessages(restoredMessages);
      printInfo(`Resumed session: ${this.memoryManager.getCurrentSessionId()} (${restoredMessages.length} messages)`);
    }

    if (this.awaitingOnboardingInput) {
      await this.showWelcomeQuestions();
    }

    console.log(chalk.gray('\nType /? for commands, or ask me anything!\n'));
  }

  private setupPermissionHandler(): void {
    if (this.permissionHandlerSetup || !this.permissionMgr) return;
    this.permissionHandlerSetup = true;

    this.permissionMgr.onPermissionRequest(async (request) => {
      console.log(this.permissionMgr!.showPermissionRequest(request));
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      
      return new Promise((resolve) => {
        rl.question(chalk.blue('> '), (answer) => {
          rl.close();
          
          const result = this.permissionMgr!.parsePermissionAnswer(answer);
          
          if (result.granted) {
            if (result.permanent) {
              this.permissionMgr!.grantPermission(request.type, request.resource);
            } else if (result.expiresInMs) {
              this.permissionMgr!.grantPermission(request.type, request.resource, result.expiresInMs);
            }
          }
          
          resolve(result.granted);
        });
      });
    });
  }

  async run(): Promise<void> {
    while (this.running) {
      try {
        const input = await this.prompt();
        if (!input) continue;
        
        if (input.startsWith('/')) {
          await this.handleCommand(input);
        } else {
          if (this.awaitingOnboardingInput) {
            await this.handleOnboardingInput(input);
            continue;
          }

          const confirmationStatus = this.agent?.getConfirmationStatus();
          if (confirmationStatus?.pending) {
            const isConfirmed = input.toLowerCase() === '是' || input.toLowerCase() === 'yes' || input.toLowerCase() === 'y';
            console.log(chalk.cyan(isConfirmed ? '✅ 确认执行计划...' : '❌ 取消执行'));
            const result = await this.agent?.confirmAction(isConfirmed);
            if (!isConfirmed) {
              this.failTrackedTask('用户取消执行计划');
            }
            if (result) {
              console.log(chalk.green('\nAssistant: '));
              await this.streamResponse(result);
              console.log();
            }
          } else {
            await this.handleMessage(input);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'Exit') {
          break;
        }
        printError('Error: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  private prompt(): Promise<string> {
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
      rl.question(chalk.blue('> '), (answer) => {
        rl.close();

        const trimmed = answer.trim();
        if (trimmed.length > 0) {
          this.recordHistory(trimmed);
        }

        resolve(trimmed);
      });
    });
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

    const providers = ['ollama', 'deepseek', 'kimi', 'glm', 'doubao', 'minimax', 'openai', 'claude', 'gemini'];
    const staticCandidates: Record<string, string[]> = {
      '/model': ['/model', '/model switch', ...providers.map(provider => `/model switch ${provider}`)],
      '/m': ['/m', '/model', '/model switch', ...providers.map(provider => `/model switch ${provider}`)],
      '/mcp': ['/mcp list', '/mcp tools', '/mcp check', '/mcp check mempalace'],
      '/lsp': ['/lsp list', '/lsp status'],
      '/skill': ['/skill list', '/skill ls', '/skill install', '/skill add', '/skill uninstall', '/skill remove', '/skill enable', '/skill disable'],
      '/skills': ['/skills list', '/skills install', '/skills uninstall', '/skills enable', '/skills disable'],
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
      '/cron': ['/cron list', '/cron create', '/cron create-news', '/cron delete', '/cron run-due'],
      '/news': ['/news hot', '/news search', '/news morning', '/news evening', '/news help'],
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
        this.showConfig();
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
      
      this.moderator?.recordWarning(input);
    }

    this.userProfile?.recordInteraction();

    const directResult = await this.directActionRouter?.tryHandle(input);
    if (directResult?.handled) {
      if (this.agent) {
        this.agent.appendMessages([
          { role: 'user', content: input },
          { role: 'assistant', content: directResult.output || '(无输出)' },
        ]);
        this.memoryManager.setMessages(this.agent.getMessages());
      }

      console.log();
      if (directResult.title) {
        console.log(chalk.cyan(directResult.title));
      }
      if (directResult.isError) {
        printError(directResult.output || 'Direct action failed');
      } else {
        console.log(chalk.green('\nAssistant: '));
        await this.streamResponse(directResult.output || '(无输出)');
      }
      console.log();
      return;
    }

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
          process.stdout.write(chalk.gray('Thinking... '));
          break;
        case 'tool_call':
          console.log(chalk.cyan('\n🔧 ' + event.content));
          break;
        case 'tool_result':
          console.log(chalk.cyan('\n[工具结果]'));
          if (event.toolResult?.is_error) {
            printError(this.getToolResultDisplayText(event.toolResult) || 'Tool execution failed');
          } else {
            const output = this.getToolResultDisplayText(event.toolResult);
            if (output.length > 0) {
              console.log(chalk.green('--- 工具输出 START ---'));
              console.log(output);
              console.log(chalk.green('--- 工具输出 END ---'));
            } else {
              console.log(chalk.gray('(无输出)'));
            }
          }
          break;
        case 'plan_summary':
          this.trackPlannedTask(event);
          break;
        case 'plan_progress':
          this.updateTrackedTaskFromPlanEvent(event);
          break;
        case 'response':
          this.completeTrackedTaskIfNeeded(event.content);
          break;
        case 'memory_sync':
          if (event.memorySync?.status === 'archived') {
            console.log(chalk.gray(`\n[MemPalace] ${event.content}`));
          } else if (event.memorySync?.status === 'failed') {
            printWarning(`[MemPalace] ${event.content}`);
          }
          break;
        case 'error':
          this.failTrackedTask(event.content);
          printError(event.content);
          break;
      }
    });

    try {
      const response = await this.agent.chat(input);
      this.memoryManager.setMessages(this.agent.getMessages());
      this.streamingOutput.clear();
      console.log(chalk.green('\nAssistant: '));
      await this.streamResponse(response);
    } catch (error) {
      printError('Failed to get response: ' + (error instanceof Error ? error.message : String(error)));
    }
    
    console.log();
  }

  private async streamResponse(text: string): Promise<void> {
    const output = createStreamingOutput({ color: 'cyan', speed: 5 });
    await output.stream(text);
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
    if (toolResult.output) return toolResult.output;
    if (toolResult.content) {
      return toolResult.content
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text || '')
        .join('\n');
    }
    return '';
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
        break;
      case 'meal':
        this.agentCat.acknowledge('meal');
        break;
      case 'interact':
        console.log(chalk.cyan(this.agentCat.interact()));
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
    if (!this.enhancedMemory) {
      printInfo('Enhanced memory not initialized');
      return;
    }

    const activeTasks = this.enhancedMemory.getActiveTasks();
    console.log(chalk.bold('\n📊 任务进度:\n'));

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
        console.log(chalk.gray(room.description));
        console.log(chalk.gray(`地标: ${room.landmarks.join(', ')}`));
        console.log(chalk.gray(`出口: ${room.exits.join(', ') || '无'}\n`));

        if (room.memories.length === 0) {
          console.log(chalk.gray('该房间暂无记忆条目。\n'));
          return;
        }

        for (const item of room.memories.slice(-10)) {
          console.log(chalk.cyan(`  • ${item.title}`));
          console.log(chalk.gray(`    ${item.content.replace(/\n/g, ' ')}`));
          if (item.tags.length > 0) {
            console.log(chalk.gray(`    tags: ${item.tags.join(', ')}`));
          }
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
  network_request, browser_open, mcp_access, tool_execute
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
      'browser_open', 'mcp_access', 'tool_execute', 'env_read', 'process_list'];
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
      printSuccess('Loaded session: ' + sessionId);
    } else {
      printError('Session not found: ' + sessionId);
    }
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
    console.log(`
${chalk.bold('Quick Commands:')}
  ${chalk.cyan('/?')}        ${chalk.gray('Show this help')}
  ${chalk.cyan('/quit')}     ${chalk.gray('Exit')}
  ${chalk.cyan('/tools')}    ${chalk.gray('List tools')}
  ${chalk.cyan('/news')}     ${chalk.gray('Tencent news shortcuts')}
  ${chalk.cyan('/model')}    ${chalk.gray('Show/change model')}
  ${chalk.cyan('/sessions')} ${chalk.gray('Show sessions')}
  ${chalk.cyan('/cron')}     ${chalk.gray('Manage cron jobs')}
  ${chalk.cyan('/reset')}    ${chalk.gray('Clear chat')}
`);
  }

  private showHelp(): void {
    console.log(`
${chalk.bold('Available Commands:')}

${chalk.cyan('/?, /？')}           Show quick help
${chalk.cyan('/help, /h')}         Show full help
${chalk.cyan('/quit, /exit, /bye, /q')}  Exit the application
${chalk.cyan('/clear, /cls')}      Clear the screen
${chalk.cyan('/history, /hi')}      Show command history
${chalk.cyan('/tools, /t')}        List available tools
${chalk.cyan('/config, /c')}       Show current configuration
${chalk.cyan('/model, /m')} [name]     Show or change model
${chalk.cyan('/model switch')} <name> Switch default provider
${chalk.cyan('/workspace, /w')}    Show or change workspace
${chalk.cyan('/reset, /r')}        Reset conversation
${chalk.cyan('/new')}              Create new session (archive old)
${chalk.cyan('/wipe')}             Reset user data (restart onboarding)
${chalk.cyan('/sessions')}         List conversation sessions
${chalk.cyan('/load')} <id>        Load a previous session
${chalk.cyan('/mcp')}              Manage MCP servers
${chalk.cyan('/lsp')}              Manage LSP servers
${chalk.cyan('/skill')}            Manage skills
${chalk.cyan('/news')}             Tencent news shortcuts (hot/search/morning/evening)
${chalk.cyan('/cron')}             Manage cron jobs
${chalk.cyan('/org, /team')}        Manage organization/team (view, load, mode)
`);
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

${chalk.gray('示例:')}
${chalk.gray('/news hot 5')}
${chalk.gray('/news search AI 5')}
${chalk.gray('/news morning')}
`);
        return;
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
        printError('Usage: /news [hot [limit]|search <keyword> [limit]|morning|evening|help]');
    }
  }

  private displayDirectToolResult(result: { is_error?: boolean; output?: string; content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }, title: string): void {
    console.log();
    console.log(chalk.cyan(title));
    const output = this.getToolResultDisplayText(result);
    if (result.is_error) {
      printError(output || `${title} 调用失败`);
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
        console.log(chalk.bold('\nCron Jobs:\n'));
        if (jobs.length === 0) {
          console.log(chalk.gray('No cron jobs found.'));
        } else {
          for (const job of jobs) {
            console.log(chalk.cyan(`  • ${job.name}`) + chalk.gray(` (${job.id})`));
            console.log(`    schedule: ${job.schedule}`);
            console.log(`    tool: ${job.toolName}`);
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
${chalk.cyan('/cron delete')} <idOrName>      删除 cron 任务
${chalk.cyan('/cron run-due')}                立即检查当前到期任务

${chalk.gray('示例:')}
${chalk.gray('/cron create-news morning-brief morning 0 8 * * * Asia/Shanghai')}
${chalk.gray('/cron create hot-news 0 9 * * * tencent_hot_news {"limit":5}')}
`);
    }
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
    console.log();
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
    ];

    const defaultProvider = config.defaultProvider;
    
    for (const provider of providers) {
      if (provider.config?.enabled) {
        const isDefault = provider.name.toLowerCase() === defaultProvider;
        const marker = isDefault ? chalk.green(' (默认)') : '';
        console.log(`${chalk.cyan(provider.name)}${marker}`);
        console.log(`  Model: ${provider.config.model}`);
        if (provider.config.baseUrl) {
          console.log(`  URL: ${provider.config.baseUrl}`);
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
    const config = configManager.getAgentConfig();
    const providerConfig = configManager.get(normalizedProvider as any);

    if (!providerConfig) {
      printError(`Provider not found: ${provider}. Use /model to see available providers.`);
      return;
    }

    if (!providerConfig.enabled) {
      printError(`Provider "${provider}" is disabled. Please enable it in config first.`);
      return;
    }

    try {
      configManager.set('defaultProvider', normalizedProvider);
      const configPath = configManager.getConfigPath();
      if (configPath) {
        await configManager.saveToFile(configPath);
      }

      this.currentProvider = normalizedProvider;
      this.llm = this.createLLMClient(configManager.getAgentConfig());
      const connected = await this.llm.checkConnection();

      if (connected) {
        printSuccess(`Switched to provider: ${normalizedProvider} (${this.llm.getModel()})`);
      } else {
        printWarning(`Switched to ${normalizedProvider}, but connection failed.`);
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
      default:
        console.log(chalk.yellow('Usage: /mcp [list|tools|check|status]'));
    }
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
        console.log(chalk.yellow('Usage: /skill [list|install|uninstall|enable|disable]'));
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
    await this.mcpManager.disconnectAll();
    await this.lspManager.disconnectAll();
    await this.sandbox.cleanup();
  }
}

export async function runCLI(): Promise<void> {
  const program = new Command();
  
  program
    .name('ai-agent')
    .description('AI Agent CLI with MCP, Ollama, LSP and Skills support')
    .version('1.2.0')
    .option('-c, --config <path>', 'Path to configuration file')
    .option('-m, --model <name>', 'Model to use')
    .option('-w, --workspace <path>', 'Workspace directory')
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

  const cli = new CLI();
  
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
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  runCLI().catch(err => {
    printError('Fatal error: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
