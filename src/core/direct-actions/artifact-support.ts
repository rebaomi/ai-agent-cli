import * as path from 'path';
import { promises as fs } from 'fs';
import type { MemoryProvider } from '../memory-provider.js';
import type { Message } from '../../types/index.js';
import { resolveOutputPath, resolveUserPath } from '../../utils/path-resolution.js';
import type { ConvertibleFormat } from './runtime-context.js';

type SourceFormat = ConvertibleFormat | 'csv' | 'tsv';

export interface DirectActionArtifactSupportOptions {
  workspace: string;
  config: Record<string, unknown>;
  getConversationMessages?: () => Message[];
  memoryProvider?: MemoryProvider;
}

export class DirectActionArtifactSupport {
  constructor(private readonly options: DirectActionArtifactSupportOptions) {}

  getLatestAssistantText(): string {
    const messages = this.options.getConversationMessages?.() || [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== 'assistant') {
        continue;
      }
      const content = message.content?.trim();
      if (content && this.isReusableTextContent(content, message.role)) {
        return content;
      }
    }
    return '';
  }

  resolveDirectSourceText(input: string): string {
    const inlineContent = this.extractInlineContent(input);
    if (inlineContent) {
      return inlineContent;
    }

    if (!this.referencesRecentArtifact(input)) {
      return '';
    }

    return this.getLatestAssistantText();
  }

  extractRequestedFileName(input: string): string | null {
    const patterns = [
      /(?:文件名叫做|文件名叫|命名为|叫做|named?|name(?: it)? as)\s*[：: ]*['"“]?([^'"”，,。\n]+?)['"”]?(?:\s|$|，|,|。)/i,
      /(?:文件名|命名为|叫做|叫|named?|name(?: it)? as)\s*[：: ]*['"“]?([^'"”，,。\n]+?)['"”]?(?:\s|$|，|,|。)/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const rawName = match?.[1]?.trim();
      if (rawName) {
        return rawName.replace(/[<>:"/\\|?*]+/g, '-').replace(/\.+$/g, '').trim();
      }
    }

    return null;
  }

  inferTextOutputPath(input: string, fileBaseName: string, extension: '.md' | '.txt'): string {
    const normalizedName = fileBaseName.toLowerCase().endsWith(extension) ? fileBaseName : `${fileBaseName}${extension}`;
    const explicitDestination = this.extractRequestedDestination(input);
    if (explicitDestination) {
      if (this.looksLikeFilePath(explicitDestination) || explicitDestination.toLowerCase().endsWith(extension)) {
        return explicitDestination.toLowerCase().endsWith(extension) ? explicitDestination : `${explicitDestination}${extension}`;
      }
      return path.join(explicitDestination, normalizedName);
    }
    if (/桌面|desktop/i.test(input)) {
      return `桌面/${normalizedName}`;
    }
    return this.resolveOutputArtifactPath(normalizedName);
  }

  inferConversionOutputPath(input: string, fileBaseName: string, format: ConvertibleFormat): string {
    switch (format) {
      case 'docx':
      case 'pdf':
        return this.inferDocumentOutputPath(input, fileBaseName, format);
      case 'md':
        return this.inferTextOutputPath(input, fileBaseName, '.md');
      case 'txt':
        return this.inferTextOutputPath(input, fileBaseName, '.txt');
      case 'xlsx': {
        const normalizedName = fileBaseName.toLowerCase().endsWith('.xlsx') ? fileBaseName : `${fileBaseName}.xlsx`;
        const explicitDestination = this.extractRequestedDestination(input);
        if (explicitDestination) {
          if (this.looksLikeFilePath(explicitDestination) || explicitDestination.toLowerCase().endsWith('.xlsx')) {
            return explicitDestination.toLowerCase().endsWith('.xlsx') ? explicitDestination : `${explicitDestination}.xlsx`;
          }
          return path.join(explicitDestination, normalizedName);
        }
        if (/桌面|desktop/i.test(input)) {
          return `桌面/${normalizedName}`;
        }
        return normalizedName;
      }
      case 'pptx': {
        const normalizedName = /\.pptx?$/i.test(fileBaseName) ? fileBaseName.replace(/\.ppt$/i, '.pptx') : `${fileBaseName}.pptx`;
        const explicitDestination = this.extractRequestedDestination(input);
        if (explicitDestination) {
          if (this.looksLikeFilePath(explicitDestination) || /\.pptx?$/i.test(explicitDestination)) {
            return /\.pptx?$/i.test(explicitDestination) ? explicitDestination.replace(/\.ppt$/i, '.pptx') : `${explicitDestination}.pptx`;
          }
          return path.join(explicitDestination, normalizedName);
        }
        if (/桌面|desktop/i.test(input)) {
          return `桌面/${normalizedName}`;
        }
        return normalizedName;
      }
    }
  }

  extractInlineContent(input: string): string {
    const patterns = [
      /(?:内容是|内容为|正文是|正文为|文本是|文本为)\s*[：:]?\s*([\s\S]+)$/i,
      /(?:content is|content:|text:)\s*([\s\S]+)$/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const value = match?.[1]?.trim();
      if (value) {
        return value.replace(/^['"“”]|['"“”]$/g, '').trim();
      }
    }

    return '';
  }

  resolveOutputArtifactPath(outputPath: string): string {
    if (/^(Desktop|桌面)([\\/]|$)/i.test(outputPath) || outputPath === 'Desktop' || outputPath === '桌面') {
      return resolveUserPath(outputPath, { workspace: this.options.workspace });
    }

    return resolveOutputPath(outputPath, {
      workspace: this.options.workspace,
      appBaseDir: typeof this.options.config.appBaseDir === 'string' ? this.options.config.appBaseDir : undefined,
      artifactOutputDir: typeof this.options.config.artifactOutputDir === 'string' ? this.options.config.artifactOutputDir : undefined,
      documentOutputDir: typeof this.options.config.documentOutputDir === 'string' ? this.options.config.documentOutputDir : undefined,
    });
  }

  async findConvertibleSourceFilePath(input: string, targetFormat: ConvertibleFormat): Promise<string> {
    const paths = this.extractPathsFromInput(input);
    const explicitCandidate = paths.find(item => /\.(md|markdown|txt|csv|tsv|docx|pdf|xlsx|ppt|pptx)$/i.test(item));
    if (explicitCandidate) {
      return explicitCandidate;
    }

    if (!this.referencesRecentFileArtifact(input)) {
      return '';
    }

    const preferredExtensions = this.getPreferredRecentSourceExtensions(input, targetFormat);
    const conversationCandidate = await this.findRecentArtifactPathFromMessages(preferredExtensions);
    if (conversationCandidate) {
      return conversationCandidate;
    }

    return this.findRecentArtifactPathFromMemory(input, preferredExtensions);
  }

  referencesRecentArtifact(input: string): boolean {
    return /(这个|这个文件|该文件|该csv|该表格|刚刚|刚才|上一步|上一份|上一个|上面|上面的|上一条|前面那个|前面生成的|最近生成的|刚生成的|那个文件|那个csv)/i.test(input);
  }

  private referencesRecentFileArtifact(input: string): boolean {
    if (!this.referencesRecentArtifact(input)) {
      return false;
    }

    return /(?:这个|该|那个|上一个|上一份|上面的|前面那个|前面生成的|最近生成的|刚生成的|刚才那个|刚刚那个)\s*(?:文件|附件|报告|文档|表格|csv|tsv|markdown|md|txt|pdf|docx|xlsx|excel|pptx|ppt|powerpoint|幻灯片|演示文稿)/i.test(input)
      || /(?:文件|附件|报告|文档|表格|csv|tsv|markdown|md|txt|pdf|docx|xlsx|excel|pptx|ppt|powerpoint|幻灯片|演示文稿)\s*(?:转成|转换成|导出为|导出成|保存成|输出为|输出成|另存为)/i.test(input);
  }

  async rememberSuccessfulToolResult(name: string, args: Record<string, unknown>): Promise<void> {
    if (!this.options.memoryProvider) {
      return;
    }

    const remembered = this.extractOutputArtifact(name, args);
    if (!remembered) {
      return;
    }

    const { path: artifactPath, label, extension } = remembered;
    await this.options.memoryProvider.store({
      kind: 'project',
      key: 'last_output_file',
      title: 'last_output_file',
      content: `${label}: ${artifactPath}`,
      metadata: { path: artifactPath, toolName: name, extension },
    });

    if (extension) {
      await this.options.memoryProvider.store({
        kind: 'project',
        key: `last_${extension}_output_file`,
        title: `last_${extension}_output_file`,
        content: `${label}: ${artifactPath}`,
        metadata: { path: artifactPath, toolName: name, extension },
      });
    }
  }

  private inferDocumentOutputPath(input: string, fileBaseName: string, format: 'docx' | 'pdf'): string {
    const suffix = format === 'docx' ? '.docx' : '.pdf';
    const normalizedName = fileBaseName.toLowerCase().endsWith(suffix) ? fileBaseName : `${fileBaseName}${suffix}`;
    const explicitDestination = this.extractRequestedDestination(input);
    if (explicitDestination) {
      if (this.looksLikeFilePath(explicitDestination) || explicitDestination.toLowerCase().endsWith(suffix)) {
        return explicitDestination.toLowerCase().endsWith(suffix) ? explicitDestination : `${explicitDestination}${suffix}`;
      }
      return path.join(explicitDestination, normalizedName);
    }
    if (/桌面|desktop/i.test(input)) {
      return `桌面/${normalizedName}`;
    }
    return normalizedName;
  }

  private isReusableTextContent(content: string, role: Message['role']): boolean {
    const normalized = content.trim();
    if (!normalized) {
      return false;
    }

    if (/^Using tool\.\.\.$/i.test(normalized)) {
      return false;
    }

    if (/^##\s*[✅❌⚠].*任务(?:完成|失败)/.test(normalized) || /\*\*原始任务\*\*/.test(normalized) || /\*\*完成进度\*\*/.test(normalized)) {
      return false;
    }

    if (/^\[步骤\s*\d+\]/.test(normalized)) {
      return false;
    }

    if (/^\[(?:write_file|read_file|read_multiple_files|search_files|glob|copy_file|move_file|txt_to_docx|txt_to_pdf|txt_to_xlsx|txt_to_pptx|docx_create_from_text|pdf_create_from_text|xlsx_create_from_text|pptx_create_from_text|execute_command)\]/i.test(normalized)) {
      return false;
    }

    if (/^(?:File written successfully:|Created report document:|Created PDF document:|Created spreadsheet document:|Created presentation document:|Permission denied:|Tool call rejected by intent contract:|Error:)/i.test(normalized)) {
      return false;
    }

    if (role === 'assistant' && /^我需要先.+?(?:规划|查看|读取|分析)/.test(normalized)) {
      return false;
    }

    return true;
  }

  private normalizePath(rawPath: string): string {
    return rawPath.replace(/^['"]|['"]$/g, '');
  }

  private extractRequestedDestination(input: string): string {
    const patterns = [
      /(?:存进|保存到|保存进|输出到|放到|放进|写入到|写进|存到)\s*['"“”]?([^'"“”\n]+?)['"“”]?(?:文件夹|目录)?(?:内|里)?(?:$|，|,|。)/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const raw = match?.[1]?.trim();
      if (raw) {
        const normalized = this.normalizePath(raw);
        if (this.isConfiguredOutputDirAlias(normalized)) {
          return '';
        }
        return normalized;
      }
    }

    return '';
  }

  private isConfiguredOutputDirAlias(value: string): boolean {
    const normalized = value
      .replace(/[“”"']/g, '')
      .replace(/[\s_/\\-]+/g, '')
      .toLowerCase();

    return [
      '配置文件指定', '配置文件指定目录', '配置文件指定的目录', '配置文件指定输出目录', '配置文件指定的输出目录',
      '配置里指定目录', '配置里指定输出目录', '配置中指定目录', '配置中指定输出目录', '配置指定目录', '配置指定输出目录',
      '配置的输出目录', '默认输出目录', '当前输出目录', 'artifact输出目录', 'artifact目录', '输出目录', '当前目录', '项目目录', '工程目录', '工作区', 'workspace',
    ].includes(normalized);
  }

  private looksLikeFilePath(value: string): boolean {
    return /\.[a-z0-9]{1,8}$/i.test(value);
  }

  private extractPathsFromInput(input: string): string[] {
    const matches = input.match(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|csv|tsv|docx|pdf|xlsx|ppt|pptx))/gi);
    return matches?.map(item => this.normalizePath(item.trim())) || [];
  }

  private getPreferredRecentSourceExtensions(input: string, targetFormat: ConvertibleFormat): string[] {
    const preferred: string[] = [];
    const push = (extension: string) => {
      if (!preferred.includes(extension)) {
        preferred.push(extension);
      }
    };

    if (/csv/i.test(input)) push('.csv');
    if (/tsv/i.test(input)) push('.tsv');
    if (/xlsx|excel/i.test(input)) push('.xlsx');
    if (/pptx|ppt|powerpoint|幻灯片|演示文稿/i.test(input)) { push('.pptx'); push('.ppt'); }
    if (/pdf/i.test(input)) push('.pdf');
    if (/docx|word/i.test(input)) push('.docx');
    if (/markdown|\bmd\b/i.test(input)) push('.md');
    if (/txt|文本/i.test(input)) push('.txt');

    if (targetFormat === 'xlsx') {
      ['.csv', '.tsv', '.xlsx', '.txt', '.md', '.markdown'].forEach(push);
    } else if (targetFormat === 'pptx') {
      ['.txt', '.md', '.markdown', '.csv', '.tsv', '.docx', '.pdf'].forEach(push);
    } else {
      ['.txt', '.md', '.markdown', '.csv', '.tsv', '.docx', '.pdf', '.xlsx', '.pptx', '.ppt'].forEach(push);
    }

    return preferred;
  }

  private async findRecentArtifactPathFromMessages(preferredExtensions: string[]): Promise<string> {
    const messages = this.options.getConversationMessages?.() || [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const paths = this.extractPathsFromInput(message?.content || '');
      for (let pathIndex = paths.length - 1; pathIndex >= 0; pathIndex -= 1) {
        const candidatePath = paths[pathIndex];
        if (!candidatePath) {
          continue;
        }
        const candidate = await this.resolveExistingCandidate(candidatePath, preferredExtensions);
        if (candidate) {
          return candidate;
        }
      }
    }

    return '';
  }

  private async findRecentArtifactPathFromMemory(input: string, preferredExtensions: string[]): Promise<string> {
    if (!this.options.memoryProvider) {
      return '';
    }

    const queries = Array.from(new Set([
      input,
      'last_output_file',
      ...preferredExtensions.map(extension => `last_${extension.replace(/^\./, '')}_output_file`),
    ]));

    for (const query of queries) {
      const results = await this.options.memoryProvider.recall(query, 8);
      for (const result of results) {
        const candidates: string[] = [];
        const metadataPath = result.metadata?.path;
        if (typeof metadataPath === 'string' && metadataPath.trim()) {
          candidates.push(metadataPath.trim());
        }
        candidates.push(...this.extractPathsFromInput(result.content));

        for (const candidatePath of candidates) {
          const candidate = await this.resolveExistingCandidate(candidatePath, preferredExtensions);
          if (candidate) {
            return candidate;
          }
        }
      }
    }

    return '';
  }

  private async resolveExistingCandidate(candidatePath: string, preferredExtensions: string[]): Promise<string> {
    const normalizedCandidate = this.normalizePath(candidatePath);
    const extension = path.extname(normalizedCandidate).toLowerCase();
    if (preferredExtensions.length > 0 && !preferredExtensions.includes(extension)) {
      return '';
    }

    const resolvedPath = this.resolveOutputArtifactPath(normalizedCandidate);
    try {
      await fs.access(resolvedPath);
      return resolvedPath;
    } catch {
      return '';
    }
  }

  private extractOutputArtifact(name: string, args: Record<string, unknown>): { path: string; label: string; extension?: string } | null {
    const outputValue = this.getArtifactArgValue(name, args);
    if (typeof outputValue !== 'string' || !outputValue.trim()) {
      return null;
    }

    const resolvedPath = this.resolveOutputArtifactPath(outputValue);
    const extension = path.extname(resolvedPath).replace(/^\./, '').toLowerCase() || undefined;
    const title = typeof args.title === 'string' && args.title.trim()
      ? args.title.trim()
      : path.basename(resolvedPath, path.extname(resolvedPath)) || '最近生成文件';

    return {
      path: resolvedPath,
      label: title,
      extension,
    };
  }

  private getArtifactArgValue(name: string, args: Record<string, unknown>): unknown {
    if (/^(write_file)$/i.test(name)) {
      return args.path;
    }

    if (/^(copy_file|move_file)$/i.test(name)) {
      return args.destination;
    }

    if (/docx_create_from_text|xlsx_create_from_text|pptx_create_from_text|txt_to_docx|txt_to_xlsx|txt_to_pptx/i.test(name)) {
      return args.output;
    }

    if (/pdf_create_from_text|txt_to_pdf/i.test(name)) {
      return args.out;
    }

    return null;
  }
}