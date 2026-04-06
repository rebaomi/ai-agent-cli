import chalk from 'chalk';

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

export function createStreamingOutput(options?: StreamOptions): StreamingOutput {
  return new StreamingOutput(options);
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
