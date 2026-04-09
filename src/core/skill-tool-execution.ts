import type { ToolResult } from '../types/index.js';
import type { SkillContext, SkillManager, SkillToolResult } from './skills.js';
import { normalizeSkillExecutionError } from './skill-execution-error.js';

export interface NormalizedSkillToolExecution {
  output: string;
  content: ToolResult['content'];
  isError?: boolean;
}

export async function executeSkillToolWithContext(
  skillManager: SkillManager,
  name: string,
  args: Record<string, unknown>,
  context: SkillContext,
): Promise<NormalizedSkillToolExecution> {
  try {
    const result = await skillManager.executeTool(name, args, context);
    return normalizeSkillToolResult(result);
  } catch (error) {
    const output = normalizeSkillExecutionError(name, error);
    return {
      output,
      content: [{ type: 'text', text: output }],
      isError: true,
    };
  }
}

export function normalizeSkillToolResult(result: SkillToolResult): NormalizedSkillToolExecution {
  return {
    output: skillToolResultToText(result),
    content: result.content,
    isError: result.isError,
  };
}

export function skillToolResultToText(result: Pick<SkillToolResult, 'content'>): string {
  return result.content
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n');
}