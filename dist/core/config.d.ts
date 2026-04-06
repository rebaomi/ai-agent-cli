import { z } from 'zod';
import type { AgentConfig } from '../types/index.js';
declare const configSchema: z.ZodObject<{
    ollama: z.ZodObject<{
        baseUrl: z.ZodDefault<z.ZodString>;
        model: z.ZodDefault<z.ZodString>;
        temperature: z.ZodDefault<z.ZodNumber>;
        maxTokens: z.ZodDefault<z.ZodNumber>;
        systemPrompt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        baseUrl: string;
        model: string;
        temperature: number;
        maxTokens: number;
        systemPrompt?: string | undefined;
    }, {
        baseUrl?: string | undefined;
        model?: string | undefined;
        temperature?: number | undefined;
        maxTokens?: number | undefined;
        systemPrompt?: string | undefined;
    }>;
    mcp: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        command: z.ZodString;
        args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        command: string;
        args?: string[] | undefined;
        env?: Record<string, string> | undefined;
    }, {
        name: string;
        command: string;
        args?: string[] | undefined;
        env?: Record<string, string> | undefined;
    }>, "many">>;
    lsp: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        command: z.ZodString;
        args: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        languages: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        rootPatterns: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        command: string;
        args?: string[] | undefined;
        languages?: string[] | undefined;
        rootPatterns?: string[] | undefined;
    }, {
        name: string;
        command: string;
        args?: string[] | undefined;
        languages?: string[] | undefined;
        rootPatterns?: string[] | undefined;
    }>, "many">>;
    sandbox: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
        allowedPaths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        deniedPaths: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        timeout: z.ZodDefault<z.ZodNumber>;
        maxMemory: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        timeout: number;
        allowedPaths?: string[] | undefined;
        deniedPaths?: string[] | undefined;
        maxMemory?: number | undefined;
    }, {
        enabled?: boolean | undefined;
        allowedPaths?: string[] | undefined;
        deniedPaths?: string[] | undefined;
        timeout?: number | undefined;
        maxMemory?: number | undefined;
    }>>;
    workspace: z.ZodDefault<z.ZodString>;
    maxIterations: z.ZodDefault<z.ZodNumber>;
    toolTimeout: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    ollama: {
        baseUrl: string;
        model: string;
        temperature: number;
        maxTokens: number;
        systemPrompt?: string | undefined;
    };
    workspace: string;
    maxIterations: number;
    toolTimeout: number;
    mcp?: {
        name: string;
        command: string;
        args?: string[] | undefined;
        env?: Record<string, string> | undefined;
    }[] | undefined;
    lsp?: {
        name: string;
        command: string;
        args?: string[] | undefined;
        languages?: string[] | undefined;
        rootPatterns?: string[] | undefined;
    }[] | undefined;
    sandbox?: {
        enabled: boolean;
        timeout: number;
        allowedPaths?: string[] | undefined;
        deniedPaths?: string[] | undefined;
        maxMemory?: number | undefined;
    } | undefined;
}, {
    ollama: {
        baseUrl?: string | undefined;
        model?: string | undefined;
        temperature?: number | undefined;
        maxTokens?: number | undefined;
        systemPrompt?: string | undefined;
    };
    mcp?: {
        name: string;
        command: string;
        args?: string[] | undefined;
        env?: Record<string, string> | undefined;
    }[] | undefined;
    lsp?: {
        name: string;
        command: string;
        args?: string[] | undefined;
        languages?: string[] | undefined;
        rootPatterns?: string[] | undefined;
    }[] | undefined;
    sandbox?: {
        enabled?: boolean | undefined;
        allowedPaths?: string[] | undefined;
        deniedPaths?: string[] | undefined;
        timeout?: number | undefined;
        maxMemory?: number | undefined;
    } | undefined;
    workspace?: string | undefined;
    maxIterations?: number | undefined;
    toolTimeout?: number | undefined;
}>;
export type ConfigSchema = z.infer<typeof configSchema>;
declare class ConfigManager {
    private config;
    private configPath;
    constructor();
    private loadSync;
    get<K extends keyof ConfigSchema>(key: K): ConfigSchema[K];
    set<K extends keyof ConfigSchema>(key: K, value: ConfigSchema[K]): void;
    getAll(): ConfigSchema;
    setAll(config: Partial<ConfigSchema>): void;
    getAgentConfig(): AgentConfig;
    getConfigPath(): string;
    load(): Promise<void>;
    save(): Promise<void>;
    loadFromFile(path: string): Promise<void>;
    saveToFile(path: string): Promise<void>;
}
export declare const configManager: ConfigManager;
export {};
//# sourceMappingURL=config.d.ts.map