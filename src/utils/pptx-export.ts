import { promises as fs } from 'fs';
import * as path from 'path';
import PptxGenJS from 'pptxgenjs';

const PptxGenJSCtor = (PptxGenJS as unknown as { default?: typeof PptxGenJS }).default ?? PptxGenJS;

const PPTX_LAYOUT = 'LAYOUT_WIDE';
const TITLE_BOX = { x: 0.6, y: 0.35, w: 11.4, h: 0.7 };
const BODY_BOX = { x: 0.7, y: 1.2, w: 11.1, h: 5.4 };
const MAX_BODY_CHARS_PER_SLIDE = 1600;

export async function writePptxDocument(outputPath: string, text: string, title?: string): Promise<void> {
  const presentation = new PptxGenJSCtor();
  presentation.layout = PPTX_LAYOUT;
  presentation.author = 'ai-agent-cli';
  presentation.company = 'ai-agent-cli';
  presentation.subject = title || 'Presentation';
  presentation.title = title || 'Presentation';
  presentation.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
  };

  const slideTitle = (title || 'Presentation').trim() || 'Presentation';
  const slides = paginateText(text);

  slides.forEach((bodyText, index) => {
    const slide = presentation.addSlide();
    slide.background = { color: 'F8F6F1' };
    slide.addText(index === 0 ? slideTitle : `${slideTitle}（续 ${index + 1}）`, {
      ...TITLE_BOX,
      fontFace: 'Microsoft YaHei',
      fontSize: 24,
      bold: true,
      color: '1F2937',
      margin: 0,
      valign: 'middle',
      fit: 'shrink',
    });
    slide.addText(bodyText || ' ', {
      ...BODY_BOX,
      fontFace: 'Microsoft YaHei',
      fontSize: 14,
      color: '374151',
      breakLine: false,
      margin: 0.08,
      valign: 'top',
      fit: 'shrink',
      paraSpaceAfter: 10,
      bullet: false,
    });
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await presentation.writeFile({ fileName: outputPath, compression: true });
}

function paginateText(text: string): string[] {
  const normalizedLines = text.replace(/\r/g, '').split('\n');
  const slides: string[] = [];
  let current = '';

  for (const line of normalizedLines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_BODY_CHARS_PER_SLIDE && current) {
      slides.push(current);
      current = line;
      continue;
    }
    current = candidate;
  }

  if (current || slides.length === 0) {
    slides.push(current);
  }

  return slides;
}
