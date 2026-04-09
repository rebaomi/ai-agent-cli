import type { MemoryProvider } from './memory-provider.js';
import { resolveOutputPath } from '../utils/path-resolution.js';
import { validateDocxContent } from '../utils/docx-validation.js';
import { extractPdfText } from '../utils/pdf-validation.js';
import { extractPptxText } from '../utils/pptx-validation.js';
import { extractXlsxText } from '../utils/xlsx-validation.js';

export interface ExportArtifactManagerOptions {
  config?: Record<string, unknown>;
  memoryProvider?: MemoryProvider;
}

export class ExportArtifactManager {
  private readonly config: Record<string, unknown>;
  private readonly memoryProvider?: MemoryProvider;

  constructor(options: ExportArtifactManagerOptions) {
    this.config = options.config ?? {};
    this.memoryProvider = options.memoryProvider;
  }

  async validateSuccessfulExportResult(name: string, args: Record<string, unknown>): Promise<string | null> {
    if (!/docx_create_from_text|pdf_create_from_text|xlsx_create_from_text|pptx_create_from_text|txt_to_docx|minimax_docx_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf|txt_to_xlsx|txt_to_pptx/i.test(name)) {
      return null;
    }

    const validationInput = this.resolveExportValidationInput(name, args);
    if (!validationInput) {
      return null;
    }

    const { resolvedPath, expectedText, expectedTitle } = validationInput;

    try {
      if (/pdf_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf/i.test(name)) {
        return this.validateExtractedTextExport({
          resolvedPath,
          expectedText,
          failurePrefix: 'PDF 文件已创建，但正文校验失败',
          extractText: () => extractPdfText(resolvedPath),
        });
      }

      if (/xlsx_create_from_text|txt_to_xlsx/i.test(name)) {
        return this.validateExtractedTextExport({
          resolvedPath,
          expectedText,
          failurePrefix: 'XLSX 文件已创建，但正文校验失败',
          extractText: async () => this.normalizeTabularText(await extractXlsxText(resolvedPath)),
          normalizeExpectedLine: (line) => this.normalizeTabularText(line),
        });
      }

      if (/pptx_create_from_text|txt_to_pptx/i.test(name)) {
        return this.validateExtractedTextExport({
          resolvedPath,
          expectedText,
          failurePrefix: 'PPTX 文件已创建，但正文校验失败',
          extractText: () => extractPptxText(resolvedPath),
        });
      }

      return this.validateSuccessfulDocxExport(resolvedPath, expectedText, expectedTitle);
    } catch (error) {
      return `Word 文档已创建，但正文校验失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async rememberSuccessfulToolResult(name: string, args: Record<string, unknown>): Promise<void> {
    if (!this.memoryProvider) {
      return;
    }

    const remembered = this.extractOutputArtifact(name, args);
    if (!remembered) {
      return;
    }

    const { path, label, extension } = remembered;
    await this.memoryProvider.store({
      kind: 'project',
      key: 'last_output_file',
      title: 'last_output_file',
      content: `${label}: ${path}`,
      metadata: { path, toolName: name, extension },
    });

    if (extension) {
      await this.memoryProvider.store({
        kind: 'project',
        key: `last_${extension}_output_file`,
        title: `last_${extension}_output_file`,
        content: `${label}: ${path}`,
        metadata: { path, toolName: name, extension },
      });
    }
  }

  private resolveExportValidationInput(
    name: string,
    args: Record<string, unknown>,
  ): { resolvedPath: string; expectedText: string; expectedTitle?: string } | null {
    const expectedText = typeof args.text === 'string' ? args.text : '';
    const expectedTitle = typeof args.title === 'string' ? args.title : undefined;
    const resolvedPath = this.resolveOutputArtifactPathFromArgs(name, args);
    if (!resolvedPath || !expectedText) {
      return null;
    }

    return {
      resolvedPath,
      expectedText,
      expectedTitle,
    };
  }

  private async validateSuccessfulDocxExport(
    resolvedPath: string,
    expectedText: string,
    expectedTitle?: string,
  ): Promise<string | null> {
    const validation = await validateDocxContent(resolvedPath, expectedText, expectedTitle);
    if (validation.ok) {
      return null;
    }

    return [
      `Word 文档已创建，但正文校验失败: ${resolvedPath}`,
      ...validation.problems,
      ...validation.missing.map(item => `缺少预期内容: ${item}`),
    ].join('\n');
  }

  private async validateExtractedTextExport(options: {
    resolvedPath: string;
    expectedText: string;
    failurePrefix: string;
    extractText: () => Promise<string>;
    normalizeExpectedLine?: (line: string) => string;
  }): Promise<string | null> {
    const extractedText = await options.extractText();
    const expectedSnippets = this.buildExpectedValidationSnippets(
      options.expectedText,
      options.normalizeExpectedLine,
    );
    const missing = expectedSnippets.filter(snippet => !extractedText.includes(snippet));
    if (missing.length === 0) {
      return null;
    }

    return [
      `${options.failurePrefix}: ${options.resolvedPath}`,
      ...missing.map(item => `缺少预期内容: ${item}`),
    ].join('\n');
  }

  private buildExpectedValidationSnippets(
    expectedText: string,
    normalizeLine: (line: string) => string = (line) => line.trim(),
  ): string[] {
    return expectedText
      .split(/\r?\n/)
      .map(line => normalizeLine(line))
      .filter(Boolean)
      .slice(0, 5);
  }

  private normalizeTabularText(value: string): string {
    return value
      .split(/\r?\n/)
      .map(line => line.trim().replace(/[\t,]+/g, '\t'))
      .join('\n');
  }

  private extractOutputArtifact(name: string, args: Record<string, unknown>): { path: string; label: string; extension?: string } | null {
    const resolvedPath = this.resolveOutputArtifactPathFromArgs(name, args);
    if (!resolvedPath) {
      return null;
    }
    const extensionMatch = resolvedPath.match(/\.([a-z0-9]{1,8})$/i);
    const extension = extensionMatch?.[1]?.toLowerCase();
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '最近生成文件';

    return {
      path: resolvedPath,
      label: title,
      extension,
    };
  }

  private resolveOutputArtifactPathFromArgs(name: string, args: Record<string, unknown>): string | null {
    const outputValue = this.getArtifactArgValue(name, args);
    if (typeof outputValue !== 'string' || !outputValue.trim()) {
      return null;
    }

    return resolveOutputPath(outputValue, {
      workspace: process.cwd(),
      artifactOutputDir: typeof this.config.artifactOutputDir === 'string' ? this.config.artifactOutputDir : undefined,
      documentOutputDir: typeof this.config.documentOutputDir === 'string' ? this.config.documentOutputDir : undefined,
    });
  }

  private getArtifactArgValue(name: string, args: Record<string, unknown>): unknown {
    if (/^(write_file)$/i.test(name)) {
      return args.path;
    }

    if (/^(copy_file|move_file)$/i.test(name)) {
      return args.destination;
    }

    if (/docx_create_from_text|xlsx_create_from_text|pptx_create_from_text|txt_to_docx|minimax_docx_create_from_text|txt_to_xlsx|txt_to_pptx/i.test(name)) {
      return args.output;
    }

    if (/pdf_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf/i.test(name)) {
      return args.out;
    }

    return null;
  }
}
