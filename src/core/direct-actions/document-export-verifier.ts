import { promises as fs } from 'fs';
import { validateDocxContent } from '../../utils/docx-validation.js';
import { extractPdfText } from '../../utils/pdf-validation.js';
import { extractPptxText } from '../../utils/pptx-validation.js';
import { extractXlsxText } from '../../utils/xlsx-validation.js';
import type { DirectActionResult } from '../direct-action-router.js';

export interface DirectActionDocumentExportVerifierOptions {
  resolveOutputArtifactPath: (outputPath: string) => string;
}

export class DirectActionDocumentExportVerifier {
  constructor(private readonly options: DirectActionDocumentExportVerifierOptions) {}

  async verifyDocumentExportResult(
    result: DirectActionResult,
    outputPath: string,
    format: 'docx' | 'pdf' | 'xlsx' | 'pptx',
    expectedText?: string,
    expectedTitle?: string,
  ): Promise<DirectActionResult> {
    if (result.isError) {
      return result;
    }

    const resolvedOutputPath = this.options.resolveOutputArtifactPath(outputPath);
    try {
      await fs.access(resolvedOutputPath);
      if (format === 'docx' && expectedText) {
        const validation = await validateDocxContent(resolvedOutputPath, expectedText, expectedTitle);
        if (!validation.ok) {
          return {
            handled: true,
            title: '[Direct document export]',
            output: [
              `Word 文档已创建，但正文校验失败: ${resolvedOutputPath}`,
              ...validation.problems,
              ...validation.missing.map(item => `缺少预期内容: ${item}`),
            ].join('\n'),
            isError: true,
          };
        }
      }
      if (format === 'xlsx' && expectedText) {
        const extractedText = this.normalizeTabularText(await extractXlsxText(resolvedOutputPath));
        const expectedSnippets = expectedText.split(/\r?\n/).map(line => this.normalizeTabularText(line)).filter(Boolean).slice(0, 5);
        const missing = expectedSnippets.filter(snippet => !extractedText.includes(snippet));
        if (missing.length > 0) {
          return {
            handled: true,
            title: '[Direct spreadsheet export]',
            output: [`XLSX 文件已创建，但正文校验失败: ${resolvedOutputPath}`, ...missing.map(item => `缺少预期内容: ${item}`)].join('\n'),
            isError: true,
          };
        }
      }
      if (format === 'pdf' && expectedText) {
        const extractedText = await extractPdfText(resolvedOutputPath);
        const expectedSnippets = expectedText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 5);
        const missing = expectedSnippets.filter(snippet => !extractedText.includes(snippet));
        if (missing.length > 0) {
          return {
            handled: true,
            title: '[Direct document export]',
            output: [`PDF 文件已创建，但正文校验失败: ${resolvedOutputPath}`, ...missing.map(item => `缺少预期内容: ${item}`)].join('\n'),
            isError: true,
          };
        }
      }
      if (format === 'pptx' && expectedText) {
        const extractedText = await extractPptxText(resolvedOutputPath);
        const expectedSnippets = expectedText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 5);
        const missing = expectedSnippets.filter(snippet => !extractedText.includes(snippet));
        if (missing.length > 0) {
          return {
            handled: true,
            title: '[Direct presentation export]',
            output: [`PPTX 文件已创建，但正文校验失败: ${resolvedOutputPath}`, ...missing.map(item => `缺少预期内容: ${item}`)].join('\n'),
            isError: true,
          };
        }
      }
      return result;
    } catch {
      return {
        handled: true,
        title: format === 'xlsx' ? '[Direct spreadsheet export]' : format === 'pptx' ? '[Direct presentation export]' : '[Direct document export]',
        output: `无法转换为 ${format.toUpperCase()}。未检测到输出文件 ${resolvedOutputPath}，可能没有相关 skill 或 skill 执行失败。`,
        isError: true,
      };
    }
  }

  private normalizeTabularText(value: string): string {
    return value
      .split(/\r?\n/)
      .map(line => line.trim().replace(/[\t,]+/g, '\t'))
      .join('\n');
  }
}