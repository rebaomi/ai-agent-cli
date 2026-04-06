import type { LLMConfig, Message, Tool, ToolCall } from '../types/index.js';
export interface OllamaGenerateOptions {
    system?: string;
    template?: string;
    context?: number[];
    stream?: boolean;
    raw?: boolean;
    images?: string[];
}
export interface OllamaResponse {
    model: string;
    response: string;
    done: boolean;
    context?: number[];
    totalDuration?: number;
    loadDuration?: number;
    promptEvalCount?: number;
    promptEvalDuration?: number;
    evalCount?: number;
    evalDuration?: number;
}
export interface OllamaTags {
    models: Array<{
        name: string;
        model: string;
        modifiedAt: string;
        size: number;
    }>;
}
export interface OllamaShow {
    license?: string;
    modelfile?: string;
    parameters?: string;
    template?: string;
    system?: string;
    details?: {
        family: string;
        families: string[];
        format: string;
        parameterSize: string;
        quantizationLevel: string;
    };
}
export declare class OllamaClient {
    private baseUrl;
    private model;
    private temperature;
    private maxTokens;
    private systemPrompt;
    private tools;
    constructor(config: LLMConfig);
    getBaseUrl(): string;
    getModel(): string;
    setModel(model: string): void;
    setTools(tools: Tool[]): void;
    checkConnection(): Promise<boolean>;
    listModels(): Promise<OllamaTags['models']>;
    showModel(model?: string): Promise<OllamaShow>;
    generateStream(messages: Message[], options?: OllamaGenerateOptions): AsyncGenerator<OllamaResponse, void, unknown>;
    generate(messages: Message[], options?: OllamaGenerateOptions): Promise<string>;
    chat(messages: Message[]): Promise<{
        content: string;
        toolCalls?: ToolCall[];
    }>;
    chatStream(messages: Message[]): AsyncGenerator<{
        content: string;
        done: boolean;
        toolCalls?: ToolCall[];
    }, void, unknown>;
    private buildRequestBody;
    private buildChatRequestBody;
}
export declare function createOllamaClient(config: LLMConfig): OllamaClient;
//# sourceMappingURL=client.d.ts.map