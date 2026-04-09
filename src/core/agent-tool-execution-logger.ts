import chalk from 'chalk';
import type { ToolResult } from '../types/index.js';
import type { ToolExecutionEvent } from './tool-executor.js';

export interface AgentToolExecutionLoggerOptions {
  getToolResultText: (result: ToolResult) => string;
}

export class AgentToolExecutionLogger {
  constructor(private readonly options: AgentToolExecutionLoggerOptions) {}

  logImmediateResult(result: ToolResult): void {
    console.log(chalk.gray(`[TOOL] Result: ${this.toPreview(result)}...`));
  }

  logExecutionEvent(event: ToolExecutionEvent): void {
    if (event.phase === 'start') {
      console.log(chalk.gray(`\n[TOOL] Executing: ${event.context.name}`));
      console.log(chalk.gray(`[TOOL] Args: ${JSON.stringify(event.context.args)}`));
      return;
    }

    if (event.phase === 'error') {
      const message = event.error instanceof Error ? event.error.message : String(event.error);
      console.log(chalk.red(`[TOOL] Error (${event.durationMs}ms): ${message}`));
      return;
    }

    const painter = event.result.is_error ? chalk.red : chalk.gray;
    console.log(painter(`[TOOL] Result (${event.durationMs}ms): ${this.toPreview(event.result)}...`));
  }

  private toPreview(result: ToolResult): string {
    return this.options.getToolResultText(result).substring(0, 200) || '(empty)';
  }
}