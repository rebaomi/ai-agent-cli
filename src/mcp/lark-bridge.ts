import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, extname, dirname, delimiter } from 'node:path';
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

export function getBaseLarkCliCandidates(binName = LARK_CLI_BIN, platform = process.platform): string[] {
  const baseCandidates = [binName];
  if (platform === 'win32') {
    const extension = extname(binName).toLowerCase();
    if (extension.length === 0) {
      // Prefer the native .exe wrapper on Windows so multi-line --text values do not pass through cmd.exe re-quoting.
      baseCandidates.push(`${binName}.exe`, `${binName}.cmd`, `${binName}.bat`);
    } else if (extension === '.cmd' || extension === '.bat') {
      const baseName = binName.slice(0, -extension.length);
      // Even if config points to .cmd/.bat, prefer the sibling .exe first to avoid cmd.exe argument re-quoting.
      baseCandidates.unshift(`${baseName}.exe`, baseName);
    }
  }

  return Array.from(new Set(baseCandidates));
}

function getLarkCliCandidates(): string[] {
  const baseCandidates = getBaseLarkCliCandidates();

  if (process.platform !== 'win32') {
    return baseCandidates;
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

function splitWindowsPathEntries(envPath = process.env.PATH): string[] {
  if (typeof envPath !== 'string' || envPath.length === 0) {
    return [];
  }

  return envPath
    .split(delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function resolveWindowsCommandPath(command: string, envPath = process.env.PATH): string | undefined {
  if (command.includes('\\') || command.includes('/')) {
    return existsSync(command) ? command : undefined;
  }

  const extension = extname(command).toLowerCase();
  const suffixes = extension.length > 0 ? [''] : ['', '.exe', '.cmd', '.bat', '.ps1'];

  for (const dir of splitWindowsPathEntries(envPath)) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function resolveWindowsNodeWrapper(command: string, args: string[], envPath = process.env.PATH): { command: string; args: string[] } | undefined {
  const resolvedCommand = resolveWindowsCommandPath(command, envPath);
  if (!resolvedCommand || !/\.(cmd|bat|ps1)$/i.test(resolvedCommand)) {
    return undefined;
  }

  const wrapperDir = dirname(resolvedCommand);
  const scriptPath = join(wrapperDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  if (!existsSync(scriptPath)) {
    return undefined;
  }

  const bundledNode = join(wrapperDir, 'node.exe');
  return {
    command: existsSync(bundledNode) ? bundledNode : 'node',
    args: [scriptPath, ...args],
  };
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

function normalizeShortcutFlags(service: string, command: string, flags: Record<string, unknown>): Record<string, unknown> {
  if (service === 'calendar' && command === '+create') {
    const normalized: Record<string, unknown> = { ...flags };

    const summary = firstNonEmptyString(
      normalized.summary,
      normalized.title,
      normalized.subject,
      normalized.name,
    );
    const description = firstNonEmptyString(
      normalized.description,
      normalized.desc,
      normalized.details,
      normalized.content,
    );
    const start = firstNonEmptyString(
      normalized.start,
      normalized.startTime,
      normalized.start_time,
      normalized['start-time'],
    );
    const end = firstNonEmptyString(
      normalized.end,
      normalized.endTime,
      normalized.end_time,
      normalized['end-time'],
    );
    const attendeeIds = firstNonEmptyString(
      normalized['attendee-ids'],
      normalized.attendeeIds,
      normalized.attendees,
    );
    const calendarId = firstNonEmptyString(
      normalized['calendar-id'],
      normalized.calendarId,
      normalized.calendar_id,
    );

    if (summary) {
      normalized.summary = summary;
    }
    if (description) {
      normalized.description = description;
    }
    if (start) {
      normalized.start = start;
    }
    if (end) {
      normalized.end = end;
    }
    if (attendeeIds) {
      normalized['attendee-ids'] = attendeeIds;
    }
    if (calendarId) {
      normalized['calendar-id'] = calendarId;
    }

    delete normalized.title;
    delete normalized.subject;
    delete normalized.name;
    delete normalized.desc;
    delete normalized.details;
    delete normalized.content;
    delete normalized.startTime;
    delete normalized.start_time;
    delete normalized['start-time'];
    delete normalized.endTime;
    delete normalized.end_time;
    delete normalized['end-time'];
    delete normalized.attendeeIds;
    delete normalized.attendees;
    delete normalized.calendarId;
    delete normalized.calendar_id;

    return normalized;
  }

  if (service !== 'im' || command !== '+messages-send') {
    return flags;
  }

  const normalized: Record<string, unknown> = { ...flags };

  const chatId = firstNonEmptyString(
    normalized['chat-id'],
    normalized.chatId,
    normalized.chat_id,
  );
  const userId = firstNonEmptyString(
    normalized['user-id'],
    normalized.userId,
    normalized.user_id,
    normalized.open_id,
  );
  const receiveId = firstNonEmptyString(
    normalized.receive_id,
    normalized.receiveId,
    normalized['receive-id'],
  );
  const receiveIdType = firstNonEmptyString(
    normalized.receive_id_type,
    normalized.receiveIdType,
    normalized['receive-id-type'],
  )?.toLowerCase();

  if (!chatId && !userId && receiveId && receiveIdType) {
    if (receiveIdType === 'chat_id' || receiveIdType === 'chatid' || receiveIdType === 'chat') {
      normalized['chat-id'] = receiveId;
    }
    if (receiveIdType === 'open_id' || receiveIdType === 'openid' || receiveIdType === 'user_id' || receiveIdType === 'userid' || receiveIdType === 'user') {
      normalized['user-id'] = receiveId;
    }
  }

  if (!normalized['chat-id'] && chatId) {
    normalized['chat-id'] = chatId;
  }
  if (!normalized['user-id'] && userId) {
    normalized['user-id'] = userId;
  }

  const hasExplicitPayload = [
    normalized.text,
    normalized.markdown,
    normalized.file,
    normalized.image,
    normalized.video,
    normalized.audio,
  ].some(value => value !== undefined && value !== null && !(typeof value === 'string' && value.trim().length === 0));

  const legacyContent = normalized.content;
  const msgType = firstNonEmptyString(normalized.msg_type, normalized.msgType)?.toLowerCase();
  if (!hasExplicitPayload && typeof legacyContent === 'string' && legacyContent.trim().length > 0) {
    if (!msgType || msgType === 'text') {
      normalized.text = legacyContent;
      delete normalized.content;
    }
  }

  delete normalized.chatId;
  delete normalized.chat_id;
  delete normalized.userId;
  delete normalized.user_id;
  delete normalized.open_id;
  delete normalized.receive_id;
  delete normalized.receiveId;
  delete normalized['receive-id'];
  delete normalized.receive_id_type;
  delete normalized.receiveIdType;
  delete normalized['receive-id-type'];
  delete normalized.msg_type;
  delete normalized.msgType;

  return normalized;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function buildShortcutArgs(input: JsonObject): string[] {
  const service = asOptionalString(input.service);
  const command = asOptionalString(input.command);
  if (!service || !command) {
    throw new Error('shortcut requires service and command');
  }

  const args = [service, command];
  const flags = normalizeShortcutFlags(service, command, asFlagRecord(input.flags));
  appendFlags(args, flags);

  if (service === 'im' && command === '+messages-send') {
    const hasTarget = typeof flags['chat-id'] === 'string' || typeof flags['user-id'] === 'string';
    if (!hasTarget) {
      throw new Error('im +messages-send requires chat-id or user-id');
    }

    const hasPayload = ['text', 'markdown', 'file', 'image', 'video', 'audio', 'content']
      .some(key => flags[key] !== undefined && flags[key] !== null && !(typeof flags[key] === 'string' && (flags[key] as string).trim().length === 0));
    if (!hasPayload) {
      throw new Error('im +messages-send requires one of text, markdown, file, image, video, audio, or content');
    }
  }

  const as = service === 'im' && command === '+messages-send'
    ? 'bot'
    : asOptionalString(input.as) || inferDefaultIdentityForShortcut(service, command);
  if (as) {
    args.push('--as', as);
  }

  if (!(service === 'im' && command === '+messages-send')) {
    args.push('--format', asOptionalString(input.format) || 'json');
  }

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

export function buildSpawnSpec(
  command: string,
  args: string[],
  platform = process.platform,
  envPath = process.env.PATH,
): { command: string; args: string[] } {
  if (platform !== 'win32') {
    return { command, args };
  }

  const nodeWrapperSpec = resolveWindowsNodeWrapper(command, args, envPath);
  if (nodeWrapperSpec) {
    return nodeWrapperSpec;
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