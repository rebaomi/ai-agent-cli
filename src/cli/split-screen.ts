import { inspect } from 'util';

type Panel = 'left' | 'right';

interface PromptState {
  label: string;
  buffer: string;
  cursor: number;
}

export class SplitScreenRenderer {
  private readonly leftLines: string[] = [];
  private readonly rightLines: string[] = [];
  private readonly maxLines = 1200;
  private active = false;
  private promptState: PromptState | null = null;
  private readonly originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    clear: console.clear,
  };
  private readonly originalWrite = process.stdout.write.bind(process.stdout);

  isActive(): boolean {
    return this.active;
  }

  open(): void {
    if (this.active) {
      return;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('当前终端不支持分屏模式');
    }

    this.active = true;
    console.log = (...args: unknown[]) => this.appendLeft(this.formatArgs(args));
    console.info = (...args: unknown[]) => this.appendLeft(this.formatArgs(args));
    console.warn = (...args: unknown[]) => this.appendLeft(this.formatArgs(args));
    console.error = (...args: unknown[]) => this.appendLeft(this.formatArgs(args));
    console.clear = () => {
      this.leftLines.length = 0;
      this.rightLines.length = 0;
      this.render();
    };

    this.originalWrite('\x1b[?1049h');
    this.originalWrite('\x1b[?25l');
    this.appendLeft('Split view enabled');
    this.render();
  }

  close(): void {
    if (!this.active) {
      return;
    }

    console.log = this.originalConsole.log;
    console.info = this.originalConsole.info;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    console.clear = this.originalConsole.clear;

    this.promptState = null;
    this.active = false;
    this.originalWrite('\x1b[?25h');
    this.originalWrite('\x1b[?1049l');
  }

  appendLeft(text: string): void {
    this.append('left', text);
  }

  appendRight(text: string): void {
    this.append('right', text);
  }

  async prompt(label: string): Promise<string> {
    if (!this.active) {
      throw new Error('split renderer is not active');
    }

    return new Promise((resolve, reject) => {
      this.promptState = { label, buffer: '', cursor: 0 };
      this.render();

      const previousRawMode = process.stdin.isRaw;
      process.stdin.setRawMode?.(true);
      process.stdin.resume();

      const onData = (chunk: Buffer | string): void => {
        try {
          const value = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');

          if (value === '\u0003') {
            cleanup();
            reject(new Error('Exit'));
            return;
          }

          if (value === '\r' || value === '\n') {
            const answer = this.promptState?.buffer ?? '';
            cleanup();
            resolve(answer);
            return;
          }

          if (value === '\u0008' || value === '\u007f') {
            if (this.promptState && this.promptState.cursor > 0) {
              const left = this.promptState.buffer.slice(0, this.promptState.cursor - 1);
              const right = this.promptState.buffer.slice(this.promptState.cursor);
              this.promptState.buffer = left + right;
              this.promptState.cursor -= 1;
              this.render();
            }
            return;
          }

          if (value === '\u001b[D') {
            if (this.promptState) {
              this.promptState.cursor = Math.max(0, this.promptState.cursor - 1);
              this.render();
            }
            return;
          }

          if (value === '\u001b[C') {
            if (this.promptState) {
              this.promptState.cursor = Math.min(this.promptState.buffer.length, this.promptState.cursor + 1);
              this.render();
            }
            return;
          }

          if (value.startsWith('\u001b')) {
            return;
          }

          if (this.promptState) {
            const left = this.promptState.buffer.slice(0, this.promptState.cursor);
            const right = this.promptState.buffer.slice(this.promptState.cursor);
            this.promptState.buffer = left + value + right;
            this.promptState.cursor += value.length;
            this.render();
          }
        } catch (error) {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };

      const cleanup = (): void => {
        process.stdin.off('data', onData);
        process.stdin.setRawMode?.(previousRawMode ?? false);
        this.promptState = null;
        this.render();
      };

      process.stdin.on('data', onData);
    });
  }

  private append(panel: Panel, text: string): void {
    const target = panel === 'left' ? this.leftLines : this.rightLines;
    const normalized = this.stripAnsi(text).replace(/\r\n/g, '\n');
    const chunks = normalized.split('\n');

    for (let index = 0; index < chunks.length; index += 1) {
      target.push(chunks[index] ?? '');
    }

    if (target.length > this.maxLines) {
      target.splice(0, target.length - this.maxLines);
    }

    if (this.active) {
      this.render();
    }
  }

  private render(): void {
    if (!this.active) {
      return;
    }

    const totalWidth = process.stdout.columns || 120;
    const totalHeight = process.stdout.rows || 32;
    const contentHeight = Math.max(6, totalHeight - 3);
    const leftWidth = Math.max(30, Math.floor((totalWidth - 1) / 2));
    const rightWidth = Math.max(20, totalWidth - leftWidth - 1);

    const leftContent = this.wrapLines(this.leftLines, leftWidth).slice(-contentHeight);
    const rightContent = this.wrapLines(this.rightLines, rightWidth).slice(-contentHeight);

    this.originalWrite('\x1b[2J\x1b[H');
    this.originalWrite(`${this.pad('Output', leftWidth)}|${this.pad('Agent Process', rightWidth)}\n`);

    for (let row = 0; row < contentHeight; row += 1) {
      this.originalWrite(`${this.pad(leftContent[row] || '', leftWidth)}|${this.pad(rightContent[row] || '', rightWidth)}\n`);
    }

    const promptLabel = this.promptState?.label || '> ';
    const promptBuffer = this.promptState?.buffer || '';
    const status = 'split:on  /split off  /mode status';
    this.originalWrite(`${this.pad(promptLabel + promptBuffer, leftWidth)}|${this.pad(status, rightWidth)}\n`);

    const cursorColumn = Math.min(leftWidth, this.visibleWidth(promptLabel + promptBuffer.slice(0, this.promptState?.cursor || 0))) + 1;
    const cursorRow = totalHeight;
    this.originalWrite(`\x1b[${cursorRow};${cursorColumn}H`);
  }

  private wrapLines(lines: string[], width: number): string[] {
    const wrapped: string[] = [];
    for (const line of lines) {
      if (line.length <= width) {
        wrapped.push(line);
        continue;
      }

      let current = line;
      while (current.length > width) {
        wrapped.push(current.slice(0, width));
        current = current.slice(width);
      }
      wrapped.push(current);
    }
    return wrapped;
  }

  private pad(value: string, width: number): string {
    const visible = this.visibleWidth(value);
    if (visible >= width) {
      return value.slice(0, width);
    }
    return value + ' '.repeat(width - visible);
  }

  private visibleWidth(value: string): number {
    return this.stripAnsi(value).length;
  }

  private stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private formatArgs(args: unknown[]): string {
    if (args.length === 0) {
      return '';
    }

    return args
      .map(arg => {
        if (typeof arg === 'string') {
          return arg;
        }
        return inspect(arg, { depth: 4, colors: false, breakLength: 120 });
      })
      .join(' ');
  }
}