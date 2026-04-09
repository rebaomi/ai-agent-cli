import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolResult } from '../types/index.js';
import { Sandbox } from '../sandbox/executor.js';
import { LSPManager } from '../lsp/client.js';
import type { MCPManager } from '../mcp/client.js';
import type { TaskManager } from '../core/task-manager.js';
import type { CronManager } from '../core/cron-manager.js';
import { writeDocxDocument } from '../utils/docx-export.js';
import { writePdfDocument } from '../utils/pdf-export.js';
import { writePptxDocument } from '../utils/pptx-export.js';
import { writeXlsxDocument } from '../utils/xlsx-export.js';
import { runBrowserAutomation, resolveBrowserExecutable, type BrowserAutomationAction, type BrowserTarget } from '../utils/browser-automation.js';
import { resolveOutputPath, resolveUserPath } from '../utils/path-resolution.js';

const execAsync = promisify(exec);

export interface BuiltInToolsOptions {
  mcpManager?: MCPManager;
  taskManager?: TaskManager;
  cronManager?: CronManager;
  workspace?: string;
  config?: Record<string, unknown>;
}

export class BuiltInTools {
  private sandbox: Sandbox;
  private lspManager: LSPManager;
  private mcpManager?: MCPManager;
  private taskManager?: TaskManager;
  private cronManager?: CronManager;
  private workspace?: string;
  private config?: Record<string, unknown>;
  private currentCronJobName?: string;

  constructor(sandbox: Sandbox, lspManager: LSPManager, options: BuiltInToolsOptions = {}) {
    this.sandbox = sandbox;
    this.lspManager = lspManager;
    this.mcpManager = options.mcpManager;
    this.taskManager = options.taskManager;
    this.cronManager = options.cronManager;
    this.workspace = options.workspace;
    this.config = options.config;
  }

  async executeToolForCronJob(name: string, args: unknown, jobName: string): Promise<ToolResult> {
    const previous = this.currentCronJobName;
    this.currentCronJobName = jobName;
    try {
      return await this.executeTool(name, args);
    } finally {
      this.currentCronJobName = previous;
    }
  }

  private getCronRootDir(): string {
    return this.cronManager?.getStoreDir()
      || path.join(os.homedir(), '.ai-agent-cli', 'cron');
  }

  private sanitizeCronJobName(name: string): string {
    return name.replace(/[<>:"/\\|?*]+/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'job';
  }

  private getCurrentCronJobWorkDir(): string | undefined {
    if (!this.currentCronJobName) {
      return undefined;
    }

    return this.cronManager?.getJobWorkDir(this.currentCronJobName)
      || path.join(this.getCronRootDir(), this.sanitizeCronJobName(this.currentCronJobName));
  }

  private getPathResolutionOptions(): { workspace?: string; appBaseDir?: string; artifactOutputDir?: string; documentOutputDir?: string } {
    const cronWorkDir = this.getCurrentCronJobWorkDir();
    if (cronWorkDir) {
      return {
        workspace: cronWorkDir,
        artifactOutputDir: cronWorkDir,
        documentOutputDir: cronWorkDir,
      };
    }

    return {
      workspace: this.workspace,
      appBaseDir: typeof this.config?.appBaseDir === 'string' ? this.config.appBaseDir : undefined,
      artifactOutputDir: typeof this.config?.artifactOutputDir === 'string' ? this.config.artifactOutputDir : undefined,
      documentOutputDir: typeof this.config?.documentOutputDir === 'string' ? this.config.documentOutputDir : undefined,
    };
  }

  private resolveInputPath(filePath: string): string {
    const pathOptions = this.getPathResolutionOptions();
    const resolvedWorkspacePath = resolveUserPath(filePath, pathOptions);

    if (existsSync(resolvedWorkspacePath)) {
      return resolvedWorkspacePath;
    }

    const resolvedArtifactPath = resolveOutputPath(filePath, pathOptions);

    if (existsSync(resolvedArtifactPath)) {
      return resolvedArtifactPath;
    }

    return resolvedWorkspacePath;
  }

  private resolveOutputFilePath(filePath: string): string {
    return resolveOutputPath(filePath, this.getPathResolutionOptions());
  }

  private isStructuredDocumentExtension(filePath: string): boolean {
    return /\.(docx|pdf|xlsx|pptx)$/i.test(filePath);
  }

  getTools(): Tool[] {
    return [
      // File Operations
      { ...this.readFileTool(), category: 'file_operations' },
      { ...this.writeFileTool(), category: 'file_operations' },
      { ...this.editFileTool(), category: 'file_operations' },
      { ...this.deleteFileTool(), category: 'file_operations' },
      { ...this.copyFileTool(), category: 'file_operations' },
      { ...this.moveFileTool(), category: 'file_operations' },
      { ...this.fileInfoTool(), category: 'file_operations' },
      { ...this.listDirectoryTool(), category: 'file_operations' },
      { ...this.createDirectoryTool(), category: 'file_operations' },
      { ...this.searchFilesTool(), category: 'file_operations' },
      { ...this.grepTool(), category: 'file_operations' },
      { ...this.globTool(), category: 'file_operations' },
      { ...this.readMultipleFilesTool(), category: 'file_operations' },
      { ...this.txtToDocxTool(), category: 'file_operations' },
      { ...this.txtToPdfTool(), category: 'file_operations' },
      { ...this.txtToPptxTool(), category: 'file_operations' },
      { ...this.txtToXlsxTool(), category: 'file_operations' },
      
      // Execution
      { ...this.executeCommandTool(), category: 'execution' },
      { ...this.calculateTool(), category: 'execution' },
      { ...this.replTool(), category: 'execution' },
      
      // Search & Fetch
      { ...this.webSearchTool(), category: 'search_fetch' },
      { ...this.fetchUrlTool(), category: 'search_fetch' },
      { ...this.openBrowserTool(), category: 'search_fetch' },
      { ...this.browserAutomateTool(), category: 'search_fetch' },
      { ...this.getWeatherTool(), category: 'search_fetch' },

      // Agents & Tasks
      { ...this.agentSendMessageTool(), category: 'agents_tasks' },
      { ...this.taskCreateTool(), category: 'agents_tasks' },
      { ...this.taskGetListTool(), category: 'agents_tasks' },
      { ...this.taskUpdateTool(), category: 'agents_tasks' },
      { ...this.taskStopTool(), category: 'agents_tasks' },
      { ...this.taskOutputTool(), category: 'agents_tasks' },
      { ...this.teamCreateTool(), category: 'agents_tasks' },
      { ...this.teamDeleteTool(), category: 'agents_tasks' },
      { ...this.listPeersTool(), category: 'agents_tasks' },
      
      // Planning
      { ...this.enterPlanModeTool(), category: 'planning' },
      { ...this.exitPlanModeTool(), category: 'planning' },
      { ...this.enterWorktreeTool(), category: 'planning' },
      { ...this.exitWorktreeTool(), category: 'planning' },
      { ...this.verifyPlanExecutionTool(), category: 'planning' },

      // MCP
      { ...this.mcpListTool(), category: 'mcp' },
      { ...this.mcpResourcesTool(), category: 'mcp' },
      { ...this.readMcpResourceTool(), category: 'mcp' },
      { ...this.mcpAuthTool(), category: 'mcp' },
      
      // System
      { ...this.getCurrentTimeTool(), category: 'system' },
      { ...this.todoWriteTool(), category: 'system' },
      { ...this.skillConfigTool(), category: 'system' },
      { ...this.configTool(), category: 'system' },
      { ...this.cronCreateTool(), category: 'system' },
      { ...this.cronDeleteTool(), category: 'system' },
      { ...this.cronStartTool(), category: 'system' },
      { ...this.cronStopTool(), category: 'system' },
      { ...this.cronRunTool(), category: 'system' },
      { ...this.cronListTool(), category: 'system' },
      
      // Experimental
      { ...this.lspCompleteTool(), category: 'experimental' },
      { ...this.lspDiagnosticsTool(), category: 'experimental' },
      { ...this.lspDefinitionTool(), category: 'experimental' },
      { ...this.sleepTool(), category: 'experimental' },
      { ...this.tencentHotNewsTool(), category: 'search_fetch' },
      { ...this.tencentSearchNewsTool(), category: 'search_fetch' },
      { ...this.tencentMorningNewsTool(), category: 'search_fetch' },
      { ...this.tencentEveningNewsTool(), category: 'search_fetch' },
      { ...this.sendLarkMessageTool(), category: 'mcp' },
      { ...this.pushNewsToLarkTool(), category: 'mcp' },
      { ...this.pushWeatherToLarkTool(), category: 'mcp' },
    ];
  }

  private readFileTool(): Tool {
    return {
      name: 'read_file',
      description: 'Read the contents of a file from the file system',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to read',
          },
        },
        required: ['path'],
      },
    };
  }

  private writeFileTool(): Tool {
    return {
      name: 'write_file',
      description: 'Write content to a text file, creating it if it does not exist',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to write',
          },
          content: {
            type: 'string',
            description: 'The content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    };
  }

  private txtToDocxTool(): Tool {
    return {
      name: 'txt_to_docx',
      description: 'Create a Word document from plain text and save it to the configured output directory unless an explicit path is provided',
      input_schema: {
        type: 'object',
        properties: {
          output: {
            type: 'string',
            description: 'Output .docx path; relative paths are saved under the configured artifact output directory',
          },
          text: {
            type: 'string',
            description: 'Plain text document body',
          },
          title: {
            type: 'string',
            description: 'Optional document title shown as the first heading',
          },
        },
        required: ['output', 'text'],
      },
    };
  }

  private txtToXlsxTool(): Tool {
    return {
      name: 'txt_to_xlsx',
      description: 'Create an XLSX spreadsheet from plain text, markdown table, CSV, or TSV content and save it to the configured output directory unless an explicit path is provided',
      input_schema: {
        type: 'object',
        properties: {
          output: {
            type: 'string',
            description: 'Output .xlsx path; relative paths are saved under the configured artifact output directory',
          },
          text: {
            type: 'string',
            description: 'Spreadsheet body as markdown table, CSV, TSV, or plain lines',
          },
          title: {
            type: 'string',
            description: 'Optional worksheet title',
          },
        },
        required: ['output', 'text'],
      },
    };
  }

  private txtToPdfTool(): Tool {
    return {
      name: 'txt_to_pdf',
      description: 'Create a PDF document from plain text and save it to the configured output directory unless an explicit path is provided',
      input_schema: {
        type: 'object',
        properties: {
          out: { type: 'string', description: 'Output .pdf path; relative paths are saved under the configured artifact output directory' },
          text: { type: 'string', description: 'Plain text document body' },
          title: { type: 'string', description: 'Optional document title' },
        },
        required: ['out', 'text'],
      },
    };
  }

  private txtToPptxTool(): Tool {
    return {
      name: 'txt_to_pptx',
      description: 'Create a PPTX presentation from plain text and save it to the configured output directory unless an explicit path is provided',
      input_schema: {
        type: 'object',
        properties: {
          output: { type: 'string', description: 'Output .pptx path; relative paths are saved under the configured artifact output directory' },
          text: { type: 'string', description: 'Slide body text, one line per paragraph or bullet' },
          title: { type: 'string', description: 'Optional slide title' },
        },
        required: ['output', 'text'],
      },
    };
  }

  private editFileTool(): Tool {
    return {
      name: 'edit_file',
      description: 'Edit a specific section of a file by replacing old text with new text',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'The exact text to find and replace',
          },
          new_string: {
            type: 'string',
            description: 'The new text to replace the old text with',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    };
  }

  private deleteFileTool(): Tool {
    return {
      name: 'delete_file',
      description: 'Delete a file from the file system',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the file to delete',
          },
        },
        required: ['path'],
      },
    };
  }

  private listDirectoryTool(): Tool {
    return {
      name: 'list_directory',
      description: 'List the contents of a directory',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path to the directory to list',
          },
        },
        required: ['path'],
      },
    };
  }

  private createDirectoryTool(): Tool {
    return {
      name: 'create_directory',
      description: 'Create a new directory',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The path of the directory to create',
          },
        },
        required: ['path'],
      },
    };
  }

  private searchFilesTool(): Tool {
    return {
      name: 'search_files',
      description: 'Search for files matching a pattern or content',
      input_schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The directory to search in',
          },
          pattern: {
            type: 'string',
            description: 'The glob pattern or file extension to search for',
          },
          content: {
            type: 'string',
            description: 'Optional text content to search for within files',
          },
        },
        required: ['path'],
      },
    };
  }

  private executeCommandTool(): Tool {
    return {
      name: 'execute_command',
      description: 'Execute a shell command and return the output',
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Optional timeout in milliseconds',
          },
        },
        required: ['command'],
      },
    };
  }

  private globTool(): Tool {
    return {
      name: 'glob',
      description: 'Find files matching a glob pattern',
      input_schema: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'The glob pattern to match (e.g., "**/*.ts")',
          },
          cwd: {
            type: 'string',
            description: 'The directory to search in',
          },
        },
        required: ['pattern'],
      },
    };
  }

  private readMultipleFilesTool(): Tool {
    return {
      name: 'read_multiple_files',
      description: 'Read the contents of multiple files at once',
      input_schema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of file paths to read',
          },
        },
        required: ['paths'],
      },
    };
  }

  private lspCompleteTool(): Tool {
    return {
      name: 'lsp_complete',
      description: 'Get code completions from the LSP server',
      input_schema: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'The URI of the file',
          },
          line: {
            type: 'number',
            description: 'The line number (0-indexed)',
          },
          character: {
            type: 'number',
            description: 'The character position (0-indexed)',
          },
        },
        required: ['uri', 'line', 'character'],
      },
    };
  }

  private lspDiagnosticsTool(): Tool {
    return {
      name: 'lsp_diagnostics',
      description: 'Get diagnostics for a file from the LSP server',
      input_schema: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'The URI of the file',
          },
        },
        required: ['uri'],
      },
    };
  }

  private lspDefinitionTool(): Tool {
    return {
      name: 'lsp_definition',
      description: 'Go to definition of a symbol',
      input_schema: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'The URI of the file',
          },
          line: {
            type: 'number',
            description: 'The line number (0-indexed)',
          },
          character: {
            type: 'number',
            description: 'The character position (0-indexed)',
          },
        },
        required: ['uri', 'line', 'character'],
      },
    };
  }

  private copyFileTool(): Tool {
    return {
      name: 'copy_file',
      description: 'Copy a file or directory to a new location',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source path' },
          destination: { type: 'string', description: 'Destination path' },
        },
        required: ['source', 'destination'],
      },
    };
  }

  private moveFileTool(): Tool {
    return {
      name: 'move_file',
      description: 'Move or rename a file or directory',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source path' },
          destination: { type: 'string', description: 'Destination path' },
        },
        required: ['source', 'destination'],
      },
    };
  }

  private fileInfoTool(): Tool {
    return {
      name: 'file_info',
      description: 'Get information about a file or directory',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to file or directory' },
        },
        required: ['path'],
      },
    };
  }

  private grepTool(): Tool {
    return {
      name: 'grep',
      description: 'Search for text in files using regular expressions',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for' },
          path: { type: 'string', description: 'Directory to search in' },
          include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
        },
        required: ['pattern', 'path'],
      },
    };
  }

  private getCurrentTimeTool(): Tool {
    return {
      name: 'get_current_time',
      description: 'Get the current date and time',
      input_schema: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'Timezone (e.g., "Asia/Shanghai", "America/New_York")' },
          format: { type: 'string', description: 'Date format (default: "YYYY-MM-DD HH:mm:ss")' },
        },
      },
    };
  }

  private calculateTool(): Tool {
    return {
      name: 'calculate',
      description: 'Evaluate a mathematical expression',
      input_schema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Mathematical expression (e.g., "2 + 2", "sqrt(16)")' },
        },
        required: ['expression'],
      },
    };
  }

  private webSearchTool(): Tool {
    return {
      name: 'web_search',
      description: 'Search the web using DuckDuckGo (no API key required)',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          numResults: { type: 'number', description: 'Number of results (default: 5)' },
        },
        required: ['query'],
      },
    };
  }

  private fetchUrlTool(): Tool {
    return {
      name: 'fetch_url',
      description: 'Fetch and extract text content from a webpage',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          maxLength: { type: 'number', description: 'Max content length (default: 10000)' },
        },
        required: ['url'],
      },
    };
  }

  private openBrowserTool(): Tool {
    return {
      name: 'open_browser',
      description: 'Open a URL in the requested browser, defaulting to the system browser unless browser is specified',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
          browser: { type: 'string', description: 'Optional browser target: chrome, edge, chromium, or default' },
          background: { type: 'boolean', description: 'Open in background without focusing (default: false)' },
        },
        required: ['url'],
      },
    };
  }

  private browserAutomateTool(): Tool {
    return {
      name: 'browser_automate',
      description: 'Use Playwright to open a page and perform scripted browser actions such as click, fill, wait, extract text, and screenshot',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Initial URL to open' },
          actions: {
            type: 'array',
            description: 'Browser action list. Supported types: goto, click, fill, press, wait_for_selector, wait, extract_text, screenshot',
            items: { type: 'object' },
          },
          browser: { type: 'string', description: 'Browser target for automation: chrome, edge, or chromium. Default chrome' },
          headless: { type: 'boolean', description: 'Run browser headless by default; set false to show the browser window' },
          timeoutMs: { type: 'number', description: 'Default timeout for actions in milliseconds' },
        },
        required: ['url'],
      },
    };
  }

  private getWeatherTool(): Tool {
    return {
      name: 'get_weather',
      description: 'Query current weather and today forecast for a city',
      input_schema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'City name, e.g. 北京 or Shanghai',
          },
          timezone: {
            type: 'string',
            description: 'Optional IANA timezone, default Asia/Shanghai',
          },
        },
      },
    };
  }

  private replTool(): Tool {
    return {
      name: 'repl',
      description: 'Evaluate JavaScript code in a sandboxed REPL',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to evaluate' },
        },
        required: ['code'],
      },
    };
  }

  private agentSendMessageTool(): Tool {
    return {
      name: 'agent_send_message',
      description: 'Queue a message for a local peer agent or team inbox',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Target agent or team name' },
          message: { type: 'string', description: 'Message content' },
        },
        required: ['target', 'message'],
      },
    };
  }

  private taskCreateTool(): Tool {
    return {
      name: 'task_create',
      description: 'Create a local task record',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          description: { type: 'string', description: 'Task description' },
          assignee: { type: 'string', description: 'Optional assignee or target agent' },
        },
        required: ['title'],
      },
    };
  }

  private taskGetListTool(): Tool {
    return {
      name: 'task_get_list',
      description: 'List local tasks',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'stopped', 'failed'],
            description: 'Optional task status filter',
          },
        },
      },
    };
  }

  private taskUpdateTool(): Tool {
    return {
      name: 'task_update',
      description: 'Update a local task',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id' },
          title: { type: 'string', description: 'New task title' },
          description: { type: 'string', description: 'New description' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'stopped', 'failed'],
            description: 'New status',
          },
          output: { type: 'string', description: 'Task output or result' },
        },
        required: ['id'],
      },
    };
  }

  private taskStopTool(): Tool {
    return {
      name: 'task_stop',
      description: 'Stop a local task',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id' },
          reason: { type: 'string', description: 'Optional stop reason' },
        },
        required: ['id'],
      },
    };
  }

  private taskOutputTool(): Tool {
    return {
      name: 'task_output',
      description: 'Get the output of a local task',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id' },
        },
        required: ['id'],
      },
    };
  }

  private teamCreateTool(): Tool {
    return {
      name: 'team_create',
      description: 'Create a lightweight local team definition',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Team name' },
          description: { type: 'string', description: 'Team description' },
          members: { type: 'array', items: { type: 'string' }, description: 'Team members' },
        },
        required: ['name'],
      },
    };
  }

  private teamDeleteTool(): Tool {
    return {
      name: 'team_delete',
      description: 'Delete a lightweight local team definition',
      input_schema: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Team id or team name' },
        },
        required: ['idOrName'],
      },
    };
  }

  private listPeersTool(): Tool {
    return {
      name: 'list_peers',
      description: 'List available local peers, teams, and MCP servers',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private enterPlanModeTool(): Tool {
    return {
      name: 'enter_plan_mode',
      description: 'Enter planning mode to develop a multi-step plan before execution',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task to plan for' },
        },
        required: ['task'],
      },
    };
  }

  private exitPlanModeTool(): Tool {
    return {
      name: 'exit_plan_mode',
      description: 'Exit planning mode and return to normal operation',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private enterWorktreeTool(): Tool {
    return {
      name: 'enter_worktree',
      description: 'Create and enter a new git worktree for isolated development',
      input_schema: {
        type: 'object',
        properties: {
          branch: { type: 'string', description: 'Branch name for the worktree' },
          path: { type: 'string', description: 'Path for the new worktree' },
        },
        required: ['branch', 'path'],
      },
    };
  }

  private exitWorktreeTool(): Tool {
    return {
      name: 'exit_worktree',
      description: 'Exit current worktree and return to main repository',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private verifyPlanExecutionTool(): Tool {
    return {
      name: 'verify_plan_execution',
      description: 'Verify that a plan was executed correctly',
      input_schema: {
        type: 'object',
        properties: {
          planId: { type: 'string', description: 'ID of the plan to verify' },
        },
        required: ['planId'],
      },
    };
  }

  private mcpListTool(): Tool {
    return {
      name: 'mcp_list',
      description: 'List connected MCP servers and their tool counts',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private mcpResourcesTool(): Tool {
    return {
      name: 'mcp_resources',
      description: 'List MCP resources for one server or all servers',
      input_schema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Optional MCP server name' },
        },
      },
    };
  }

  private readMcpResourceTool(): Tool {
    return {
      name: 'read_mcp_resource',
      description: 'Read a specific MCP resource',
      input_schema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP server name' },
          uri: { type: 'string', description: 'Resource URI' },
        },
        required: ['server', 'uri'],
      },
    };
  }

  private mcpAuthTool(): Tool {
    return {
      name: 'mcp_auth',
      description: 'Show MCP authentication guidance for a server',
      input_schema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Optional MCP server name' },
        },
      },
    };
  }

  private todoWriteTool(): Tool {
    return {
      name: 'todo_write',
      description: 'Write or update a todo item',
      input_schema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Todo content' },
          done: { type: 'boolean', description: 'Mark as done' },
        },
        required: ['content'],
      },
    };
  }

  private skillConfigTool(): Tool {
    return {
      name: 'skill_config',
      description: 'Configure or query skill settings',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'enable', 'disable', 'install', 'uninstall'], description: 'Action to perform' },
          skillName: { type: 'string', description: 'Name of the skill' },
        },
        required: ['action'],
      },
    };
  }

  private configTool(): Tool {
    return {
      name: 'config',
      description: 'Get or set configuration values',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'list'], description: 'Action to perform' },
          key: { type: 'string', description: 'Config key' },
          value: { type: 'string', description: 'Config value (for set)' },
        },
        required: ['action'],
      },
    };
  }

  private cronCreateTool(): Tool {
    return {
      name: 'cron_create',
      description: 'Create a persistent cron job that runs a tool on schedule',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Job name' },
          schedule: { type: 'string', description: 'Cron expression, e.g. "0 8 * * *" or @daily' },
          tool: { type: 'string', description: 'Tool name to run, e.g. tencent_morning_news' },
          args: { type: 'object', description: 'Optional tool arguments' },
          description: { type: 'string', description: 'Optional job description' },
          timezone: { type: 'string', description: 'Optional IANA timezone' },
        },
        required: ['name', 'schedule', 'tool'],
      },
    };
  }

  private cronDeleteTool(): Tool {
    return {
      name: 'cron_delete',
      description: 'Delete a persistent cron job',
      input_schema: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Cron job id or name' },
        },
        required: ['idOrName'],
      },
    };
  }

  private cronStartTool(): Tool {
    return {
      name: 'cron_start',
      description: 'Start the cron scheduler or enable a cron job by id or name',
      input_schema: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Optional cron job id or name' },
        },
      },
    };
  }

  private cronStopTool(): Tool {
    return {
      name: 'cron_stop',
      description: 'Stop the cron scheduler or disable a cron job by id or name',
      input_schema: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Optional cron job id or name' },
        },
      },
    };
  }

  private cronRunTool(): Tool {
    return {
      name: 'cron_run',
      description: 'Run a cron job immediately once by id or name, regardless of whether it is currently due',
      input_schema: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Cron job id or name' },
        },
        required: ['idOrName'],
      },
    };
  }

  private cronListTool(): Tool {
    return {
      name: 'cron_list',
      description: 'List persistent cron jobs',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private sleepTool(): Tool {
    return {
      name: 'sleep',
      description: 'Pause execution for a specified duration',
      input_schema: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'Number of seconds to sleep' },
        },
        required: ['seconds'],
      },
    };
  }

  private tencentHotNewsTool(): Tool {
    return {
      name: 'tencent_hot_news',
      description: 'Query Tencent News hot ranking list',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of news items (default: 10)' },
        },
      },
    };
  }

  private tencentSearchNewsTool(): Tool {
    return {
      name: 'tencent_search_news',
      description: 'Search Tencent News by keyword',
      input_schema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search keyword' },
          limit: { type: 'number', description: 'Number of results (default: 10)' },
        },
        required: ['keyword'],
      },
    };
  }

  private tencentMorningNewsTool(): Tool {
    return {
      name: 'tencent_morning_news',
      description: 'Query Tencent News morning edition',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private tencentEveningNewsTool(): Tool {
    return {
      name: 'tencent_evening_news',
      description: 'Query Tencent News evening edition',
      input_schema: {
        type: 'object',
        properties: {},
      },
    };
  }

  private pushNewsToLarkTool(): Tool {
    return {
      name: 'push_news_to_lark',
      description: 'Fetch Tencent News and send it to a Lark chat via the configured lark MCP bridge using bot identity',
      input_schema: {
        type: 'object',
        properties: {
          newsType: { type: 'string', description: 'One of morning, evening, hot, search' },
          chatId: { type: 'string', description: 'Optional Lark chat id (oc_xxx); falls back to notifications.lark.morningNews.chatId' },
          keyword: { type: 'string', description: 'Required for search news type' },
          limit: { type: 'number', description: 'Limit for hot/search news, default 10' },
          title: { type: 'string', description: 'Optional news heading title' },
          timezone: { type: 'string', description: 'Optional timezone for the header, default Asia/Shanghai' },
          saveOutput: { type: 'boolean', description: 'Save the generated message to local output directory' },
          dryRun: { type: 'boolean', description: 'Return the outgoing message without sending it to Lark' },
        },
        required: ['newsType'],
      },
    };
  }

  private pushWeatherToLarkTool(): Tool {
    return {
      name: 'push_weather_to_lark',
      description: 'Fetch today weather for a city and send it to a Lark chat via the configured lark MCP bridge using bot identity',
      input_schema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Optional Lark chat id (oc_xxx); falls back to notifications.lark.weather.chatId or notifications.lark.morningNews.chatId' },
          city: { type: 'string', description: 'City name, default notifications.lark.weather.city or 北京' },
          timezone: { type: 'string', description: 'Optional timezone, default notifications.lark.weather.timezone or Asia/Shanghai' },
          dryRun: { type: 'boolean', description: 'Return the outgoing message without sending it to Lark' },
        },
      },
    };
  }

  private sendLarkMessageTool(): Tool {
    return {
      name: 'send_lark_message',
      description: 'Send a custom message or media to a Lark chat via the configured lark MCP bridge using bot identity',
      input_schema: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Optional Lark chat id (oc_xxx); falls back to notifications.lark.morningNews.chatId' },
          text: { type: 'string', description: 'Plain text message body' },
          markdown: { type: 'string', description: 'Markdown message body' },
          file: { type: 'string', description: 'Relative file path to send as an attachment' },
          image: { type: 'string', description: 'Relative image path to send' },
          video: { type: 'string', description: 'Relative video path to send' },
          audio: { type: 'string', description: 'Relative audio path to send' },
          dryRun: { type: 'boolean', description: 'Return the outgoing request without sending it to Lark' },
        },
      },
    };
  }

  async executeTool(name: string, args: unknown): Promise<ToolResult> {
    try {
      let result: string;

      switch (name) {
        case 'read_file':
          result = await this.sandbox.readFile(this.resolveInputPath((args as { path: string }).path));
          break;

        case 'write_file': {
          const { path: filePath, content } = args as { path: string; content: string };
          const resolvedPath = this.resolveOutputFilePath(filePath);
          if (this.isStructuredDocumentExtension(resolvedPath)) {
            throw new Error(`write_file 不能直接写入 ${path.extname(resolvedPath)} 文件。请改用对应的导出工具生成真实文档。`);
          }
          await this.sandbox.writeFile(resolvedPath, content);
          result = `File written successfully: ${resolvedPath}`;
          break;
        }

        case 'txt_to_docx': {
          const { output, text, title } = args as { output: string; text: string; title?: string };
          const resolvedPath = this.resolveOutputFilePath(output);
          await writeDocxDocument(resolvedPath, String(text || ''), typeof title === 'string' ? title : undefined);
          result = `Created report document: ${resolvedPath}`;
          break;
        }

        case 'txt_to_pdf': {
          const { out, text, title } = args as { out: string; text: string; title?: string };
          const resolvedPath = this.resolveOutputFilePath(out);
          await writePdfDocument(resolvedPath, String(text || ''), typeof title === 'string' ? title : undefined);
          result = `Created PDF document: ${resolvedPath}`;
          break;
        }

        case 'txt_to_pptx': {
          const { output, text, title } = args as { output: string; text: string; title?: string };
          const resolvedPath = this.resolveOutputFilePath(output);
          await writePptxDocument(resolvedPath, String(text || ''), typeof title === 'string' ? title : undefined);
          result = `Created presentation document: ${resolvedPath}`;
          break;
        }

        case 'txt_to_xlsx': {
          const { output, text, title } = args as { output: string; text: string; title?: string };
          const resolvedPath = this.resolveOutputFilePath(output);
          await writeXlsxDocument(resolvedPath, String(text || ''), typeof title === 'string' ? title : undefined);
          result = `Created spreadsheet document: ${resolvedPath}`;
          break;
        }

        case 'edit_file': {
          const { path: filePath, old_string, new_string } = args as {
            path: string;
            old_string: string;
            new_string: string;
          };
          const resolvedPath = this.resolveOutputFilePath(filePath);
          const content = await this.sandbox.readFile(resolvedPath);
          const newContent = content.replace(old_string, new_string);
          if (content === newContent) {
            return { tool_call_id: '', output: 'No changes made - old_string not found', is_error: true };
          }
          await this.sandbox.writeFile(resolvedPath, newContent);
          result = `File edited successfully: ${resolvedPath}`;
          break;
        }

        case 'delete_file':
          await this.sandbox.deleteFile(this.resolveInputPath((args as { path: string }).path));
          result = 'File deleted successfully';
          break;

        case 'list_directory':
          result = (await this.sandbox.listDirectory(this.resolveInputPath((args as { path: string }).path))).join('\n');
          break;

        case 'create_directory': {
          const dirPath = this.resolveOutputFilePath((args as { path: string }).path);
          await fs.mkdir(dirPath, { recursive: true });
          result = `Directory created: ${dirPath}`;
          break;
        }

        case 'search_files': {
          const { path: searchPath, pattern, content } = args as {
            path: string;
            pattern?: string;
            content?: string;
          };
          result = await this.searchFiles(this.resolveInputPath(searchPath), pattern, content);
          break;
        }

        case 'execute_command': {
          const { command, timeout } = args as { command: string; timeout?: number };
          const isWindows = process.platform === 'win32';
          const cwd = this.getCurrentCronJobWorkDir() || process.cwd();
          await fs.mkdir(cwd, { recursive: true });
          const execResult = isWindows
            ? await this.sandbox.execute('powershell', ['-NoProfile', '-Command', command], { cwd, timeout })
            : await this.sandbox.execute('bash', ['-lc', command], { cwd, timeout });
          result = `Exit code: ${execResult.exitCode}\n\nStdout:\n${execResult.stdout}\n\nStderr:\n${execResult.stderr}`;
          break;
        }

        case 'glob':
          result = await this.glob(
            (args as { pattern: string; cwd?: string }).pattern,
            (args as { pattern: string; cwd?: string }).cwd ? this.resolveInputPath((args as { pattern: string; cwd?: string }).cwd as string) : undefined,
          );
          break;

        case 'read_multiple_files':
          result = await this.readMultipleFiles((args as { paths: string[] }).paths.map(filePath => this.resolveInputPath(filePath)));
          break;

        case 'lsp_complete': {
          const { uri, line, character } = args as { uri: string; line: number; character: number };
          const completions = await this.lspComplete(uri, line, character);
          result = JSON.stringify(completions, null, 2);
          break;
        }

        case 'lsp_diagnostics': {
          const { uri } = args as { uri: string };
          const diagnostics = await this.lspDiagnostics(uri);
          result = JSON.stringify(diagnostics, null, 2);
          break;
        }

        case 'lsp_definition': {
          const { uri, line, character } = args as { uri: string; line: number; character: number };
          const definition = await this.lspDefinition(uri, line, character);
          result = JSON.stringify(definition, null, 2);
          break;
        }

        case 'copy_file': {
          const { source, destination } = args as { source: string; destination: string };
          const resolvedSource = this.resolveInputPath(source);
          const resolvedDestination = this.resolveOutputFilePath(destination);
          await fs.copyFile(resolvedSource, resolvedDestination);
          result = `Copied: ${resolvedSource} -> ${resolvedDestination}`;
          break;
        }

        case 'move_file': {
          const { source, destination } = args as { source: string; destination: string };
          const resolvedSource = this.resolveInputPath(source);
          const resolvedDestination = this.resolveOutputFilePath(destination);
          await fs.rename(resolvedSource, resolvedDestination);
          result = `Moved: ${resolvedSource} -> ${resolvedDestination}`;
          break;
        }

        case 'file_info': {
          const { path: filePath } = args as { path: string };
          const resolvedPath = this.resolveInputPath(filePath);
          const stats = await fs.stat(resolvedPath);
          result = JSON.stringify({
            path: resolvedPath,
            size: stats.size,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
          }, null, 2);
          break;
        }

        case 'grep': {
          const { pattern, path: searchPath, include } = args as { pattern: string; path: string; include?: string };
          result = await this.grep(this.resolveInputPath(searchPath), pattern, include);
          break;
        }

        case 'get_current_time': {
          const { timezone, format } = args as { timezone?: string; format?: string };
          result = this.getCurrentTime(timezone, format);
          break;
        }

        case 'calculate': {
          const { expression } = args as { expression: string };
          result = this.calculate(expression);
          break;
        }

        case 'web_search': {
          const { query, numResults } = args as { query: string; numResults?: number };
          result = await this.webSearch(query, numResults ?? 5);
          break;
        }

        case 'fetch_url': {
          const { url, maxLength } = args as { url: string; maxLength?: number };
          result = await this.fetchUrl(url, maxLength ?? 10000);
          break;
        }

        case 'open_browser': {
          const { url, background, browser } = args as { url: string; background?: boolean; browser?: BrowserTarget | 'default' };
          result = await this.openBrowser(url, background ?? false, browser ?? 'default');
          break;
        }

        case 'browser_automate': {
          const { url, actions, headless, timeoutMs, browser } = args as {
            url: string;
            actions?: BrowserAutomationAction[];
            browser?: BrowserTarget;
            headless?: boolean;
            timeoutMs?: number;
          };
          result = await this.browserAutomate(url, actions ?? [], browser ?? 'chrome', headless ?? true, timeoutMs ?? 15000);
          break;
        }

        case 'get_weather': {
          const { city, timezone } = args as { city?: string; timezone?: string };
          result = await this.getWeather(city, timezone);
          break;
        }

        case 'agent_send_message': {
          const { target, message } = args as { target: string; message: string };
          result = await this.agentSendMessage(target, message);
          break;
        }

        case 'task_create': {
          const { title, description, assignee } = args as { title: string; description?: string; assignee?: string };
          result = await this.taskCreate(title, description, assignee);
          break;
        }

        case 'task_get_list': {
          const { status } = args as { status?: 'pending' | 'in_progress' | 'completed' | 'stopped' | 'failed' };
          result = this.taskGetList(status);
          break;
        }

        case 'task_update': {
          const { id, ...updates } = args as { id: string; title?: string; description?: string; status?: 'pending' | 'in_progress' | 'completed' | 'stopped' | 'failed'; output?: string };
          result = await this.taskUpdate(id, updates);
          break;
        }

        case 'task_stop': {
          const { id, reason } = args as { id: string; reason?: string };
          result = await this.taskStop(id, reason);
          break;
        }

        case 'task_output': {
          const { id } = args as { id: string };
          result = this.taskOutput(id);
          break;
        }

        case 'team_create': {
          const { name: teamName, description, members } = args as { name: string; description?: string; members?: string[] };
          result = await this.teamCreate(teamName, description, members);
          break;
        }

        case 'team_delete': {
          const { idOrName } = args as { idOrName: string };
          result = await this.teamDelete(idOrName);
          break;
        }

        case 'list_peers':
          result = this.listPeers();
          break;

        case 'repl': {
          const { code } = args as { code: string };
          result = this.evaluateRepl(code);
          break;
        }

        case 'enter_plan_mode':
          result = 'Entered planning mode. Use exit_plan_mode to return to normal operation.';
          break;

        case 'exit_plan_mode':
          result = 'Exited planning mode.';
          break;

        case 'enter_worktree': {
          const { branch, path: worktreePath } = args as { branch: string; path: string };
          result = await this.createWorktree(branch, worktreePath);
          break;
        }

        case 'exit_worktree':
          result = 'Worktree support requires git integration.';
          break;

        case 'verify_plan_execution': {
          const { planId } = args as { planId: string };
          result = `Plan ${planId} verification requires planner integration.`;
          break;
        }

        case 'mcp_list':
          result = await this.mcpList();
          break;

        case 'mcp_resources': {
          const { server } = args as { server?: string };
          result = await this.mcpResources(server);
          break;
        }

        case 'read_mcp_resource': {
          const { server, uri } = args as { server: string; uri: string };
          result = await this.readMcpResource(server, uri);
          break;
        }

        case 'mcp_auth': {
          const { server } = args as { server?: string };
          result = this.mcpAuth(server);
          break;
        }

        case 'todo_write': {
          const { content, done } = args as { content: string; done?: boolean };
          result = `Todo "${content}" ${done ? 'completed' : 'added'}`;
          break;
        }

        case 'skill_config': {
          const { action, skillName } = args as { action: string; skillName?: string };
          result = `Skill config: ${action} ${skillName || ''}`;
          break;
        }

        case 'config': {
          const { action, key, value } = args as { action: string; key?: string; value?: string };
          result = `Config ${action}: ${key || ''} ${value || ''}`;
          break;
        }

        case 'cron_create': {
          const { name: jobName, schedule, tool, args: toolArgs, description, timezone } = args as {
            name: string;
            schedule: string;
            tool: string;
            args?: Record<string, unknown>;
            description?: string;
            timezone?: string;
          };
          result = await this.cronCreate(jobName, schedule, tool, toolArgs, description, timezone);
          break;
        }

        case 'cron_delete': {
          const { idOrName } = args as { idOrName: string };
          result = await this.cronDelete(idOrName);
          break;
        }

        case 'cron_start': {
          const { idOrName } = args as { idOrName?: string };
          result = await this.cronStart(idOrName);
          break;
        }

        case 'cron_stop': {
          const { idOrName } = args as { idOrName?: string };
          result = await this.cronStop(idOrName);
          break;
        }

        case 'cron_run': {
          const { idOrName } = args as { idOrName: string };
          result = await this.cronRun(idOrName);
          break;
        }

        case 'cron_list':
          result = this.cronList();
          break;

        case 'sleep': {
          const { seconds } = args as { seconds: number };
          await new Promise(r => setTimeout(r, seconds * 1000));
          result = `Slept for ${seconds} seconds`;
          break;
        }

        case 'tencent_hot_news': {
          const { limit } = args as { limit?: number };
          result = await this.getTencentHotNews(limit ?? 10);
          break;
        }

        case 'tencent_search_news': {
          const { keyword, limit } = args as { keyword: string; limit?: number };
          result = await this.searchTencentNews(keyword, limit ?? 10);
          break;
        }

        case 'tencent_morning_news':
          result = await this.getTencentMorningNews();
          break;

        case 'tencent_evening_news':
          result = await this.getTencentEveningNews();
          break;

        case 'push_news_to_lark': {
          result = await this.pushNewsToLark(args as {
            newsType: string;
            chatId?: string;
            keyword?: string;
            limit?: number;
            title?: string;
            timezone?: string;
            saveOutput?: boolean;
            dryRun?: boolean;
          });
          break;
        }

        case 'push_weather_to_lark': {
          result = await this.pushWeatherToLark(args as {
            chatId?: string;
            city?: string;
            timezone?: string;
            dryRun?: boolean;
          });
          break;
        }

        case 'send_lark_message': {
          result = await this.sendLarkMessage(args as {
            chatId?: string;
            text?: string;
            markdown?: string;
            file?: string;
            image?: string;
            video?: string;
            audio?: string;
            dryRun?: boolean;
          });
          break;
        }

        default:
          return { tool_call_id: '', output: `Unknown tool: ${name}`, is_error: true };
      }

      return {
        tool_call_id: '',
        output: result,
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const errorText = `Error: ${error instanceof Error ? error.message : String(error)}`;
      return {
        tool_call_id: '',
        output: errorText,
        content: [{ type: 'text', text: errorText }],
        is_error: true,
      };
    }
  }

  private async searchFiles(dir: string, pattern?: string, content?: string): Promise<string> {
    const results: string[] = [];

    async function search(currentDir: string): Promise<void> {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await search(fullPath);
        } else if (entry.isFile()) {
          if (pattern) {
            const ext = pattern.replace('*', '');
            if (entry.name.endsWith(ext)) {
              results.push(fullPath);
            }
          }
          
          if (content) {
            const fileContent = await fs.readFile(fullPath, 'utf-8');
            if (fileContent.includes(content)) {
              results.push(`${fullPath} (matched: ${content})`);
            }
          }
        }
      }
    }

    await search(dir);
    return results.length > 0 ? results.join('\n') : 'No matches found';
  }

  private async glob(pattern: string, cwd?: string): Promise<string> {
    const { join, resolve, sep } = await import('path');
    const baseDir = cwd ?? process.cwd();
    const results: string[] = [];
    
    const normalizedPattern = pattern.replace(/\\/g, '/');
    const parts = normalizedPattern.split('/');
    const regex = new RegExp(
      '^' + parts.map(p => p === '**' ? '.*' : p.replace(/\*/g, '[^/]*')).join('/') + '$'
    );
    
    async function search(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await search(fullPath);
          } else {
            const relativePath = resolve(fullPath).replace(resolve(baseDir), baseDir);
            const normalizedPath = relativePath.replace(/\\/g, '/');
            if (regex.test(normalizedPath)) {
              results.push(fullPath);
            }
          }
        }
      } catch { /* ignore */ }
    }
    
    await search(baseDir);
    return results.join('\n');
  }

  private async readMultipleFiles(paths: string[]): Promise<string> {
    const results: string[] = [];
    
    for (const filePath of paths) {
      try {
        const content = await this.sandbox.readFile(filePath);
        results.push(`=== ${filePath} ===\n${content}`);
      } catch (error) {
        results.push(`=== ${filePath} ===\nError: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
    return results.join('\n\n');
  }

  private async lspComplete(uri: string, line: number, character: number): Promise<unknown[]> {
    const client = this.lspManager.getClientForUri(uri);
    if (!client) return [];
    return client.complete(uri, { line, character });
  }

  private async lspDiagnostics(uri: string): Promise<unknown[]> {
    return [];
  }

  private async lspDefinition(uri: string, line: number, character: number): Promise<unknown> {
    const client = this.lspManager.getClientForUri(uri);
    if (!client) return null;
    return client.definition(uri, { line, character });
  }

  private async grep(dir: string, pattern: string, include?: string): Promise<string> {
    const results: string[] = [];
    const regex = new RegExp(pattern, 'gi');

    async function search(currentDir: string): Promise<void> {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await search(fullPath);
        } else if (entry.isFile()) {
          if (include && !entry.name.match(include.replace('*', '.*'))) {
            continue;
          }
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            lines.forEach((line, index) => {
              if (regex.test(line)) {
                results.push(`${fullPath}:${index + 1}: ${line.trim()}`);
              }
              regex.lastIndex = 0;
            });
          } catch { /* ignore */ }
        }
      }
    }

    await search(dir);
    return results.length > 0 ? results.join('\n') : 'No matches found';
  }

  private getCurrentTime(timezone?: string, format?: string): string {
    const now = new Date();
    if (timezone) {
      try {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        return formatter.format(now);
      } catch {
        return now.toISOString();
      }
    }

    if (format) {
      return format
        .replace('YYYY', String(now.getFullYear()))
        .replace('MM', String(now.getMonth() + 1).padStart(2, '0'))
        .replace('DD', String(now.getDate()).padStart(2, '0'))
        .replace('HH', String(now.getHours()).padStart(2, '0'))
        .replace('mm', String(now.getMinutes()).padStart(2, '0'))
        .replace('ss', String(now.getSeconds()).padStart(2, '0'));
    }

    return now.toISOString();
  }

  private calculate(expression: string): string {
    try {
      const sanitized = expression
        .replace(/[^0-9+\-*/().sqrt,\s]/gi, '')
        .replace(/sqrt\(/gi, 'Math.sqrt(')
        .replace(/pow\(/gi, 'Math.pow(')
        .replace(/abs\(/gi, 'Math.abs(')
        .replace(/floor\(/gi, 'Math.floor(')
        .replace(/ceil\(/gi, 'Math.ceil(')
        .replace(/round\(/gi, 'Math.round(')
        .replace(/pi/gi, 'Math.PI')
        .replace(/e(?![xp])/gi, 'Math.E');

      const result = new Function(`return ${sanitized}`)();
      return `${expression} = ${result}`;
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : 'Invalid expression'}`;
    }
  }

  private getNetworkHeaders(accept = 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8'): Record<string, string> {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': accept,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private decodeHtmlEntities(value: string): string {
    return value
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(parseInt(dec, 10)));
  }

  private htmlToPlainText(value: string): string {
    return this.decodeHtmlEntities(value)
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeWebSearchUrl(rawHref: string, baseUrl = 'https://duckduckgo.com'): string | null {
    if (!rawHref) return null;

    const decodedHref = this.decodeHtmlEntities(rawHref.trim());
    const absoluteHref = decodedHref.startsWith('//')
      ? `https:${decodedHref}`
      : decodedHref.startsWith('/')
        ? `${baseUrl}${decodedHref}`
        : decodedHref;

    try {
      const parsed = new URL(absoluteHref);
      if (/duckduckgo\.com$/i.test(parsed.hostname) && parsed.pathname === '/l/') {
        const target = parsed.searchParams.get('uddg');
        if (target) {
          return this.decodeHtmlEntities(target);
        }
      }

      if (/^https?:$/i.test(parsed.protocol)) {
        return parsed.toString();
      }
    } catch {
      return null;
    }

    return null;
  }

  private extractBaiduResults(html: string, numResults: number): Array<{ title: string; url: string; snippet?: string }> {
    const results: Array<{ title: string; url: string; snippet?: string }> = [];
    const seen = new Set<string>();
    const titleMatches = Array.from(
      html.matchAll(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi),
    );

    for (let index = 0; index < titleMatches.length && results.length < numResults; index++) {
      const match = titleMatches[index];
      if (!match) {
        continue;
      }

      const normalizedUrl = this.normalizeWebSearchUrl(match[1] || '', 'https://www.baidu.com');
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        continue;
      }

      const blockStart = match.index ?? 0;
      const blockEnd = titleMatches[index + 1]?.index ?? Math.min(html.length, blockStart + 2200);
      const blockHtml = html.slice(blockStart, blockEnd);
      const snippetMatch = blockHtml.match(
        /<(?:div|span|p)[^>]+class="[^"]*(?:c-abstract|c-span-last|content-right|summary|desc)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i,
      );

      seen.add(normalizedUrl);
      results.push({
        title: this.htmlToPlainText(match[2] || '') || 'No title',
        url: normalizedUrl,
        snippet: snippetMatch ? this.htmlToPlainText(snippetMatch[1] || '') || undefined : undefined,
      });
    }

    return results;
  }

  private extractDuckDuckGoHtmlResults(html: string, numResults: number): Array<{ title: string; url: string; snippet?: string }> {
    const results: Array<{ title: string; url: string; snippet?: string }> = [];
    const seen = new Set<string>();
    const anchorRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetRegex = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippets = Array.from(html.matchAll(snippetRegex)).map(match => this.htmlToPlainText(match[1] || ''));

    let index = 0;
    for (const match of html.matchAll(anchorRegex)) {
      if (results.length >= numResults) break;

      const normalizedUrl = this.normalizeWebSearchUrl(match[1] || '');
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        index++;
        continue;
      }

      seen.add(normalizedUrl);
      results.push({
        title: this.htmlToPlainText(match[2] || '') || 'No title',
        url: normalizedUrl,
        snippet: snippets[index] || undefined,
      });
      index++;
    }

    return results;
  }

  private extractDuckDuckGoLiteResults(html: string, numResults: number): Array<{ title: string; url: string; snippet?: string }> {
    const results: Array<{ title: string; url: string; snippet?: string }> = [];
    const seen = new Set<string>();
    const anchorRegex = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*result-link[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    for (const match of html.matchAll(anchorRegex)) {
      if (results.length >= numResults) break;

      const normalizedUrl = this.normalizeWebSearchUrl(match[1] || '');
      if (!normalizedUrl || seen.has(normalizedUrl)) continue;

      seen.add(normalizedUrl);
      results.push({
        title: this.htmlToPlainText(match[2] || '') || 'No title',
        url: normalizedUrl,
      });
    }

    return results;
  }

  private async webSearch(query: string, numResults: number): Promise<string> {
    try {
      const encodedQuery = encodeURIComponent(query);
      const endpoints = [
        {
          name: 'duckduckgo-html',
          url: `https://html.duckduckgo.com/html/?q=${encodedQuery}&kl=wt-wt`,
          parse: (html: string) => this.extractDuckDuckGoHtmlResults(html, numResults),
        },
        {
          name: 'duckduckgo-lite',
          url: `https://lite.duckduckgo.com/lite/?q=${encodedQuery}&kl=wt-wt`,
          parse: (html: string) => this.extractDuckDuckGoLiteResults(html, numResults),
        },
        {
          name: 'baidu',
          url: `https://www.baidu.com/s?wd=${encodedQuery}&rn=${Math.max(1, numResults)}`,
          parse: (html: string) => this.extractBaiduResults(html, numResults),
        },
      ];

      const errors: string[] = [];

      for (const endpoint of endpoints) {
        try {
          const response = await this.fetchWithTimeout(endpoint.url, {
            headers: this.getNetworkHeaders(),
          }, 15000);

          if (!response.ok) {
            errors.push(`${endpoint.name}: HTTP ${response.status}`);
            continue;
          }

          const html = await response.text();
          const parsedResults = endpoint.parse(html).slice(0, Math.max(1, numResults));
          if (parsedResults.length === 0) {
            errors.push(`${endpoint.name}: parsed 0 results`);
            continue;
          }

          const lines = parsedResults.map((item, index) => {
            const snippetPart = item.snippet ? `\n   Snippet: ${item.snippet}` : '';
            return `${index + 1}. ${item.title}\n   URL: ${item.url}${snippetPart}`;
          });

          return `Search results for "${query}":\n\n${lines.join('\n\n')}`;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${endpoint.name}: ${message}`);
        }
      }

      return `Search failed for "${query}". ${errors.join('; ')}`;
    } catch (error) {
      return `Search error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async fetchUrl(url: string, maxLength: number): Promise<string> {
    try {
      const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const parsedUrl = new URL(normalizedUrl);

      const response = await this.fetchWithTimeout(normalizedUrl, {
        headers: this.getNetworkHeaders('text/html,application/xhtml+xml,text/plain,application/json,application/xml,text/xml;q=0.9,*/*;q=0.8'),
      }, 15000);

      if (!response.ok) {
        return `Failed to fetch: HTTP ${response.status}`;
      }

      const contentType = response.headers.get('content-type') || '';
      const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
      const isPlainText = /text\/plain|application\/json|application\/xml|text\/xml/i.test(contentType);

      if (!isHtml && !isPlainText) {
        return `Unsupported content type: ${contentType}`;
      }

      let text = await response.text();
      if (isHtml) {
        text = text
          .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, ' ')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ');
        text = this.htmlToPlainText(text);
      } else {
        text = this.decodeHtmlEntities(text).replace(/\s+/g, ' ').trim();
      }

      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '...[truncated]';
      }

      const finalUrl = response.url || parsedUrl.toString();
      return `Fetched from: ${new URL(finalUrl).hostname}\nURL: ${finalUrl}\n\n${text}`;
    } catch (error) {
      return `Fetch error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async openBrowser(url: string, background: boolean, browser: BrowserTarget | 'default'): Promise<string> {
    try {
      let command: string;
      const isWindows = process.platform === 'win32';
      const isMac = process.platform === 'darwin';

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      if (browser !== 'default') {
        const executablePath = resolveBrowserExecutable(browser);
        if (!executablePath) {
          return `Failed to open browser: 未找到可用的 ${browser} 浏览器`;
        }

        await new Promise<void>((resolve, reject) => {
          const child = spawn(executablePath, [url], {
            detached: true,
            stdio: 'ignore',
            windowsHide: background,
          });
          child.once('error', reject);
          child.once('spawn', () => {
            child.unref();
            resolve();
          });
        });

        return `Opened in ${browser}: ${url}`;
      }

      if (isWindows) {
        command = background
          ? `start "" "${url}"`
          : `start "" "${url}"`;
      } else if (isMac) {
        command = `open ${background ? '-g ' : ''}"${url}"`;
      } else {
        command = background
          ? `xdg-open "${url}" > /dev/null 2>&1 &`
          : `xdg-open "${url}"`;
      }

      await execAsync(command);

      return `Opened in browser: ${url}`;
    } catch (error) {
      return `Failed to open browser: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async browserAutomate(url: string, actions: BrowserAutomationAction[], browser: BrowserTarget, headless: boolean, timeoutMs: number): Promise<string> {
    return runBrowserAutomation({
      url,
      actions,
      browser,
      headless,
      timeoutMs,
      resolveOutputPath: (requestedPath?: string) => this.resolveOutputFilePath(requestedPath || path.join('browser', `screenshot-${Date.now()}.png`)),
    });
  }

  private evaluateRepl(code: string): string {
    const candidates = [
      `return (${code});`,
      `return ${code};`,
      code,
    ];

    let lastError: Error | undefined;
    for (const candidate of candidates) {
      try {
        const result = new Function(candidate)();
        return String(result);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError || new Error('Invalid REPL code');
  }

  private async createWorktree(branch: string, path: string): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      execSync(`git worktree add "${path}" -b ${branch}`, { stdio: 'pipe' });
      return `Created worktree at ${path} with branch ${branch}`;
    } catch (error) {
      return `Failed to create worktree: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async agentSendMessage(target: string, message: string): Promise<string> {
    if (!this.taskManager) {
      return 'Agent messaging is unavailable: task manager not initialized';
    }

    const queued = await this.taskManager.sendMessage(target, message);
    return `Queued message ${queued.id} for ${target}`;
  }

  private async taskCreate(title: string, description?: string, assignee?: string): Promise<string> {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const task = await this.taskManager.createTask({ title, description, assignee });
    return JSON.stringify(task, null, 2);
  }

  private taskGetList(status?: 'pending' | 'in_progress' | 'completed' | 'stopped' | 'failed'): string {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const tasks = this.taskManager.listTasks(status);
    return tasks.length > 0 ? JSON.stringify(tasks, null, 2) : 'No tasks found';
  }

  private async taskUpdate(id: string, updates: { title?: string; description?: string; status?: 'pending' | 'in_progress' | 'completed' | 'stopped' | 'failed'; output?: string }): Promise<string> {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const task = await this.taskManager.updateTask(id, updates);
    return task ? JSON.stringify(task, null, 2) : `Task not found: ${id}`;
  }

  private async taskStop(id: string, reason?: string): Promise<string> {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const task = await this.taskManager.stopTask(id, reason);
    return task ? JSON.stringify(task, null, 2) : `Task not found: ${id}`;
  }

  private taskOutput(id: string): string {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const task = this.taskManager.getTask(id);
    if (!task) {
      return `Task not found: ${id}`;
    }

    return task.output || '(empty)';
  }

  private async teamCreate(name: string, description?: string, members?: string[]): Promise<string> {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const team = await this.taskManager.createTeam({ name, description, members });
    return JSON.stringify(team, null, 2);
  }

  private async teamDelete(idOrName: string): Promise<string> {
    if (!this.taskManager) {
      return 'Task manager not initialized';
    }

    const team = await this.taskManager.deleteTeam(idOrName);
    return team ? JSON.stringify(team, null, 2) : `Team not found: ${idOrName}`;
  }

  private listPeers(): string {
    const peers = this.taskManager?.listPeers() || [];
    const mcpServers = this.mcpManager?.getServerNames().map(name => ({ id: name, type: 'mcp', description: 'Connected MCP server' })) || [];
    const merged = [...peers, ...mcpServers];
    return merged.length > 0 ? JSON.stringify(merged, null, 2) : 'No peers found';
  }

  private async mcpList(): Promise<string> {
    if (!this.mcpManager) {
      return 'MCP manager not initialized';
    }

    const servers = this.mcpManager.getServerNames();
    if (servers.length === 0) {
      return 'No MCP servers connected';
    }

    const tools = await this.mcpManager.listAllTools();
    const summary = servers.map(server => ({
      server,
      toolCount: tools.filter(item => item.server === server).length,
    }));
    return JSON.stringify(summary, null, 2);
  }

  private async mcpResources(server?: string): Promise<string> {
    if (!this.mcpManager) {
      return 'MCP manager not initialized';
    }

    const resources = await this.mcpManager.listResources(server);
    return resources.length > 0 ? JSON.stringify(resources, null, 2) : 'No MCP resources found';
  }

  private async readMcpResource(server: string, uri: string): Promise<string> {
    if (!this.mcpManager) {
      return 'MCP manager not initialized';
    }

    const result = await this.mcpManager.readResource(server, uri);
    return JSON.stringify(result, null, 2);
  }

  private mcpAuth(server?: string): string {
    if (!this.mcpManager) {
      return 'MCP manager not initialized';
    }

    return server
      ? `MCP auth for ${server} is managed by the server command/env configuration. Reconnect the server after updating credentials.`
      : 'MCP auth is managed by each server command/env configuration. Reconnect servers after updating credentials.';
  }

  private async cronCreate(
    name: string,
    schedule: string,
    toolName: string,
    args?: Record<string, unknown>,
    description?: string,
    timezone?: string,
  ): Promise<string> {
    if (!this.cronManager) {
      return 'Cron manager not initialized';
    }

    const job = await this.cronManager.createJob({
      name,
      schedule,
      toolName,
      args,
      description,
      timezone,
    });
    return JSON.stringify(job, null, 2);
  }

  private async cronDelete(idOrName: string): Promise<string> {
    if (!this.cronManager) {
      return 'Cron manager not initialized';
    }

    const job = await this.cronManager.deleteJob(idOrName);
    return job ? JSON.stringify(job, null, 2) : `Cron job not found: ${idOrName}`;
  }

  private async cronStart(idOrName?: string): Promise<string> {
    if (!this.cronManager) {
      return 'Cron manager not initialized';
    }

    if (!idOrName) {
      this.cronManager.start();
      return 'Cron scheduler started';
    }

    const job = await this.cronManager.startJob(idOrName);
    return job ? JSON.stringify(job, null, 2) : `Cron job not found: ${idOrName}`;
  }

  private async cronStop(idOrName?: string): Promise<string> {
    if (!this.cronManager) {
      return 'Cron manager not initialized';
    }

    if (!idOrName) {
      this.cronManager.stop();
      return 'Cron scheduler stopped';
    }

    const job = await this.cronManager.stopJob(idOrName);
    return job ? JSON.stringify(job, null, 2) : `Cron job not found: ${idOrName}`;
  }

  private async cronRun(idOrName: string): Promise<string> {
    if (!this.cronManager) {
      throw new Error('Cron manager not initialized');
    }

    const run = await this.cronManager.runJobNow(idOrName);
    if (!run) {
      throw new Error(`Cron job not found: ${idOrName}`);
    }

    if (run.result.is_error) {
      throw new Error(`Cron job run failed: ${run.result.output || run.job.toolName}`);
    }

    return JSON.stringify({
      job: run.job,
      workDir: this.cronManager.getJobWorkDir(run.job.name),
      result: {
        output: run.result.output,
        is_error: Boolean(run.result.is_error),
      },
    }, null, 2);
  }

  private cronList(): string {
    if (!this.cronManager) {
      return 'Cron manager not initialized';
    }

    const jobs = this.cronManager.listJobs();
    return JSON.stringify({
      schedulerRunning: this.cronManager.isRunning(),
      jobs,
    }, null, 2);
  }

  private async getTencentHotNews(limit: number): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(`npx @tencentnews/cli hot --limit ${limit}`, { 
        encoding: 'utf-8',
        timeout: 30000,
      });
      return output;
    } catch (error) {
      return `Failed to get hot news: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async searchTencentNews(keyword: string, limit: number): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(`npx @tencentnews/cli search "${keyword}" --limit ${limit}`, { 
        encoding: 'utf-8',
        timeout: 30000,
      });
      return output;
    } catch (error) {
      return `Failed to search news: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async getTencentMorningNews(): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(`npx @tencentnews/cli morning`, { 
        encoding: 'utf-8',
        timeout: 30000,
      });
      return output;
    } catch (error) {
      return `Failed to get morning news: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async getTencentEveningNews(): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      const output = execSync(`npx @tencentnews/cli evening`, { 
        encoding: 'utf-8',
        timeout: 30000,
      });
      return output;
    } catch (error) {
      return `Failed to get evening news: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async pushNewsToLark(input: {
    newsType: string;
    chatId?: string;
    keyword?: string;
    limit?: number;
    title?: string;
    timezone?: string;
    saveOutput?: boolean;
    dryRun?: boolean;
  }): Promise<string> {
    if (!this.mcpManager) {
      throw new Error('MCP manager not initialized');
    }

    if (!this.mcpManager.getServerNames().includes('lark')) {
      throw new Error('Lark MCP server not connected');
    }

    const legacyUserId = typeof (input as Record<string, unknown>).userId === 'string'
      ? ((input as Record<string, unknown>).userId as string).trim()
      : '';
    if (legacyUserId) {
      throw new Error('push_news_to_lark only supports chatId. Please use notifications.lark.morningNews.chatId or pass chatId explicitly.');
    }

    const configuredTarget = this.getConfiguredLarkNewsTarget();
    const chatId = typeof input.chatId === 'string' && input.chatId.trim().length > 0
      ? input.chatId.trim()
      : configuredTarget.chatId;
    if (!chatId) {
      throw new Error('push_news_to_lark requires chatId, or notifications.lark.morningNews.chatId in config');
    }

    const newsType = (input.newsType || '').trim().toLowerCase();
    const limit = Number.isFinite(input.limit) && (input.limit || 0) > 0 ? Math.floor(input.limit as number) : 10;
    const timezone = typeof input.timezone === 'string' && input.timezone.trim().length > 0
      ? input.timezone.trim()
      : 'Asia/Shanghai';

    let newsBody: string;
    switch (newsType) {
      case 'morning':
        newsBody = await this.getTencentMorningNews();
        break;
      case 'evening':
        newsBody = await this.getTencentEveningNews();
        break;
      case 'hot':
        newsBody = await this.getTencentHotNews(limit);
        break;
      case 'search':
        if (!input.keyword?.trim()) {
          throw new Error('newsType=search requires keyword');
        }
        newsBody = await this.searchTencentNews(input.keyword.trim(), limit);
        break;
      default:
        throw new Error(`Unsupported newsType: ${input.newsType}`);
    }

    if (/^Failed to /i.test(newsBody)) {
      throw new Error(newsBody);
    }

    const title = typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : this.buildNewsPushTitle(newsType, input.keyword, limit);
    const message = this.buildNewsPushMessage(title, newsBody, timezone);
    const savedPath = input.saveOutput ? await this.savePushedNewsOutput(newsType, message, input.keyword, limit) : null;

    if (input.dryRun) {
      return [
        'DRY RUN: 未发送到飞书',
        savedPath ? `Saved to: ${savedPath}` : undefined,
        '',
        message,
      ].filter(Boolean).join('\n');
    }

    const flags: Record<string, unknown> = {
      text: message,
    };
    if (chatId) {
      flags['chat-id'] = chatId;
    }

    const result = await this.mcpManager.callTool('lark', 'shortcut', {
      service: 'im',
      command: '+messages-send',
      as: 'bot',
      flags,
    });
    const responseText = this.normalizeMcpTextResult(result);

    return [
      `新闻已发送到飞书群 ${chatId}`,
      savedPath ? `Saved to: ${savedPath}` : undefined,
      responseText || undefined,
    ].filter(Boolean).join('\n');
  }

  private async getWeather(city?: string, timezone?: string): Promise<string> {
    const configured = this.getConfiguredLarkWeatherTarget();
    const finalCity = typeof city === 'string' && city.trim().length > 0 ? city.trim() : configured.city || '北京';
    const finalTimezone = typeof timezone === 'string' && timezone.trim().length > 0 ? timezone.trim() : configured.timezone || 'Asia/Shanghai';
    return this.buildWeatherSummary(finalCity, finalTimezone);
  }

  private async pushWeatherToLark(input: {
    chatId?: string;
    city?: string;
    timezone?: string;
    dryRun?: boolean;
  }): Promise<string> {
    if (!this.mcpManager) {
      throw new Error('MCP manager not initialized');
    }

    if (!this.mcpManager.getServerNames().includes('lark')) {
      throw new Error('Lark MCP server not connected');
    }

    const configured = this.getConfiguredLarkWeatherTarget();
    const chatId = typeof input.chatId === 'string' && input.chatId.trim().length > 0
      ? input.chatId.trim()
      : configured.chatId;
    if (!chatId) {
      throw new Error('push_weather_to_lark requires chatId, or notifications.lark.weather.chatId / notifications.lark.morningNews.chatId in config');
    }

    const city = typeof input.city === 'string' && input.city.trim().length > 0 ? input.city.trim() : configured.city || '北京';
    const timezone = typeof input.timezone === 'string' && input.timezone.trim().length > 0 ? input.timezone.trim() : configured.timezone || 'Asia/Shanghai';
    const message = await this.buildWeatherSummary(city, timezone);

    if (input.dryRun) {
      return ['DRY RUN: 未发送到飞书', '', message].filter(Boolean).join('\n');
    }

    const result = await this.mcpManager.callTool('lark', 'shortcut', {
      service: 'im',
      command: '+messages-send',
      as: 'bot',
      flags: {
        'chat-id': chatId,
        text: message,
      },
    });
    const responseText = this.normalizeMcpTextResult(result);

    return [
      `天气已发送到飞书群 ${chatId}`,
      responseText || undefined,
    ].filter(Boolean).join('\n');
  }

  private async sendLarkMessage(input: {
    chatId?: string;
    text?: string;
    markdown?: string;
    file?: string;
    image?: string;
    video?: string;
    audio?: string;
    dryRun?: boolean;
  }): Promise<string> {
    if (!this.mcpManager) {
      throw new Error('MCP manager not initialized');
    }

    if (!this.mcpManager.getServerNames().includes('lark')) {
      throw new Error('Lark MCP server not connected');
    }

    const configuredTarget = this.getConfiguredLarkNewsTarget();
    const chatId = typeof input.chatId === 'string' && input.chatId.trim().length > 0
      ? input.chatId.trim()
      : configuredTarget.chatId;

    if (!chatId) {
      throw new Error('send_lark_message requires chatId, or notifications.lark.morningNews.chatId in config');
    }

    const flags: Record<string, unknown> = {
      'chat-id': chatId,
    };

    const payloadCandidates: Array<[keyof typeof input, string | undefined]> = [
      ['file', typeof input.file === 'string' && input.file.trim().length > 0 ? input.file.trim() : undefined],
      ['image', typeof input.image === 'string' && input.image.trim().length > 0 ? input.image.trim() : undefined],
      ['video', typeof input.video === 'string' && input.video.trim().length > 0 ? input.video.trim() : undefined],
      ['audio', typeof input.audio === 'string' && input.audio.trim().length > 0 ? input.audio.trim() : undefined],
      ['markdown', typeof input.markdown === 'string' && input.markdown.trim().length > 0 ? input.markdown : undefined],
      ['text', typeof input.text === 'string' && input.text.trim().length > 0 ? input.text : undefined],
    ];
    const selectedPayload = payloadCandidates.find(([, value]) => typeof value === 'string' && value.length > 0);
    let cleanupStagedAttachment: (() => Promise<void>) | undefined;

    if (selectedPayload) {
      const [payloadType, payloadValue] = selectedPayload;
      if (payloadType === 'file' || payloadType === 'image' || payloadType === 'video' || payloadType === 'audio') {
        const staged = await this.prepareLarkAttachmentPath(payloadValue!, input.dryRun === true);
        flags[payloadType] = staged.relativePath;
        cleanupStagedAttachment = staged.cleanup;
      } else {
        flags[payloadType] = payloadValue;
      }
    }

    const payloadKeys = ['text', 'markdown', 'file', 'image', 'video', 'audio'].filter(key => flags[key] !== undefined);
    if (payloadKeys.length === 0) {
      throw new Error('send_lark_message requires one of text, markdown, file, image, video, or audio');
    }

    if (input.dryRun) {
      return JSON.stringify({
        service: 'im',
        command: '+messages-send',
        as: 'bot',
        flags,
      }, null, 2);
    }

    try {
      const result = await this.mcpManager.callTool('lark', 'shortcut', {
        service: 'im',
        command: '+messages-send',
        as: 'bot',
        flags,
      });
      const responseText = this.normalizeMcpTextResult(result);

      return [
        `消息已发送到飞书群 ${chatId}`,
        responseText || undefined,
      ].filter(Boolean).join('\n');
    } finally {
      await cleanupStagedAttachment?.();
    }
  }

  private async prepareLarkAttachmentPath(inputPath: string, dryRun: boolean): Promise<{ relativePath: string; cleanup?: () => Promise<void> }> {
    const resolvedPath = this.resolveInputPath(inputPath);
    const cwd = process.cwd();
    const relativeToCwd = path.relative(cwd, resolvedPath);
    const withinCwd = relativeToCwd.length > 0 && !relativeToCwd.startsWith('..') && !path.isAbsolute(relativeToCwd);

    if (withinCwd) {
      return {
        relativePath: this.normalizeLarkRelativePath(relativeToCwd),
      };
    }

    const stagedRelativeDir = path.join('ai-agent-cli-lark-attachments');
    const stagedFileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(resolvedPath)}`;
    const stagedAbsoluteDir = path.join(cwd, stagedRelativeDir);
    const stagedAbsolutePath = path.join(stagedAbsoluteDir, stagedFileName);

    if (!dryRun) {
      await fs.mkdir(stagedAbsoluteDir, { recursive: true });
      await fs.copyFile(resolvedPath, stagedAbsolutePath);
    }

    return {
      relativePath: this.normalizeLarkRelativePath(path.join(stagedRelativeDir, stagedFileName)),
      cleanup: async () => {
        if (dryRun) {
          return;
        }

        await fs.rm(stagedAbsolutePath, { force: true }).catch(() => {});
        await fs.rmdir(stagedAbsoluteDir).catch(() => {});
      },
    };
  }

  private normalizeLarkRelativePath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\.(?!\/)/, './');
    return normalized.startsWith('./') ? normalized : `./${normalized}`;
  }

  private getConfiguredLarkNewsTarget(): { chatId?: string } {
    const notifications = this.config?.notifications as {
      lark?: {
        morningNews?: {
          chatId?: string;
        };
      };
    } | undefined;
    const morningNews = notifications?.lark?.morningNews;
    const chatId = typeof morningNews?.chatId === 'string' ? morningNews.chatId.trim() : '';

    if (chatId) {
      return { chatId };
    }

    return {};
  }

  private getConfiguredLarkWeatherTarget(): { chatId?: string; city?: string; timezone?: string } {
    const notifications = this.config?.notifications as {
      lark?: {
        morningNews?: {
          chatId?: string;
          timezone?: string;
        };
        weather?: {
          chatId?: string;
          city?: string;
          timezone?: string;
        };
      };
    } | undefined;

    const weather = notifications?.lark?.weather;
    const fallback = notifications?.lark?.morningNews;
    const chatId = typeof weather?.chatId === 'string' && weather.chatId.trim()
      ? weather.chatId.trim()
      : (typeof fallback?.chatId === 'string' ? fallback.chatId.trim() : '');
    const city = typeof weather?.city === 'string' && weather.city.trim() ? weather.city.trim() : '';
    const timezone = typeof weather?.timezone === 'string' && weather.timezone.trim()
      ? weather.timezone.trim()
      : (typeof fallback?.timezone === 'string' && fallback.timezone.trim() ? fallback.timezone.trim() : 'Asia/Shanghai');

    return {
      chatId: chatId || undefined,
      city: city || undefined,
      timezone,
    };
  }

  private buildNewsPushTitle(newsType: string, keyword?: string, limit?: number): string {
    switch (newsType) {
      case 'morning':
        return '腾讯新闻早报';
      case 'evening':
        return '腾讯新闻晚报';
      case 'hot':
        return `腾讯热点新闻 Top ${limit || 10}`;
      case 'search':
        return `腾讯新闻搜索: ${keyword || ''}`.trim();
      default:
        return '腾讯新闻推送';
    }
  }

  private buildNewsPushMessage(title: string, content: string, timezone: string): string {
    const timestamp = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date());

    const maxBodyLength = 3600;
    const safeContent = content.length > maxBodyLength
      ? `${content.slice(0, maxBodyLength)}\n\n[内容过长，已截断]`
      : content;

    return `${title}\n时间: ${timestamp}\n\n${safeContent}`;
  }

  private async buildWeatherSummary(city: string, timezone: string): Promise<string> {
    const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh-cn`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'ai-agent-cli/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch weather: HTTP ${response.status}`);
    }

    const payload = await response.json() as {
      current_condition?: Array<Record<string, unknown>>;
      weather?: Array<Record<string, unknown>>;
    };

    const current = payload.current_condition?.[0] as Record<string, unknown> | undefined;
    const today = payload.weather?.[0] as Record<string, unknown> | undefined;
    if (!current || !today) {
      throw new Error('Weather service returned an unexpected payload');
    }

    const description = this.readWeatherText(current.weatherDesc) || '未知';
    const currentTemp = this.readStringField(current.temp_C);
    const feelsLike = this.readStringField(current.FeelsLikeC);
    const humidity = this.readStringField(current.humidity);
    const windSpeed = this.readStringField(current.windspeedKmph);
    const windDirection = this.readStringField(current.winddir16Point);
    const uvIndex = this.readStringField(current.uvIndex);
    const maxTemp = this.readStringField(today.maxtempC);
    const minTemp = this.readStringField(today.mintempC);
    const astronomy = Array.isArray(today.astronomy) ? today.astronomy[0] as Record<string, unknown> : undefined;
    const sunrise = astronomy ? this.readStringField(astronomy.sunrise) : '';
    const sunset = astronomy ? this.readStringField(astronomy.sunset) : '';
    const rainChance = this.extractMaxChanceOfRain(today.hourly);
    const dateLabel = new Intl.DateTimeFormat('zh-CN', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
    }).format(new Date());

    return [
      `今日天气 ${city}`,
      `日期: ${dateLabel}`,
      `天气: ${description}`,
      `气温: ${currentTemp || '?'}°C，体感 ${feelsLike || '?'}°C`,
      `最高/最低: ${maxTemp || '?'}°C / ${minTemp || '?'}°C`,
      humidity ? `湿度: ${humidity}%` : undefined,
      windSpeed ? `风况: ${windDirection || '未知风向'} ${windSpeed} km/h` : undefined,
      rainChance ? `降雨概率: ${rainChance}%` : undefined,
      uvIndex ? `紫外线指数: ${uvIndex}` : undefined,
      sunrise || sunset ? `日出/日落: ${sunrise || '?'} / ${sunset || '?'}` : undefined,
    ].filter(Boolean).join('\n');
  }

  private readWeatherText(value: unknown): string {
    if (Array.isArray(value)) {
      const first = value[0] as { value?: unknown } | undefined;
      return this.readStringField(first?.value);
    }

    return '';
  }

  private readStringField(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private extractMaxChanceOfRain(hourly: unknown): string {
    if (!Array.isArray(hourly)) {
      return '';
    }

    const values = hourly
      .map(entry => entry as Record<string, unknown>)
      .map(entry => Number.parseInt(this.readStringField(entry.chanceofrain), 10))
      .filter(value => Number.isFinite(value));

    if (values.length === 0) {
      return '';
    }

    return String(Math.max(...values));
  }

  private async savePushedNewsOutput(newsType: string, content: string, keyword?: string, limit?: number): Promise<string> {
    const dir = this.getCurrentCronJobWorkDir() || path.join(os.homedir(), '.ai-agent-cli', 'outputs', 'tencent-news');
    await fs.mkdir(dir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
    const keywordSuffix = keyword ? `_${keyword.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}` : '';
    const fileName = `lark_push_${newsType}${keywordSuffix}_${timestamp}.txt`;
    const filePath = path.join(dir, fileName);
    const header = [
      `Type: ${newsType}`,
      keyword ? `Keyword: ${keyword}` : undefined,
      limit ? `Limit: ${limit}` : undefined,
      `GeneratedAt: ${new Date().toISOString()}`,
      '',
    ].filter(Boolean).join('\n');

    await fs.writeFile(filePath, `${header}${content}`.trim() + '\n', 'utf-8');
    return filePath;
  }

  private normalizeMcpTextResult(result: { content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }> }): string {
    return (result.content || [])
      .filter(item => item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text || '')
      .join('\n')
      .trim();
  }
}

export function createBuiltInTools(sandbox: Sandbox, lspManager: LSPManager, options: BuiltInToolsOptions = {}): BuiltInTools {
  return new BuiltInTools(sandbox, lspManager, options);
}
