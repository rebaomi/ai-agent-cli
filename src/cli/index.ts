import chalk from 'chalk';
import { Command } from 'commander';
import { configManager } from '../core/config.js';
import { createMemoryManager, MemoryManager } from '../core/memory.js';
import { createSkillManager } from '../core/skills.js';
import { OllamaClient } from '../ollama/client.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
import { Agent, createAgent } from '../core/agent.js';
import type { AgentEvent } from '../core/agent.js';
import { printSuccess, printError, printWarning, printInfo, createStreamingOutput, StreamingOutput } from '../utils/output.js';
import * as readline from 'readline';

const logo = `
╔═══════════════════════════════════════════════════╗
║           AI Agent CLI v1.2.0                     ║
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
  private builtInTools?: BuiltInTools;
  private workspace: string;
  private running = true;
  private cmdHistory: string[] = [];
  private historyIndex = -1;
  private streamingOutput?: StreamingOutput;

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
      printWarning('Ollama server not reachable at ' + config.ollama.baseUrl);
      console.log(chalk.gray('  Run "ollama serve" to start Ollama, then restart this CLI\n'));
    } else {
      printSuccess('Connected to Ollama (' + config.ollama.model + ')');
    }

    this.sandbox = new Sandbox(config.sandbox);
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
          console.log(chalk.gray('Current model: ' + this.ollama?.getModel()));
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
      default:
        console.log(chalk.yellow(`Unknown command: ${command}. Type /? for help.`));
    }
  }

  private async handleMessage(input: string): Promise<void> {
    this.cmdHistory.push(input);
    this.historyIndex = this.cmdHistory.length;

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
${chalk.cyan('/sessions')}         List conversation sessions
${chalk.cyan('/load')} <id>        Load a previous session
${chalk.cyan('/mcp')}              Manage MCP servers
${chalk.cyan('/lsp')}              Manage LSP servers
${chalk.cyan('/skill')}            Manage skills
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
