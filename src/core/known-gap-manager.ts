import type { SkillLearningTodoSearchResult } from './skills.js';

export interface KnownGapSkillManager {
  searchLearningTodos?: (query: string, limit?: number) => Promise<SkillLearningTodoSearchResult[]>;
}

export class KnownGapManager {
  private currentNotice = '';
  private currentContext = '';

  constructor(private readonly skillManager?: KnownGapSkillManager) {}

  async prepare(input: string): Promise<void> {
    this.reset();

    if (!this.skillManager || typeof this.skillManager.searchLearningTodos !== 'function') {
      return;
    }

    try {
      const queries = this.buildQueries(input);
      let strongest: SkillLearningTodoSearchResult | undefined;

      for (const query of queries) {
        const matches = await this.skillManager.searchLearningTodos(query, 2);
        const candidate = matches.find(item => item.score >= 0.55);
        if (candidate && (!strongest || candidate.score > strongest.score)) {
          strongest = candidate;
        }
      }

      if (!strongest) {
        return;
      }

      this.currentNotice = `这是已知能力缺口：${strongest.issueSummary}（todo: ${strongest.id}，建议 skill: ${strongest.suggestedSkill}）。`;
      this.currentContext = [
        'Known skill gap detected for this task.',
        `Start by telling the user exactly this sentence: ${this.currentNotice}`,
        'Then decide whether a truthful downgrade path exists. If a downgrade is viable, explain the downgrade briefly and execute it. If not, say the capability is currently unavailable.',
        `Known blockers: ${(strongest.blockers || []).join(' | ') || 'n/a'}`,
        `Suggested next actions: ${(strongest.nextActions || []).join(' | ') || 'n/a'}`,
      ].join('\n');
    } catch {
      this.reset();
    }
  }

  getNotice(): string {
    return this.currentNotice;
  }

  getContext(): string {
    return this.currentContext;
  }

  applyNotice(response: string): string {
    const normalized = response.trim();
    if (!this.currentNotice) {
      return normalized;
    }

    if (!normalized) {
      return this.currentNotice;
    }

    if (normalized.startsWith(this.currentNotice) || normalized.includes('这是已知能力缺口')) {
      return normalized;
    }

    return `${this.currentNotice}\n\n${normalized}`;
  }

  private reset(): void {
    this.currentNotice = '';
    this.currentContext = '';
  }

  private buildQueries(input: string): string[] {
    const stripped = input.replace(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.(?:md|markdown|txt|docx|pdf|xlsx))/gi, ' ');
    const formatTerms = Array.from(new Set((input.match(/docx|pdf|xlsx|markdown|md|txt|excel|word/gi) || []).map(item => item.toLowerCase())));

    return Array.from(new Set([
      input.trim(),
      stripped.replace(/\s+/g, ' ').trim(),
      formatTerms.join(' 转 '),
    ].filter(Boolean)));
  }
}