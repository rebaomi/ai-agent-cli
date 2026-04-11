import type { LLMProviderInterface } from '../../llm/types.js';
import type { BrowserActionProposal, BrowserAgentTask, BrowserExecutionTrace, BrowserPageDigest, BrowserPhaseSnapshot, BrowserScriptResultContract, BrowserWorkflow } from '../domain/types.js';

export interface BrowserActionPlan {
  source: 'rule' | 'llm';
  finalMessage?: string;
  actions: BrowserActionProposal[];
}

export interface BrowserActionPlannerOptions {
  plannerClient: LLMProviderInterface;
  maxActionsPerPlan: number;
}

const ACTION_TYPES = new Set<BrowserActionProposal['type']>(['navigate', 'click', 'fill', 'press', 'extract', 'wait', 'evaluate_script', 'call_userscript_api', 'toggle_userscript_mode', 'done']);

export class BrowserActionPlanner {
  constructor(private readonly options: BrowserActionPlannerOptions) {}

  async createPlan(
    task: BrowserAgentTask,
    digest: BrowserPageDigest,
    traces: BrowserExecutionTrace[],
    options?: {
      previousDigest?: BrowserPageDigest;
      diffSummary?: string;
      allowFastPath?: boolean;
      workflows?: BrowserWorkflow[];
      phase?: BrowserPhaseSnapshot;
    },
  ): Promise<BrowserActionPlan> {
    const heuristic = this.createHeuristicPlan(task, digest, options?.phase);

    if (options?.allowFastPath !== false && this.shouldUseFastPath(heuristic)) {
      return heuristic;
    }

    try {
      const raw = await this.options.plannerClient.generate(this.buildPrompt(task, digest, traces, heuristic, options?.previousDigest, options?.diffSummary, options?.workflows, options?.phase));
      const parsed = this.parsePlan(raw, options?.workflows, options?.phase);
      if (parsed.actions.length > 0 || parsed.finalMessage) {
        return parsed;
      }
    } catch {
      // fall through to heuristic plan
    }

    return heuristic;
  }

  private buildPrompt(
    task: BrowserAgentTask,
    digest: BrowserPageDigest,
    traces: BrowserExecutionTrace[],
    heuristic: BrowserActionPlan,
    previousDigest?: BrowserPageDigest,
    diffSummary?: string,
    workflows?: BrowserWorkflow[],
    phase?: BrowserPhaseSnapshot,
  ): string {
    const recentTraces = traces.slice(-6).map(trace => `- [${trace.status}] ${trace.summary}`).join('\n') || '- none';
    const interactiveDetails = (digest.interactiveElements || [])
      .slice(0, 20)
      .map(element => `${element.selector} | role=${element.role} | text=${element.text || '-'} | type=${element.type || '-'} | placeholder=${element.placeholder || '-'} | href=${element.href || '-'}`)
      .join('\n') || 'none';

    const workflowContext = (workflows || [])
      .slice(0, 3)
      .map(workflow => {
        const currentPhaseConfig = phase ? workflow.phaseConfigurations[phase.phase] : undefined;
        const lines = [
          `- Workflow: ${workflow.name}`,
          `  Description: ${workflow.description}`,
          workflow.whenToUse ? `  When to Use: ${workflow.whenToUse}` : '',
          workflow.startUrl ? `  Start URL: ${workflow.startUrl}` : '',
          workflow.matchPatterns.length > 0 ? `  Match: ${workflow.matchPatterns.join(', ')}` : '',
          workflow.steps.length > 0 ? `  Steps: ${workflow.steps.join(' | ')}` : '',
          workflow.hints.length > 0 ? `  Hints: ${workflow.hints.join(' | ')}` : '',
          workflow.successCriteria.length > 0 ? `  Success: ${workflow.successCriteria.join(' | ')}` : '',
          Object.keys(workflow.selectorSlots).length > 0 ? `  Selector Slots: ${Object.entries(workflow.selectorSlots).map(([key, values]) => `${key}=${values.join(' | ')}`).join('; ')}` : '',
          Object.keys(workflow.preferredSelectors).length > 0 ? `  Preferred Selectors: ${Object.entries(workflow.preferredSelectors).map(([key, values]) => `${key}=${values.join(' | ')}`).join('; ')}` : '',
          Object.keys(workflow.fallbackActions).length > 0 ? `  Fallback Actions: ${Object.entries(workflow.fallbackActions).map(([key, values]) => `${key}=${values.join(' | ')}`).join('; ')}` : '',
          workflow.doneConditions.length > 0 ? `  Done Conditions: ${workflow.doneConditions.join(' | ')}` : '',
          workflow.scriptBinding ? `  Script Binding: ${describeScriptBinding(workflow.scriptBinding)}` : '',
          workflow.scriptApis?.length ? `  Script APIs: ${workflow.scriptApis.map(api => `${api.name}(${api.args.map(arg => `${arg.name}${arg.type ? `:${arg.type}` : ''}${arg.required === false ? '?' : ''}`).join(', ')}) - ${api.description}${formatScriptApiReturns(api)}`).join(' | ')}` : '',
          Object.keys(workflow.phaseConfigurations).length > 0 ? `  Phase Overrides: ${Object.keys(workflow.phaseConfigurations).join(', ')}` : '',
          currentPhaseConfig?.steps.length ? `  Phase Steps (${phase?.phase}): ${currentPhaseConfig.steps.join(' | ')}` : '',
          currentPhaseConfig?.hints.length ? `  Phase Hints (${phase?.phase}): ${currentPhaseConfig.hints.join(' | ')}` : '',
          Object.keys(currentPhaseConfig?.selectorSlots || {}).length > 0 ? `  Phase Selector Slots (${phase?.phase}): ${Object.entries(currentPhaseConfig?.selectorSlots || {}).map(([key, values]) => `${key}=${values.join(' | ')}`).join('; ')}` : '',
          Object.keys(currentPhaseConfig?.preferredSelectors || {}).length > 0 ? `  Phase Preferred Selectors (${phase?.phase}): ${Object.entries(currentPhaseConfig?.preferredSelectors || {}).map(([key, values]) => `${key}=${values.join(' | ')}`).join('; ')}` : '',
          Object.keys(currentPhaseConfig?.fallbackActions || {}).length > 0 ? `  Phase Fallback Actions (${phase?.phase}): ${Object.entries(currentPhaseConfig?.fallbackActions || {}).map(([key, values]) => `${key}=${values.join(' | ')}`).join('; ')}` : '',
          currentPhaseConfig?.doneConditions.length ? `  Phase Done Conditions (${phase?.phase}): ${currentPhaseConfig.doneConditions.join(' | ')}` : '',
          currentPhaseConfig?.successCriteria.length ? `  Phase Success (${phase?.phase}): ${currentPhaseConfig.successCriteria.join(' | ')}` : '',
          currentPhaseConfig?.scriptBinding ? `  Phase Script Binding (${phase?.phase}): ${describeScriptBinding(currentPhaseConfig.scriptBinding)}` : '',
          currentPhaseConfig?.scriptApis?.length ? `  Phase Script APIs (${phase?.phase}): ${currentPhaseConfig.scriptApis.map(api => `${api.name}(${api.args.map(arg => `${arg.name}${arg.type ? `:${arg.type}` : ''}${arg.required === false ? '?' : ''}`).join(', ')}) - ${api.description}${formatScriptApiReturns(api)}`).join(' | ')}` : '',
          workflow.maxRetries !== undefined ? `  Max Retries: ${workflow.maxRetries}` : '',
        ].filter(Boolean);
        return lines.join('\n');
      })
      .join('\n\n') || 'none';

    return [
      '你是浏览器自动化动作规划器。',
      '目标是在尽量少的步骤内完成用户任务。',
      '如果存在 workflow 指南，优先遵循 workflow 中的步骤和约束。',
      '只能输出严格 JSON，不要输出 markdown，不要解释。',
      '',
      `用户目标: ${task.goal}`,
      `当前 URL: ${digest.url}`,
      `当前标题: ${digest.title}`,
      previousDigest ? `上一步 URL: ${previousDigest.url}` : '',
      previousDigest ? `上一步标题: ${previousDigest.title}` : '',
      diffSummary ? `相对上一步的页面变化: ${diffSummary}` : '',
      phase ? `当前页面阶段: ${phase.phase} (confidence=${phase.confidence.toFixed(2)})` : '',
      phase?.transition ? `最近阶段切换: ${phase.transition}` : '',
      phase?.signals?.length ? `阶段判定信号: ${phase.signals.join(' | ')}` : '',
      `页面文本摘要: ${digest.visibleText || ''}`,
      '命中的 workflow 指南:',
      workflowContext,
      '可交互元素:',
      interactiveDetails,
      '最近执行轨迹:',
      recentTraces,
      '',
      '返回 JSON 结构:',
      '{"finalMessage":"可选","actions":[{"type":"navigate|click|fill|press|extract|wait|evaluate_script|call_userscript_api|toggle_userscript_mode|done","selector":"可选","url":"可选","value":"可选","key":"可选","script":"可选","api":"可选","args":[],"enabled":true,"expectResult":{"type":"array","shape":"{ id: string }"},"reason":"原因","confidence":0.0}]}',
      '',
      '规则:',
      `1. actions 最多 ${this.options.maxActionsPerPlan} 个。`,
      '2. 优先使用页面里已经给出的 selector，不要编造新 selector。',
      '3. 如果任务已经完成，返回 done。',
      '4. 只有在确实需要跳转时才使用 navigate，并给出完整 URL。',
      '5. 如果需要读取结果内容，优先使用 extract。',
      '6. 如果 workflow 定义了 selector slots，可使用 $slotName 作为 selector 引用。',
      '7. evaluate_script 用于直接执行页面脚本；script 字段填写要执行的 JavaScript。',
      '8. call_userscript_api 用于调用页面上用户脚本暴露的全局函数；api 字段填写全局函数路径，args 填参数数组。若 workflow 为该 API 声明了返回契约，优先遵守它。',
      '9. toggle_userscript_mode 用于显式开启或关闭用户脚本模式；enabled=true 表示开启，false 表示关闭。',
      '10. 如果 workflow 已绑定脚本，优先利用这些脚本能力，而不是重复点击或硬编码 DOM 操作。',
      '11. 严禁规划支付、提现、转账、下单付款、验证码填写、密码填写、身份证/银行卡等敏感信息提交，遇到此类场景应停止自动化并返回 done，提示用户本人手动处理。',
      `12. 如果模型不确定，请参考这个低风险回退方案: ${JSON.stringify(heuristic)}。`,
    ].join('\n');
  }

  private parsePlan(raw: string, workflows?: BrowserWorkflow[], phase?: BrowserPhaseSnapshot): BrowserActionPlan {
    const jsonText = this.extractJson(raw);
    const parsed = JSON.parse(jsonText) as { finalMessage?: unknown; actions?: unknown };
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];

    return {
      source: 'llm',
      finalMessage: typeof parsed.finalMessage === 'string' && parsed.finalMessage.trim().length > 0
        ? parsed.finalMessage.trim()
        : undefined,
      actions: actions
        .map(action => this.normalizeAction(action, workflows, phase))
        .filter((action): action is BrowserActionProposal => action !== null)
        .slice(0, this.options.maxActionsPerPlan),
    };
  }

  private extractJson(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
      return fenced[1].trim();
    }

    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return trimmed.slice(start, end + 1);
    }

    return trimmed;
  }

  private normalizeAction(action: unknown, workflows?: BrowserWorkflow[], phase?: BrowserPhaseSnapshot): BrowserActionProposal | null {
    if (!action || typeof action !== 'object') {
      return null;
    }

    const candidate = action as Record<string, unknown>;
    const type = typeof candidate.type === 'string' ? candidate.type.trim().toLowerCase() as BrowserActionProposal['type'] : null;
    if (!type || !ACTION_TYPES.has(type)) {
      return null;
    }

    const normalized: BrowserActionProposal = {
      type,
      reason: typeof candidate.reason === 'string' && candidate.reason.trim().length > 0 ? candidate.reason.trim() : 'planner action',
      confidence: this.normalizeConfidence(candidate.confidence),
    };

    if (typeof candidate.selector === 'string' && candidate.selector.trim()) {
      normalized.selector = candidate.selector.trim();
    }
    if (typeof candidate.url === 'string' && candidate.url.trim()) {
      normalized.url = candidate.url.trim();
    }
    if (typeof candidate.value === 'string') {
      normalized.value = candidate.value;
    }
    if (typeof candidate.key === 'string' && candidate.key.trim()) {
      normalized.key = candidate.key.trim();
    }
    if (typeof candidate.script === 'string' && candidate.script.trim()) {
      normalized.script = candidate.script;
    }
    if (typeof candidate.api === 'string' && candidate.api.trim()) {
      normalized.api = candidate.api.trim();
    }
    if (Array.isArray(candidate.args)) {
      normalized.args = candidate.args;
    }
    if (typeof candidate.enabled === 'boolean') {
      normalized.enabled = candidate.enabled;
    }
    const explicitExpectResult = this.normalizeScriptResultContract(candidate.expectResult);
    if (explicitExpectResult) {
      normalized.expectResult = explicitExpectResult;
    } else if (normalized.type === 'call_userscript_api' && normalized.api) {
      const inferred = this.findScriptApiReturnContract(normalized.api, workflows, phase);
      if (inferred) {
        normalized.expectResult = inferred;
      }
    }

    return normalized;
  }

  private normalizeScriptResultContract(value: unknown): BrowserScriptResultContract | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const candidate = value as Record<string, unknown>;
    const type = candidate.type === 'string' || candidate.type === 'number' || candidate.type === 'boolean' || candidate.type === 'json' || candidate.type === 'array' || candidate.type === 'object' || candidate.type === 'void'
      ? candidate.type
      : undefined;
    const shape = typeof candidate.shape === 'string' && candidate.shape.trim() ? candidate.shape.trim() : undefined;
    const description = typeof candidate.description === 'string' && candidate.description.trim() ? candidate.description.trim() : undefined;

    if (!type && !shape && !description) {
      return undefined;
    }

    return { type, shape, description };
  }

  private findScriptApiReturnContract(apiPath: string, workflows?: BrowserWorkflow[], phase?: BrowserPhaseSnapshot): BrowserScriptResultContract | undefined {
    for (const workflow of workflows || []) {
      const phaseApis = phase ? workflow.phaseConfigurations[phase.phase]?.scriptApis || [] : [];
      const apis = [...phaseApis, ...(workflow.scriptApis || [])];
      const matched = apis.find(api => api.name === apiPath);
      if (matched?.returns) {
        return matched.returns;
      }
    }

    return undefined;
  }

  private normalizeConfidence(value: unknown): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return 0.5;
    }

    return Math.max(0, Math.min(1, value));
  }

  private createHeuristicPlan(task: BrowserAgentTask, digest: BrowserPageDigest, phase?: BrowserPhaseSnapshot): BrowserActionPlan {
    const goalUrl = extractFirstUrl(task.goal) || task.startUrl;
    if ((digest.url === 'about:blank' || digest.url === 'data:,') && goalUrl) {
      return {
        source: 'rule',
        actions: [
          {
            type: 'navigate',
            url: goalUrl,
            reason: '先进入目标页面',
            confidence: 0.92,
          },
        ],
      };
    }

    const completionPlan = this.createCompletionPlan(task, digest, phase);
    if (completionPlan) {
      return completionPlan;
    }

    const clickPlan = this.createKeywordClickPlan(task, digest, phase);
    if (clickPlan) {
      return clickPlan;
    }

    const searchBox = (digest.interactiveElements || []).find(element => /input|textarea/i.test(element.role) && /search|查询|搜索|查找/i.test(`${element.placeholder || ''} ${element.text || ''} ${element.type || ''}`));
    const searchQuery = extractSearchQuery(task.goal);
    if (searchBox && searchQuery && (!phase || phase.phase === 'search-input' || phase.phase === 'landing' || phase.phase === 'unknown')) {
      return {
        source: 'rule',
        actions: ([
          {
            type: 'fill' as const,
            selector: searchBox.selector,
            value: searchQuery,
            reason: '向搜索框输入查询词',
            confidence: 0.72,
          },
          {
            type: 'press' as const,
            selector: searchBox.selector,
            key: 'Enter',
            reason: '提交搜索',
            confidence: 0.7,
          },
        ] satisfies BrowserActionProposal[]).slice(0, this.options.maxActionsPerPlan),
      };
    }

    return {
      source: 'rule',
      actions: [
        {
          type: 'extract',
          selector: 'body',
          reason: '先提取当前页面主要内容，再决定下一步',
          confidence: 0.4,
        },
      ],
    };
  }

  private shouldUseFastPath(plan: BrowserActionPlan): boolean {
    if (plan.source !== 'rule' || plan.actions.length === 0) {
      return false;
    }

    return plan.actions.every(action => action.confidence >= 0.7 || action.type === 'extract' || action.type === 'done');
  }

  private createCompletionPlan(task: BrowserAgentTask, digest: BrowserPageDigest, phase?: BrowserPhaseSnapshot): BrowserActionPlan | null {
    if (!isSummaryLikeGoal(task.goal)) {
      return null;
    }

    if (!digest.visibleText || digest.visibleText.trim().length < 80) {
      return null;
    }

    if (phase?.phase === 'search-input') {
      return null;
    }

    return {
      source: 'rule',
      actions: ([
        {
          type: 'extract' as const,
          selector: 'body',
          reason: '任务更像读取和总结当前页面，直接提取正文更快',
          confidence: 0.82,
        },
        {
          type: 'done' as const,
          reason: '已获取当前页面主要内容，可直接总结',
          confidence: 0.8,
        },
      ] satisfies BrowserActionProposal[]).slice(0, this.options.maxActionsPerPlan),
    };
  }

  private createKeywordClickPlan(task: BrowserAgentTask, digest: BrowserPageDigest, phase?: BrowserPhaseSnapshot): BrowserActionPlan | null {
    const elements = digest.interactiveElements || [];
    if (elements.length === 0) {
      return null;
    }

    if (phase?.phase === 'detail') {
      return null;
    }

    const keywords = extractGoalKeywords(task.goal);
    if (keywords.length === 0) {
      return null;
    }

    let bestMatch: { selector: string; score: number; text: string } | null = null;
    for (const element of elements) {
      const haystack = `${element.text || ''} ${element.placeholder || ''} ${element.href || ''}`.toLowerCase();
      if (!haystack) {
        continue;
      }

      let score = 0;
      for (const keyword of keywords) {
        if (haystack.includes(keyword)) {
          score += keyword.length;
        }
      }

      if (score > 0 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = {
          selector: element.selector,
          score,
          text: (element.text || element.placeholder || element.href || '').slice(0, 80),
        };
      }
    }

    if (!bestMatch || bestMatch.score < 4) {
      return null;
    }

    return {
      source: 'rule',
      actions: [
        {
          type: 'click',
          selector: bestMatch.selector,
          reason: `页面中有和目标高度相关的入口：${bestMatch.text}`,
          confidence: 0.78,
        },
      ],
    };
  }
}

function extractFirstUrl(input: string): string | undefined {
  const match = input.match(/https?:\/\/\S+/i);
  return match?.[0];
}

function extractSearchQuery(input: string): string | undefined {
  const normalized = input.trim();
  const patterns = [
    /(?:搜索|查找|查一下|搜一下)\s+(.+)/i,
    /search\s+for\s+(.+)/i,
    /search\s+(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function extractGoalKeywords(input: string): string[] {
  const normalized = input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .split(/\s+/)
    .map(part => part.trim())
    .filter(part => part.length >= 2)
    .filter(part => !COMMON_STOP_WORDS.has(part));

  return Array.from(new Set(normalized)).slice(0, 8);
}

const COMMON_STOP_WORDS = new Set([
  '帮我', '请', '麻烦', '打开', '访问', '进入', '浏览', '网页', '网站', '页面', '自动', '操作', '浏览器', '完成', '处理', '执行',
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'search', 'click', 'open', 'page', 'website', 'web',
]);

function isSummaryLikeGoal(input: string): boolean {
  const normalized = input.toLowerCase();
  const directTerms = ['总结', '概括', '摘要', '提取', '读取', '列出', '告诉我', '有哪些', '汇总', '总结下', 'summarize', 'summary', 'list'];

  if (directTerms.some(term => normalized.includes(term))) {
    return true;
  }

  return /(?:前|top)\s*\d+/i.test(input);
}

function describeScriptBinding(binding: NonNullable<BrowserWorkflow['scriptBinding']>): string {
  const parts = [
    binding.initScriptPaths.length > 0 ? `initPaths=${binding.initScriptPaths.join(' | ')}` : '',
    binding.initScripts.length > 0 ? `initInline=${binding.initScripts.length}` : '',
    binding.pageScriptPaths.length > 0 ? `pagePaths=${binding.pageScriptPaths.join(' | ')}` : '',
    binding.pageScripts.length > 0 ? `pageInline=${binding.pageScripts.length}` : '',
    binding.userscriptPaths.length > 0 ? `userscriptPaths=${binding.userscriptPaths.join(' | ')}` : '',
    binding.userscriptInline.length > 0 ? `userscriptInline=${binding.userscriptInline.length}` : '',
    binding.userscriptMode ? `userscriptMode=${binding.userscriptMode}` : '',
    binding.userscriptRunAt ? `userscriptRunAt=${binding.userscriptRunAt}` : '',
  ].filter(Boolean);

  return parts.join('; ');
}

function formatScriptApiReturns(api: NonNullable<BrowserWorkflow['scriptApis']>[number]): string {
  if (!api.returns) {
    return '';
  }

  const parts = [
    api.returns.type || '',
    api.returns.shape ? `<${api.returns.shape}>` : '',
    api.returns.description ? ` ${api.returns.description}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? ` -> ${parts.join(' ').trim()}` : '';
}