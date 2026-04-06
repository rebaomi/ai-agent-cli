import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from '../types/index.js';
import { Sandbox } from '../sandbox/executor.js';
import { LSPManager } from '../lsp/client.js';

export class BuiltInTools {
  private sandbox: Sandbox;
  private lspManager: LSPManager;

  constructor(sandbox: Sandbox, lspManager: LSPManager) {
    this.sandbox = sandbox;
    this.lspManager = lspManager;
  }

  getTools(): Tool[] {
    return [
      this.readFileTool(),
      this.writeFileTool(),
      this.editFileTool(),
      this.deleteFileTool(),
      this.copyFileTool(),
      this.moveFileTool(),
      this.fileInfoTool(),
      this.listDirectoryTool(),
      this.createDirectoryTool(),
      this.searchFilesTool(),
      this.grepTool(),
      this.executeCommandTool(),
      this.globTool(),
      this.readMultipleFilesTool(),
      this.getCurrentTimeTool(),
      this.calculateTool(),
      this.lspCompleteTool(),
      this.lspDiagnosticsTool(),
      this.lspDefinitionTool(),
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

        default:
          return { tool_call_id: '', output: `Unknown tool: ${name}`, is_error: true };
      }

      return { tool_call_id: '', content: [{ type: 'text', text: result }] };
    } catch (error) {
      return {
        tool_call_id: '',
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
    const { join, resolve } = await import('path');
    const baseDir = cwd ?? process.cwd();
    const results: string[] = [];
    
    const parts = pattern.split('/');
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
            if (regex.test(relativePath.replace(/\\/g, '/'))) {
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
}

export function createBuiltInTools(sandbox: Sandbox, lspManager: LSPManager): BuiltInTools {
  return new BuiltInTools(sandbox, lspManager);
}
