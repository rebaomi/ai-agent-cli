import type { ToolCall } from '../types/index.js';
import type { LLMProviderInterface } from '../llm/types.js';
import {
  TOOL_INTENT_CONTRACT_PROMPT,
  buildFallbackIntentContract,
  parseIntentContractResponse,
  type IntentContract,
} from './tool-intent-contract.js';
import { validateToolCallsAgainstContract } from './tool-call-validator.js';

export interface ToolCallPreparationPolicyOptions {
  llm: LLMProviderInterface;
  availableToolNames: string[] | (() => string[]);
  onThinking?: (message: string) => void;
}

export interface ToolCallPreparationResult {
  contract: IntentContract;
  toolCalls: ToolCall[];
  rejections: Array<{ toolCall: ToolCall; reason: string }>;
}

export class ToolCallPreparationPolicy {
  constructor(private readonly options: ToolCallPreparationPolicyOptions) {}

  async prepare(
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ): Promise<ToolCallPreparationResult> {
    const contract = await this.resolveIntentContract(userInput, assistantContent, toolCalls, useModelContract);
    const validation = validateToolCallsAgainstContract(contract, toolCalls, this.getAvailableToolNames());

    if (validation.corrections.length > 0) {
      this.options.onThinking?.(`Intent contract 已校正工具调用：${validation.corrections.join('；')}`);
    }

    if (validation.rejections.length > 0) {
      this.options.onThinking?.(`Intent contract 拒绝了 ${validation.rejections.length} 个不一致的工具调用。`);
    }

    return {
      contract,
      toolCalls: validation.toolCalls,
      rejections: validation.rejections,
    };
  }

  private getAvailableToolNames(): string[] {
    return typeof this.options.availableToolNames === 'function'
      ? this.options.availableToolNames()
      : this.options.availableToolNames;
  }

  async resolveIntentContract(
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ): Promise<IntentContract> {
    const fallback = buildFallbackIntentContract(userInput, toolCalls);
    if (!useModelContract) {
      return fallback;
    }

    try {
      const response = await this.options.llm.generate([
        { role: 'system', content: TOOL_INTENT_CONTRACT_PROMPT },
        {
          role: 'user',
          content: [
            `用户请求: ${userInput}`,
            `assistant 当前输出: ${assistantContent}`,
            `拟调用工具: ${toolCalls.map(toolCall => `${toolCall.function.name} ${toolCall.function.arguments}`).join(' | ')}`,
          ].join('\n'),
        },
      ]);

      const parsed = parseIntentContractResponse(response);
      if (!parsed) {
        return fallback;
      }

      return {
        action: parsed.action || fallback.action,
        summary: parsed.summary || fallback.summary,
        targetFormat: parsed.targetFormat || fallback.targetFormat,
        sourceHint: parsed.sourceHint || fallback.sourceHint,
        confidence: parsed.confidence ?? fallback.confidence,
      };
    } catch {
      return fallback;
    }
  }
}

export function prepareToolCallArgs(
  argsStr: string,
  resolveArgs: (args: Record<string, unknown>) => Record<string, unknown>,
): { args: Record<string, unknown> } | { error: string } {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsStr);
  } catch {
    return { error: 'Invalid JSON arguments' };
  }

  return { args: resolveArgs(args) };
}