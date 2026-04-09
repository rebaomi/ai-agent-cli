import type { SkillManager } from '../skills.js';
import type { DirectActionResult } from '../direct-action-router.js';

export class DirectActionKnownGapSupport {
  constructor(private readonly skillManager: SkillManager) {}

  async buildKnownGapResult(input: string, detail: string, fallbacks: string[]): Promise<DirectActionResult> {
    const prefix = await this.getKnownGapPrefix(input);
    const message = [
      prefix || '这是当前能力缺口。',
      detail,
      fallbacks.length > 0 ? `可行的降级方案：${fallbacks.join(' ')}` : '',
    ].filter(Boolean).join('\n\n');

    return {
      handled: true,
      title: '[Direct document conversion]',
      output: message,
      isError: true,
    };
  }

  private async getKnownGapPrefix(input: string): Promise<string> {
    if (typeof this.skillManager.searchLearningTodos !== 'function') {
      return '';
    }

    try {
      let strongest: { id: string; issueSummary: string; suggestedSkill: string; score: number } | undefined;
      for (const query of this.buildKnownGapQueries(input)) {
        const matches = await this.skillManager.searchLearningTodos(query, 1);
        const candidate = matches[0];
        if (candidate && candidate.score >= 0.55 && (!strongest || candidate.score > strongest.score)) {
          strongest = candidate;
        }
      }

      if (!strongest) {
        return '';
      }

      return `这是已知能力缺口：${strongest.issueSummary}（todo: ${strongest.id}，建议 skill: ${strongest.suggestedSkill}）。`;
    } catch {
      return '';
    }
  }

  private buildKnownGapQueries(input: string): string[] {
    const stripped = input.replace(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|csv|tsv|docx|pdf|xlsx|ppt|pptx))/gi, ' ');
    const formatTerms = Array.from(new Set((input.match(/docx|pdf|xlsx|pptx|ppt|markdown|md|txt|csv|tsv|excel|word|powerpoint/gi) || []).map(item => item.toLowerCase())));
    return Array.from(new Set([
      input.trim(),
      stripped.replace(/\s+/g, ' ').trim(),
      formatTerms.join(' 转 '),
    ].filter(Boolean)));
  }
}