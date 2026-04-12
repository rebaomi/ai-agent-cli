import chalk from 'chalk';

export type OutputLevel = 'debug' | 'info' | 'warning' | 'error';
export type OutputChannel = 'process' | 'notification' | 'permission';

export interface OutputChannelPolicy {
  enabled?: boolean;
  minLevel?: OutputLevel;
}

export interface OutputCoordinatorEntry {
  channel: OutputChannel;
  level: OutputLevel;
  text: string;
}

export interface OutputCoordinatorOptions {
  getPolicy?: (channel: OutputChannel) => OutputChannelPolicy | undefined;
  write: (entry: OutputCoordinatorEntry) => void;
}

export interface StreamOptions {
  prefix?: string;
  color?: 'cyan' | 'green' | 'yellow' | 'red' | 'blue' | 'magenta';
  speed?: number;
  showCursor?: boolean;
}

export class StreamingOutput {
  private buffer: string = '';
  private prefix: string;
  private color: 'cyan' | 'green' | 'yellow' | 'red' | 'blue' | 'magenta';
  private speed: number;
  private showCursor: boolean;
  private isStreaming: boolean = false;

  constructor(options: StreamOptions = {}) {
    this.prefix = options.prefix || '';
    this.color = options.color || 'cyan';
    this.speed = options.speed || 20;
    this.showCursor = options.showCursor ?? true;
  }

  async stream(text: string): Promise<void> {
    if (!text) return;
    
    this.isStreaming = true;
    this.buffer += text;

    if (this.prefix) {
      process.stdout.write(chalk[this.color](this.prefix));
    }

    for (const char of text) {
      process.stdout.write(char);
      if (this.speed > 0 && !'\n\r'.includes(char)) {
        await this.sleep(this.speed);
      }
    }

    if (this.showCursor) {
      process.stdout.write(chalk.reset(''));
    }
    
    this.isStreaming = false;
  }

  async streamLine(text: string): Promise<void> {
    await this.stream(text + '\n');
  }

  clear(): void {
    process.stdout.write('\r\x1b[K');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  isActive(): boolean {
    return this.isStreaming;
  }

  getBuffer(): string {
    return this.buffer;
  }

  clearBuffer(): void {
    this.buffer = '';
  }
}

export class OutputCoordinator {
  private readonly queued: OutputCoordinatorEntry[] = [];
  private readonly pauseTokens = new Set<string>();

  constructor(private readonly options: OutputCoordinatorOptions) {}

  write(entry: OutputCoordinatorEntry): void {
    if (!entry.text.trim()) {
      return;
    }

    if (!this.shouldDeliver(entry)) {
      return;
    }

    if (this.pauseTokens.size > 0 && entry.channel !== 'permission') {
      this.queued.push(entry);
      return;
    }

    this.options.write(entry);
  }

  pause(token: string): void {
    this.pauseTokens.add(token);
  }

  resume(token: string): void {
    this.pauseTokens.delete(token);
    if (this.pauseTokens.size === 0) {
      this.flush();
    }
  }

  isPaused(): boolean {
    return this.pauseTokens.size > 0;
  }

  flush(): void {
    while (this.pauseTokens.size === 0 && this.queued.length > 0) {
      const next = this.queued.shift();
      if (next) {
        this.options.write(next);
      }
    }
  }

  clear(): void {
    this.queued.length = 0;
    this.pauseTokens.clear();
  }

  private shouldDeliver(entry: OutputCoordinatorEntry): boolean {
    const policy = this.options.getPolicy?.(entry.channel);
    if (policy?.enabled === false) {
      return false;
    }

    const minLevel = policy?.minLevel || 'info';
    return compareOutputLevel(entry.level, minLevel) >= 0;
  }
}

export function createStreamingOutput(options?: StreamOptions): StreamingOutput {
  return new StreamingOutput(options);
}

export function createOutputCoordinator(options: OutputCoordinatorOptions): OutputCoordinator {
  return new OutputCoordinator(options);
}

export function printSuccess(message: string): void {
  console.log(chalk.green('✓') + ' ' + message);
}

export function printError(message: string): void {
  console.log(chalk.red('✗') + ' ' + message);
}

export function printWarning(message: string): void {
  console.log(chalk.yellow('⚠') + ' ' + message);
}

export function printInfo(message: string): void {
  console.log(chalk.blue('ℹ') + ' ' + message);
}

export async function printTypingEffect(text: string, speed = 15): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    if (speed > 0 && !'\n\r'.includes(char)) {
      await new Promise(resolve => setTimeout(resolve, speed));
    }
  }
  console.log();
}

function compareOutputLevel(left: OutputLevel, right: OutputLevel): number {
  return getOutputLevelWeight(left) - getOutputLevelWeight(right);
}

function getOutputLevelWeight(level: OutputLevel): number {
  switch (level) {
    case 'debug':
      return 10;
    case 'info':
      return 20;
    case 'warning':
      return 30;
    case 'error':
      return 40;
  }
}
