import type { DirectActionResult } from '../direct-action-router.js';

export type ConvertibleFormat = 'md' | 'txt' | 'docx' | 'pdf' | 'xlsx' | 'pptx';
type SourceFormat = ConvertibleFormat | 'csv' | 'tsv';

export interface LarkWorkflowRuntime {
  handleLarkWorkflow: (input: string) => Promise<DirectActionResult | null>;
}

export interface ExternalSearchRuntime {
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  resolveOutputArtifactPath: (outputPath: string) => string;
}

export interface FileActionRuntime {
  workspace: string;
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  normalizePath: (value: string) => string;
  splitExplicitPaths: (input: string) => string[];
  stripDirectorySuffix: (value: string) => string;
  normalizeSearchQuery: (value: string) => string;
  normalizeGlobPattern: (value: string) => string;
  detectTextFormat: (input: string) => 'markdown' | 'text' | null;
  resolveDirectSourceText: (input: string) => string;
  extractRequestedFileName: (input: string) => string | null;
  inferTextOutputPath: (input: string, fileBaseName: string, extension: '.md' | '.txt') => string;
}

export interface DocumentActionRuntime {
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  executeSkillTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  detectConvertibleFormat: (input: string) => ConvertibleFormat | null;
  findConvertibleSourceFilePath: (input: string, targetFormat: ConvertibleFormat) => Promise<string>;
  resolveDirectSourceText: (input: string) => string;
  extractRequestedFileName: (input: string) => string | null;
  inferConversionOutputPath: (input: string, fileBaseName: string, format: ConvertibleFormat) => string;
  resolveDocumentExportTool: (format: ConvertibleFormat) => string | null;
  hasBuiltInTool: (name: string) => boolean;
  detectFormatFromPath: (value: string) => SourceFormat | null;
  formatLabel: (format: ConvertibleFormat) => string;
  isUnavailableDocxSkillResult: (format: ConvertibleFormat, output: string) => boolean;
  buildKnownGapResult: (input: string, detail: string, fallbacks: string[]) => Promise<DirectActionResult>;
  verifyDocumentExportResult: (result: DirectActionResult, outputPath: string, format: 'docx' | 'pdf' | 'xlsx' | 'pptx', expectedText?: string, expectedTitle?: string) => Promise<DirectActionResult>;
}