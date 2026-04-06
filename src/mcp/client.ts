import { spawn, ChildProcess } from 'child_process';
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

export class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private tools: Map<string, MCPTool> = new Map();
  private resources: Map<string, MCPResource> = new Map();
  private isInitialized = false;
  private config: MCPConfig;

  constructor(config: MCPConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { command, args = [], env = {} } = this.config;
      
      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        shell: process.platform === 'win32',
        windowsHide: true,
      });

      let stdoutBuffer = '';
      let stderrBuffer = '';

      this.process.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        this.processStdout(stdoutBuffer);
      });

      this.process.stderr?.on('data', (data: Buffer) => {
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

  private processStdout(buffer: string): void {
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line) as MCPResponse | MCPNotification;
          this.handleMessage(message);
        } catch {
          // Wait for more data
        }
      }
    }
  }

  private handleMessage(message: MCPResponse | MCPNotification): void {
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if ('error' in message && message.error) {
          pending.reject(new Error(message.error.message));
        } else if ('result' in message) {
          pending.resolve(message.result);
        }
        this.pendingRequests.delete(message.id);
      }
    }

    if ('method' in message && !('id' in message)) {
      this.handleNotification(message as MCPNotification);
    }
  }

  private handleNotification(notification: MCPNotification): void {
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

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Process not running'));
        return;
      }

      const id = ++this.requestId;
      const request: MCPRequest = {
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

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin) return;

    const notification: MCPNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  async initialize(): Promise<InitializeResult> {
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
    }) as InitializeResult;

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

  async listTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest('tools/list') as { tools: MCPTool[] };
    this.tools.clear();
    for (const tool of result.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    }) as ToolResult;
    return result;
  }

  async listResources(): Promise<MCPResource[]> {
    const result = await this.sendRequest('resources/list') as { resources: MCPResource[] };
    this.resources.clear();
    for (const resource of result.resources ?? []) {
      this.resources.set(resource.uri, resource);
    }
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }> {
    return this.sendRequest('resources/read', { uri }) as Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string }> }>;
  }

  async listPrompts(): Promise<unknown[]> {
    const result = await this.sendRequest('prompts/list') as { prompts: unknown[] };
    return result.prompts ?? [];
  }

  getTools(): MCPTool[] {
    return Array.from(this.tools.values());
  }

  getResources(): MCPResource[] {
    return Array.from(this.resources.values());
  }

  isConnected(): boolean {
    return this.isInitialized && this.process !== null;
  }

  disconnect(): void {
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
  private clients: Map<string, MCPClient> = new Map();

  async addServer(config: MCPConfig): Promise<MCPClient> {
    const client = new MCPClient(config);
    
    await client.connect();
    await client.initialize();

    this.clients.set(config.name, client);
    return client;
  }

  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      client.disconnect();
      this.clients.delete(name);
    }
  }

  getClient(name: string): MCPClient | undefined {
    return this.clients.get(name);
  }

  getAllClients(): MCPClient[] {
    return Array.from(this.clients.values());
  }

  async listAllTools(): Promise<Array<{ server: string; tool: MCPTool }>> {
    const tools: Array<{ server: string; tool: MCPTool }> = [];
    for (const [name, client] of this.clients) {
      for (const tool of client.getTools()) {
        tools.push({ server: name, tool });
      }
    }
    return tools;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} not found`);
    }
    return client.callTool(toolName, args);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
  }
}

export function createMCPManager(): MCPManager {
  return new MCPManager();
}
