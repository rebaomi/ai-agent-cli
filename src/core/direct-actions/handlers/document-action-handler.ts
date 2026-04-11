import { looksLikeToolErrorText } from '../../../utils/docx-validation.js';
import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { ConvertibleFormat, DocumentActionRuntime } from '../runtime-context.js';

const directActionTraceEnabled = process.env.AI_AGENT_CLI_DIRECT_ACTION_TRACE === '1';

function traceDirectActionStage(stage: string, detail: string): void {
  if (directActionTraceEnabled) {
    console.log(`[DIRECT_ACTION_HANDLER] ${stage}: ${detail}`);
  }
}

export class DocumentActionHandler implements DirectActionHandler {
  readonly name = 'document-action';

  constructor(private readonly runtime: DocumentActionRuntime) {}

  canHandle(input: string): boolean {
    return this.runtime.detectConvertibleFormat(input) !== null;
  }

  async handle(input: string): Promise<DirectActionResult | null> {
    const targetFormat = this.runtime.detectConvertibleFormat(input);
    if (!targetFormat) {
      return null;
    }

    const sourcePath = await this.runtime.findConvertibleSourceFilePath(input, targetFormat);
    if (sourcePath) {
      return this.convertSourceFile(input, sourcePath, targetFormat);
    }

    const sourceText = this.runtime.resolveDirectSourceText(input);
    if (!sourceText) {
      return null;
    }

    const fileBaseName = this.runtime.extractRequestedFileName(input) || 'exported-document';
    return this.convertTextContent(input, sourceText, fileBaseName, targetFormat);
  }

  private async convertSourceFile(input: string, sourcePath: string, targetFormat: ConvertibleFormat): Promise<DirectActionResult> {
    const sourceFormat = this.runtime.detectFormatFromPath(sourcePath);
    const fileBaseName = this.runtime.extractRequestedFileName(input) || sourcePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

    if (!sourceFormat) {
      return {
        handled: true,
        title: '[Direct document conversion]',
        output: `暂不支持识别源文件格式: ${sourcePath}`,
        isError: true,
      };
    }

    if (sourceFormat === targetFormat) {
      const outputPath = this.runtime.inferConversionOutputPath(input, fileBaseName, targetFormat);
      const result = await this.runtime.executeBuiltInTool('copy_file', {
        source: sourcePath,
        destination: outputPath,
      }, '[Direct document copy]');
      return { ...result, category: 'document-action' };
    }

    if (targetFormat === 'pptx' && !(sourceFormat === 'md' || sourceFormat === 'txt' || sourceFormat === 'csv' || sourceFormat === 'tsv')) {
      return this.runtime.buildKnownGapResult(
        input,
        `当前没有可用的 ${sourceFormat.toUpperCase()} 到 PPT/PPTX 转换工具。`,
        ['可以先生成 PPT 大纲、逐页标题与讲稿，再手动导入 PowerPoint。', '也可以先导出为 .pdf 或 .docx 后再手动转换为 PPT。'],
      );
    }

    if (targetFormat === 'xlsx' && (sourceFormat === 'md' || sourceFormat === 'txt' || sourceFormat === 'csv' || sourceFormat === 'tsv')) {
      const readResult = await this.runtime.executeBuiltInTool('read_file', { path: sourcePath }, '[Direct source read]');
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

    if (sourceFormat === 'md' || sourceFormat === 'txt' || sourceFormat === 'csv' || sourceFormat === 'tsv') {
      const readResult = await this.runtime.executeBuiltInTool('read_file', { path: sourcePath }, '[Direct source read]');
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

    return this.runtime.buildKnownGapResult(
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
      const outputPath = this.runtime.inferConversionOutputPath(input, fileBaseName, targetFormat);
      const result = await this.runtime.executeBuiltInTool('write_file', {
        path: outputPath,
        content: sourceText,
      }, '[Direct file save]');
      return { ...result, category: 'document-action' };
    }

    const toolName = this.runtime.resolveDocumentExportTool(targetFormat);
    if (!toolName) {
      return this.runtime.buildKnownGapResult(
        input,
        `未找到可用的 ${this.runtime.formatLabel(targetFormat)} 导出工具。`,
        ['当前只能在已安装对应 skill 的情况下执行这类导出。', '可先用 /skill todos 查看是否已有相关缺口记录，再用 /skill adopt-from-todo 生成草稿。'],
      );
    }

    const outputPath = this.runtime.inferConversionOutputPath(input, fileBaseName, targetFormat);
    const title = fileBaseName.replace(/[-_]+/g, ' ').trim() || 'exported document';
    const args = /pdf_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf/i.test(toolName)
      ? { out: outputPath, text: sourceText, title }
      : { output: outputPath, text: sourceText, title };
    traceDirectActionStage('prepare-export', `${toolName} -> ${outputPath}`);

    if (looksLikeToolErrorText(sourceText)) {
      return this.runtime.buildKnownGapResult(
        input,
        '上游步骤产出的不是正文内容，而是错误文本，已停止继续导出。',
        ['先修复上游步骤，再重试 DOCX 导出。', '必要时可先把新闻正文保存为 TXT 检查内容是否正确。'],
      );
    }

    traceDirectActionStage('execute-export-start', toolName);
    const result = this.runtime.hasBuiltInTool(toolName)
      ? await this.runtime.executeBuiltInTool(toolName, args, '[Direct document conversion]')
      : await this.runtime.executeSkillTool(toolName, args, '[Direct document conversion]');
    traceDirectActionStage('execute-export-done', `${toolName} error=${result.isError === true}`);

    if (this.runtime.isUnavailableDocxSkillResult(targetFormat, result.output || '')) {
      return this.runtime.buildKnownGapResult(
        input,
        result.output || '无可用 docx skill。',
        ['可先降级导出为 PDF、Markdown 或 TXT。', '如果要继续使用 DOCX，请先安装可用的 .NET SDK 后再试。'],
      );
    }

    if (targetFormat === 'docx' || targetFormat === 'pdf' || targetFormat === 'xlsx' || targetFormat === 'pptx') {
      traceDirectActionStage('verify-export-start', `${targetFormat} -> ${outputPath}`);
      const verified = await this.runtime.verifyDocumentExportResult(result, outputPath, targetFormat, sourceText, title);
      traceDirectActionStage('verify-export-done', `${targetFormat} error=${verified.isError === true}`);
      return { ...verified, category: 'document-action' };
    }

    return { ...result, category: 'document-action' };
  }
}