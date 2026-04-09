import type { ToolCall, ToolResult } from '../types/index.js';
import type { IntentContract } from './tool-intent-contract.js';
import type { ToolCallPreparationPolicy } from './tool-call-preparation-policy.js';
import { prepareToolCallArgs } from './tool-call-preparation-policy.js';
import type { ToolExecutionGuard } from './tool-execution-guard.js';
import type { ToolRegistry } from './tool-registry.js';
import type { ToolResultPostProcessor } from './tool-result-post-processor.js';

export interface AgentToolCallServiceOptions {
  resolvePlannedToolArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  toolExecutionGuard: Pick<ToolExecutionGuard, 'authorize'>;
  toolRegistry: Pick<ToolRegistry, 'execute'>;
  toolResultPostProcessor: Pick<ToolResultPostProcessor, 'process'>;
  toolCallPreparationPolicy: Pick<ToolCallPreparationPolicy, 'prepare'>;
  setLastReusableContent: (content: string) => void;
}

export class AgentToolCallService {
  constructor(private readonly options: AgentToolCallServiceOptions) {}

  parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const regex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      try {
        const jsonStr = match[1];
        if (!jsonStr) {
          continue;
        }
        const parsed = JSON.parse(jsonStr);
        if (parsed.name && parsed.arguments) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments),
            },
          });
        }
      } catch {
        continue;
      }
    }

    return toolCalls;
  }

  async prepareToolCallsForExecution(
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ): Promise<{ contract: IntentContract; toolCalls: ToolCall[]; rejections: Array<{ toolCall: ToolCall; reason: string }> }> {
    return this.options.toolCallPreparationPolicy.prepare(userInput, assistantContent, toolCalls, useModelContract);
  }

  async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const { name, arguments: argsStr } = toolCall.function;
    const preparedArgs = prepareToolCallArgs(argsStr, (args) => this.options.resolvePlannedToolArgs(args));
    if ('error' in preparedArgs) {
      return {
        tool_call_id: toolCall.id,
        output: preparedArgs.error,
        is_error: true,
      };
    }

    const args = preparedArgs.args;
    const permissionDeniedResult = await this.options.toolExecutionGuard.authorize(name, args);
    if (permissionDeniedResult) {
      return this.withToolCallResultMetadata(toolCall.id, permissionDeniedResult);
    }

    const result = this.normalizeToolResult(await this.options.toolRegistry.execute(name, args));
    const outcome = await this.options.toolResultPostProcessor.process(name, args, result);
    if (outcome.reusableContent) {
      this.options.setLastReusableContent(outcome.reusableContent);
    }

    return this.withToolCallResultMetadata(toolCall.id, this.normalizeToolResult(outcome.result));
  }

  getToolResultText(result: ToolResult): string {
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

  private withToolCallResultMetadata(toolCallId: string, result: ToolResult): ToolResult {
    return {
      ...result,
      tool_call_id: toolCallId,
    };
  }

  private normalizeToolResult(result: ToolResult): ToolResult {
    return {
      ...result,
      is_error: result.is_error === true,
    };
  }
}