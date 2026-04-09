export type ExportFormat = 'docx' | 'pdf' | 'md' | 'txt' | 'xlsx' | 'pptx';

const EXPORT_VERB_PATTERN = /(保存成|导出为|导出成|输出为|输出成|存成|写成|转成|转换成|save(?:\s+as)?|export(?:\s+as)?|convert(?:\s+to)?|write(?:\s+as)?|生成(?:一个|一份|成)?(?:pdf|docx|word|ppt|pptx|powerpoint|markdown|md|txt|xlsx))/i;

export function detectRequestedExportFormat(input: string, supportedFormats?: ExportFormat[]): ExportFormat | null {
  if (!EXPORT_VERB_PATTERN.test(input)) {
    return null;
  }

  const normalized = input.toLowerCase();
  const compact = normalized.replace(/\s+/g, '');
  const allowed = new Set(supportedFormats || ['docx', 'pdf', 'md', 'txt', 'xlsx', 'pptx']);

  const matchesAny = (patterns: RegExp[], target: string): boolean => patterns.some(pattern => pattern.test(target));

  if (allowed.has('pdf') && (matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|convert(?:\s+to)?|export(?:\s+as)?|save(?:\s+as)?|write(?:\s+as)?)\s*(?:一份|一个)?\s*(?:pdf|pdf文档)\b/i,
    /生成(?:一个|一份|成)?\s*(?:pdf|pdf文档)\b/i,
    /(?:输出|保存|导出).+?\.pdf\b/i,
  ], normalized) || matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成)pdf(?:文件|格式|文档)?/i,
    /生成pdf(?:文件|格式|文档)?/i,
  ], compact))) {
    return 'pdf';
  }

  if (allowed.has('docx') && (matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|convert(?:\s+to)?|export(?:\s+as)?|save(?:\s+as)?|write(?:\s+as)?)\s*(?:一份|一个)?\s*(?:word文档|word|docx文档|docx)\b/i,
    /生成(?:一个|一份|成)?\s*(?:word文档|word|docx文档|docx)\b/i,
    /(?:输出|保存|导出).+?\.docx\b/i,
  ], normalized) || matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成)(?:word|docx)(?:文件|格式|文档)?/i,
    /生成(?:word|docx)(?:文件|格式|文档)?/i,
  ], compact))) {
    return 'docx';
  }

  if (allowed.has('pptx') && (matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|convert(?:\s+to)?|export(?:\s+as)?|save(?:\s+as)?|write(?:\s+as)?)\s*(?:一份|一个)?\s*(?:pptx|ppt|powerpoint|幻灯片|演示文稿)\b/i,
    /生成(?:一个|一份|成)?\s*(?:pptx|ppt|powerpoint|幻灯片|演示文稿)\b/i,
    /(?:输出|保存|导出).+?\.pptx?\b/i,
  ], normalized) || matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成)(?:pptx|ppt|powerpoint|幻灯片|演示文稿)(?:文件|格式|文档)?/i,
    /生成(?:pptx|ppt|powerpoint|幻灯片|演示文稿)(?:文件|格式|文档)?/i,
  ], compact))) {
    return 'pptx';
  }

  if (allowed.has('xlsx') && (matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|convert(?:\s+to)?|export(?:\s+as)?|save(?:\s+as)?|write(?:\s+as)?)\s*(?:一份|一个)?\s*(?:xlsx|excel|电子表格)\b/i,
    /生成(?:一个|一份|成)?\s*(?:xlsx|excel|电子表格)\b/i,
    /(?:输出|保存|导出).+?\.xlsx\b/i,
  ], normalized) || matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成)(?:xlsx|excel|电子表格)(?:文件|格式|文档)?/i,
    /生成(?:xlsx|excel|电子表格)(?:文件|格式|文档)?/i,
  ], compact))) {
    return 'xlsx';
  }

  if (allowed.has('md') && (matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|convert(?:\s+to)?|export(?:\s+as)?|save(?:\s+as)?|write(?:\s+as)?)\s*(?:一份|一个)?\s*(?:markdown文件|markdown文档|markdown|md文件|md文档|md)\b/i,
    /生成(?:一个|一份|成)?\s*(?:markdown文件|markdown文档|markdown|md文件|md文档|md)\b/i,
    /(?:输出|保存|导出).+?\.md\b/i,
  ], normalized) || matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成)(?:markdown|md)(?:文件|格式|文档)?/i,
    /生成(?:markdown|md)(?:文件|格式|文档)?/i,
  ], compact))) {
    return 'md';
  }

  if (allowed.has('txt') && (matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|convert(?:\s+to)?|export(?:\s+as)?|save(?:\s+as)?|write(?:\s+as)?)\s*(?:一份|一个)?\s*(?:txt文件|txt文档|txt|文本文件|文本|text file|text document)\b/i,
    /生成(?:一个|一份|成)?\s*(?:txt文件|txt文档|txt|文本文件|文本|text file|text document)\b/i,
    /(?:输出|保存|导出).+?\.txt\b/i,
  ], normalized) || matchesAny([
    /(?:转成|转换成|保存成|导出为|导出成|输出为|输出成|存成|写成|改成|变成)(?:txt|文本)(?:文件|格式|文档)?/i,
    /生成(?:txt|文本)(?:文件|格式|文档)?/i,
  ], compact))) {
    return 'txt';
  }

  return null;
}

export function isDocxExportTool(name: string): boolean {
  return /docx_create_from_text|txt_to_docx|minimax_docx_create_from_text/i.test(name);
}

export function isPdfExportTool(name: string): boolean {
  return /pdf_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf/i.test(name);
}

export function isXlsxExportTool(name: string): boolean {
  return /xlsx_create_from_text|txt_to_xlsx/i.test(name);
}

export function isPptxExportTool(name: string): boolean {
  return /pptx_create_from_text|txt_to_pptx/i.test(name);
}

export function selectPreferredExportTool(format: 'docx' | 'pdf' | 'xlsx' | 'pptx', availableTools: Iterable<string>): string | null {
  const available = new Set(availableTools);
  const candidates = format === 'docx'
    ? ['docx_create_from_text', 'txt_to_docx', 'minimax_docx_create_from_text']
    : format === 'pdf'
      ? ['pdf_create_from_text', 'txt_to_pdf', 'minimax_pdf_text_to_pdf']
      : format === 'xlsx'
        ? ['xlsx_create_from_text', 'txt_to_xlsx']
        : ['pptx_create_from_text', 'txt_to_pptx'];

  return candidates.find(name => available.has(name)) || null;
}

export function retargetExportPath(value: unknown, suffix: string): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const normalized = value.trim();
  if (/\.[a-z0-9]{1,8}$/i.test(normalized)) {
    return normalized.replace(/\.[a-z0-9]{1,8}$/i, suffix);
  }

  return normalized.toLowerCase().endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}