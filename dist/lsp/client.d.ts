import { EventEmitter } from 'events';
import * as protocol from 'vscode-languageserver-protocol';
import type { LSPServerConfig, CompletionItem, SymbolInfo } from '../types/index.js';
export interface LSPClientOptions {
    rootUri: string;
    workspaceFolders?: string[];
}
export type LSPMethod = keyof typeof protocol;
export type LSPNotificationHandler = (params: unknown) => void;
export declare class LSPClient extends EventEmitter {
    private config;
    private process;
    private requestId;
    private pendingRequests;
    private capabilities;
    private rootUri;
    private workspaceFolders;
    private documentSyncHandler?;
    private diagnosticsHandler?;
    private completionHandler?;
    private hoverHandler?;
    private definitionHandler?;
    private referencesHandler?;
    private symbolsHandler?;
    constructor(config: LSPServerConfig);
    connect(options: LSPClientOptions): Promise<void>;
    private parseMessages;
    private handleMessage;
    private getNotificationHandler;
    private sendRequest;
    private sendNotification;
    initialize(): Promise<void>;
    onDocumentChange(handler: LSPNotificationHandler): void;
    onDiagnostics(handler: LSPNotificationHandler): void;
    onCompletion(handler: LSPNotificationHandler): void;
    onHover(handler: LSPNotificationHandler): void;
    openDocument(uri: string, languageId: string, content: string): Promise<void>;
    changeDocument(uri: string, changes: Array<{
        range: {
            start: {
                line: number;
                character: number;
            };
            end: {
                line: number;
                character: number;
            };
        };
        text: string;
    }>): Promise<void>;
    saveDocument(uri: string, content: string): Promise<void>;
    closeDocument(uri: string): Promise<void>;
    complete(uri: string, position: {
        line: number;
        character: number;
    }): Promise<CompletionItem[]>;
    hover(uri: string, position: {
        line: number;
        character: number;
    }): Promise<unknown>;
    definition(uri: string, position: {
        line: number;
        character: number;
    }): Promise<unknown>;
    references(uri: string, position: {
        line: number;
        character: number;
    }, context: {
        includeDeclaration: boolean;
    }): Promise<unknown>;
    documentSymbols(uri: string): Promise<SymbolInfo[]>;
    workspaceSymbols(query: string): Promise<SymbolInfo[]>;
    getCapabilities(): Record<string, unknown>;
    isConnected(): boolean;
    disconnect(): void;
}
export declare class LSPManager {
    private clients;
    private uriToClient;
    addServer(config: LSPServerConfig, rootUri: string): Promise<LSPClient>;
    removeServer(name: string): void;
    getClient(name: string): LSPClient | undefined;
    getClientForUri(uri: string): LSPClient | undefined;
    registerDocument(clientName: string, uri: string): void;
    disconnectAll(): Promise<void>;
}
export declare function createLSPManager(): LSPManager;
//# sourceMappingURL=client.d.ts.map