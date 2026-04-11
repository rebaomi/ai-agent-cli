import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { FileActionRuntime } from '../runtime-context.js';

const OPENABLE_DOCUMENT_PATTERN = /\.(?:doc|docx|xls|xlsx|ppt|pptx|pdf|csv|tsv|txt|md)$/i;

export class FileActionHandler implements DirectActionHandler {
  readonly name = 'file-action';

  constructor(private readonly runtime: FileActionRuntime) {}

  canHandle(input: string): boolean {
    return /读取|查看文件|打开文件|列出目录|列出文件|查看目录|搜索|查找|grep|find|保存成markdown|保存成txt|保存为markdown|保存为txt|read_file|list_directory/i.test(input)
      || (/^(?:请)?(?:帮我)?打开\s+.+/i.test(input) && OPENABLE_DOCUMENT_PATTERN.test(input));
  }

  async handle(input: string): Promise<DirectActionResult | null> {
    const builtInResult = await this.tryBuiltInFileAction(input);
    if (builtInResult) {
      return builtInResult;
    }

    return this.tryTextFileSaveAction(input);
  }

  private async tryTextFileSaveAction(input: string): Promise<DirectActionResult | null> {
    const format = this.runtime.detectTextFormat(input);
    if (!format) {
      return null;
    }

    const content = this.runtime.resolveDirectSourceText(input);
    if (!content) {
      return null;
    }

    const extension = format === 'markdown' ? '.md' : '.txt';
    const fileBaseName = this.runtime.extractRequestedFileName(input) || (format === 'markdown' ? 'notes' : 'output');
    const outputPath = this.runtime.inferTextOutputPath(input, fileBaseName, extension);

    return this.runtime.executeBuiltInTool('write_file', {
      path: outputPath,
      content,
    }, '[Direct file save]');
  }

  private async tryBuiltInFileAction(input: string): Promise<DirectActionResult | null> {
    const openPatterns = [
      /^(?:打开文件|打开文档|打开表格|打开word|打开excel|打开ppt|打开pdf|打开)\s+(.+)$/i,
      /^(?:请)?(?:帮我)?打开\s+(.+)$/i,
    ];
    const readPatterns = [
      /^(?:read_file|读取文件|读取|查看文件|查看|打开文件|打开)\s+(.+)$/i,
      /^(?:请)?(?:帮我)?(?:读取|查看|打开)\s+(.+)$/i,
    ];
    const listPatterns = [
      /^(?:list_directory|列出目录|列出文件|查看目录)\s+(.+)$/i,
      /^(?:请)?(?:帮我)?列出\s+(.+?)\s*(?:目录|文件夹)?$/i,
    ];
    const searchPatterns = [
      /^(?:在|于)\s+(.+?)\s*(?:中|里|下)\s*(?:搜索|查找|grep|find)\s+(.+)$/i,
      /^(?:搜索|查找|grep|find)\s+(.+?)\s+(?:在|于|inside|under)\s+(.+)$/i,
    ];
    const filePatternSearchPatterns = [
      /^(?:查找|搜索|列出|寻找)(?:所有|全部)?\s+([a-z0-9]+|\*\.[a-z0-9]+)\s*文件(?:\s+(?:在|于)\s+(.+))?$/i,
    ];

    for (const pattern of openPatterns) {
      const match = input.match(pattern);
      const rawTarget = match?.[1]?.trim();
      if (!rawTarget) {
        continue;
      }

      const explicitPaths = this.runtime.splitExplicitPaths(rawTarget);
      const candidate = this.runtime.normalizePath(explicitPaths[0] || rawTarget);
      if (OPENABLE_DOCUMENT_PATTERN.test(candidate)) {
        return this.runtime.executeBuiltInTool('open_path', {
          path: candidate,
          background: false,
        }, '[Direct open_path]');
      }
    }

    for (const pattern of readPatterns) {
      const match = input.match(pattern);
      const rawTarget = match?.[1]?.trim();
      if (rawTarget) {
        const paths = this.runtime.splitExplicitPaths(rawTarget);
        if (paths.length > 1) {
          return this.runtime.executeBuiltInTool('read_multiple_files', { paths: paths.map(path => this.runtime.normalizePath(path)) }, '[Direct read_multiple_files]');
        }

        return this.runtime.executeBuiltInTool('read_file', { path: this.runtime.normalizePath(paths[0] || rawTarget) }, '[Direct read_file]');
      }
    }

    for (const pattern of listPatterns) {
      const match = input.match(pattern);
      const dirPath = this.runtime.stripDirectorySuffix(match?.[1]?.trim() || '');
      if (dirPath) {
        return this.runtime.executeBuiltInTool('list_directory', { path: this.runtime.normalizePath(dirPath) }, '[Direct list_directory]');
      }
    }

    for (const pattern of searchPatterns) {
      const match = input.match(pattern);
      const rawPath = this.runtime.stripDirectorySuffix(match?.[1]?.trim() || '');
      const rawQuery = match?.[2]?.trim();
      const query = this.runtime.normalizeSearchQuery(rawQuery || '');
      if (rawPath && query) {
        return this.runtime.executeBuiltInTool('search_files', {
          path: this.runtime.normalizePath(rawPath),
          content: query,
        }, '[Direct search_files]');
      }
    }

    for (const pattern of filePatternSearchPatterns) {
      const match = input.match(pattern);
      const rawPattern = match?.[1]?.trim();
      const rawPath = this.runtime.stripDirectorySuffix(match?.[2]?.trim() || '$WORKSPACE');
      const globPattern = this.runtime.normalizeGlobPattern(rawPattern || '');
      if (globPattern) {
        return this.runtime.executeBuiltInTool('glob', {
          pattern: globPattern,
          cwd: rawPath === '$WORKSPACE' ? this.runtime.workspace : this.runtime.normalizePath(rawPath),
        }, '[Direct glob]');
      }
    }

    return null;
  }
}