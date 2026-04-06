import { EventEmitter } from 'events';
import type { MCPConfig, MCPResource, MCPTool } from '../types/index.js';
export interface MCPRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: Record<string, unknown>;
}
export interface MCPResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface MCPNotification {
    jsonrpc: '2.0';
    method: string;
    params?: Record<string, unknown>;
}
export interface InitializeResult {
    protocolVersion: string;
    capabilities: {
        tools?: Record<string, unknown>;
        resources?: Record<string, unknown>;
        prompts?: Record<string, unknown>;
    };
    serverInfo: {
        name: string;
        version: string;
    };
}
export interface ToolResult {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: string;
        mimeType?: string;
    }>;
    isError?: boolean;
}
export declare class MCPClient extends EventEmitter {
    private process;
    private requestId;
    private pendingRequests;
    private tools;
    private resources;
    private isInitialized;
    private config;
    constructor(config: MCPConfig);
    connect(): Promise<void>;
    private processStdout;
    private handleMessage;
    private handleNotification;
    private sendRequest;
    private sendNotification;
    initialize(): Promise<InitializeResult>;
    listTools(): Promise<MCPTool[]>;
    callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
    listResources(): Promise<MCPResource[]>;
    readResource(uri: string): Promise<{
        contents: Array<{
            uri: string;
            mimeType?: string;
            text?: string;
        }>;
    }>;
    listPrompts(): Promise<unknown[]>;
    getTools(): MCPTool[];
    getResources(): MCPResource[];
    isConnected(): boolean;
    disconnect(): void;
}
export declare class MCPManager {
    private clients;
    addServer(config: MCPConfig): Promise<MCPClient>;
    removeServer(name: string): Promise<void>;
    getClient(name: string): MCPClient | undefined;
    getAllClients(): MCPClient[];
    listAllTools(): Promise<Array<{
        server: string;
        tool: MCPTool;
    }>>;
    callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult>;
    disconnectAll(): Promise<void>;
}
export declare function createMCPManager(): MCPManager;
//# sourceMappingURL=client.d.ts.map