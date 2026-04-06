import { spawn } from 'child_process';
import { EventEmitter } from 'events';
export class MCPClient extends EventEmitter {
    process = null;
    requestId = 0;
    pendingRequests = new Map();
    tools = new Map();
    resources = new Map();
    isInitialized = false;
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    async connect() {
        return new Promise((resolve, reject) => {
            const { command, args = [], env = {} } = this.config;
            this.process = spawn(command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, ...env },
            });
            let stdoutBuffer = '';
            let stderrBuffer = '';
            this.process.stdout?.on('data', (data) => {
                stdoutBuffer += data.toString();
                this.processStdout(stdoutBuffer);
            });
            this.process.stderr?.on('data', (data) => {
                stderrBuffer += data.toString();
                if (stderrBuffer.includes('\n')) {
                    this.emit('error', new Error(stderrBuffer));
                    stderrBuffer = '';
                }
            });
            this.process.on('error', (error) => {
                this.emit('error', error);
                reject(error);
            });
            this.process.on('exit', (code) => {
                this.emit('close', code);
                this.isInitialized = false;
            });
            const timeout = setTimeout(() => {
                reject(new Error('MCP connection timeout'));
            }, 30000);
            this.once('initialized', () => {
                clearTimeout(timeout);
                resolve();
            });
            this.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }
    processStdout(buffer) {
        const lines = buffer.split('\n');
        for (const line of lines) {
            if (line.trim()) {
                try {
                    const message = JSON.parse(line);
                    this.handleMessage(message);
                }
                catch {
                    // Wait for more data
                }
            }
        }
    }
    handleMessage(message) {
        if ('id' in message && message.id !== undefined) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                if ('error' in message && message.error) {
                    pending.reject(new Error(message.error.message));
                }
                else if ('result' in message) {
                    pending.resolve(message.result);
                }
                this.pendingRequests.delete(message.id);
            }
        }
        if ('method' in message && !('id' in message)) {
            this.handleNotification(message);
        }
    }
    handleNotification(notification) {
        switch (notification.method) {
            case 'notifications/tools/list_changed':
                this.emit('toolsChanged');
                break;
            case 'notifications/resources/list_changed':
                this.emit('resourcesChanged');
                break;
            default:
                this.emit('notification', notification);
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
            this.process.stdin.write(JSON.stringify(request) + '\n');
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out`));
                }
            }, 60000);
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
        this.process.stdin.write(JSON.stringify(notification) + '\n');
    }
    async initialize() {
        const result = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {
                tools: {},
                resources: {},
                prompts: {},
            },
            clientInfo: {
                name: 'ai-agent-cli',
                version: '1.0.0',
            },
        });
        this.isInitialized = true;
        this.sendNotification('notifications/initialized');
        this.emit('initialized', result);
        if (result.capabilities.tools) {
            await this.listTools();
        }
        if (result.capabilities.resources) {
            await this.listResources();
        }
        return result;
    }
    async listTools() {
        const result = await this.sendRequest('tools/list');
        this.tools.clear();
        for (const tool of result.tools ?? []) {
            this.tools.set(tool.name, tool);
        }
        return result.tools ?? [];
    }
    async callTool(name, args) {
        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        });
        return result;
    }
    async listResources() {
        const result = await this.sendRequest('resources/list');
        this.resources.clear();
        for (const resource of result.resources ?? []) {
            this.resources.set(resource.uri, resource);
        }
        return result.resources ?? [];
    }
    async readResource(uri) {
        return this.sendRequest('resources/read', { uri });
    }
    async listPrompts() {
        const result = await this.sendRequest('prompts/list');
        return result.prompts ?? [];
    }
    getTools() {
        return Array.from(this.tools.values());
    }
    getResources() {
        return Array.from(this.resources.values());
    }
    isConnected() {
        return this.isInitialized && this.process !== null;
    }
    disconnect() {
        if (this.process) {
            this.sendNotification('exit');
            this.process.kill();
            this.process = null;
        }
        this.isInitialized = false;
        this.pendingRequests.clear();
        this.tools.clear();
        this.resources.clear();
    }
}
export class MCPManager {
    clients = new Map();
    async addServer(config) {
        const client = new MCPClient(config);
        await client.connect();
        await client.initialize();
        this.clients.set(config.name, client);
        return client;
    }
    async removeServer(name) {
        const client = this.clients.get(name);
        if (client) {
            client.disconnect();
            this.clients.delete(name);
        }
    }
    getClient(name) {
        return this.clients.get(name);
    }
    getAllClients() {
        return Array.from(this.clients.values());
    }
    async listAllTools() {
        const tools = [];
        for (const [name, client] of this.clients) {
            for (const tool of client.getTools()) {
                tools.push({ server: name, tool });
            }
        }
        return tools;
    }
    async callTool(serverName, toolName, args) {
        const client = this.clients.get(serverName);
        if (!client) {
            throw new Error(`MCP server ${serverName} not found`);
        }
        return client.callTool(toolName, args);
    }
    async disconnectAll() {
        for (const client of this.clients.values()) {
            client.disconnect();
        }
        this.clients.clear();
    }
}
export function createMCPManager() {
    return new MCPManager();
}
//# sourceMappingURL=client.js.map