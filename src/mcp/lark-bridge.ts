import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

type JsonObject = Record<string, unknown>;

interface MCPRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: JsonObject;
}

interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

interface MCPToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const LARK_CLI_BIN = process.env.LARK_CLI_BIN || 'lark-cli';

function getLarkCliCandidates(): string[] {
  const baseCandidates = [LARK_CLI_BIN];
  if (process.platform === 'win32' && extname(LARK_CLI_BIN).length === 0) {
    baseCandidates.push(`${LARK_CLI_BIN}.cmd`, `${LARK_CLI_BIN}.exe`, `${LARK_CLI_BIN}.bat`);
  }

  if (process.platform !== 'win32') {
    return Array.from(new Set(baseCandidates));
  }

  const appData = process.env.APPDATA;
  const userProfile = process.env.USERPROFILE;
  const npmBins = [
    appData ? join(appData, 'npm') : undefined,
    userProfile ? join(userProfile, 'AppData', 'Roaming', 'npm') : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const expanded = [...baseCandidates];
  for (const binDir of npmBins) {
    for (const candidate of baseCandidates) {
      expanded.push(join(binDir, candidate));
    }
  }

  return Array.from(new Set(expanded));
}

const TOOL_DEFINITIONS: MCPToolDefinition[] = [
  {
    name: 'help',
    description: 'Show lark-cli help for the root command or a specific topic.',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional command path, for example ["calendar"] or ["im", "+messages-send"].',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'doctor',
    description: 'Run lark-cli doctor to inspect config, auth and endpoint reachability.',
    inputSchema: {
      type: 'object',
      properties: {
        offline: { type: 'boolean', description: 'Skip network checks.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'auth_status',
    description: 'Show current lark-cli authentication status.',
    inputSchema: {
      type: 'object',
      properties: {
        verify: { type: 'boolean', description: 'Verify token against server.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'schema',
    description: 'Inspect a lark-cli schema target, such as calendar.events.instance_view.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional schema path.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'shortcut',
    description: 'Run a lark-cli shortcut command such as calendar +agenda or docs +create.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name, for example calendar, im, docs.' },
        command: { type: 'string', description: 'Shortcut name, usually begins with +.' },
        flags: { type: 'object', description: 'Flag map. Booleans become --flag, strings become --flag value.' },
        as: { type: 'string', enum: ['auto', 'user', 'bot'], description: 'Identity type.' },
        format: { type: 'string', enum: ['json', 'pretty', 'table', 'ndjson', 'csv'], description: 'Output format.' },
        dryRun: { type: 'boolean', description: 'Preview request without executing.' },
      },
      required: ['service', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'service',
    description: 'Run a structured lark-cli service resource method such as calendar calendars list.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name.' },
        resource: { type: 'string', description: 'Resource name.' },
        method: { type: 'string', description: 'Method name.' },
        params: { type: 'object', description: 'JSON object passed to --params.' },
        data: { type: 'object', description: 'JSON object passed to --data.' },
        as: { type: 'string', enum: ['auto', 'user', 'bot'], description: 'Identity type.' },
        format: { type: 'string', enum: ['json', 'pretty', 'table', 'ndjson', 'csv'], description: 'Output format.' },
        dryRun: { type: 'boolean', description: 'Preview request without executing.' },
      },
      required: ['service', 'resource', 'method'],
      additionalProperties: false,
    },
  },
  {
    name: 'api',
    description: 'Run lark-cli api for a raw OpenAPI call.',
    inputSchema: {
      type: 'object',
      properties: {
        httpMethod: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP method.' },
        path: { type: 'string', description: 'OpenAPI path, for example /open-apis/calendar/v4/calendars.' },
        params: { type: 'object', description: 'JSON object passed to --params.' },
        data: { type: 'object', description: 'JSON object passed to --data.' },
        as: { type: 'string', enum: ['auto', 'user', 'bot'], description: 'Identity type.' },
        format: { type: 'string', enum: ['json', 'pretty', 'table', 'ndjson', 'csv'], description: 'Output format.' },
        dryRun: { type: 'boolean', description: 'Preview request without executing.' },
      },
      required: ['httpMethod', 'path'],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asFlagRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function appendFlags(args: string[], flags: Record<string, unknown>): void {
  for (const [key, rawValue] of Object.entries(flags)) {
    if (rawValue === undefined || rawValue === null || rawValue === false) {
      continue;
    }

    const flagName = `--${key}`;
    if (rawValue === true) {
      args.push(flagName);
      continue;
    }

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item === undefined || item === null) {
          continue;
        }
        args.push(flagName, typeof item === 'string' ? item : JSON.stringify(item));
      }
      continue;
    }

    if (typeof rawValue === 'object') {
      args.push(flagName, JSON.stringify(rawValue));
      continue;
    }

    args.push(flagName, String(rawValue));
  }
}

function buildShortcutArgs(input: JsonObject): string[] {
  const service = asOptionalString(input.service);
  const command = asOptionalString(input.command);
  if (!service || !command) {
    throw new Error('shortcut requires service and command');
  }

  const args = [service, command];
  appendFlags(args, asFlagRecord(input.flags));

  const as = asOptionalString(input.as)
    || inferDefaultIdentityForShortcut(service, command);
  if (as) {
    args.push('--as', as);
  }

  args.push('--format', asOptionalString(input.format) || 'json');

  if (input.dryRun === true) {
    args.push('--dry-run');
  }

  return args;
}

function inferDefaultIdentityForShortcut(service: string, command: string): string | undefined {
  if (service === 'im' && command === '+messages-send') {
    return 'bot';
  }

  return undefined;
}

function buildServiceArgs(input: JsonObject): string[] {
  const service = asOptionalString(input.service);
  const resource = asOptionalString(input.resource);
  const method = asOptionalString(input.method);
  if (!service || !resource || !method) {
    throw new Error('service requires service, resource and method');
  }

  const args = [service, resource, method];
  if (isRecord(input.params)) {
    args.push('--params', JSON.stringify(input.params));
  }
  if (isRecord(input.data)) {
    args.push('--data', JSON.stringify(input.data));
  }

  const as = asOptionalString(input.as);
  if (as) {
    args.push('--as', as);
  }

  args.push('--format', asOptionalString(input.format) || 'json');

  if (input.dryRun === true) {
    args.push('--dry-run');
  }

  return args;
}

function buildApiArgs(input: JsonObject): string[] {
  const httpMethod = asOptionalString(input.httpMethod);
  const apiPath = asOptionalString(input.path);
  if (!httpMethod || !apiPath) {
    throw new Error('api requires httpMethod and path');
  }

  const args = ['api', httpMethod.toUpperCase(), apiPath];
  if (isRecord(input.params)) {
    args.push('--params', JSON.stringify(input.params));
  }
  if (isRecord(input.data)) {
    args.push('--data', JSON.stringify(input.data));
  }

  const as = asOptionalString(input.as);
  if (as) {
    args.push('--as', as);
  }

  args.push('--format', asOptionalString(input.format) || 'json');

  if (input.dryRun === true) {
    args.push('--dry-run');
  }

  return args;
}

export function buildLarkCliArgs(toolName: string, input: JsonObject): string[] {
  switch (toolName) {
    case 'help':
      return [...asStringArray(input.args), '--help'];
    case 'doctor': {
      const args = ['doctor'];
      if (input.offline === true) {
        args.push('--offline');
      }
      return args;
    }
    case 'auth_status': {
      const args = ['auth', 'status'];
      if (input.verify === true) {
        args.push('--verify');
      }
      return args;
    }
    case 'schema': {
      const target = asOptionalString(input.target);
      return target ? ['schema', target] : ['schema'];
    }
    case 'shortcut':
      return buildShortcutArgs(input);
    case 'service':
      return buildServiceArgs(input);
    case 'api':
      return buildApiArgs(input);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function formatExecutionOutput(toolName: string, result: CommandExecutionResult): string {
  const parsed = tryParseJson(result.stdout);
  if (parsed !== undefined) {
    return JSON.stringify(parsed, null, 2);
  }

  const trimmedStdout = result.stdout.trim();
  if (trimmedStdout.length > 0) {
    return trimmedStdout;
  }

  const trimmedStderr = result.stderr.trim();
  if (trimmedStderr.length > 0) {
    return trimmedStderr;
  }

  return `${toolName} completed with exit code ${result.exitCode}`;
}

async function executeCommand(args: string[]): Promise<CommandExecutionResult> {
  let lastError: Error | undefined;
  for (const candidate of getLarkCliCandidates()) {
    if (process.platform === 'win32' && candidate.includes('\\') && !existsSync(candidate)) {
      continue;
    }

    try {
      return await new Promise<CommandExecutionResult>((resolve, reject) => {
        const spawnSpec = buildSpawnSpec(candidate, args);
        const child = spawn(spawnSpec.command, spawnSpec.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: process.env,
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        child.on('error', (error) => {
          reject(error);
        });

        child.on('close', (code) => {
          const exitCode = code ?? 0;
          if (exitCode !== 0) {
            reject(new Error(stderr.trim() || stdout.trim() || `lark-cli exited with code ${exitCode}`));
            return;
          }

          resolve({ stdout, stderr, exitCode });
        });
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((lastError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw lastError;
      }
    }
  }

  throw lastError || new Error(`Unable to locate lark-cli executable from ${getLarkCliCandidates().join(', ')}`);
}

function buildSpawnSpec(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') {
    return { command, args };
  }

  if (!/\.(cmd|bat)$/i.test(command)) {
    return { command, args };
  }

  const escaped = [command, ...args].map(value => escapeWindowsShellArg(value)).join(' ');
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', escaped],
  };
}

function escapeWindowsShellArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/g.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

async function callTool(toolName: string, input: JsonObject): Promise<MCPToolResponse> {
  const args = buildLarkCliArgs(toolName, input);
  const result = await executeCommand(args);
  return {
    content: [{ type: 'text', text: formatExecutionOutput(toolName, result) }],
  };
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeError(id: number | string | undefined, message: string): void {
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
    },
  });
}

async function handleRequest(request: MCPRequest): Promise<void> {
  switch (request.method) {
    case 'initialize':
      writeMessage({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'lark-cli-bridge', version: '1.0.0' },
        },
      });
      return;
    case 'notifications/initialized':
    case 'exit':
      return;
    case 'tools/list':
      writeMessage({ jsonrpc: '2.0', id: request.id, result: { tools: TOOL_DEFINITIONS } });
      return;
    case 'resources/list':
      writeMessage({ jsonrpc: '2.0', id: request.id, result: { resources: [] } });
      return;
    case 'tools/call': {
      const params = request.params ?? {};
      const toolName = asOptionalString(params.name);
      const input = isRecord(params.arguments) ? params.arguments : {};
      if (!toolName) {
        writeError(request.id, 'tools/call requires params.name');
        return;
      }

      try {
        const result = await callTool(toolName, input);
        writeMessage({ jsonrpc: '2.0', id: request.id, result });
      } catch (error) {
        writeError(request.id, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    default:
      writeError(request.id, `Unsupported method: ${request.method}`);
  }
}

export async function startLarkBridgeServer(): Promise<void> {
  process.stdin.setEncoding('utf8');

  let buffer = '';
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let request: MCPRequest;
      try {
        request = JSON.parse(trimmed) as MCPRequest;
      } catch {
        writeError(undefined, 'Invalid JSON request');
        continue;
      }

      void handleRequest(request);
    }
  });
}

const entryFile = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryFile) {
  void startLarkBridgeServer();
}

export { TOOL_DEFINITIONS };