import type { Tool, ToolResult } from '../types/index.js';
import { Sandbox } from '../sandbox/executor.js';
import { LSPManager } from '../lsp/client.js';
export declare class BuiltInTools {
    private sandbox;
    private lspManager;
    constructor(sandbox: Sandbox, lspManager: LSPManager);
    getTools(): Tool[];
    private readFileTool;
    private writeFileTool;
    private editFileTool;
    private deleteFileTool;
    private listDirectoryTool;
    private createDirectoryTool;
    private searchFilesTool;
    private executeCommandTool;
    private globTool;
    private readMultipleFilesTool;
    private lspCompleteTool;
    private lspDiagnosticsTool;
    private lspDefinitionTool;
    executeTool(name: string, args: unknown): Promise<ToolResult>;
    private searchFiles;
    private glob;
    private readMultipleFiles;
    private lspComplete;
    private lspDiagnostics;
    private lspDefinition;
}
export declare function createBuiltInTools(sandbox: Sandbox, lspManager: LSPManager): BuiltInTools;
//# sourceMappingURL=builtin.d.ts.map