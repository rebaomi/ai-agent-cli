import { mkdirSync, createWriteStream, type WriteStream } from 'fs';
import os from 'os';
import path from 'path';
import type { OutputConfig, OutputChannelLevel } from '../../types/index.js';

export type TerminalSystemCategory = 'agentcat' | 'health' | 'system' | 'permission';

export interface TerminalSystemOptions {
  level?: OutputChannelLevel;
  silent?: boolean;
  category?: TerminalSystemCategory;
}

export interface TerminalManagerOptions {
  config?: OutputConfig;
  appBaseDir?: string;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class TerminalManager {
  private config: OutputConfig;
  private appBaseDir: string;
  private readonly mainOutput: NodeJS.WriteStream;
  private readonly stderrOutput: NodeJS.WriteStream;
  private systemOutput: NodeJS.WriteStream;
  private debugOutput?: WriteStream;
  private systemLog?: WriteStream;
  private progressLine = '';

  constructor(options: TerminalManagerOptions = {}) {
    this.config = {};
    this.appBaseDir = options.appBaseDir || path.join(os.homedir(), '.ai-agent-cli');
    this.mainOutput = options.stdout || process.stdout;
    this.stderrOutput = options.stderr || process.stderr;
    this.systemOutput = this.stderrOutput;
    this.updateConfig(options.config, options.appBaseDir);
  }

  updateConfig(config?: OutputConfig, appBaseDir?: string): void {
    this.clearProgress();
    this.systemLog?.end();
    this.debugOutput?.end();

    this.config = config || {};
    this.appBaseDir = appBaseDir || this.appBaseDir;
    this.systemLog = undefined;
    this.debugOutput = undefined;

    const systemTarget = this.config.channels?.system?.target || (this.config.systemToStderr === false ? 'stdout' : 'stderr');
    this.systemOutput = systemTarget === 'stdout' ? this.mainOutput : this.stderrOutput;

    const logsDir = path.join(this.appBaseDir, 'logs');
    const systemLogPath = this.resolveLogPath(this.config.channels?.system?.logFile) || this.resolveLogPath(this.config.systemLogFile);
    if (systemLogPath) {
      mkdirSync(path.dirname(systemLogPath), { recursive: true });
      this.systemLog = createWriteStream(systemLogPath, { flags: 'a' });
    }

    const debugEnabled = this.config.channels?.debug?.target === 'file'
      || this.config.debugToFile === true
      || Boolean(this.config.channels?.debug?.file)
      || Boolean(this.config.debugLogFile);
    const debugEnabledInCurrentMode = this.isDebugEnabledInCurrentMode();
    if (debugEnabled && debugEnabledInCurrentMode) {
      mkdirSync(logsDir, { recursive: true });
      const configuredPath = this.resolveLogPath(this.config.channels?.debug?.file) || this.resolveLogPath(this.config.debugLogFile);
      const defaultPath = path.join(logsDir, `debug-${Date.now()}.log`);
      const debugPath = configuredPath || defaultPath;
      mkdirSync(path.dirname(debugPath), { recursive: true });
      this.debugOutput = createWriteStream(debugPath, { flags: 'a' });
    }
  }

  write(content: string): void {
    this.clearProgress();
    this.mainOutput.write(content);
  }

  writeLine(content: string): void {
    this.write(ensureTrailingNewline(content));
  }

  system(message: string, options: TerminalSystemOptions = {}): void {
    const normalizedMessage = stripTrailingNewlines(message);
    if (!normalizedMessage) {
      return;
    }

    const level = options.level || 'info';
    const timestamp = new Date().toISOString();
    const prefix = this.getPrefix(level);
    const formatted = `${prefix} [${timestamp}] ${normalizedMessage}`;
    const finalText = ensureTrailingNewline(formatted);

    this.systemLog?.write(finalText);
    this.debugOutput?.write(finalText);

    if (!options.silent && this.shouldDisplay(options)) {
      this.clearProgress();
      this.systemOutput.write(finalText);
    }
  }

  debug(message: string, options?: { echoToTerminal?: boolean; level?: OutputChannelLevel }): void {
    const normalizedMessage = stripTrailingNewlines(message);
    if (!normalizedMessage) {
      return;
    }

    const level = options?.level || 'debug';
    const timestamp = new Date().toISOString();
    const formatted = ensureTrailingNewline(`[${level.toUpperCase()}] [${timestamp}] ${normalizedMessage}`);
    this.debugOutput?.write(formatted);

    if (options?.echoToTerminal) {
      this.clearProgress();
      this.systemOutput.write(formatted);
    }
  }

  progress(message: string): void {
    if (!message) {
      return;
    }

    this.clearProgress();
    this.progressLine = `⏳ ${message}`;
    this.systemOutput.write(this.progressLine);
  }

  clearProgress(): void {
    if (!this.progressLine) {
      return;
    }

    this.systemOutput.write(`\r${' '.repeat(this.progressLine.length)}\r`);
    this.progressLine = '';
  }

  close(): void {
    this.clearProgress();
    this.systemLog?.end();
    this.debugOutput?.end();
  }

  private shouldDisplay(options: TerminalSystemOptions): boolean {
    const agentcatConfig = this.config.agentcat;
    if (options.category === 'agentcat') {
      return agentcatConfig?.displayInTerminal !== false;
    }

    const silentInProduction = this.config.channels?.system?.silentInProduction ?? this.config.silentSystemInProduction ?? true;
    const mode = this.config.mode || 'development';
    if (mode === 'production' && silentInProduction && (options.category === 'health' || options.category === 'system')) {
      return false;
    }

    return true;
  }

  private isDebugEnabledInCurrentMode(): boolean {
    const mode = this.config.mode || 'development';
    if (mode !== 'production') {
      return true;
    }

    return this.config.channels?.debug?.enabledInProduction ?? false;
  }

  private getPrefix(level: OutputChannelLevel): string {
    switch (level) {
      case 'error':
        return '[ERROR]';
      case 'warning':
        return '[WARN]';
      case 'debug':
        return '[DEBUG]';
      case 'info':
      default:
        return '[INFO]';
    }
  }

  private resolveLogPath(configuredPath?: string): string | undefined {
    if (!configuredPath) {
      return undefined;
    }

    if (configuredPath.startsWith('~/')) {
      return path.join(os.homedir(), configuredPath.slice(2));
    }

    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    return path.join(this.appBaseDir, configuredPath);
  }
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function stripTrailingNewlines(content: string): string {
  return content.replace(/[\r\n]+$/g, '');
}