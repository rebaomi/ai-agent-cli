import { promises as fs } from 'fs';
import { PDFParse } from 'pdf-parse';

export async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  if (!looksLikePdf(buffer)) {
    return buffer.toString('utf-8').replace(/\r/g, '').trim();
  }

  const parser = new PDFParse({ data: buffer });
  try {
    const result = await Promise.race([
      parser.getText(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('PDF text extraction timed out')), 5000);
      }),
    ]);
    return (result.text || '').replace(/\r/g, '').trim();
  } catch {
    return buffer.toString('utf-8').replace(/\r/g, '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString('utf-8') === '%PDF-';
}