import { promises as fs } from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolResult } from '../types/index.js';
import { Sandbox } from '../sandbox/executor.js';
import { LSPManager } from '../lsp/client.js';
import type { MCPManager } from '../mcp/client.js';
import type { TaskManager } from '../core/task-manager.js';
import type { CronManager } from '../core/cron-manager.js';

const execAsync = promisify(exec);

export interface BuiltInToolsOptions {
  mcpManager?: MCPManager;
  taskManager?: TaskManager;
  cronManager?: CronManager;
}

export class BuiltInTools {
  private sandbox: Sandbox;
  private lspManager: LSPManager;
  private mcpManager?: MCPManager;
  private taskManager?: TaskManager;
  private cronManager?: CronManager;

  constructor(sandbox: Sandbox, lspManager: LSPManager, options: BuiltInToolsOptions = {}) {
    this.sandbox = sandbox;
    this.lspManager = lspManager;
    this.mcpManager = options.mcpManager;
    this.taskManager = options.taskManager;
    this.cronManager = options.cronManager;
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
      
      // Execution
      { ...this.executeCommandTool(), category: 'execution' },
      { ...this.calculateTool(), category: 'execution' },
      { ...this.replTool(), category: 'execution' },
      
      // Search & Fetch
      { ...this.webSearchTool(), category: 'search_fetch' },
      { ...this.fetchUrlTool(), category: 'search_fetch' },
      { ...this.openBrowserTool(), category: 'search_fetch' },

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
      description: 'Write content to a file, creating it if it does not exist',
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
      description: 'Open a URL in the default browser',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' },
          background: { type: 'boolean', description: 'Open in background without focusing (default: false)' },
        },
        required: ['url'],
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

  async executeTool(name: string, args: unknown): Promise<ToolResult> {
    try {
      let result: string;

      switch (name) {
        case 'read_file':
          result = await this.sandbox.readFile((args as { path: string }).path);
          break;

        case 'write_file': {
          const { path: filePath, content } = args as { path: string; content: string };
          await this.sandbox.writeFile(filePath, content);
          result = `File written successfully: ${filePath}`;
          break;
        }

        case 'edit_file': {
          const { path: filePath, old_string, new_string } = args as {
            path: string;
            old_string: string;
            new_string: string;
          };
          const content = await this.sandbox.readFile(filePath);
          const newContent = content.replace(old_string, new_string);
          if (content === newContent) {
            return { tool_call_id: '', output: 'No changes made - old_string not found', is_error: true };
          }
          await this.sandbox.writeFile(filePath, newContent);
          result = `File edited successfully: ${filePath}`;
          break;
        }

        case 'delete_file':
          await this.sandbox.deleteFile((args as { path: string }).path);
          result = 'File deleted successfully';
          break;

        case 'list_directory':
          result = (await this.sandbox.listDirectory((args as { path: string }).path)).join('\n');
          break;

        case 'create_directory': {
          const dirPath = (args as { path: string }).path;
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
          result = await this.searchFiles(searchPath, pattern, content);
          break;
        }

        case 'execute_command': {
          const { command, timeout } = args as { command: string; timeout?: number };
          const execResult = await this.sandbox.execute(command, [], { cwd: process.cwd() });
          result = `Exit code: ${execResult.exitCode}\n\nStdout:\n${execResult.stdout}\n\nStderr:\n${execResult.stderr}`;
          break;
        }

        case 'glob':
          result = await this.glob((args as { pattern: string; cwd?: string }).pattern, (args as { pattern: string; cwd?: string }).cwd);
          break;

        case 'read_multiple_files':
          result = await this.readMultipleFiles((args as { paths: string[] }).paths);
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
          await fs.copyFile(source, destination);
          result = `Copied: ${source} -> ${destination}`;
          break;
        }

        case 'move_file': {
          const { source, destination } = args as { source: string; destination: string };
          await fs.rename(source, destination);
          result = `Moved: ${source} -> ${destination}`;
          break;
        }

        case 'file_info': {
          const { path: filePath } = args as { path: string };
          const stats = await fs.stat(filePath);
          result = JSON.stringify({
            path: filePath,
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
          result = await this.grep(searchPath, pattern, include);
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
          const { url, background } = args as { url: string; background?: boolean };
          result = await this.openBrowser(url, background ?? false);
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

  private async webSearch(query: string, numResults: number): Promise<string> {
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}&kl=wt-wt`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        return `Search failed: HTTP ${response.status}`;
      }

      const html = await response.text();

      const results: string[] = [];
      const linkRegex = /<a[^>]+href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/gi;
      const snippetRegex = /<a[^>]+class="result__a"[^>]*>[\s\S]*?<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

      let match;
      let count = 0;

      while ((match = linkRegex.exec(html)) !== null && count < numResults) {
        const href = match[1] || '';
        const titleMatch = match[0]?.match(/>([^<]+)<\/a>/);
        const title = titleMatch?.[1]?.trim() || 'No title';

        if (href.startsWith('http') && !href.includes('duckduckgo')) {
          results.push(`${count + 1}. ${title}\n   URL: ${href}`);
          count++;
        }
      }

      if (results.length === 0) {
        const simpleRegex = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
        while ((match = simpleRegex.exec(html)) !== null && count < numResults) {
          const href = match[1] || '';
          const title = (match[2] || '').trim().replace(/<[^>]+>/g, '');

          if (!href.includes('duckduckgo') && !href.includes('html.duckduckgo')) {
            results.push(`${count + 1}. ${title}\n   URL: ${href}`);
            count++;
          }
        }
      }

      if (results.length === 0) {
        return `No results found for: ${query}`;
      }

      return `Search results for "${query}":\n\n${results.join('\n\n')}`;
    } catch (error) {
      return `Search error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async fetchUrl(url: string, maxLength: number): Promise<string> {
    try {
      const parsedUrl = new URL(url);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,text/plain',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        return `Failed to fetch: HTTP ${response.status}`;
      }

      const contentType = response.headers.get('content-type') || '';

      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return `Unsupported content type: ${contentType}`;
      }

      let text = await response.text();

      text = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > maxLength) {
        text = text.substring(0, maxLength) + '...[truncated]';
      }

      return `Fetched from: ${parsedUrl.hostname}\n\n${text}`;
    } catch (error) {
      return `Fetch error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async openBrowser(url: string, background: boolean): Promise<string> {
    try {
      let command: string;
      const isWindows = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const isLinux = process.platform === 'linux';

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
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

  private evaluateRepl(code: string): string {
    try {
      const result = new Function(`return ${code}`)();
      return String(result);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
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

  private cronList(): string {
    if (!this.cronManager) {
      return 'Cron manager not initialized';
    }

    const jobs = this.cronManager.listJobs();
    return jobs.length > 0 ? JSON.stringify(jobs, null, 2) : 'No cron jobs found';
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
}

export function createBuiltInTools(sandbox: Sandbox, lspManager: LSPManager, options: BuiltInToolsOptions = {}): BuiltInTools {
  return new BuiltInTools(sandbox, lspManager, options);
}
