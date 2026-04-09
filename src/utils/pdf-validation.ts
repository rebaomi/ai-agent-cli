import { promises as fs } from 'fs';
import { PDFParse } from 'pdf-parse';

export async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result.text || '').replace(/\r/g, '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}