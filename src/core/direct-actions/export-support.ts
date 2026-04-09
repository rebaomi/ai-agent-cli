import { detectRequestedExportFormat, selectPreferredExportTool } from '../export-intent.js';
import type { ConvertibleFormat } from './runtime-context.js';

type SourceFormat = ConvertibleFormat | 'csv' | 'tsv';

export class DirectActionExportSupport {
  detectConvertibleFormat(input: string): ConvertibleFormat | null {
    const detected = detectRequestedExportFormat(input, ['docx', 'pdf', 'xlsx', 'md', 'txt', 'pptx']);
    if (detected) {
      return detected;
    }

    if (/(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成).*(?:pptx|ppt|powerpoint|幻灯片|演示文稿)/i.test(input)) {
      return 'pptx';
    }

    return null;
  }

  detectTextFormat(input: string): 'markdown' | 'text' | null {
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

  resolveDocumentExportTool(format: 'docx' | 'pdf' | 'xlsx' | 'pptx' | ConvertibleFormat, availableToolNames: string[]): string | null {
    if (format !== 'docx' && format !== 'pdf' && format !== 'xlsx' && format !== 'pptx') {
      return null;
    }

    return selectPreferredExportTool(format, availableToolNames);
  }

  detectFormatFromPath(value: string): SourceFormat | null {
    const normalized = value.toLowerCase();
    if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) {
      return 'md';
    }
    if (normalized.endsWith('.txt')) {
      return 'txt';
    }
    if (normalized.endsWith('.csv')) {
      return 'csv';
    }
    if (normalized.endsWith('.tsv')) {
      return 'tsv';
    }
    if (normalized.endsWith('.docx')) {
      return 'docx';
    }
    if (normalized.endsWith('.pdf')) {
      return 'pdf';
    }
    if (normalized.endsWith('.xlsx')) {
      return 'xlsx';
    }
    if (normalized.endsWith('.ppt') || normalized.endsWith('.pptx')) {
      return 'pptx';
    }
    return null;
  }

  formatLabel(format: ConvertibleFormat): string {
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
}