import path from 'path';
import type { DirectActionResult } from '../../direct-action-router.js';
import type { ResolvedIntent } from '../../intent-resolver.js';
import type { DirectActionHandler } from '../request-handler.js';

export interface ObsidianNoteRuntime {
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  normalizePath: (value: string) => string;
  splitExplicitPaths: (input: string) => string[];
  getVaultPath: () => string | null;
}

export class ObsidianNoteHandler implements DirectActionHandler {
  readonly name = 'obsidian-note';

  constructor(private readonly runtime: ObsidianNoteRuntime) {}

  canHandle(input: string, intent?: ResolvedIntent): boolean {
    return intent?.name === 'obsidian.note';
  }

  async handle(input: string, intent?: ResolvedIntent): Promise<DirectActionResult | null> {
    const vaultPath = this.runtime.getVaultPath();
    if (!vaultPath) {
      return {
        handled: true,
        title: '[Obsidian note]',
        output: '未检测到已配置的 Obsidian vault 路径。请先在 config.yaml 的 obsidian MCP 配置中指定 vault 目录。',
        isError: true,
      };
    }

    const action = typeof intent?.slots.action === 'string' ? intent.slots.action : this.detectAction(input);
    if (action === 'search') {
      return this.searchNotes(vaultPath, input);
    }
    if (action === 'list') {
      return this.runtime.executeBuiltInTool('list_directory', { path: vaultPath }, '[Obsidian list_directory]');
    }
    if (action === 'read') {
      return this.readNote(vaultPath, input);
    }
    if (action === 'create' || action === 'write') {
      return this.writeNote(vaultPath, input, false);
    }
    if (action === 'append') {
      return this.writeNote(vaultPath, input, true);
    }
    if (action === 'update') {
      return this.updateNote(vaultPath, input);
    }

    return null;
  }

  private detectAction(input: string): string {
    if (/(追加)/i.test(input)) return 'append';
    if (/(更新|修改)/i.test(input)) return 'update';
    if (/(创建|新建)/i.test(input)) return 'create';
    if (/(写入|保存)/i.test(input)) return 'write';
    if (/(搜索|查找)/i.test(input)) return 'search';
    if (/(列出)/i.test(input)) return 'list';
    return 'read';
  }

  private async searchNotes(vaultPath: string, input: string): Promise<DirectActionResult> {
    const query = this.extractSearchQuery(input);
    if (!query) {
      return {
        handled: true,
        title: '[Obsidian search]',
        output: '缺少搜索关键词。可直接说“搜索 Obsidian 里关于 AI agent 的笔记”。',
        isError: true,
      };
    }

    return this.runtime.executeBuiltInTool('search_files', {
      path: vaultPath,
      pattern: '*.md',
      content: query,
    }, '[Obsidian search_files]');
  }

  private async readNote(vaultPath: string, input: string): Promise<DirectActionResult> {
    const notePath = this.resolveNotePath(vaultPath, input);
    if (!notePath) {
      return {
        handled: true,
        title: '[Obsidian read]',
        output: '缺少要读取的笔记名或路径。可直接说“打开 Obsidian 里的 Daily/2026-04-11.md”。',
        isError: true,
      };
    }

    return this.runtime.executeBuiltInTool('read_file', { path: notePath }, '[Obsidian read_file]');
  }

  private async writeNote(vaultPath: string, input: string, append: boolean): Promise<DirectActionResult> {
    const notePath = this.resolveNotePath(vaultPath, input, !append);
    const content = this.extractContent(input);
    if (!notePath || !content) {
      return {
        handled: true,
        title: append ? '[Obsidian append]' : '[Obsidian write]',
        output: '缺少笔记路径或正文内容。请同时给出文件名/路径和要写入的内容。',
        isError: true,
      };
    }

    if (!append) {
      return this.runtime.executeBuiltInTool('write_file', { path: notePath, content }, '[Obsidian write_file]');
    }

    const readResult = await this.runtime.executeBuiltInTool('read_file', { path: notePath }, '[Obsidian read_before_append]');
    const previous = readResult.isError ? '' : (readResult.output || '');
    const merged = previous.trim().length > 0 ? `${previous.replace(/\s+$/g, '')}\n\n${content}` : content;
    return this.runtime.executeBuiltInTool('write_file', { path: notePath, content: merged }, '[Obsidian append_write]');
  }

  private async updateNote(vaultPath: string, input: string): Promise<DirectActionResult> {
    const notePath = this.resolveNotePath(vaultPath, input);
    const [oldString, newString] = this.extractReplacementPair(input);
    if (!notePath || !oldString || !newString) {
      return {
        handled: true,
        title: '[Obsidian edit]',
        output: '更新笔记时需要给出文件路径，以及要替换的旧文本和新文本。',
        isError: true,
      };
    }

    return this.runtime.executeBuiltInTool('edit_file', {
      path: notePath,
      old_string: oldString,
      new_string: newString,
    }, '[Obsidian edit_file]');
  }

  private extractSearchQuery(input: string): string {
    return input
      .replace(/obsidian|vault|笔记库|笔记|markdown|md文件/gi, ' ')
      .replace(/(?:搜索|查找|列出|打开|读取|查看).{0,8}(?:关于)?/gi, ' ')
      .replace(/(?:最相关的|相关的|只读不要修改|只读|不要修改)/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractContent(input: string): string {
    const patterns = [
      /(?:内容是|内容为|正文是|正文为|追加内容是|写入内容是)\s*[：:]?\s*([\s\S]+)$/i,
      /(?:追加|写入|保存|创建).{0,12}(?:为|成)?\s*["“”']([^"“”']+)["“”']\s*$/i,
    ];

    for (const pattern of patterns) {
      const value = input.match(pattern)?.[1]?.trim();
      if (value) {
        return value;
      }
    }

    return '';
  }

  private extractReplacementPair(input: string): [string, string] {
    const matches = [...input.matchAll(/["“”']([^"“”']+)["“”']/g)].map(match => match[1]?.trim()).filter(Boolean) as string[];
    return [matches[0] || '', matches[1] || ''];
  }

  private resolveNotePath(vaultPath: string, input: string, allowNew = false): string | null {
    const explicitPaths = this.runtime.splitExplicitPaths(input);
    const explicit = explicitPaths[0] ? this.runtime.normalizePath(explicitPaths[0]) : '';
    if (explicit) {
      if (/^[a-z]:[\\/]/i.test(explicit) || explicit.startsWith(vaultPath)) {
        return explicit;
      }
      return path.join(vaultPath, this.ensureMarkdownSuffix(explicit));
    }

    const fileNamePatterns = [
      /(?:文件名|笔记名|页面名|文档名|日报名)[：: ]*["“”']?([^"“”'，。,\n]+)["“”']?/i,
      /(?:打开|读取|查看|追加到|写入到|保存到|创建).{0,8}["“”']([^"“”']+)["“”']/i,
    ];
    for (const pattern of fileNamePatterns) {
      const fileName = input.match(pattern)?.[1]?.trim();
      if (fileName) {
        return path.join(vaultPath, this.ensureMarkdownSuffix(fileName));
      }
    }

    if (!allowNew) {
      return null;
    }

    return path.join(vaultPath, 'untitled.md');
  }

  private ensureMarkdownSuffix(value: string): string {
    const normalized = value.replace(/^['"]|['"]$/g, '').trim();
    return /\.(md|markdown)$/i.test(normalized) ? normalized : `${normalized}.md`;
  }
}
