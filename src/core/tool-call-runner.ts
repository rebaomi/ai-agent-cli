import { createRejectedToolResult } from './tool-call-validator.js';
import type { ToolCall, ToolResult } from '../types/index.js';

export interface PreparedToolCallBatch {
  toolCalls: ToolCall[];
  rejections: Array<{ toolCall: ToolCall; reason: string }>;
}

export interface ToolCallRunnerOptions {
  executeToolCall: (toolCall: ToolCall) => Promise<ToolResult>;
  getToolResultText: (result: ToolResult) => string;
  incrementToolCallCount?: () => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (result: ToolResult, toolOutput: string) => void;
  onRejectedToolResult?: (toolCall: ToolCall, result: ToolResult, toolOutput: string) => void;
  onToolMessage?: (toolCall: ToolCall, toolOutput: string) => void;
}

export interface ToolCallRunBehavior {
  throwOnRejection?: boolean;
  throwOnToolError?: boolean;
  collectOutputs?: boolean;
}

export interface ToolCallRunResult {
  outputs: string[];
}

export class ToolCallRunner {
  constructor(private readonly options: ToolCallRunnerOptions) {}

  async run(batch: PreparedToolCallBatch, behavior: ToolCallRunBehavior = {}): Promise<ToolCallRunResult> {
    const outputs: string[] = [];

    for (const rejected of batch.rejections) {
      const result = createRejectedToolResult(rejected.toolCall.id, rejected.reason);
      const toolOutput = this.options.getToolResultText(result);

      this.options.onRejectedToolResult?.(rejected.toolCall, result, toolOutput);
      this.options.onToolResult?.(result, toolOutput);
      this.options.onToolMessage?.(rejected.toolCall, toolOutput);

      if (behavior.throwOnRejection) {
        throw new Error(toolOutput || `${rejected.toolCall.function.name} 被 intent contract 拒绝`);
      }
    }

    for (const toolCall of batch.toolCalls) {
      this.options.incrementToolCallCount?.();
      this.options.onToolCall?.(toolCall);

      const result = await this.options.executeToolCall(toolCall);
      const toolOutput = this.options.getToolResultText(result);

      this.options.onToolResult?.(result, toolOutput);
      this.options.onToolMessage?.(toolCall, toolOutput);

      if (behavior.collectOutputs) {
        outputs.push(`[${toolCall.function.name}]\n${toolOutput || '(无输出)'}`);
      }

      if (behavior.throwOnToolError && result.is_error) {
        throw new Error(toolOutput || `${toolCall.function.name} 执行失败`);
      }
    }

    return { outputs };
  }
}