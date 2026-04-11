import { promises as fs } from 'fs';
import { inflateRawSync } from 'zlib';

export interface DocxValidationResult {
  ok: boolean;
  text: string;
  missing: string[];
  problems: string[];
}

export async function extractDocxText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const documentXml = extractZipEntry(buffer, 'word/document.xml');
  if (!documentXml) {
    return '';
  }

  return decodeXmlText(documentXml.toString('utf-8'));
}

export async function validateDocxContent(filePath: string, expectedText: string, expectedTitle?: string): Promise<DocxValidationResult> {
  const text = await extractDocxText(filePath);
  const normalizedDocText = normalizeText(text);
  const problems: string[] = [];

  if (!normalizedDocText) {
    return {
      ok: false,
      text,
      missing: [],
      problems: ['导出的 Word 文档正文为空或无法解析。'],
    };
  }

  if (/\[repl\]\s*error:|invalid or unexpected token/i.test(normalizedDocText)) {
    problems.push('导出的 Word 文档正文包含 repl 报错，而不是目标内容。');
  }

  const missing = buildExpectedSnippets(expectedText, expectedTitle)
    .filter(snippet => !normalizedDocText.includes(normalizeText(snippet)));

  return {
    ok: problems.length === 0 && missing.length === 0,
    text,
    missing,
    problems,
  };
}

export function looksLikeToolErrorText(value: string): boolean {
  const normalized = normalizeText(value);
  return /(^|\n)\[[^\]]+\]\s*error:|(^|\n)error:\s|(^|\n)skill tool error:|unhandled exception:|exception:|directorynotfoundexception|invalid or unexpected token/i.test(normalized);
}

export function looksLikePlaceholderContent(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  return /(此处为|此处填写|这里填写|待补充|待完善|待填写|占位|placeholder|lorem ipsum|\btodo\b|\btbd\b|to be added|to be completed|内容详见后续|正文略|内容略)/i.test(normalized);
}

export function looksLikeIncompleteStructuredDocument(value: string): boolean {
  if (!looksLikePlaceholderContent(value)) {
    return false;
  }

  const normalized = value.replace(/\r/g, '');
  const headingCount = (normalized.match(/^#{1,6}\s+/gm) || []).length;
  const sectionKeywords = /(摘要|引言|正文|结论|参考文献|主要应用场景|技术实现架构|典型案例分析|挑战与限制|未来发展趋势)/i;
  const paragraphLikeLines = normalized
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => line.length >= 12).length;

  return headingCount >= 3 || (sectionKeywords.test(normalized) && paragraphLikeLines >= 4);
}

function buildExpectedSnippets(expectedText: string, expectedTitle?: string): string[] {
  const snippets: string[] = [];
  const title = (expectedTitle || '').trim();
  if (title.length >= 4) {
    snippets.push(title);
  }

  const lines = expectedText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !looksLikeToolErrorText(line));

  for (const line of lines) {
    if (line.length >= 8) {
      snippets.push(line.slice(0, 80));
    }
    if (snippets.length >= 3) {
      break;
    }
  }

  if (snippets.length === 0) {
    const compact = expectedText.replace(/\s+/g, ' ').trim();
    if (compact.length > 0) {
      snippets.push(compact.slice(0, 80));
    }
  }

  return Array.from(new Set(snippets.map(item => item.trim()).filter(Boolean)));
}

function extractZipEntry(buffer: Buffer, entryName: string): Buffer | null {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    return null;
  }

  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      return null;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.toString('utf-8', offset + 46, offset + 46 + fileNameLength);

    if (fileName === entryName) {
      return readLocalFileData(buffer, localHeaderOffset, compressionMethod, compressedSize);
    }

    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return null;
}

function readLocalFileData(buffer: Buffer, localHeaderOffset: number, compressionMethod: number, compressedSize: number): Buffer | null {
  if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    return null;
  }

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) {
    return compressed;
  }

  if (compressionMethod === 8) {
    return inflateRawSync(compressed);
  }

  return null;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  return -1;
}

function decodeXmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/?\s*>/g, '\t')
    .replace(/<w:br\/?\s*>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
