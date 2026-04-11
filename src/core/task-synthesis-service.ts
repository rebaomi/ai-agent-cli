import type { MemoryProvider } from './memory-provider.js';

export interface TaskSynthesisMemorySyncEvent {
  backend: 'local' | 'mempalace' | 'hybrid';
  status: 'archived' | 'failed' | 'skipped';
  detail?: string;
  content: string;
}

export interface TaskSynthesisServiceOptions {
  memoryProvider?: MemoryProvider;
  agentRole?: string;
  onResponse?: (content: string) => void;
  onMemorySync?: (event: TaskSynthesisMemorySyncEvent) => void;
  now?: () => Date;
}

export class TaskSynthesisService {
  constructor(private readonly options: TaskSynthesisServiceOptions) {}

  async synthesizeResults(originalTask: string, stepResults: string[]): Promise<string> {
    const failedSteps = stepResults.filter(result => result.includes('失败')).length;
    const completedSteps = stepResults.length - failedSteps;
    const totalSteps = stepResults.length;
    const allSucceeded = failedSteps === 0 && totalSteps > 0;
    const partiallySucceeded = failedSteps > 0 && completedSteps > 0;
    const overallStatus = allSucceeded ? 'completed' : partiallySucceeded ? 'partial' : 'failed';

    let finalResponse = allSucceeded
      ? '## ✅ 任务完成\n\n'
      : partiallySucceeded
        ? '## ⚠️ 任务部分完成\n\n'
        : '## ❌ 任务失败\n\n';
    finalResponse += `**原始任务**: ${originalTask}\n\n`;
    finalResponse += '**执行摘要**:\n\n';

    for (let index = 0; index < stepResults.length; index += 1) {
      finalResponse += `### 步骤 ${index + 1}\n${stepResults[index]}\n\n`;
    }

    finalResponse += `---\n**完成进度**: ${completedSteps}/${totalSteps} 步骤成功完成`;
    if (!allSucceeded) {
      finalResponse += `\n**最终状态**: ${partiallySucceeded ? '部分完成，至少一个关键步骤失败。' : '执行失败，未达到任务要求。'}`;
    }
    finalResponse += `\n\n**下一步建议**: ${this.buildNextStepSuggestion(overallStatus)}`;

    await this.archiveTaskSummary(
      originalTask,
      stepResults,
      completedSteps,
      totalSteps,
      overallStatus,
    );

    this.options.onResponse?.(finalResponse);
    return finalResponse;
  }

  private async archiveTaskSummary(
    originalTask: string,
    stepResults: string[],
    completedSteps: number,
    totalSteps: number,
    status: 'completed' | 'partial' | 'failed',
  ): Promise<void> {
    if (!this.options.memoryProvider) {
      this.options.onMemorySync?.({
        backend: 'local',
        status: 'skipped',
        detail: 'provider_missing',
        content: 'Memory provider 未启用，跳过长期归档。',
      });
      return;
    }

    const summaryLines = stepResults
      .map(result => result.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 4);
    const entry = [
      `DATE:${(this.options.now?.() || new Date()).toISOString().slice(0, 10)}`,
      `TASK:${originalTask}`,
      `STATUS:${status}`,
      `PROGRESS:${completedSteps}/${totalSteps}`,
      summaryLines.length > 0 ? `SUMMARY:${summaryLines.join(' | ')}` : undefined,
      'IMPORTANCE:★★★',
    ].filter(Boolean).join('\n');

    try {
      await this.options.memoryProvider.store({
        kind: 'task',
        title: originalTask,
        content: entry,
        metadata: {
          completedSteps,
          totalSteps,
          agentRole: this.options.agentRole || 'ai-agent-cli',
        },
      });
      this.options.onMemorySync?.({
        backend: this.options.memoryProvider.backend,
        status: 'archived',
        detail: 'task_summary',
        content: 'Memory provider 已归档本次任务摘要。',
      });
    } catch (error) {
      this.options.onMemorySync?.({
        backend: this.options.memoryProvider.backend,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
        content: `Memory provider 归档失败: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private buildNextStepSuggestion(status: 'completed' | 'partial' | 'failed'): string {
    if (status === 'completed') {
      return '如果你愿意，我可以继续帮你做结果验证、补测试/文档，或者把这次流程沉淀成可复用模板。';
    }

    if (status === 'partial') {
      return '如果你愿意，我可以先定位失败步骤，再继续补跑剩余部分，或者把当前已完成结果整理成可交付输出。';
    }

    return '如果你愿意，我可以先排查失败原因，缩小问题范围，再给你一个更稳的修复或执行方案。';
  }
}