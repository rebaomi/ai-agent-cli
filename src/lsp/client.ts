import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as protocol from 'vscode-languageserver-protocol';
import type {
  LSPServerConfig,
  CompletionItem,
  Diagnostic,
  SymbolInfo,
} from '../types/index.js';

export interface LSPClientOptions {
  rootUri: string;
  workspaceFolders?: string[];
}

export type LSPMethod = keyof typeof protocol;
export type LSPNotificationHandler = (params: unknown) => void;

export class LSPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private capabilities: Record<string, unknown> = {};
  private rootUri: string;
  private workspaceFolders: string[];
  private documentSyncHandler?: LSPNotificationHandler;
  private diagnosticsHandler?: LSPNotificationHandler;
  private completionHandler?: LSPNotificationHandler;
  private hoverHandler?: LSPNotificationHandler;
  private definitionHandler?: LSPNotificationHandler;
  private referencesHandler?: LSPNotificationHandler;
  private symbolsHandler?: LSPNotificationHandler;

  constructor(private config: LSPServerConfig) {
    super();
    this.rootUri = '';
    this.workspaceFolders = [];
  }

  async connect(options: LSPClientOptions): Promise<void> {
    this.rootUri = options.rootUri;
    this.workspaceFolders = options.workspaceFolders ?? [];

    return new Promise((resolve, reject) => {
      const { command, args = [] } = this.config;
      
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdoutBuffer = '';

      this.process.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const messages = this.parseMessages(stdoutBuffer);
        stdoutBuffer = messages.remaining;
        for (const msg of messages.messages) {
          this.handleMessage(msg);
        }
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.emit('error', new Error(data.toString()));
      });

      this.process.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.process.on('exit', (code) => {
        this.emit('close', code);
      });

      this.initialize().then(() => resolve()).catch(reject);
    });
  }

  private parseMessages(buffer: string): { messages: unknown[]; remaining: string } {
    const messages: unknown[] = [];
    let remaining = buffer;

    while (remaining.length > 0) {
      if (remaining.startsWith('Content-Length: ')) {
        const headerEnd = remaining.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        
        const headerLines = remaining.slice(0, headerEnd).split('\r\n');
        const contentLengthLine = headerLines.find(l => l.startsWith('Content-Length: '));
        
        if (!contentLengthLine) {
          remaining = remaining.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(contentLengthLine.split(': ')[1] ?? '0', 10);
        const content = remaining.slice(headerEnd + 4, headerEnd + 4 + contentLength);
        
        if (content.length < contentLength) break;
        
        try {
          messages.push(JSON.parse(content));
          remaining = remaining.slice(headerEnd + 4 + contentLength);
        } catch {
          break;
        }
      } else {
        remaining = remaining.slice(1);
      }
    }

    return { messages, remaining };
  }

  private handleMessage(message: unknown): void {
    const msg = message as Record<string, unknown>;
    
    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        if ('error' in msg) {
          pending.reject(new Error((msg.error as { message?: string })?.message ?? 'Unknown error'));
        } else if ('result' in msg) {
          pending.resolve(msg.result);
        }
        this.pendingRequests.delete(msg.id);
      }
    } else if ('method' in msg && typeof msg.method === 'string') {
      const handler = this.getNotificationHandler(msg.method);
      if (handler) {
        handler(msg.params);
      }
      this.emit(`notification:${msg.method}`, msg.params);
    }
  }

  private getNotificationHandler(method: string): LSPNotificationHandler | undefined {
    switch (method) {
      case 'textDocument/didOpen':
      case 'textDocument/didChange':
      case 'textDocument/didSave':
        return this.documentSyncHandler;
      case 'textDocument/publishDiagnostics':
        return this.diagnosticsHandler;
      case 'textDocument/completion':
        return this.completionHandler;
      case 'textDocument/hover':
        return this.hoverHandler;
      case 'textDocument/definition':
        return this.definitionHandler;
      case 'textDocument/references':
        return this.referencesHandler;
      case 'workspace/symbol':
        return this.symbolsHandler;
      default:
        return undefined;
    }
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Process not running'));
        return;
      }

      const id = ++this.requestId;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });
      
      const content = JSON.stringify(request);
      this.process.stdin.write(`Content-Length: ${content.length}\r\n\r\n${content}`);

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const content = JSON.stringify(notification);
    this.process.stdin.write(`Content-Length: ${content.length}\r\n\r\n${content}`);
  }

  async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      workspaceFolders: this.workspaceFolders.map(name => ({ name, uri: name })),
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: true,
            willSave: true,
            didSave: true,
            willSaveWaitUntil: true,
          },
          completion: {
            dynamicRegistration: true,
            completionItem: {
              snippetSupport: true,
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
          },
          hover: { dynamicRegistration: true },
          references: { dynamicRegistration: true },
          definition: { dynamicRegistration: true },
        },
        workspace: {
          symbol: { dynamicRegistration: true },
          executeCommand: { dynamicRegistration: true },
        },
      },
    }) as { capabilities: Record<string, unknown> };

    this.capabilities = result.capabilities ?? {};
    this.sendNotification('initialized', {});
  }

  onDocumentChange(handler: LSPNotificationHandler): void {
    this.documentSyncHandler = handler;
  }

  onDiagnostics(handler: LSPNotificationHandler): void {
    this.diagnosticsHandler = handler;
  }

  onCompletion(handler: LSPNotificationHandler): void {
    this.completionHandler = handler;
  }

  onHover(handler: LSPNotificationHandler): void {
    this.hoverHandler = handler;
  }

  async openDocument(uri: string, languageId: string, content: string): Promise<void> {
    this.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text: content },
    });
  }

  async changeDocument(uri: string, changes: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }>): Promise<void> {
    this.sendNotification('textDocument/didChange', {
      textDocument: { uri, version: Date.now() },
      contentChanges: changes,
    });
  }

  async saveDocument(uri: string, content: string): Promise<void> {
    this.sendNotification('textDocument/didSave', {
      textDocument: { uri },
      text: content,
    });
  }

  async closeDocument(uri: string): Promise<void> {
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  async complete(uri: string, position: { line: number; character: number }): Promise<CompletionItem[]> {
    const result = await this.sendRequest('textDocument/completion', {
      textDocument: { uri },
      position,
    }) as CompletionItem[] | { isIncomplete: boolean; items: CompletionItem[] };
    
    if (Array.isArray(result)) return result;
    return result.items ?? [];
  }

  async hover(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position,
    });
  }

  async definition(uri: string, position: { line: number; character: number }): Promise<unknown> {
    return this.sendRequest('textDocument/definition', {
      textDocument: { uri },
      position,
    });
  }

  async references(uri: string, position: { line: number; character: number }, context: { includeDeclaration: boolean }): Promise<unknown> {
    return this.sendRequest('textDocument/references', {
      textDocument: { uri },
      position,
      context,
    });
  }

  async documentSymbols(uri: string): Promise<SymbolInfo[]> {
    const result = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    }) as SymbolInfo[];
    return result ?? [];
  }

  async workspaceSymbols(query: string): Promise<SymbolInfo[]> {
    const result = await this.sendRequest('workspace/symbol', {
      query,
    }) as SymbolInfo[];
    return result ?? [];
  }

  getCapabilities(): Record<string, unknown> {
    return this.capabilities;
  }

  isConnected(): boolean {
    return this.process !== null;
  }

  disconnect(): void {
    if (this.process) {
      this.sendNotification('exit');
      this.process.kill();
      this.process = null;
    }
    this.pendingRequests.clear();
    this.capabilities = {};
  }
}

export class LSPManager {
  private clients: Map<string, LSPClient> = new Map();
  private uriToClient: Map<string, LSPClient> = new Map();

  async addServer(config: LSPServerConfig, rootUri: string): Promise<LSPClient> {
    const client = new LSPClient(config);
    await client.connect({ rootUri });
    this.clients.set(config.name, client);
    return client;
  }

  removeServer(name: string): void {
    const client = this.clients.get(name);
    if (client) {
      client.disconnect();
      this.clients.delete(name);
    }
  }

  getClient(name: string): LSPClient | undefined {
    return this.clients.get(name);
  }

  getClientForUri(uri: string): LSPClient | undefined {
    return this.uriToClient.get(uri);
  }

  registerDocument(clientName: string, uri: string): void {
    const client = this.clients.get(clientName);
    if (client) {
      this.uriToClient.set(uri, client);
    }
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
    this.uriToClient.clear();
  }
}

export function createLSPManager(): LSPManager {
  return new LSPManager();
}
