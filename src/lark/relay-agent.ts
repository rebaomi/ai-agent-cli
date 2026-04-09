import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { LarkRelayConfig } from '../types/index.js';

export interface LarkRelayMessage {
  type: string;
  content: string;
  messageId?: string;
  chatId?: string;
  senderId?: string;
  chatType?: string;
  messageType?: string;
  raw: Record<string, unknown>;
}

export interface NormalizedLarkRelayConfig {
  enabled: boolean;
  autoSubscribe: boolean;
  eventTypes: string[];
  compact: boolean;
  quiet: boolean;
  allowedChatIds: string[];
  allowedSenderIds: string[];
  allowCommands: boolean;
  cliBin: string;
}

interface ManagedRelayState {
  pid: number;
  cliBin: string;
  args: string[];
  createdAt: number;
}

export interface LarkRelayProcessInfo {
  pid: number;
  commandLine: string;
  owner: 'current' | 'managed' | 'external';
}

export interface LarkRelayStatus {
  enabled: boolean;
  autoSubscribe: boolean;
  running: boolean;
  summary: string;
  currentPid?: number;
  managedPid?: number;
  lastStartupError?: string;
  lastStopDetail?: string;
  subscribeProcesses: LarkRelayProcessInfo[];
  externalOccupancy: boolean;
}

export function normalizeLarkRelayConfig(config?: LarkRelayConfig): NormalizedLarkRelayConfig {
  return {
    enabled: config?.enabled ?? false,
    autoSubscribe: config?.autoSubscribe ?? true,
    eventTypes: sanitizeList(config?.eventTypes, ['im.message.receive_v1']),
    compact: config?.compact ?? true,
    quiet: config?.quiet ?? true,
    allowedChatIds: sanitizeList(config?.allowedChatIds),
    allowedSenderIds: sanitizeList(config?.allowedSenderIds),
    allowCommands: config?.allowCommands ?? false,
    cliBin: typeof config?.cliBin === 'string' && config.cliBin.trim().length > 0
      ? config.cliBin.trim()
      : (process.env.LARK_CLI_BIN || (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli')),
  };
}

export function parseLarkRelayMessageLine(line: string, relayConfig?: LarkRelayConfig): LarkRelayMessage | null {
  const normalized = normalizeLarkRelayConfig(relayConfig);

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  const type = firstNonEmptyString(
    asString(raw.type),
    asString((raw.header as Record<string, unknown> | undefined)?.event_type),
  );
  if (type !== 'im.message.receive_v1') {
    return null;
  }

  const messageId = firstNonEmptyString(
    asString(raw.message_id),
    asString(raw.id),
    asString((raw.event as Record<string, unknown> | undefined)?.message_id),
    asString((((raw.event as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.message_id)),
  );
  const chatId = firstNonEmptyString(
    asString(raw.chat_id),
    asString((((raw.event as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.chat_id)),
  );
  const senderId = firstNonEmptyString(
    asString(raw.sender_id),
    asString(((((raw.event as Record<string, unknown> | undefined)?.sender as Record<string, unknown> | undefined)?.sender_id as Record<string, unknown> | undefined)?.open_id)),
  );
  const messageType = firstNonEmptyString(
    asString(raw.message_type),
    asString(((((raw.event as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.message_type))),
  );
  const chatType = firstNonEmptyString(
    asString(raw.chat_type),
    asString(((((raw.event as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.chat_type))),
  );
  const content = extractMessageContent(raw).trim();

  if (!content) {
    return null;
  }

  if (normalized.allowedChatIds.length > 0 && (!chatId || !normalized.allowedChatIds.includes(chatId))) {
    return null;
  }

  if (normalized.allowedSenderIds.length > 0 && (!senderId || !normalized.allowedSenderIds.includes(senderId))) {
    return null;
  }

  return {
    type,
    content,
    messageId: messageId || undefined,
    chatId: chatId || undefined,
    senderId: senderId || undefined,
    chatType: chatType || undefined,
    messageType: messageType || undefined,
    raw,
  };
}

export class LarkRelayAgent extends EventEmitter {
  private process: ChildProcess | null = null;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly config: NormalizedLarkRelayConfig;
  private startupOutput: string[] = [];
  private lastStartupError = '';
  private lastStopDetail = '';

  constructor(config?: LarkRelayConfig) {
    super();
    this.config = normalizeLarkRelayConfig(config);
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getSummary(): string {
    const filters: string[] = [];
    if (this.config.allowedChatIds.length > 0) {
      filters.push(`chat=${this.config.allowedChatIds.join(',')}`);
    }
    if (this.config.allowedSenderIds.length > 0) {
      filters.push(`sender=${this.config.allowedSenderIds.join(',')}`);
    }

    return [
      `events=${this.config.eventTypes.join(',')}`,
      `compact=${this.config.compact ? 'on' : 'off'}`,
      `quiet=${this.config.quiet ? 'on' : 'off'}`,
      filters.length > 0 ? `filter=${filters.join(';')}` : undefined,
    ].filter(Boolean).join(' | ');
  }

  async getStatus(): Promise<LarkRelayStatus> {
    const managedState = await this.readManagedState();
    const subscribeProcesses = await this.listSubscribeProcesses();
    const currentPid = this.process?.pid ?? undefined;

    return {
      enabled: this.config.enabled,
      autoSubscribe: this.config.autoSubscribe,
      running: this.isRunning(),
      summary: this.getSummary(),
      currentPid,
      managedPid: managedState?.pid,
      lastStartupError: this.lastStartupError || undefined,
      lastStopDetail: this.lastStopDetail || undefined,
      subscribeProcesses: subscribeProcesses.map(processInfo => ({
        ...processInfo,
        owner: currentPid && processInfo.pid === currentPid
          ? 'current'
          : managedState?.pid === processInfo.pid
            ? 'managed'
            : 'external',
      })),
      externalOccupancy: subscribeProcesses.some(processInfo => {
        if (currentPid && processInfo.pid === currentPid) {
          return false;
        }
        return managedState?.pid !== processInfo.pid;
      }),
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled || !this.config.autoSubscribe || this.process) {
      return;
    }

    this.lastStartupError = '';
    await this.cleanupManagedOrphan();

    await new Promise<void>((resolve, reject) => {
      const relayArgs = this.buildArgs();
      const spawnSpec = this.buildSpawnSpec(this.config.cliBin, relayArgs);
      let settled = false;
      let readyTimer: NodeJS.Timeout | undefined;

      this.startupOutput = [];
      this.stdoutBuffer = '';
      this.stderrBuffer = '';

      this.process = spawn(spawnSpec.command, spawnSpec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true,
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.stdoutBuffer += data.toString();
        this.flushStdoutBuffer();
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        this.stderrBuffer += data.toString();
        const lines = this.stderrBuffer.split(/\r?\n/);
        this.stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            this.startupOutput.push(trimmed);
            this.emit('stderr', trimmed);
          }
        }
      });

      this.process.once('spawn', () => {
        void this.writeManagedState({
          pid: this.process?.pid ?? 0,
          cliBin: this.config.cliBin,
          args: relayArgs,
          createdAt: Date.now(),
        });

        readyTimer = setTimeout(() => {
          if (settled) {
            return;
          }

          if (!this.process || this.process.exitCode !== null || this.process.killed) {
            return;
          }

          settled = true;
          this.lastStartupError = '';
          this.emit('started', this.getSummary());
          resolve();
        }, 2000);
      });

      this.process.once('error', (error) => {
        if (readyTimer) {
          clearTimeout(readyTimer);
        }
        if (!settled) {
          settled = true;
          this.process = null;
          void this.clearManagedState();
          this.lastStartupError = error.message;
          reject(error);
          return;
        }
        this.emit('error', error);
      });

      this.process.once('exit', (code, signal) => {
        if (readyTimer) {
          clearTimeout(readyTimer);
        }
        const previous = this.process;
        this.process = null;
        if (this.stderrBuffer.trim()) {
          this.startupOutput.push(this.stderrBuffer.trim());
          this.emit('stderr', this.stderrBuffer.trim());
          this.stderrBuffer = '';
        }
        void this.clearManagedState();
        const detail = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        this.lastStopDetail = detail;
        this.emit('stopped', detail);
        if (!settled) {
          settled = true;
          const message = this.buildStartupFailureMessage(detail);
          this.lastStartupError = message;
          reject(new Error(message));
        }
        if (previous) {
          previous.removeAllListeners();
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      await this.clearManagedState();
      return;
    }

    const current = this.process;
    this.process = null;
    await this.clearManagedState();

    await new Promise<void>((resolve) => {
      current.once('exit', () => resolve());
      current.kill('SIGTERM');
      setTimeout(() => {
        try {
          current.kill('SIGKILL');
        } catch {
        }
        resolve();
      }, 2000).unref();
    });
  }

  private buildArgs(): string[] {
    const args = ['event', '+subscribe', '--as', 'bot'];
    if (this.config.eventTypes.length > 0) {
      args.push('--event-types', this.config.eventTypes.join(','));
    }
    if (this.config.compact) {
      args.push('--compact');
    }
    if (this.config.quiet) {
      args.push('--quiet');
    }
    return args;
  }

  private flushStdoutBuffer(): void {
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      const message = parseLarkRelayMessageLine(trimmed, this.config);
      if (message) {
        this.emit('message', message);
      } else {
        this.startupOutput.push(trimmed);
      }
    }
  }

  private buildStartupFailureMessage(detail: string): string {
    const output = this.startupOutput.filter(Boolean).join('\n').trim();
    if (output) {
      return output;
    }
    return `Lark relay exited before startup (${detail})`;
  }

  private async cleanupManagedOrphan(): Promise<void> {
    const state = await this.readManagedState();
    if (!state?.pid) {
      return;
    }

    const commandLine = await this.getProcessCommandLine(state.pid);
    if (!commandLine) {
      await this.clearManagedState();
      return;
    }

    if (!this.looksLikeManagedRelayCommand(commandLine)) {
      await this.clearManagedState();
      return;
    }

    try {
      process.kill(state.pid, 'SIGTERM');
    } catch {
      await this.clearManagedState();
      return;
    }

    const stopped = await this.waitForProcessExit(state.pid, 3000);
    if (!stopped) {
      try {
        process.kill(state.pid, 'SIGKILL');
      } catch {
      }
      await this.waitForProcessExit(state.pid, 1000);
    }

    await this.clearManagedState();
    this.emit('stderr', `[managed relay] reaped stale subscribe process pid=${state.pid}`);
  }

  private looksLikeManagedRelayCommand(commandLine: string): boolean {
    return /event\s+\+subscribe/i.test(commandLine) && /lark-cli|lark-cli\.cmd/i.test(commandLine);
  }

  private async listSubscribeProcesses(): Promise<Array<{ pid: number; commandLine: string }>> {
    try {
      if (process.platform === 'win32') {
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match 'event\\s+\\+subscribe' -and $_.CommandLine -match 'lark-cli' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
        ], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const { output, code } = await captureProcessOutput(ps, 2500);
        if (code !== 0 || !output.trim()) {
          return [];
        }

        const parsed = JSON.parse(output) as Array<{ ProcessId?: number; CommandLine?: string }> | { ProcessId?: number; CommandLine?: string };
        const items = Array.isArray(parsed) ? parsed : [parsed];
        return items
          .map(item => ({
            pid: typeof item.ProcessId === 'number' ? item.ProcessId : 0,
            commandLine: typeof item.CommandLine === 'string' ? item.CommandLine.trim() : '',
          }))
          .filter(item => item.pid > 0 && this.looksLikeManagedRelayCommand(item.commandLine));
      }

      const proc = spawn('ps', ['-axo', 'pid=,args='], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const { output, code } = await captureProcessOutput(proc, 2500);
      if (code !== 0) {
        return [];
      }

      return output
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const match = line.match(/^(\d+)\s+(.+)$/);
          const pidText = match?.[1];
          const commandLine = match?.[2]?.trim();
          if (!pidText || !commandLine) {
            return null;
          }
          return {
            pid: Number(pidText),
            commandLine,
          };
        })
        .filter((item): item is { pid: number; commandLine: string } => !!item && item.pid > 0 && this.looksLikeManagedRelayCommand(item.commandLine));
    } catch {
      return [];
    }
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const commandLine = await this.getProcessCommandLine(pid);
      if (!commandLine) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
  }

  private async getProcessCommandLine(pid: number): Promise<string | null> {
    try {
      if (process.platform === 'win32') {
        const ps = spawn('powershell.exe', [
          '-NoProfile',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`,
        ], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        const { output, code } = await captureProcessOutput(ps, 2000);
        if (code !== 0) {
          return null;
        }
        const trimmed = output.trim();
        return trimmed || null;
      }

      const proc = spawn('ps', ['-p', String(pid), '-o', 'args='], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const { output, code } = await captureProcessOutput(proc, 2000);
      if (code !== 0) {
        return null;
      }
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  private getStateFilePath(): string {
    return path.join(os.homedir(), '.ai-agent-cli', 'lark-relay-state.json');
  }

  private async readManagedState(): Promise<ManagedRelayState | null> {
    try {
      const content = await fs.readFile(this.getStateFilePath(), 'utf-8');
      const parsed = JSON.parse(content) as ManagedRelayState;
      if (!parsed || typeof parsed.pid !== 'number' || parsed.pid <= 0) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeManagedState(state: ManagedRelayState): Promise<void> {
    if (!state.pid) {
      return;
    }
    await fs.mkdir(path.dirname(this.getStateFilePath()), { recursive: true });
    await fs.writeFile(this.getStateFilePath(), JSON.stringify(state, null, 2), 'utf-8');
  }

  private async clearManagedState(): Promise<void> {
    try {
      await fs.rm(this.getStateFilePath(), { force: true });
    } catch {
    }
  }

  private buildSpawnSpec(command: string, args: string[]): { command: string; args: string[] } {
    if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) {
      return { command, args };
    }

    const escaped = [command, ...args].map(value => this.escapeWindowsShellArg(value)).join(' ');
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', escaped],
    };
  }

  private escapeWindowsShellArg(value: string): string {
    if (value.length === 0) {
      return '""';
    }

    if (!/[\s"]/g.test(value)) {
      return value;
    }

    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
  }
}

function sanitizeList(input?: string[], fallback: string[] = []): string[] {
  const values = Array.isArray(input) ? input : fallback;
  return values
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmptyString(...values: string[]): string {
  return values.find(value => value.length > 0) || '';
}

function extractMessageContent(raw: Record<string, unknown>): string {
  const compactContent = asString(raw.content);
  if (compactContent) {
    return compactContent;
  }

  const nestedContent = asString((((raw.event as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content));
  if (!nestedContent) {
    return '';
  }

  try {
    const parsed = JSON.parse(nestedContent) as Record<string, unknown>;
    return firstNonEmptyString(
      asString(parsed.text),
      asString(parsed.title),
      typeof parsed === 'object' ? JSON.stringify(parsed) : '',
    );
  } catch {
    return nestedContent;
  }
}

function captureProcessOutput(processRef: ChildProcess, timeoutMs: number): Promise<{ output: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      try {
        processRef.kill();
      } catch {
      }
      reject(new Error(`process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    processRef.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    processRef.once('error', reject);
    processRef.once('close', (code) => {
      clearTimeout(timer);
      resolve({ output, code });
    });
  });
}