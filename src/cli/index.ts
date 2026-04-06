import chalk from 'chalk';
import { Command } from 'commander';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { configManager } from '../core/config.js';
import { createMemoryManager, MemoryManager } from '../core/memory.js';
import { createEnhancedMemoryManager, EnhancedMemoryManager } from '../core/memory-enhanced.js';
import { createSkillManager } from '../core/skills.js';
import { OllamaClient } from '../ollama/client.js';
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
import { PermissionManager, permissionManager } from '../core/permission-manager.js';
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
  private agent?: Agent;
  private ollama?: OllamaClient;
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
  private isFirstInteraction = true;
  private permissionHandlerSetup = false;

  constructor() {
    this.mcpManager = new MCPManager();
    this.lspManager = new LSPManager();
    this.skillManager = createSkillManager();
    this.workspace = process.cwd();
  }

  async initialize(): Promise<void> {
    console.log(chalk.cyan(logo));
    console.log(chalk.gray('Initializing...\n'));
    
    const config = configManager.getAgentConfig();

    this.memoryManager = createMemoryManager();
    await this.memoryManager.initialize();
    printSuccess('Memory manager ready');

    this.userProfile = userProfileManager;
    await this.userProfile.initialize();
    const profile = this.userProfile.getProfile();
    if (profile) {
      printSuccess('User profile loaded');
    } else {
      this.isFirstInteraction = true;
    }

    this.moderator = contentModerator;

    this.permissionMgr = permissionManager;
    await this.permissionMgr.initialize();
    this.setupPermissionHandler();

    this.ollama = new OllamaClient(config.ollama);
    
    let connected = false;
    try {
      connected = await Promise.race([
        this.ollama.checkConnection(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))
      ]);
    } catch (error) {
      printWarning('Failed to connect to Ollama: ' + (error instanceof Error ? error.message : String(error)));
    }
    
    if (!connected) {
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
      console.log(chalk.gray('  或者配置其他模型提供商 (DeepSeek/Kimi/GLM 等)\n'));
    } else {
      printSuccess('Connected to Ollama (' + config.ollama.model + ')');
    }

    const sandboxConfig = config.sandbox || { enabled: true, timeout: 30000 };
    if (!sandboxConfig.allowedPaths) {
      sandboxConfig.allowedPaths = [config.workspace || process.cwd()];
    }
    this.sandbox = new Sandbox(sandboxConfig);
    await this.sandbox.initialize();
    printSuccess('Sandbox ready');

    await this.skillManager.initialize();
    const skills = await this.skillManager.listSkills();
    if (skills.length > 0) {
      printSuccess(skills.length + ' skills loaded');
    }

    this.builtInTools = new BuiltInTools(this.sandbox, this.lspManager);
    printSuccess(this.builtInTools.getTools().length + ' built-in tools');

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
      ollama: this.ollama,
      mcpManager: this.mcpManager,
      lspManager: this.lspManager,
      sandbox: this.sandbox,
      builtInTools: this.builtInTools,
      systemPrompt: config.ollama.systemPrompt,
      maxIterations: config.maxIterations,
    });

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
          await this.handleMessage(input);
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
      });
      rl.on('close', () => {});
      rl.question(chalk.blue('> '), (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
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
        if (args[0]) {
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
      default:
        console.log(chalk.yellow(`Unknown command: ${command}. Type /? for help.`));
    }
  }

  private async handleMessage(input: string): Promise<void> {
    this.cmdHistory.push(input);
    this.historyIndex = this.cmdHistory.length;

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

    if (this.isFirstInteraction && this.userProfile) {
      this.showWelcomeQuestions();
      this.isFirstInteraction = false;
      return;
    }

    this.userProfile?.recordInteraction();

    if (this.organizationMode && this.organization) {
      await this.handleOrganizationMessage(input);
      return;
    }

    if (!this.ollama) {
      printError('Ollama not connected. Please check your configuration.');
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
          if (event.toolResult?.is_error) {
            printError(event.toolResult.output || 'Tool execution failed');
          } else {
            const output = event.toolResult?.output || '';
            if (output.length > 200) {
              console.log(chalk.gray(output.slice(0, 200) + '...'));
            } else if (output) {
              console.log(chalk.gray(output));
            }
          }
          break;
        case 'response':
          break;
        case 'error':
          printError(event.content);
          break;
      }
    });

    try {
      const response = await this.agent.chat(input);
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

  private async handleOrganizationMessage(input: string): Promise<void> {
    if (!this.organization) {
      printError('Organization not loaded');
      return;
    }

    console.log(chalk.cyan('\n🏢 Organization Mode Active'));
    console.log(chalk.gray('Team: ' + this.organization.getConfig().name + '\n'));

    try {
      const response = await this.organization.processUserInput(input);
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
      case 'clear':
        this.enhancedMemory.clearAllAgentShortTermMemory();
        printSuccess('Short-term memory cleared');
        break;
      default:
        console.log(chalk.bold('\n💾 记忆管理:\n'));
        console.log(chalk.cyan('/memory long') + '   ' + chalk.gray('查看长期记忆'));
        console.log(chalk.cyan('/memory short [agentId]') + '   ' + chalk.gray('查看短期记忆'));
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
    
    console.log();
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
      printError('User profile not initialized');
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
    
    this.isFirstInteraction = true;
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
      this.memoryManager.clearHistory();
      this.agent?.clearMessages();
      this.isFirstInteraction = true;
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

  private showQuickHelp(): void {
    console.log(`
${chalk.bold('Quick Commands:')}
  ${chalk.cyan('/?')}        ${chalk.gray('Show this help')}
  ${chalk.cyan('/quit')}     ${chalk.gray('Exit')}
  ${chalk.cyan('/tools')}    ${chalk.gray('List tools')}
  ${chalk.cyan('/model')}    ${chalk.gray('Show/change model')}
  ${chalk.cyan('/sessions')} ${chalk.gray('Show sessions')}
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
${chalk.cyan('/model, /m')} [name] Show or change the model
${chalk.cyan('/workspace, /w')}    Show or change workspace
${chalk.cyan('/reset, /r')}        Reset conversation
${chalk.cyan('/new')}              Create new session (archive old)
${chalk.cyan('/wipe')}             Reset user data (restart onboarding)
${chalk.cyan('/sessions')}         List conversation sessions
${chalk.cyan('/load')} <id>        Load a previous session
${chalk.cyan('/mcp')}              Manage MCP servers
${chalk.cyan('/lsp')}              Manage LSP servers
${chalk.cyan('/skill')}            Manage skills
${chalk.cyan('/org, /team')}        Manage organization/team (view, load, mode)
`);
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
    if (!this.ollama) return;
    
    try {
      this.ollama.setModel(model);
      const connected = await this.ollama.checkConnection();
      if (connected) {
        printSuccess('Model changed to: ' + model);
      } else {
        printError('Failed to verify model. Please ensure the model is available.');
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
        const clients = this.mcpManager.getAllClients();
        if (clients.length === 0) {
          console.log(chalk.gray('No MCP servers connected.'));
        } else {
          for (const client of clients) {
            console.log(chalk.cyan(`  • ${client}`));
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
      default:
        console.log(chalk.yellow('Usage: /mcp [list|tools]'));
    }
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
    if (!this.ollama) {
      printError('Ollama not initialized');
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
        ollama: this.ollama,
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
  await cli.run();
}

runCLI().catch(err => {
  printError('Fatal error: ' + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
