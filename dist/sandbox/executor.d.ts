import type { SandboxConfig, ExecuteResult } from '../types/index.js';
export declare class Sandbox {
    private enabled;
    private allowedPaths;
    private deniedPaths;
    private timeout;
    private maxMemory?;
    private tempDir;
    constructor(config?: SandboxConfig);
    initialize(): Promise<void>;
    private isPathAllowed;
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, content: string): Promise<void>;
    deleteFile(filePath: string): Promise<void>;
    listDirectory(dirPath: string): Promise<string[]>;
    execute(command: string, args?: string[], options?: {
        cwd?: string;
        env?: Record<string, string>;
    }): Promise<ExecuteResult>;
    executeNode(script: string, args?: string[]): Promise<ExecuteResult>;
    executeBash(script: string): Promise<ExecuteResult>;
    executePowerShell(script: string): Promise<ExecuteResult>;
    executePython(script: string): Promise<ExecuteResult>;
    getTempDir(): string;
    isEnabled(): boolean;
    setEnabled(enabled: boolean): void;
    cleanup(): Promise<void>;
}
export declare class ToolRegistry {
    private tools;
    register(name: string, handler: (args: unknown) => Promise<unknown>): void;
    execute(name: string, args: unknown): Promise<unknown>;
    getTools(): string[];
    hasTool(name: string): boolean;
}
export declare function createSandbox(config?: SandboxConfig): Sandbox;
export declare function createToolRegistry(): ToolRegistry;
//# sourceMappingURL=executor.d.ts.map