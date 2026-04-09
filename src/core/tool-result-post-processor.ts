import type { ToolResult } from '../types/index.js';
import { ExportArtifactManager } from './export-artifact-manager.js';
import type { MemoryProvider } from './memory-provider.js';

export interface ToolResultPostProcessorOptions {
  config?: Record<string, unknown>;
  memoryProvider?: MemoryProvider;
}

export interface ToolResultPostProcessOutcome {
  result: ToolResult;
  reusableContent?: string;
}

export class ToolResultPostProcessor {
  private readonly exportArtifactManager: ExportArtifactManager;

  constructor(options: ToolResultPostProcessorOptions) {
    this.exportArtifactManager = new ExportArtifactManager({
      config: options.config,
      memoryProvider: options.memoryProvider,
    });
  }

  async process(name: string, args: Record<string, unknown>, result: ToolResult): Promise<ToolResultPostProcessOutcome> {
    if (result.is_error) {
      return { result };
    }

    const reusableContent = this.extractReusableContentFromTool(name, args, result).trim() || undefined;
    const exportValidationError = await this.exportArtifactManager.validateSuccessfulExportResult(name, args);
    if (exportValidationError) {
      return {
        result: {
          tool_call_id: result.tool_call_id,
          output: exportValidationError,
          is_error: true,
        },
        reusableContent,
      };
    }

    await this.exportArtifactManager.rememberSuccessfulToolResult(name, args);

    return {
      result,
      reusableContent,
    };
  }

  private extractReusableContentFromTool(name: string, args: Record<string, unknown>, result: ToolResult): string {
    if (/^(write_file)$/i.test(name)) {
      const targetPath = typeof args.path === 'string' ? args.path : '';
      if (/\.(txt|md|markdown|csv|tsv)$/i.test(targetPath) && typeof args.content === 'string') {
        return args.content;
      }
    }

    if (/^(read_file|read_multiple_files|tencent_hot_news|tencent_search_news|tencent_morning_news|tencent_evening_news)$/i.test(name)) {
      return this.getToolResultText(result);
    }

    return '';
  }

  private getToolResultText(result: ToolResult): string {
    if (typeof result.output === 'string' && result.output.length > 0) {
      return result.output;
    }

    if (Array.isArray(result.content)) {
      return result.content
        .filter(item => item.type === 'text' && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n');
    }

    return '';
  }
}
