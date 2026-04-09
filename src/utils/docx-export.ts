import { promises as fs } from 'fs';
import * as path from 'path';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

export async function writeDocxDocument(outputPath: string, text: string, title?: string): Promise<void> {
  const normalizedTitle = (title || 'exported document').trim() || 'exported document';
  const bodyLines = text.replace(/\r/g, '').split('\n');

  const children: Paragraph[] = [];
  if (normalizedTitle) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun(normalizedTitle)],
      }),
    );
  }

  for (const line of bodyLines) {
    children.push(
      new Paragraph({
        children: [new TextRun(line)],
      }),
    );
  }

  if (children.length === 0) {
    children.push(new Paragraph(''));
  }

  const document = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(document);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
}