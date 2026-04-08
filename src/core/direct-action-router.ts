import * as path from 'path';
import { promises as fs } from 'fs';
import { BuiltInTools } from '../tools/builtin.js';
import { SkillManager, SkillContext, SkillToolResult } from './skills.js';
import { PermissionManager } from './permission-manager.js';
import { extractResource, getToolPermission } from './tool-permissions.js';
import type { Message } from '../types/index.js';
import { resolveOutputPath, resolveUserPath } from '../utils/path-resolution.js';
import { detectRequestedExportFormat, selectPreferredExportTool } from './export-intent.js';

type ConvertibleFormat = 'md' | 'txt' | 'docx' | 'pdf' | 'xlsx' | 'pptx';

export interface DirectActionResult {
  handled: boolean;
  title?: string;
  output?: string;
  isError?: boolean;
}

export interface DirectActionRouterOptions {
  builtInTools: BuiltInTools;
  skillManager: SkillManager;
  permissionManager: PermissionManager;
  workspace: string;
  config?: unknown;
  getConversationMessages?: () => Message[];
}

export class DirectActionRouter {
  private builtInTools: BuiltInTools;
  private skillManager: SkillManager;
  private permissionManager: PermissionManager;
  private workspace: string;
  private config: Record<string, unknown>;
  private getConversationMessages?: () => Message[];

  constructor(options: DirectActionRouterOptions) {
    this.builtInTools = options.builtInTools;
    this.skillManager = options.skillManager;
    this.permissionManager = options.permissionManager;
    this.workspace = options.workspace;
    this.config = (options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : {});
    this.getConversationMessages = options.getConversationMessages;
  }

  async tryHandle(input: string): Promise<DirectActionResult | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const builtInResult = await this.tryBuiltInFileAction(trimmed);
    if (builtInResult) return builtInResult;

    const conversionResult = await this.tryDocumentConversionAction(trimmed);
    if (conversionResult) return conversionResult;

    const directToolResult = await this.tryExplicitToolCall(trimmed);
    if (directToolResult) return directToolResult;

    const skillCommandResult = await this.trySkillCommand(trimmed);
    if (skillCommandResult) return skillCommandResult;

    const hookResult = await this.trySkillMessageHooks(trimmed);
    if (hookResult) return hookResult;

    return null;
  }

  private async tryDocumentConversionAction(input: string): Promise<DirectActionResult | null> {
    const targetFormat = this.detectConvertibleFormat(input);
    if (!targetFormat) {
      return null;
    }

    const sourcePath = this.findConvertibleSourceFilePath(input);
    if (sourcePath) {
      return this.convertSourceFile(input, sourcePath, targetFormat);
    }

    const sourceText = this.extractInlineContent(input) || this.getLatestAssistantText();
    if (!sourceText) {
      return {
        handled: true,
        title: '[Direct document conversion]',
        output: '未找到可转换的源内容。请先提供源文件、内联内容，或先让 agent 生成文本。',
        isError: true,
      };
    }

    const fileBaseName = this.extractRequestedFileName(input) || 'exported-document';
    return this.convertTextContent(input, sourceText, fileBaseName, targetFormat);
  }

  private async tryDocumentSaveAction(input: string): Promise<DirectActionResult | null> {
    const format = this.detectDocumentFormat(input);
    if (!format) {
      return null;
    }

    const sourceText = this.extractInlineContent(input) || this.getLatestAssistantText();
    if (!sourceText) {
      return {
        handled: true,
        title: '[Direct document export]',
        output: '未找到可导出的最近回复内容。请先让 agent 生成内容，或在本轮消息里明确提供文本。',
        isError: true,
      };
    }

    const toolName = this.resolveDocumentExportTool(format);
    if (!toolName) {
      return {
        handled: true,
        title: '[Direct document export]',
        output: `未找到可用的 ${format === 'docx' ? 'Word' : 'PDF'} 导出工具。`,
        isError: true,
      };
    };

    const fileBaseName = this.extractRequestedFileName(input) || 'exported-document';
    const outputPath = this.inferDocumentOutputPath(input, fileBaseName, format);
    const title = fileBaseName.replace(/[-_]+/g, ' ').trim() || 'exported document';

    const args = toolName === 'txt_to_pdf' || toolName === 'minimax_pdf_text_to_pdf'
      ? { out: outputPath, text: sourceText, title }
      : { output: outputPath, text: sourceText, title };

    const result = await this.executeSkillTool(toolName, args, '[Direct document export]');

    if (this.isUnavailableDocxSkillResult(format, result.output || '')) {
      return this.buildKnownGapResult(
        input,
        result.output || '无可用 docx skill。',
        ['可先降级导出为 PDF、Markdown 或 TXT。', '如果要继续使用 DOCX，请先安装可用的 .NET SDK 后再试。'],
      );
    }

    return this.verifyDocumentExportResult(result, outputPath, format);
  }

  private async trySourceFileDocumentExport(input: string): Promise<DirectActionResult | null> {
    const format = this.detectDocumentFormat(input);
    if (!format) {
      return null;
    }

    const sourcePath = this.findReadableSourceFilePath(input);
    if (!sourcePath) {
      return null;
    }

    const readResult = await this.executeBuiltInTool('read_file', { path: sourcePath }, '[Direct source read]');
    if (readResult.isError || !readResult.output) {
      return {
        handled: true,
        title: '[Direct document export]',
        output: readResult.output || '读取源文件失败，无法导出文档。',
        isError: true,
      };
    }

    const toolName = this.resolveDocumentExportTool(format);
    if (!toolName) {
      return {
        handled: true,
        title: '[Direct document export]',
        output: `未找到可用的 ${format === 'docx' ? 'Word' : 'PDF'} 导出工具。`,
        isError: true,
      };
    }

    const defaultBaseName = path.basename(sourcePath, path.extname(sourcePath));
    const fileBaseName = this.extractRequestedFileName(input) || defaultBaseName;
    const outputPath = this.inferDocumentOutputPath(input, fileBaseName, format);
    const title = fileBaseName.replace(/[-_]+/g, ' ').trim() || 'exported document';

    const args = toolName === 'txt_to_pdf' || toolName === 'minimax_pdf_text_to_pdf'
      ? { out: outputPath, text: readResult.output, title }
      : { output: outputPath, text: readResult.output, title };

    const result = await this.executeSkillTool(toolName, args, '[Direct document export]');

    if (this.isUnavailableDocxSkillResult(format, result.output || '')) {
      return this.buildKnownGapResult(
        input,
        result.output || '无可用 docx skill。',
        ['可先降级导出为 PDF、Markdown 或 TXT。', '如果要继续使用 DOCX，请先安装可用的 .NET SDK 后再试。'],
      );
    }

    return this.verifyDocumentExportResult(result, outputPath, format);
  }

  private async tryTextFileSaveAction(input: string): Promise<DirectActionResult | null> {
    const format = this.detectTextFormat(input);
    if (!format) {
      return null;
    }

    const content = this.extractInlineContent(input) || this.getLatestAssistantText();
    if (!content) {
      return {
        handled: true,
        title: '[Direct file save]',
        output: '未找到可保存的文本内容。请先让 agent 生成内容，或在本轮消息里明确提供“内容是 …”。',
        isError: true,
      };
    }

    const extension = format === 'markdown' ? '.md' : '.txt';
    const fileBaseName = this.extractRequestedFileName(input) || (format === 'markdown' ? 'notes' : 'output');
    const outputPath = this.inferTextOutputPath(input, fileBaseName, extension);

    return this.executeBuiltInTool('write_file', {
      path: outputPath,
      content,
    }, '[Direct file save]');
  }

  private async trySkillMessageHooks(input: string): Promise<DirectActionResult | null> {
    const ctx = this.createSkillContext();

    for (const skill of this.skillManager.getEnabledSkills()) {
      const result = await skill.hooks?.onMessage?.(input, ctx);
      if (result) {
        return {
          handled: true,
          title: `[Skill:${skill.name}]`,
          output: result,
        };
      }
    }

    return null;
  }

  private async tryBuiltInFileAction(input: string): Promise<DirectActionResult | null> {
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

    for (const pattern of readPatterns) {
      const match = input.match(pattern);
      const rawTarget = match?.[1]?.trim();
      if (rawTarget) {
        const paths = this.splitExplicitPaths(rawTarget);
        if (paths.length > 1) {
          return this.executeBuiltInTool('read_multiple_files', { paths: paths.map(path => this.normalizePath(path)) }, '[Direct read_multiple_files]');
        }

        return this.executeBuiltInTool('read_file', { path: this.normalizePath(paths[0] || rawTarget) }, '[Direct read_file]');
      }
    }

    for (const pattern of listPatterns) {
      const match = input.match(pattern);
      const dirPath = this.stripDirectorySuffix(match?.[1]?.trim() || '');
      if (dirPath) {
        return this.executeBuiltInTool('list_directory', { path: this.normalizePath(dirPath) }, '[Direct list_directory]');
      }
    }

    for (const pattern of searchPatterns) {
      const match = input.match(pattern);
      const rawPath = this.stripDirectorySuffix(match?.[1]?.trim() || '');
      const rawQuery = match?.[2]?.trim();
      const query = this.normalizeSearchQuery(rawQuery || '');
      if (rawPath && query) {
        return this.executeBuiltInTool('search_files', {
          path: this.normalizePath(rawPath),
          content: query,
        }, '[Direct search_files]');
      }
    }

    for (const pattern of filePatternSearchPatterns) {
      const match = input.match(pattern);
      const rawPattern = match?.[1]?.trim();
      const rawPath = this.stripDirectorySuffix(match?.[2]?.trim() || '$WORKSPACE');
      const globPattern = this.normalizeGlobPattern(rawPattern || '');
      if (globPattern) {
        return this.executeBuiltInTool('glob', {
          pattern: globPattern,
          cwd: rawPath === '$WORKSPACE' ? this.workspace : this.normalizePath(rawPath),
        }, '[Direct glob]');
      }
    }

    return null;
  }

  private async trySkillCommand(input: string): Promise<DirectActionResult | null> {
    const [commandName, ...args] = input.split(/\s+/);
    if (!commandName) return null;

    const skillCommand = this.skillManager.getCommands().find(command => command.name === commandName);
    if (!skillCommand) return null;

    const granted = await this.permissionManager.requestPermission(
      'tool_execute',
      `skill_command:${commandName}`,
      `Execute skill command: ${commandName}`,
    );
    if (!granted) {
      return {
        handled: true,
        title: `[Skill:${skillCommand.skill}]`,
        output: `Permission denied: skill command ${commandName}`,
        isError: true,
      };
    }

    const output = await this.skillManager.executeCommand(commandName, args, this.createSkillContext());
    return {
      handled: true,
      title: `[Skill:${skillCommand.skill}]`,
      output,
    };
  }

  private async tryExplicitToolCall(input: string): Promise<DirectActionResult | null> {
    const match = input.match(/^@tool\s+(\S+)\s*(.*)$/i);
    if (!match) return null;

    const toolName = match[1];
    const rawArgs = match[2]?.trim() || '{}';
    if (!toolName) return null;

    let args: Record<string, unknown>;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return {
        handled: true,
        title: '[Direct tool]',
        output: 'Invalid JSON arguments for @tool call',
        isError: true,
      };
    }

    const builtInNames = new Set(this.builtInTools.getTools().map(tool => tool.name));
    if (builtInNames.has(toolName)) {
      return this.executeBuiltInTool(toolName, args, `[Direct ${toolName}]`);
    }

    const skillTool = this.skillManager.getTools().find(tool => tool.name === toolName);
    if (skillTool) {
      return this.executeSkillTool(toolName, args, `[Skill:${skillTool.skill}]`);
    }

    return {
      handled: true,
      title: '[Direct tool]',
      output: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  private async executeBuiltInTool(name: string, args: Record<string, unknown>, title: string): Promise<DirectActionResult> {
    const permission = getToolPermission(name);
    if (permission) {
      const resource = extractResource(name, args) || permission.resourceExtractor?.(args);
      const granted = await this.permissionManager.requestPermission(
        permission.permissionType,
        resource,
        `${name}${resource ? ` on ${resource}` : ''}`,
      );
      if (!granted) {
        return {
          handled: true,
          title,
          output: `Permission denied: ${permission.permissionType}${resource ? ` (${resource})` : ''}`,
          isError: true,
        };
      }
    }

    const result = await this.builtInTools.executeTool(name, args);
    return {
      handled: true,
      title,
      output: result.output || this.skillToolResultToText({ content: result.content?.filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text || '' })) || [] }),
      isError: result.is_error,
    };
  }

  private async executeSkillTool(name: string, args: Record<string, unknown>, title: string): Promise<DirectActionResult> {
    const skillTool = this.skillManager.getTools().find(tool => tool.name === name);
    if (!skillTool) {
      return {
        handled: true,
        title,
        output: `Unknown skill tool: ${name}`,
        isError: true,
      };
    }

    const granted = await this.permissionManager.requestPermission(
      'tool_execute',
      `skill_tool:${name}`,
      `Execute skill tool: ${name}`,
    );
    if (!granted) {
      return {
        handled: true,
        title,
        output: `Permission denied: skill tool ${name}`,
        isError: true,
      };
    }

    let result: SkillToolResult;
    try {
      result = await this.skillManager.executeTool(name, args, this.createSkillContext());
    } catch (error) {
      return {
        handled: true,
        title,
        output: this.normalizeSkillExecutionError(name, error),
        isError: true,
      };
    }

    return {
      handled: true,
      title,
      output: this.skillToolResultToText(result),
      isError: result.isError,
    };
  }

  private createSkillContext(): SkillContext {
    return {
      workspace: this.workspace,
      config: this.config,
      skillsDir: this.skillManager.getSkillsDir(),
    };
  }

  private skillToolResultToText(result: SkillToolResult): string {
    return result.content.map(item => item.text).join('\n');
  }

  private detectConvertibleFormat(input: string): ConvertibleFormat | null {
    const detected = detectRequestedExportFormat(input, ['docx', 'pdf', 'xlsx', 'md', 'txt', 'pptx']);
    if (detected) {
      return detected;
    }

    if (/(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成).*(?:pptx|ppt|powerpoint|幻灯片|演示文稿)/i.test(input)) {
      return 'pptx';
    }

    return null;
  }

  private detectDocumentFormat(input: string): 'docx' | 'pdf' | null {
    const format = detectRequestedExportFormat(input, ['docx', 'pdf']);
    return format === 'docx' || format === 'pdf' ? format : null;
  }

  private detectTextFormat(input: string): 'markdown' | 'text' | null {
    const wantsSave = /(保存|写入|导出|生成|输出|存成|save|export|write)/i.test(input);
    if (!wantsSave) {
      return null;
    }

    if (/(markdown|md|markdown文档)/i.test(input)) {
      return 'markdown';
    }

    if (/(txt|文本|text file|text document)/i.test(input)) {
      return 'text';
    }

    return null;
  }

  private async convertSourceFile(input: string, sourcePath: string, targetFormat: ConvertibleFormat): Promise<DirectActionResult> {
    const sourceFormat = this.detectFormatFromPath(sourcePath);
    const fileBaseName = this.extractRequestedFileName(input) || path.basename(sourcePath, path.extname(sourcePath));

    if (!sourceFormat) {
      return {
        handled: true,
        title: '[Direct document conversion]',
        output: `暂不支持识别源文件格式: ${sourcePath}`,
        isError: true,
      };
    }

    if (sourceFormat === targetFormat) {
      const outputPath = this.inferConversionOutputPath(input, fileBaseName, targetFormat);
      return this.executeBuiltInTool('copy_file', {
        source: sourcePath,
        destination: outputPath,
      }, '[Direct document copy]');
    }

    if (targetFormat === 'xlsx') {
      return this.buildKnownGapResult(
        input,
        `当前没有可用的 ${sourceFormat.toUpperCase()} 到 XLSX 转换工具。`,
        ['可以先导出为 .md、.txt、.docx 或 .pdf。', '如果后续补了表格导出 skill，可再把这条 todo 转成 candidate 实现。'],
      );
    }

    if (targetFormat === 'pptx') {
      return this.buildKnownGapResult(
        input,
        `当前没有可用的 ${sourceFormat.toUpperCase()} 到 PPT/PPTX 转换工具。`,
        ['可以先生成 PPT 大纲、逐页标题与讲稿，再手动导入 PowerPoint。', '也可以先导出为 .pdf 或 .docx 后再手动转换为 PPT。'],
      );
    }

    if (sourceFormat === 'md' || sourceFormat === 'txt') {
      const readResult = await this.executeBuiltInTool('read_file', { path: sourcePath }, '[Direct source read]');
      if (readResult.isError || !readResult.output) {
        return {
          handled: true,
          title: '[Direct document conversion]',
          output: readResult.output || '读取源文件失败，无法继续转换。',
          isError: true,
        };
      }

      return this.convertTextContent(input, readResult.output, fileBaseName, targetFormat);
    }

    return this.buildKnownGapResult(
      input,
      `当前没有可用的 ${sourceFormat.toUpperCase()} 内容提取或转换工具。`,
      ['如果你能先把源内容导出成 .md 或 .txt，我可以继续转换到目标格式。', '如果只是需要保留原文件，可先复制到目标目录。'],
    );
  }

  private async convertTextContent(
    input: string,
    sourceText: string,
    fileBaseName: string,
    targetFormat: ConvertibleFormat,
  ): Promise<DirectActionResult> {
    if (targetFormat === 'md' || targetFormat === 'txt') {
      const outputPath = this.inferConversionOutputPath(input, fileBaseName, targetFormat);
      return this.executeBuiltInTool('write_file', {
        path: outputPath,
        content: sourceText,
      }, '[Direct file save]');
    }

    if (targetFormat === 'xlsx') {
      return this.buildKnownGapResult(
        input,
        '当前没有可用的文本到 XLSX 导出工具。',
        ['可以先导出为 .md、.txt、.docx 或 .pdf。', '如果你需要表格结构，请先明确列头与行数据，再接入专门的 xlsx/csv 导出 skill。'],
      );
    }

    if (targetFormat === 'pptx') {
      return this.buildKnownGapResult(
        input,
        '当前没有可用的文本到 PPT/PPTX 导出工具。',
        ['可以先让我生成 PPT 大纲、逐页标题和演讲备注。', '也可以先导出为 .pdf 或 .docx，再手动导入 PowerPoint。'],
      );
    }

    const toolName = this.resolveDocumentExportTool(targetFormat);
    if (!toolName) {
      return this.buildKnownGapResult(
        input,
        `未找到可用的 ${this.formatLabel(targetFormat)} 导出工具。`,
        ['当前只能在已安装对应 skill 的情况下执行这类导出。', '可先用 /skill todos 查看是否已有相关缺口记录，再用 /skill adopt-from-todo 生成草稿。'],
      );
    }

    const outputPath = this.inferConversionOutputPath(input, fileBaseName, targetFormat);
    const title = fileBaseName.replace(/[-_]+/g, ' ').trim() || 'exported document';
    const args = toolName === 'txt_to_pdf' || toolName === 'minimax_pdf_text_to_pdf'
      ? { out: outputPath, text: sourceText, title }
      : { output: outputPath, text: sourceText, title };

    const result = await this.executeSkillTool(toolName, args, '[Direct document conversion]');

    if (this.isUnavailableDocxSkillResult(targetFormat, result.output || '')) {
      return this.buildKnownGapResult(
        input,
        result.output || '无可用 docx skill。',
        ['可先降级导出为 PDF、Markdown 或 TXT。', '如果要继续使用 DOCX，请先安装可用的 .NET SDK 后再试。'],
      );
    }

    return this.verifyDocumentExportResult(result, outputPath, targetFormat);
  }

  private resolveDocumentExportTool(format: 'docx' | 'pdf' | ConvertibleFormat): string | null {
    if (format !== 'docx' && format !== 'pdf') {
      return null;
    }

    return selectPreferredExportTool(format, this.skillManager.getTools().map(tool => tool.name));
  }

  private getLatestAssistantText(): string {
    const messages = this.getConversationMessages?.() || [];
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== 'assistant') {
        continue;
      }
      const content = message.content?.trim();
      if (content) {
        return content;
      }
    }
    return '';
  }

  private extractRequestedFileName(input: string): string | null {
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

  private inferTextOutputPath(input: string, fileBaseName: string, extension: '.md' | '.txt'): string {
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
    return normalizedName;
  }

  private inferConversionOutputPath(input: string, fileBaseName: string, format: ConvertibleFormat): string {
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

  private normalizePath(rawPath: string): string {
    const unquoted = rawPath.replace(/^['"]|['"]$/g, '');
    return unquoted;
  }

  private splitExplicitPaths(input: string): string[] {
    return input
      .split(/\s*(?:,|，|、|\s和\s|\s及\s|\s以及\s|\sand\s)\s*/i)
      .map(part => this.stripDirectorySuffix(this.normalizePath(part.trim())))
      .filter(part => this.looksLikePath(part));
  }

  private looksLikePath(value: string): boolean {
    if (!value) {
      return false;
    }

    return /[\\/]/.test(value)
      || /\.[a-z0-9]{1,8}$/i.test(value)
      || /^(?:\.\.?)(?:[\\/]|$)/.test(value)
      || /^[a-z]:[\\/]/i.test(value);
  }

  private stripDirectorySuffix(value: string): string {
    return value.replace(/\s*(?:目录|文件夹)$/i, '').trim();
  }

  private normalizeSearchQuery(value: string): string {
    return value
      .replace(/^(?:关键词|关键字|内容|文本)\s*[：:]?\s*/i, '')
      .replace(/^['"“”]|['"“”]$/g, '')
      .trim();
  }

  private normalizeGlobPattern(value: string): string {
    const normalized = value.trim().replace(/^\./, '');
    if (!normalized) {
      return '';
    }

    if (normalized.includes('*')) {
      return normalized.startsWith('**/') ? normalized : `**/${normalized}`;
    }

    return `**/*.${normalized}`;
  }

  private extractInlineContent(input: string): string {
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

  private extractRequestedDestination(input: string): string {
    const patterns = [
      /(?:存进|保存到|保存进|输出到|放到|放进|写入到|写进|存到)\s*['"“”]?([^'"“”\n]+?)['"“”]?(?:文件夹|目录)?(?:内|里)?(?:$|，|,|。)/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const raw = match?.[1]?.trim();
      if (raw) {
        return this.normalizePath(raw);
      }
    }

    return '';
  }

  private looksLikeFilePath(value: string): boolean {
    return /\.[a-z0-9]{1,8}$/i.test(value);
  }

  private detectFormatFromPath(value: string): ConvertibleFormat | null {
    const extension = path.extname(value).toLowerCase();
    if (extension === '.md' || extension === '.markdown') {
      return 'md';
    }
    if (extension === '.txt') {
      return 'txt';
    }
    if (extension === '.docx') {
      return 'docx';
    }
    if (extension === '.pdf') {
      return 'pdf';
    }
    if (extension === '.xlsx') {
      return 'xlsx';
    }
    if (extension === '.ppt' || extension === '.pptx') {
      return 'pptx';
    }
    return null;
  }

  private formatLabel(format: ConvertibleFormat): string {
    switch (format) {
      case 'docx':
        return 'Word';
      case 'pdf':
        return 'PDF';
      case 'xlsx':
        return 'XLSX';
      case 'md':
        return 'Markdown';
      case 'txt':
        return 'TXT';
      case 'pptx':
        return 'PPTX';
    }
  }

  private normalizeSkillExecutionError(toolName: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    if (this.isUnavailableDocxSkill(toolName, message)) {
      return [
        '无可用 docx skill。',
        '当前安装的 minimax-docx 不可用，原因是缺少可运行的 .NET SDK。',
        '可先降级为 PDF、Markdown 或 TXT 导出，或在安装 .NET SDK 后再试 DOCX。',
      ].join('\n');
    }

    if (this.isUnavailablePdfSkill(toolName, message)) {
      return [
        '无可用 pdf skill。',
        '当前安装的 minimax-pdf 不可用，原因是缺少 Playwright/Chromium 运行环境。',
        '可先执行 npm install -g playwright，并运行 npx playwright install chromium；或者先降级为 Markdown、TXT、DOCX。',
      ].join('\n');
    }

    return `Skill tool error: ${message}`;
  }

  private isUnavailableDocxSkill(toolName: string, message: string): boolean {
    if (!/docx/i.test(toolName)) {
      return false;
    }

    return /minimax-docx 当前不可用|缺少 .*\.net sdk|No \.NET SDKs were found|application 'run' does not exist|dotnet run/i.test(message);
  }

  private isUnavailablePdfSkill(toolName: string, message: string): boolean {
    if (!/pdf/i.test(toolName)) {
      return false;
    }

    return /playwright not found|npx playwright install chromium|chromium/i.test(message);
  }

  private isUnavailableDocxSkillResult(format: 'docx' | 'pdf' | ConvertibleFormat, output: string): boolean {
    return format === 'docx' && /无可用 docx skill/i.test(output);
  }

  private async getKnownGapPrefix(input: string): Promise<string> {
    if (typeof this.skillManager.searchLearningTodos !== 'function') {
      return '';
    }

    try {
      let strongest: { id: string; issueSummary: string; suggestedSkill: string; score: number } | undefined;
      for (const query of this.buildKnownGapQueries(input)) {
        const matches = await this.skillManager.searchLearningTodos(query, 1);
        const candidate = matches[0];
        if (candidate && candidate.score >= 0.55 && (!strongest || candidate.score > strongest.score)) {
          strongest = candidate;
        }
      }

      if (!strongest) {
        return '';
      }

      return `这是已知能力缺口：${strongest.issueSummary}（todo: ${strongest.id}，建议 skill: ${strongest.suggestedSkill}）。`;
    } catch {
      return '';
    }
  }

  private buildKnownGapQueries(input: string): string[] {
    const stripped = input.replace(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|docx|pdf|xlsx))/gi, ' ');
    const formatTerms = Array.from(new Set((input.match(/docx|pdf|xlsx|markdown|md|txt|excel|word/gi) || []).map(item => item.toLowerCase())));
    return Array.from(new Set([
      input.trim(),
      stripped.replace(/\s+/g, ' ').trim(),
      formatTerms.join(' 转 '),
    ].filter(Boolean)));
  }

  private async buildKnownGapResult(input: string, detail: string, fallbacks: string[]): Promise<DirectActionResult> {
    const prefix = await this.getKnownGapPrefix(input);
    const message = [
      prefix || '这是当前能力缺口。',
      detail,
      fallbacks.length > 0 ? `可行的降级方案：${fallbacks.join(' ')}` : '',
    ].filter(Boolean).join('\n\n');

    return {
      handled: true,
      title: '[Direct document conversion]',
      output: message,
      isError: true,
    };
  }

  private async verifyDocumentExportResult(
    result: DirectActionResult,
    outputPath: string,
    format: 'docx' | 'pdf',
  ): Promise<DirectActionResult> {
    if (result.isError) {
      return result;
    }

    const resolvedOutputPath = this.resolveOutputArtifactPath(outputPath);
    try {
      await fs.access(resolvedOutputPath);
      return result;
    } catch {
      return {
        handled: true,
        title: '[Direct document export]',
        output: `无法转换为 ${format.toUpperCase()}。未检测到输出文件 ${resolvedOutputPath}，可能没有相关 skill 或 skill 执行失败。`,
        isError: true,
      };
    }
  }

  private resolveOutputArtifactPath(outputPath: string): string {
    if (/^(Desktop|桌面)([\\/]|$)/i.test(outputPath) || outputPath === 'Desktop' || outputPath === '桌面') {
      return resolveUserPath(outputPath, { workspace: this.workspace });
    }

    return resolveOutputPath(outputPath, {
      workspace: this.workspace,
      artifactOutputDir: typeof this.config.artifactOutputDir === 'string' ? this.config.artifactOutputDir : undefined,
      documentOutputDir: typeof this.config.documentOutputDir === 'string' ? this.config.documentOutputDir : undefined,
    });
  }

  private findReadableSourceFilePath(input: string): string {
    const paths = this.extractPathsFromInput(input);
    const candidate = paths.find(item => /\.(md|markdown|txt)$/i.test(item));
    return candidate || '';
  }

  private findConvertibleSourceFilePath(input: string): string {
    const paths = this.extractPathsFromInput(input);
    const candidate = paths.find(item => /\.(md|markdown|txt|docx|pdf|xlsx)$/i.test(item));
    return candidate || '';
  }

  private extractPathsFromInput(input: string): string[] {
    const matches = input.match(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|docx|pdf|xlsx))/gi);
    return matches?.map(item => this.normalizePath(item.trim())) || [];
  }
}

export function createDirectActionRouter(options: DirectActionRouterOptions): DirectActionRouter {
  return new DirectActionRouter(options);
}