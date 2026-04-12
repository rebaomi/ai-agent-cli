import type { LLMProviderInterface } from '../llm/types.js';
import type { Plan } from './planner.js';
import type { SkillCandidateRefinement, SkillLearningTodo } from './skills.js';
import { looksLikePlaceholderContent } from '../utils/docx-validation.js';

export interface SkillLearningCandidate {
  name: string;
  path: string;
  sourceTask: string;
  confidence?: number;
}

export interface SkillLearningManager {
  maybeCreateCandidateFromExecution?: (input: {
    originalTask: string;
    stepDescriptions: string[];
    stepResults: string[];
    completedSteps: number;
    totalSteps: number;
    refinement?: SkillCandidateRefinement;
  }) => Promise<SkillLearningCandidate | null>;
  addLearningTodo?: (input: Omit<SkillLearningTodo, 'id' | 'createdAt'>) => Promise<SkillLearningTodo>;
}

export interface SkillLearningServiceOptions {
  llm: Pick<LLMProviderInterface, 'generate'>;
  skillManager?: SkillLearningManager;
  onSkillLearning?: (candidate: SkillLearningCandidate) => void;
  onSkillLearningTodo?: (todo: SkillLearningTodo) => void;
  onSkip?: (message: string) => void;
}

type LearningTodoAssessment = {
  shouldTrack: boolean;
  issueSummary: string;
  suggestedSkill: string;
  blockers: string[];
  nextActions: string[];
  tags: string[];
  confidence?: number;
};

export class SkillLearningService {
  constructor(private readonly options: SkillLearningServiceOptions) {}

  async processExecution(originalTask: string, plan: Plan, stepResults: string[]): Promise<void> {
    await this.maybeLearnSkillCandidate(originalTask, plan, stepResults);
    await this.maybeCaptureLearningTodo(originalTask, plan, stepResults);
  }

  private async maybeLearnSkillCandidate(originalTask: string, plan: Plan, stepResults: string[]): Promise<void> {
    if (!this.options.skillManager || typeof this.options.skillManager.maybeCreateCandidateFromExecution !== 'function') {
      return;
    }

    const completedSteps = stepResults.filter(result => !result.includes('失败')).length;
    try {
      const refinement = await this.assessSkillCandidateDraft(originalTask, plan, stepResults, completedSteps);
      const candidate = await this.options.skillManager.maybeCreateCandidateFromExecution({
        originalTask,
        stepDescriptions: plan.steps.map(step => step.description),
        stepResults,
        completedSteps,
        totalSteps: plan.steps.length,
        refinement,
      });

      if (candidate) {
        this.options.onSkillLearning?.(candidate);
      }
    } catch (error) {
      this.options.onSkip?.(`Skill learning skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async maybeCaptureLearningTodo(originalTask: string, plan: Plan, stepResults: string[]): Promise<void> {
    if (!this.options.skillManager || typeof this.options.skillManager.addLearningTodo !== 'function') {
      return;
    }

    const failedResults = stepResults.filter(result => result.includes('失败'));
    if (failedResults.length === 0) {
      return;
    }

    if (this.shouldSkipLearningTodo(failedResults)) {
      this.options.onSkip?.('Skill learning todo skipped: failure looks like an execution bug or placeholder artifact, not a reusable skill gap.');
      return;
    }

    const suggestion = await this.assessLearningTodo(originalTask, plan, stepResults);
    if (!suggestion.shouldTrack) {
      return;
    }

    try {
      const todo = await this.options.skillManager.addLearningTodo({
        sourceTask: originalTask,
        issueSummary: suggestion.issueSummary,
        suggestedSkill: suggestion.suggestedSkill,
        blockers: suggestion.blockers,
        nextActions: suggestion.nextActions,
        tags: suggestion.tags,
        confidence: suggestion.confidence,
      });

      this.options.onSkillLearningTodo?.(todo);
    } catch (error) {
      this.options.onSkip?.(`Skill learning todo skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async assessSkillCandidateDraft(
    originalTask: string,
    plan: Plan,
    stepResults: string[],
    completedSteps: number,
  ): Promise<SkillCandidateRefinement | undefined> {
    const fallback = this.buildFallbackSkillCandidateRefinement(originalTask, plan, stepResults, completedSteps);

    try {
      const response = await this.options.llm.generate([
        {
          role: 'system',
          content: [
            '你是 procedural skill reviewer。你的任务是在候选 skill 落盘前做一次自检与精炼。',
            '请判断这个成功任务是否值得沉淀成可复用 procedural skill，并输出 JSON。',
            '返回格式：',
            '{',
            '  "shouldCreate": true,',
            '  "confidence": 0.0,',
            '  "refinedDescription": "一句更稳定的技能描述",',
            '  "whenToUse": "适用任务描述",',
            '  "procedure": ["步骤1", "步骤2"],',
            '  "verification": ["验证点1", "验证点2"],',
            '  "tags": ["tag1", "tag2"],',
            '  "qualitySummary": "简短评估摘要",',
            '  "suggestedName": "skill name hint"',
            '}',
            '要求：',
            '- 如果流程过于一次性、环境偶然性太强或步骤不稳定，就 shouldCreate=false。',
            '- confidence 取值 0 到 1。',
            '- procedure 必须是可复用、抽象后的步骤，不要照抄原始日志。',
            '- 只返回 JSON。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `任务: ${originalTask}`,
            `完成进度: ${completedSteps}/${plan.steps.length}`,
            '计划步骤:',
            ...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
            '执行结果:',
            ...stepResults.map((result, index) => `${index + 1}. ${result.replace(/\s+/g, ' ').slice(0, 400)}`),
          ].join('\n'),
        },
      ]);

      const parsed = this.parseSkillCandidateRefinement(response);
      if (!parsed) {
        return fallback;
      }

      return {
        ...fallback,
        ...parsed,
        procedure: parsed.procedure && parsed.procedure.length > 0 ? parsed.procedure : fallback.procedure,
        verification: parsed.verification && parsed.verification.length > 0 ? parsed.verification : fallback.verification,
        tags: parsed.tags && parsed.tags.length > 0 ? parsed.tags : fallback.tags,
      };
    } catch {
      return fallback;
    }
  }

  private parseSkillCandidateRefinement(response: string): SkillCandidateRefinement | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    const raw = jsonMatch?.[1] ?? jsonMatch?.[2] ?? response;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        shouldCreate: typeof parsed.shouldCreate === 'boolean' ? parsed.shouldCreate : undefined,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
        refinedDescription: typeof parsed.refinedDescription === 'string' ? parsed.refinedDescription.trim() : undefined,
        whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse.trim() : undefined,
        procedure: Array.isArray(parsed.procedure) ? parsed.procedure.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined,
        verification: Array.isArray(parsed.verification) ? parsed.verification.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined,
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined,
        qualitySummary: typeof parsed.qualitySummary === 'string' ? parsed.qualitySummary.trim() : undefined,
        suggestedName: typeof parsed.suggestedName === 'string' ? parsed.suggestedName.trim() : undefined,
      };
    } catch {
      return null;
    }
  }

  private buildFallbackSkillCandidateRefinement(
    originalTask: string,
    plan: Plan,
    stepResults: string[],
    completedSteps: number,
  ): SkillCandidateRefinement {
    const shortenedTask = originalTask.replace(/\s+/g, ' ').trim();
    return {
      shouldCreate: completedSteps === plan.steps.length && plan.steps.length >= 2,
      confidence: completedSteps === plan.steps.length ? 0.68 : 0.4,
      refinedDescription: `Reusable draft skill for: ${shortenedTask.slice(0, 100)}`,
      whenToUse: shortenedTask,
      procedure: plan.steps.map(step => step.description),
      verification: [
        '确认输出物与本次任务结果一致。',
        '确认步骤不依赖一次性环境状态或手动上下文。',
      ],
      tags: this.extractProceduralTags(originalTask, plan.steps.map(step => step.description), stepResults),
      qualitySummary: 'Fallback self-review: completed workflow with reusable multi-step structure.',
    };
  }

  private async assessLearningTodo(
    originalTask: string,
    plan: Plan,
    stepResults: string[],
  ): Promise<LearningTodoAssessment> {
    const fallback: LearningTodoAssessment = {
      shouldTrack: true,
      issueSummary: '任务在执行过程中存在未解决的步骤失败，适合沉淀为待学习 skill。',
      suggestedSkill: this.deriveSuggestedSkillName(originalTask),
      blockers: stepResults.filter(result => result.includes('失败')).map(result => result.replace(/\s+/g, ' ').slice(0, 180)),
      nextActions: ['分析失败步骤的缺口。', '确认是否需要新 skill 或补强现有 skill。', '复盘并抽象可复用流程。'],
      tags: this.extractProceduralTags(originalTask, plan.steps.map(step => step.description), stepResults),
      confidence: 0.74,
    };

    try {
      const response = await this.options.llm.generate([
        {
          role: 'system',
          content: [
            '你是 Hermes 风格的 skill gap reviewer。',
            '任务失败或未解决时，请判断是否值得加入待学习 skill todo。',
            '只返回 JSON：',
            '{',
            '  "shouldTrack": true,',
            '  "issueSummary": "问题摘要",',
            '  "suggestedSkill": "建议学习的 skill 名称或方向",',
            '  "blockers": ["阻塞点1"],',
            '  "nextActions": ["下一步1"],',
            '  "tags": ["tag1"],',
            '  "confidence": 0.0',
            '}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `任务: ${originalTask}`,
            '计划步骤:',
            ...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
            '步骤结果:',
            ...stepResults.map((result, index) => `${index + 1}. ${result.replace(/\s+/g, ' ').slice(0, 400)}`),
          ].join('\n'),
        },
      ]);

      const parsed = this.parseLearningTodoAssessment(response);
      return parsed || fallback;
    } catch {
      return fallback;
    }
  }

  private parseLearningTodoAssessment(response: string): LearningTodoAssessment | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    const raw = jsonMatch?.[1] ?? jsonMatch?.[2] ?? response;

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const suggestedSkill = typeof parsed.suggestedSkill === 'string' ? parsed.suggestedSkill.trim() : '';
      const issueSummary = typeof parsed.issueSummary === 'string' ? parsed.issueSummary.trim() : '';
      if (!suggestedSkill || !issueSummary) {
        return null;
      }

      return {
        shouldTrack: typeof parsed.shouldTrack === 'boolean' ? parsed.shouldTrack : true,
        issueSummary,
        suggestedSkill,
        blockers: Array.isArray(parsed.blockers) ? parsed.blockers.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [],
        nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      };
    } catch {
      return null;
    }
  }

  private deriveSuggestedSkillName(originalTask: string): string {
    return originalTask
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'learn-skill-gap';
  }

  private shouldSkipLearningTodo(failedResults: string[]): boolean {
    return failedResults.some(result => {
      const normalized = result.replace(/\s+/g, ' ').trim();
      if (/enoent:.*\$[A-Z_][A-Z0-9_]*/i.test(normalized) || /stat '.*\$[A-Z_][A-Z0-9_]*'/i.test(normalized)) {
        return true;
      }

      if (/正文校验失败|缺少预期内容/i.test(normalized) && looksLikePlaceholderContent(normalized)) {
        return true;
      }

      return false;
    });
  }

  private extractProceduralTags(originalTask: string, stepDescriptions: string[], stepResults: string[]): string[] {
    const corpus = [originalTask, ...stepDescriptions, ...stepResults].join(' ').toLowerCase();
    const tags = new Set<string>();
    const tagRules: Array<[RegExp, string]> = [
      [/(日志|log)/i, 'logs'],
      [/(日报|report)/i, 'report'],
      [/(文档|docx|word|pdf|markdown|md)/i, 'document'],
      [/(搜索|查找|grep|find)/i, 'search'],
      [/(导出|输出|保存)/i, 'export'],
      [/(代码|code|typescript|javascript)/i, 'code'],
      [/(表格|excel|xlsx|csv)/i, 'spreadsheet'],
    ];

    for (const [pattern, tag] of tagRules) {
      if (pattern.test(corpus)) {
        tags.add(tag);
      }
    }

    return Array.from(tags).slice(0, 8);
  }
}