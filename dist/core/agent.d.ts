import type { Message, ToolCall, ToolResult } from '../types/index.js';
import { OllamaClient } from '../ollama/client.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
export interface AgentOptions {
    ollama: OllamaClient;
    mcpManager?: MCPManager;
    lspManager?: LSPManager;
    sandbox?: Sandbox;
    builtInTools?: BuiltInTools;
    systemPrompt?: string;
    maxIterations?: number;
}
export interface AgentEvent {
    type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error';
    content: string;
    toolCall?: ToolCall;
    toolResult?: ToolResult;
}
export declare class Agent {
    private ollama;
    private mcpManager;
    private lspManager;
    private sandbox;
    private builtInTools;
    private messages;
    private systemPrompt;
    private maxIterations;
    private iteration;
    private tools;
    private onEvent?;
    constructor(options: AgentOptions);
    setEventHandler(handler: (event: AgentEvent) => void): void;
    private initializeTools;
    private getDefaultSystemPrompt;
    chat(input: string): Promise<string>;
    private generateResponse;
    private executeToolCall;
    getMessages(): Message[];
    clearMessages(): void;
    setSystemPrompt(prompt: string): void;
    refreshTools(): Promise<void>;
    getToolCount(): number;
}
export declare function createAgent(options: AgentOptions): Agent;
//# sourceMappingURL=agent.d.ts.map