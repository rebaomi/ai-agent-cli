import { spawn } from 'child_process';
import { EventEmitter } from 'events';
export class LSPClient extends EventEmitter {
    config;
    process = null;
    requestId = 0;
    pendingRequests = new Map();
    capabilities = {};
    rootUri;
    workspaceFolders;
    documentSyncHandler;
    diagnosticsHandler;
    completionHandler;
    hoverHandler;
    definitionHandler;
    referencesHandler;
    symbolsHandler;
    constructor(config) {
        super();
        this.config = config;
        this.rootUri = '';
        this.workspaceFolders = [];
    }
    async connect(options) {
        this.rootUri = options.rootUri;
        this.workspaceFolders = options.workspaceFolders ?? [];
        return new Promise((resolve, reject) => {
            const { command, args = [] } = this.config;
            this.process = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            });
            let stdoutBuffer = '';
            this.process.stdout?.on('data', (data) => {
                stdoutBuffer += data.toString();
                const messages = this.parseMessages(stdoutBuffer);
                stdoutBuffer = messages.remaining;
                for (const msg of messages.messages) {
                    this.handleMessage(msg);
                }
            });
            this.process.stderr?.on('data', (data) => {
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
    parseMessages(buffer) {
        const messages = [];
        let remaining = buffer;
        while (remaining.length > 0) {
            if (remaining.startsWith('Content-Length: ')) {
                const headerEnd = remaining.indexOf('\r\n\r\n');
                if (headerEnd === -1)
                    break;
                const headerLines = remaining.slice(0, headerEnd).split('\r\n');
                const contentLengthLine = headerLines.find(l => l.startsWith('Content-Length: '));
                if (!contentLengthLine) {
                    remaining = remaining.slice(headerEnd + 4);
                    continue;
                }
                const contentLength = parseInt(contentLengthLine.split(': ')[1] ?? '0', 10);
                const content = remaining.slice(headerEnd + 4, headerEnd + 4 + contentLength);
                if (content.length < contentLength)
                    break;
                try {
                    messages.push(JSON.parse(content));
                    remaining = remaining.slice(headerEnd + 4 + contentLength);
                }
                catch {
                    break;
                }
            }
            else {
                remaining = remaining.slice(1);
            }
        }
        return { messages, remaining };
    }
    handleMessage(message) {
        const msg = message;
        if ('id' in msg && typeof msg.id === 'number') {
            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                if ('error' in msg) {
                    pending.reject(new Error(msg.error?.message ?? 'Unknown error'));
                }
                else if ('result' in msg) {
                    pending.resolve(msg.result);
                }
                this.pendingRequests.delete(msg.id);
            }
        }
        else if ('method' in msg && typeof msg.method === 'string') {
            const handler = this.getNotificationHandler(msg.method);
            if (handler) {
                handler(msg.params);
            }
            this.emit(`notification:${msg.method}`, msg.params);
        }
    }
    getNotificationHandler(method) {
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
    sendRequest(method, params) {
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
    sendNotification(method, params) {
        if (!this.process?.stdin)
            return;
        const notification = {
            jsonrpc: '2.0',
            method,
            params,
        };
        const content = JSON.stringify(notification);
        this.process.stdin.write(`Content-Length: ${content.length}\r\n\r\n${content}`);
    }
    async initialize() {
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
        });
        this.capabilities = result.capabilities ?? {};
        this.sendNotification('initialized', {});
    }
    onDocumentChange(handler) {
        this.documentSyncHandler = handler;
    }
    onDiagnostics(handler) {
        this.diagnosticsHandler = handler;
    }
    onCompletion(handler) {
        this.completionHandler = handler;
    }
    onHover(handler) {
        this.hoverHandler = handler;
    }
    async openDocument(uri, languageId, content) {
        this.sendNotification('textDocument/didOpen', {
            textDocument: { uri, languageId, version: 1, text: content },
        });
    }
    async changeDocument(uri, changes) {
        this.sendNotification('textDocument/didChange', {
            textDocument: { uri, version: Date.now() },
            contentChanges: changes,
        });
    }
    async saveDocument(uri, content) {
        this.sendNotification('textDocument/didSave', {
            textDocument: { uri },
            text: content,
        });
    }
    async closeDocument(uri) {
        this.sendNotification('textDocument/didClose', {
            textDocument: { uri },
        });
    }
    async complete(uri, position) {
        const result = await this.sendRequest('textDocument/completion', {
            textDocument: { uri },
            position,
        });
        if (Array.isArray(result))
            return result;
        return result.items ?? [];
    }
    async hover(uri, position) {
        return this.sendRequest('textDocument/hover', {
            textDocument: { uri },
            position,
        });
    }
    async definition(uri, position) {
        return this.sendRequest('textDocument/definition', {
            textDocument: { uri },
            position,
        });
    }
    async references(uri, position, context) {
        return this.sendRequest('textDocument/references', {
            textDocument: { uri },
            position,
            context,
        });
    }
    async documentSymbols(uri) {
        const result = await this.sendRequest('textDocument/documentSymbol', {
            textDocument: { uri },
        });
        return result ?? [];
    }
    async workspaceSymbols(query) {
        const result = await this.sendRequest('workspace/symbol', {
            query,
        });
        return result ?? [];
    }
    getCapabilities() {
        return this.capabilities;
    }
    isConnected() {
        return this.process !== null;
    }
    disconnect() {
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
    clients = new Map();
    uriToClient = new Map();
    async addServer(config, rootUri) {
        const client = new LSPClient(config);
        await client.connect({ rootUri });
        this.clients.set(config.name, client);
        return client;
    }
    removeServer(name) {
        const client = this.clients.get(name);
        if (client) {
            client.disconnect();
            this.clients.delete(name);
        }
    }
    getClient(name) {
        return this.clients.get(name);
    }
    getClientForUri(uri) {
        return this.uriToClient.get(uri);
    }
    registerDocument(clientName, uri) {
        const client = this.clients.get(clientName);
        if (client) {
            this.uriToClient.set(uri, client);
        }
    }
    async disconnectAll() {
        for (const client of this.clients.values()) {
            client.disconnect();
        }
        this.clients.clear();
        this.uriToClient.clear();
    }
}
export function createLSPManager() {
    return new LSPManager();
}
//# sourceMappingURL=client.js.map