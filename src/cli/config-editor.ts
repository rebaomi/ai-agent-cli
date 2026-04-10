import { promises as fs } from 'fs';
import * as readline from 'readline';

export interface TerminalConfigEditorResult {
  saved: boolean;
}

export interface TerminalConfigEditorOptions {
  filePath: string;
  title?: string;
}

type EditorMode = 'insert' | 'command';

export class TerminalConfigEditor {
  private readonly filePath: string;
  private readonly title: string;
  private lines: string[] = [''];
  private mode: EditorMode = 'insert';
  private cursorRow = 0;
  private cursorCol = 0;
  private scrollTop = 0;
  private commandBuffer = '';
  private statusMessage = '';
  private dirty = false;
  private saved = false;
  private eol = '\n';
  private hadTrailingNewline = false;
  private keypressBusy = false;

  constructor(options: TerminalConfigEditorOptions) {
    this.filePath = options.filePath;
    this.title = options.title || 'Config Editor';
  }

  async edit(): Promise<TerminalConfigEditorResult> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error('当前终端不支持交互式编辑模式');
    }

    await this.loadFile();

    return new Promise<TerminalConfigEditorResult>((resolve, reject) => {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode?.(true);
      process.stdin.resume();

      const cleanup = (): void => {
        process.stdin.off('keypress', onKeypress);
        process.stdin.setRawMode?.(false);
        process.stdout.write('\x1b[?25h');
        process.stdout.write('\x1b[?1049l');
      };

      const finish = (result: TerminalConfigEditorResult): void => {
        cleanup();
        resolve(result);
      };

      const fail = (error: unknown): void => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const onKeypress = async (input: string, key: readline.Key): Promise<void> => {
        if (this.keypressBusy) {
          return;
        }

        this.keypressBusy = true;
        try {
          if (key.ctrl && key.name === 'c') {
            this.statusMessage = '检测到 Ctrl+C，未保存内容不会自动退出。按 Esc 后使用 /save 或 /q!。';
          } else if (this.mode === 'insert') {
            this.handleInsertKey(input, key);
          } else {
            const commandResult = await this.handleCommandKey(input, key);
            if (commandResult === 'exit') {
              finish({ saved: this.saved });
              return;
            }
          }

          this.render();
        } catch (error) {
          fail(error);
        } finally {
          this.keypressBusy = false;
        }
      };

      process.stdin.on('keypress', onKeypress);
      process.stdout.write('\x1b[?1049h');
      process.stdout.write('\x1b[?25l');
      this.render();
    });
  }

  private async loadFile(): Promise<void> {
    const content = await fs.readFile(this.filePath, 'utf-8');
    this.eol = content.includes('\r\n') ? '\r\n' : '\n';
    this.hadTrailingNewline = /\r?\n$/.test(content);
    const normalized = content.replace(/\r\n/g, '\n');
    this.lines = normalized.length > 0 ? normalized.split('\n') : [''];
    if (this.lines.length === 0) {
      this.lines = [''];
    }
    this.statusMessage = '插入模式：可直接编辑。按 Esc 进入命令模式，输入 /save 保存，/q 退出。';
  }

  private handleInsertKey(input: string, key: readline.Key): void {
    if (key.name === 'escape') {
      this.mode = 'command';
      this.commandBuffer = '';
      this.statusMessage = '命令模式：输入 /save 保存，/q 退出，/q! 强制退出，i 返回编辑。';
      return;
    }

    if (key.name === 'up') {
      this.cursorRow = Math.max(0, this.cursorRow - 1);
      this.cursorCol = Math.min(this.cursorCol, this.currentLine().length);
    } else if (key.name === 'down') {
      this.cursorRow = Math.min(this.lines.length - 1, this.cursorRow + 1);
      this.cursorCol = Math.min(this.cursorCol, this.currentLine().length);
    } else if (key.name === 'left') {
      if (this.cursorCol > 0) {
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = this.currentLine().length;
      }
    } else if (key.name === 'right') {
      if (this.cursorCol < this.currentLine().length) {
        this.cursorCol++;
      } else if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = 0;
      }
    } else if (key.name === 'home') {
      this.cursorCol = 0;
    } else if (key.name === 'end') {
      this.cursorCol = this.currentLine().length;
    } else if (key.name === 'return') {
      const line = this.currentLine();
      const left = line.slice(0, this.cursorCol);
      const right = line.slice(this.cursorCol);
      this.lines[this.cursorRow] = left;
      this.lines.splice(this.cursorRow + 1, 0, right);
      this.cursorRow++;
      this.cursorCol = 0;
      this.dirty = true;
    } else if (key.name === 'backspace') {
      if (this.cursorCol > 0) {
        const line = this.currentLine();
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
        this.cursorCol--;
        this.dirty = true;
      } else if (this.cursorRow > 0) {
        const previousLine = this.lines[this.cursorRow - 1] || '';
        const currentLine = this.currentLine();
        this.lines[this.cursorRow - 1] = previousLine + currentLine;
        this.lines.splice(this.cursorRow, 1);
        this.cursorRow--;
        this.cursorCol = previousLine.length;
        this.dirty = true;
      }
    } else if (key.name === 'delete') {
      const line = this.currentLine();
      if (this.cursorCol < line.length) {
        this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
        this.dirty = true;
      } else if (this.cursorRow < this.lines.length - 1) {
        this.lines[this.cursorRow] = line + (this.lines[this.cursorRow + 1] || '');
        this.lines.splice(this.cursorRow + 1, 1);
        this.dirty = true;
      }
    } else if (key.name === 'tab') {
      this.insertText('  ');
    } else if (!key.ctrl && !key.meta && input) {
      this.insertText(input);
    }

    this.ensureCursorVisible();
  }

  private async handleCommandKey(input: string, key: readline.Key): Promise<'continue' | 'exit'> {
    if (key.name === 'escape') {
      this.mode = 'insert';
      this.commandBuffer = '';
      this.statusMessage = '已返回插入模式。';
      return 'continue';
    }

    if (key.name === 'backspace') {
      this.commandBuffer = this.commandBuffer.slice(0, -1);
      return 'continue';
    }

    if (key.name === 'return') {
      return this.executeCommand(this.commandBuffer.trim());
    }

    if (!key.ctrl && !key.meta && input) {
      if (this.commandBuffer.length === 0 && input === 'i') {
        this.mode = 'insert';
        this.statusMessage = '已返回插入模式。';
        return 'continue';
      }
      this.commandBuffer += input;
    }

    return 'continue';
  }

  private async executeCommand(command: string): Promise<'continue' | 'exit'> {
    if (command.length === 0) {
      this.mode = 'insert';
      this.statusMessage = '已返回插入模式。';
      return 'continue';
    }

    if (command === '/save') {
      await this.saveFile();
      this.commandBuffer = '';
      return 'continue';
    }

    if (command === '/q') {
      if (this.dirty) {
        this.statusMessage = '仍有未保存内容。先用 /save，或使用 /q! 强制退出。';
        this.commandBuffer = '';
        return 'continue';
      }
      return 'exit';
    }

    if (command === '/q!') {
      return 'exit';
    }

    if (command === '/help') {
      this.statusMessage = '命令：/save 保存，/q 退出，/q! 强制退出，i 或 Esc 返回插入模式。';
      this.commandBuffer = '';
      return 'continue';
    }

    this.statusMessage = `未知命令: ${command}`;
    this.commandBuffer = '';
    return 'continue';
  }

  private async saveFile(): Promise<void> {
    const normalizedLines = this.lines.length > 0 ? this.lines : [''];
    const content = normalizedLines.join(this.eol) + (this.hadTrailingNewline ? this.eol : '');
    await fs.writeFile(this.filePath, content, 'utf-8');
    this.dirty = false;
    this.saved = true;
    this.statusMessage = `已保存到 ${this.filePath}`;
  }

  private insertText(value: string): void {
    const line = this.currentLine();
    this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + value + line.slice(this.cursorCol);
    this.cursorCol += value.length;
    this.dirty = true;
  }

  private currentLine(): string {
    return this.lines[this.cursorRow] || '';
  }

  private ensureCursorVisible(): void {
    const viewportHeight = Math.max(5, (process.stdout.rows || 24) - 4);
    if (this.cursorRow < this.scrollTop) {
      this.scrollTop = this.cursorRow;
      return;
    }
    if (this.cursorRow >= this.scrollTop + viewportHeight) {
      this.scrollTop = this.cursorRow - viewportHeight + 1;
    }
  }

  private render(): void {
    const width = process.stdout.columns || 120;
    const height = process.stdout.rows || 30;
    const lineNumberWidth = String(Math.max(this.lines.length, 1)).length;
    const viewportHeight = Math.max(5, height - 4);
    const visibleLines = this.lines.slice(this.scrollTop, this.scrollTop + viewportHeight);
    const dirtyFlag = this.dirty ? ' [+]' : '';
    const modeLabel = this.mode === 'insert' ? 'INSERT' : 'COMMAND';
    const header = `${this.title} ${this.filePath}${dirtyFlag}`;

    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(`${this.padRight(header, width)}\n`);

    for (let index = 0; index < viewportHeight; index++) {
      const line = visibleLines[index];
      if (line === undefined) {
        process.stdout.write(`${this.padRight('~', width)}\n`);
        continue;
      }

      const lineNumber = String(this.scrollTop + index + 1).padStart(lineNumberWidth, ' ');
      const prefix = `${lineNumber} | `;
      const availableWidth = Math.max(0, width - prefix.length);
      process.stdout.write(`${prefix}${this.padRight(line.slice(0, availableWidth), availableWidth)}\n`);
    }

    const status = `[${modeLabel}] ${this.statusMessage}`;
    process.stdout.write(`${this.padRight(status, width)}\n`);

    if (this.mode === 'command') {
      process.stdout.write(this.padRight(`/${this.commandBuffer}`, width));
      const commandColumn = Math.min(width, this.commandBuffer.length + 2);
      process.stdout.write(`\x1b[${height};${commandColumn}H`);
    } else {
      const visibleRow = this.cursorRow - this.scrollTop;
      const prefixWidth = lineNumberWidth + 3;
      const cursorColumn = Math.min(width, prefixWidth + this.cursorCol + 1);
      const cursorRow = Math.min(height - 1, visibleRow + 2);
      process.stdout.write(this.padRight('Esc 命令模式 | /save 保存 | /q 退出 | /q! 强退', width));
      process.stdout.write(`\x1b[${cursorRow};${cursorColumn}H`);
    }
  }

  private padRight(value: string, width: number): string {
    if (value.length >= width) {
      return value.slice(0, width);
    }
    return value + ' '.repeat(width - value.length);
  }
}