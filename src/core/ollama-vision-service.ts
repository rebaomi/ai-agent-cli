import { promises as fs } from 'fs';
import * as path from 'path';
import { OllamaClient } from '../ollama/client.js';
import type { LLMConfig, Message } from '../types/index.js';
import { resolveUserPath } from '../utils/path-resolution.js';

const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export interface OllamaVisionServiceOptions {
  workspace: string;
  appBaseDir?: string;
  artifactOutputDir?: string;
  documentOutputDir?: string;
  homeDir?: string;
  ollamaConfig: LLMConfig;
}

export interface AnalyzeImageDirectoryInput {
  directory: string;
  prompt?: string;
  model?: string;
  maxImages?: number;
}

export interface AnalyzeVisionTargetsInput {
  targets: string[];
  prompt?: string;
  model?: string;
  maxImages?: number;
}

export interface AnalyzeImageDirectoryResult {
  directory: string;
  resolvedDirectory: string;
  model: string;
  imageCount: number;
  imageFiles: string[];
  prompt: string;
  response: string;
}

export interface AnalyzeVisionTargetsResult {
  targets: string[];
  resolvedTargets: string[];
  model: string;
  imageCount: number;
  imageFiles: string[];
  prompt: string;
  response: string;
}

export class OllamaVisionService {
  constructor(private readonly options: OllamaVisionServiceOptions) {}

  async analyzeDirectory(input: AnalyzeImageDirectoryInput): Promise<AnalyzeImageDirectoryResult> {
    const result = await this.analyzeTargets({
      targets: [input.directory],
      prompt: input.prompt,
      model: input.model,
      maxImages: input.maxImages,
    });

    return {
      directory: input.directory,
      resolvedDirectory: result.resolvedTargets[0] || input.directory,
      model: result.model,
      imageCount: result.imageCount,
      imageFiles: result.imageFiles,
      prompt: result.prompt,
      response: result.response,
    };
  }

  async analyzeTargets(input: AnalyzeVisionTargetsInput): Promise<AnalyzeVisionTargetsResult> {
    const normalizedTargets = Array.from(new Set(input.targets.map(target => target.trim()).filter(Boolean)));
    if (normalizedTargets.length === 0) {
      throw new Error('至少需要提供一个图片文件或目录。');
    }

    const resolvedTargets = normalizedTargets.map(target => resolveUserPath(target, {
      workspace: this.options.workspace,
      appBaseDir: this.options.appBaseDir,
      artifactOutputDir: this.options.artifactOutputDir,
      documentOutputDir: this.options.documentOutputDir,
      homeDir: this.options.homeDir,
    }));

    const imageFiles = await collectImageFilesFromTargets(
      resolvedTargets,
      input.maxImages ?? this.options.ollamaConfig.visionMaxImages ?? 12,
    );
    if (imageFiles.length === 0) {
      throw new Error('指定目标中没有可分析的图片文件。支持 png/jpg/jpeg/webp/gif/bmp。');
    }

    const model = input.model?.trim() || this.options.ollamaConfig.visionModel || 'minicpm-v';
    const prompt = buildVisionPrompt(input.prompt, imageFiles.map(file => path.basename(file)), resolvedTargets);
    const images = await Promise.all(imageFiles.map(file => readImageAsBase64(file)));
    const client = new OllamaClient({
      ...this.options.ollamaConfig,
      model,
    });
    const response = await client.generate(buildVisionMessages(prompt), { images });

    return {
      targets: normalizedTargets,
      resolvedTargets,
      model,
      imageCount: imageFiles.length,
      imageFiles,
      prompt,
      response,
    };
  }
}

export async function collectImageFiles(directory: string, maxImages: number): Promise<string[]> {
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`图片目录不存在或不是文件夹: ${directory}`);
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map(entry => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'))
    .slice(0, Math.max(1, maxImages));
}

export async function collectImageFilesFromTargets(targets: string[], maxImages: number): Promise<string[]> {
  const files: string[] = [];
  for (const target of targets) {
    if (files.length >= maxImages) {
      break;
    }

    const stat = await fs.stat(target).catch(() => null);
    if (!stat) {
      continue;
    }

    if (stat.isDirectory()) {
      const remaining = Math.max(1, maxImages - files.length);
      files.push(...await collectImageFiles(target, remaining));
      continue;
    }

    if (stat.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase())) {
      files.push(target);
    }
  }

  return files.slice(0, Math.max(1, maxImages));
}

export async function readImageAsBase64(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

export function buildVisionPrompt(userPrompt: string | undefined, fileNames: string[], resolvedTargets: string[] = []): string {
  const normalizedPrompt = userPrompt?.trim() || '请逐张识别这些图片的主要内容，并给出整体总结、异常点和建议。';
  return [
    '你是一个图片理解助手，将收到一个或多个目录/文件中的图片。',
    resolvedTargets.length > 0 ? `输入目标: ${resolvedTargets.join(', ')}` : undefined,
    `图片数量: ${fileNames.length}`,
    `文件顺序: ${fileNames.join(', ')}`,
    '请按图片顺序输出观察结果；如果有明显重复、异常、质量问题或关键差异，也请指出。',
    normalizedPrompt,
  ].filter(Boolean).join('\n');
}

function buildVisionMessages(prompt: string): Message[] {
  return [{ role: 'user', content: prompt }];
}

export function createOllamaVisionService(options: OllamaVisionServiceOptions): OllamaVisionService {
  return new OllamaVisionService(options);
}