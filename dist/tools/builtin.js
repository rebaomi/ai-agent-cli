import { promises as fs } from 'fs';
import * as path from 'path';
export class BuiltInTools {
    sandbox;
    lspManager;
    constructor(sandbox, lspManager) {
        this.sandbox = sandbox;
        this.lspManager = lspManager;
    }
    getTools() {
        return [
            this.readFileTool(),
            this.writeFileTool(),
            this.editFileTool(),
            this.deleteFileTool(),
            this.listDirectoryTool(),
            this.createDirectoryTool(),
            this.searchFilesTool(),
            this.executeCommandTool(),
            this.globTool(),
            this.readMultipleFilesTool(),
            this.lspCompleteTool(),
            this.lspDiagnosticsTool(),
            this.lspDefinitionTool(),
        ];
    }
    readFileTool() {
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
    writeFileTool() {
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
    editFileTool() {
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
    deleteFileTool() {
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
    listDirectoryTool() {
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
    createDirectoryTool() {
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
    searchFilesTool() {
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
    executeCommandTool() {
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
    globTool() {
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
    readMultipleFilesTool() {
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
    lspCompleteTool() {
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
    lspDiagnosticsTool() {
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
    lspDefinitionTool() {
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
    async executeTool(name, args) {
        try {
            let result;
            switch (name) {
                case 'read_file':
                    result = await this.sandbox.readFile(args.path);
                    break;
                case 'write_file': {
                    const { path: filePath, content } = args;
                    await this.sandbox.writeFile(filePath, content);
                    result = `File written successfully: ${filePath}`;
                    break;
                }
                case 'edit_file': {
                    const { path: filePath, old_string, new_string } = args;
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
                    await this.sandbox.deleteFile(args.path);
                    result = 'File deleted successfully';
                    break;
                case 'list_directory':
                    result = (await this.sandbox.listDirectory(args.path)).join('\n');
                    break;
                case 'create_directory': {
                    const dirPath = args.path;
                    await fs.mkdir(dirPath, { recursive: true });
                    result = `Directory created: ${dirPath}`;
                    break;
                }
                case 'search_files': {
                    const { path: searchPath, pattern, content } = args;
                    result = await this.searchFiles(searchPath, pattern, content);
                    break;
                }
                case 'execute_command': {
                    const { command, timeout } = args;
                    const execResult = await this.sandbox.execute(command, [], { cwd: process.cwd() });
                    result = `Exit code: ${execResult.exitCode}\n\nStdout:\n${execResult.stdout}\n\nStderr:\n${execResult.stderr}`;
                    break;
                }
                case 'glob':
                    result = await this.glob(args.pattern, args.cwd);
                    break;
                case 'read_multiple_files':
                    result = await this.readMultipleFiles(args.paths);
                    break;
                case 'lsp_complete': {
                    const { uri, line, character } = args;
                    const completions = await this.lspComplete(uri, line, character);
                    result = JSON.stringify(completions, null, 2);
                    break;
                }
                case 'lsp_diagnostics': {
                    const { uri } = args;
                    const diagnostics = await this.lspDiagnostics(uri);
                    result = JSON.stringify(diagnostics, null, 2);
                    break;
                }
                case 'lsp_definition': {
                    const { uri, line, character } = args;
                    const definition = await this.lspDefinition(uri, line, character);
                    result = JSON.stringify(definition, null, 2);
                    break;
                }
                default:
                    return { tool_call_id: '', output: `Unknown tool: ${name}`, is_error: true };
            }
            return { tool_call_id: '', content: [{ type: 'text', text: result }] };
        }
        catch (error) {
            return {
                tool_call_id: '',
                content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
                is_error: true,
            };
        }
    }
    async searchFiles(dir, pattern, content) {
        const results = [];
        async function search(currentDir) {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                    await search(fullPath);
                }
                else if (entry.isFile()) {
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
    async glob(pattern, cwd) {
        const { join, resolve } = await import('path');
        const baseDir = cwd ?? process.cwd();
        const results = [];
        const parts = pattern.split('/');
        const regex = new RegExp('^' + parts.map(p => p === '**' ? '.*' : p.replace(/\*/g, '[^/]*')).join('/') + '$');
        async function search(dir) {
            try {
                const entries = await fs.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await search(fullPath);
                    }
                    else {
                        const relativePath = resolve(fullPath).replace(resolve(baseDir), baseDir);
                        if (regex.test(relativePath.replace(/\\/g, '/'))) {
                            results.push(fullPath);
                        }
                    }
                }
            }
            catch { /* ignore */ }
        }
        await search(baseDir);
        return results.join('\n');
    }
    async readMultipleFiles(paths) {
        const results = [];
        for (const filePath of paths) {
            try {
                const content = await this.sandbox.readFile(filePath);
                results.push(`=== ${filePath} ===\n${content}`);
            }
            catch (error) {
                results.push(`=== ${filePath} ===\nError: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return results.join('\n\n');
    }
    async lspComplete(uri, line, character) {
        const client = this.lspManager.getClientForUri(uri);
        if (!client)
            return [];
        return client.complete(uri, { line, character });
    }
    async lspDiagnostics(uri) {
        return [];
    }
    async lspDefinition(uri, line, character) {
        const client = this.lspManager.getClientForUri(uri);
        if (!client)
            return null;
        return client.definition(uri, { line, character });
    }
}
export function createBuiltInTools(sandbox, lspManager) {
    return new BuiltInTools(sandbox, lspManager);
}
//# sourceMappingURL=builtin.js.map