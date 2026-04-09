import { promises as fs } from 'fs';
import { inflateRawSync } from 'zlib';

export async function extractXlsxText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const sheetXml = extractZipEntry(buffer, 'xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    return '';
  }

  return decodeSheetText(sheetXml.toString('utf-8'));
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

function decodeSheetText(xml: string): string {
  const rows = Array.from(xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g));
  return rows
    .map(match => {
      const rowXml = match[1] || '';
      const cells = Array.from(rowXml.matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g));
      return cells
        .map(cell => decodeCellText(cell[1] || ''))
        .join('\t');
    })
    .join('\n')
    .trim();
}

function decodeCellText(cellXml: string): string {
  const inlineText = cellXml.match(/<t(?:\s+xml:space="preserve")?>([\s\S]*?)<\/t>/);
  const raw = inlineText?.[1] || '';
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}