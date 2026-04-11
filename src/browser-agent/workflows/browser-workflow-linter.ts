import { z } from 'zod';
import { BROWSER_AGENT_PHASES, BROWSER_WORKFLOW_LINT_SCHEMA_VERSION, type BrowserAgentPhase, type BrowserWorkflow, type BrowserWorkflowLintIssue, type BrowserWorkflowLintResult, type BrowserWorkflowScriptApi } from '../domain/types.js';

const PHASE_SET = new Set<BrowserAgentPhase>(BROWSER_AGENT_PHASES);
const PHASE_SECTION_HEADINGS = [
  'Phase Steps',
  'Phase Hints',
  'Phase Success',
  'Phase Success Criteria',
  'Phase Selector Slots',
  'Phase Preferred Selectors',
  'Phase Fallback Actions',
  'Phase Done Conditions',
] as const;

const phaseSchema = z.object({
  phase: z.enum(BROWSER_AGENT_PHASES),
  steps: z.array(z.string().trim().min(1)),
  hints: z.array(z.string().trim().min(1)),
  successCriteria: z.array(z.string().trim().min(1)),
  selectorSlots: z.record(z.string(), z.array(z.string().trim().min(1))),
  preferredSelectors: z.record(z.string(), z.array(z.string().trim().min(1))),
  fallbackActions: z.record(z.string(), z.array(z.string().trim().min(1))),
  doneConditions: z.array(z.string().trim().min(1)),
  scriptBinding: z.object({
    initScriptPaths: z.array(z.string().trim().min(1)),
    initScripts: z.array(z.string().trim().min(1)),
    pageScriptPaths: z.array(z.string().trim().min(1)),
    pageScripts: z.array(z.string().trim().min(1)),
    userscriptPaths: z.array(z.string().trim().min(1)),
    userscriptInline: z.array(z.string().trim().min(1)),
    userscriptMode: z.enum(['on', 'off']).optional(),
    userscriptRunAt: z.enum(['document-start', 'document-end']).optional(),
  }).optional(),
  scriptApis: z.array(z.object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    args: z.array(z.object({
      name: z.string().trim().min(1),
      type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
      required: z.boolean().optional(),
      description: z.string().trim().min(1).optional(),
    })),
    returns: z.object({
      type: z.enum(['string', 'number', 'boolean', 'json', 'array', 'object', 'void']).optional(),
      shape: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).optional(),
    }).refine(value => Boolean(value.type || value.shape || value.description), {
      message: 'returns 至少需要一个 type、shape 或 description',
    }).optional(),
  })).optional(),
});

const workflowSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  sourcePath: z.string().trim().min(1),
  startUrl: z.string().trim().optional(),
  matchPatterns: z.array(z.string().trim().min(1)),
  whenToUse: z.string().trim().optional(),
  steps: z.array(z.string().trim().min(1)),
  hints: z.array(z.string().trim().min(1)),
  successCriteria: z.array(z.string().trim().min(1)),
  selectorSlots: z.record(z.string(), z.array(z.string().trim().min(1))),
  preferredSelectors: z.record(z.string(), z.array(z.string().trim().min(1))),
  fallbackActions: z.record(z.string(), z.array(z.string().trim().min(1))),
  doneConditions: z.array(z.string().trim().min(1)),
  phaseConfigurations: z.record(z.string(), phaseSchema),
  scriptBinding: z.object({
    initScriptPaths: z.array(z.string().trim().min(1)),
    initScripts: z.array(z.string().trim().min(1)),
    pageScriptPaths: z.array(z.string().trim().min(1)),
    pageScripts: z.array(z.string().trim().min(1)),
    userscriptPaths: z.array(z.string().trim().min(1)),
    userscriptInline: z.array(z.string().trim().min(1)),
    userscriptMode: z.enum(['on', 'off']).optional(),
    userscriptRunAt: z.enum(['document-start', 'document-end']).optional(),
  }).optional(),
  scriptApis: z.array(z.object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    args: z.array(z.object({
      name: z.string().trim().min(1),
      type: z.enum(['string', 'number', 'boolean', 'json']).optional(),
      required: z.boolean().optional(),
      description: z.string().trim().min(1).optional(),
    })),
    returns: z.object({
      type: z.enum(['string', 'number', 'boolean', 'json', 'array', 'object', 'void']).optional(),
      shape: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).optional(),
    }).refine(value => Boolean(value.type || value.shape || value.description), {
      message: 'returns 至少需要一个 type、shape 或 description',
    }).optional(),
  })).optional(),
  maxRetries: z.number().int().min(1).max(10).optional(),
  priority: z.number().int().min(0).max(10000),
  explicit: z.boolean().optional(),
});

const ACTION_KEYS = new Set(['click', 'fill', 'extract', 'press', 'wait', 'navigate']);
const DONE_CONDITION_PREFIXES = ['urlIncludes:', 'titleIncludes:', 'textIncludes:', 'urlMatches:', 'textMatches:'];

export function lintWorkflowDocument(input: {
  filePath: string;
  rawContent: string;
  workflow?: BrowserWorkflow;
  hasFrontmatter: boolean;
  frontmatter: Record<string, unknown>;
}): BrowserWorkflowLintResult {
  const issues: BrowserWorkflowLintIssue[] = [];
  const workflowName = input.workflow?.name || asTrimmedString(input.frontmatter.name);

  issues.push(...collectInvalidPhaseDefinitions(input.rawContent, input.frontmatter));

  if (!input.hasFrontmatter) {
    issues.push(warning('missing-frontmatter', '缺少 YAML frontmatter，建议显式声明 name、description、match、priority 等字段。', 'file', {
      suggestion: {
        summary: '补充 workflow frontmatter，避免文件名回退和隐式行为。',
        example: '---\nname: example\ndescription: describe workflow\nmatch:\n  - example.com\npriority: 100\n---',
      },
    }));
  }

  if (!input.workflow) {
    issues.push(error('invalid-workflow', 'Workflow 解析失败，无法生成有效配置。', 'file'));
    return {
      kind: 'browser-workflow-lint-result',
      schemaVersion: BROWSER_WORKFLOW_LINT_SCHEMA_VERSION,
      filePath: input.filePath,
      workflowName,
      valid: false,
      issueCounts: countIssues(issues),
      issues,
    };
  }

  const parsed = workflowSchema.safeParse(input.workflow);
  if (!parsed.success) {
    for (const item of parsed.error.issues) {
      issues.push(error('schema-invalid', `${item.path.join('.') || 'workflow'}: ${item.message}`, 'frontmatter'));
    }
  }

  if (!asTrimmedString(input.frontmatter.name)) {
    issues.push(warning('missing-name', 'frontmatter 未显式声明 name，当前使用文件名回退。', 'frontmatter', {
      field: 'name',
      suggestion: { summary: '显式声明 workflow 名称，避免重命名文件时语义漂移。', example: 'name: site-task-name' },
    }));
  }

  if (!asTrimmedString(input.frontmatter.description)) {
    issues.push(warning('missing-description', 'frontmatter 未显式声明 description，当前使用 When to Use 或默认描述回退。', 'frontmatter', {
      field: 'description',
      suggestion: { summary: '补充一句明确描述，让 planner 更容易判断 workflow 适用范围。', example: 'description: Search jobs and summarize top results' },
    }));
  }

  if (input.workflow.matchPatterns.length === 0) {
    issues.push(warning('missing-match', '未声明 match，workflow 只能靠显式 --workflow 使用，无法自动匹配站点。', 'frontmatter', {
      field: 'match',
      suggestion: { summary: '补充域名、URL 子串或正则，支持自动命中 workflow。', example: 'match:\n  - example.com' },
    }));
  }

  if (input.workflow.steps.length === 0) {
    issues.push(warning('missing-steps', '缺少 Steps 段落，模型只能依赖 description/hints 推断流程。', 'section', {
      heading: 'Steps',
      suggestion: { summary: '增加全局 Steps，或用 Phase Steps 分别声明各阶段动作。', example: '## Steps\n1. Open the search page.\n2. Submit the query.\n3. Summarize results.' },
    }));
  }

  if (input.workflow.successCriteria.length === 0) {
    issues.push(warning('missing-success', '缺少 Success 段落，完成判定会更依赖 doneConditions 或模型判断。', 'section', {
      heading: 'Success',
      suggestion: { summary: '增加 Success 或 Done Conditions，让完成态更稳定。', example: '## Success\n- At least one result card is extracted.' },
    }));
  }

  validateScriptBinding(input.workflow.scriptBinding, 'scriptBinding', issues);
  validateScriptApis(input.workflow.scriptApis, 'scriptApis', issues);

  for (const [action, selectors] of Object.entries(input.workflow.preferredSelectors)) {
    if (!ACTION_KEYS.has(action)) {
        issues.push(error('invalid-preferred-selector-action', `preferredSelectors.${action} 不是支持的动作类型。`, 'frontmatter', { field: `preferredSelectors.${action}`, action }));
    }
    for (const selector of selectors) {
      collectSlotReferenceIssues(selector, input.workflow.selectorSlots, `preferredSelectors.${action}`, issues);
    }
  }

  for (const [action, steps] of Object.entries(input.workflow.fallbackActions)) {
    if (!ACTION_KEYS.has(action)) {
        issues.push(error('invalid-fallback-action-key', `fallbackActions.${action} 不是支持的动作类型。`, 'frontmatter', { field: `fallbackActions.${action}`, action }));
    }
    for (const step of steps) {
      validateFallbackAction(step, input.workflow.selectorSlots, `fallbackActions.${action}`, issues);
    }
  }

  for (const condition of input.workflow.doneConditions) {
    if (!isValidDoneCondition(condition)) {
      issues.push(error('invalid-done-condition', `doneCondition 格式不受支持: ${condition}`, 'frontmatter', {
        field: 'doneConditions',
        suggestion: { summary: '使用受支持的 doneCondition 前缀。', example: 'doneConditions:\n  - urlIncludes:success\n  - textIncludes:完成' },
      }));
    }
  }

  for (const [phase, config] of Object.entries(input.workflow.phaseConfigurations)) {
    if (!isBrowserAgentPhase(phase) || !config) {
      continue;
    }

    const phaseParsed = phaseSchema.safeParse(config);
    if (!phaseParsed.success) {
      for (const item of phaseParsed.error.issues) {
        issues.push(error('phase-schema-invalid', `${phase}.${item.path.join('.') || 'phase'}: ${item.message}`, 'section', {
          phase,
          heading: 'Phase Sections',
          field: `phaseConfigurations.${phase}.${item.path.join('.')}`,
        }));
      }
      continue;
    }

    if (config.steps.length === 0) {
      issues.push(warning('missing-phase-steps', `阶段 ${phase} 缺少 Phase Steps，planner 只能依赖全局步骤和模型推断。`, 'section', {
        phase,
        heading: 'Phase Steps',
      }));
    }

    if (config.successCriteria.length === 0 && config.doneConditions.length === 0) {
      issues.push(warning('missing-phase-success', `阶段 ${phase} 缺少 Success/Done Conditions，阶段完成判断会更弱。`, 'section', {
        phase,
        heading: 'Phase Success',
      }));
    }

    validateScriptBinding(config.scriptBinding, `phaseConfigurations.${phase}.scriptBinding`, issues, {
      phase,
      heading: 'Phase Script Binding',
      location: 'section',
    });
    validateScriptApis(config.scriptApis, `phaseConfigurations.${phase}.scriptApis`, issues, {
      phase,
      heading: 'Phase Script APIs',
      location: 'section',
    });

    const mergedSelectorSlots = {
      ...input.workflow.selectorSlots,
      ...config.selectorSlots,
    };

    for (const [action, selectors] of Object.entries(config.preferredSelectors)) {
      if (!ACTION_KEYS.has(action)) {
        issues.push(error('invalid-phase-preferred-selector-action', `phase ${phase} preferredSelectors.${action} 不是支持的动作类型。`, 'section', {
          phase,
          heading: 'Phase Preferred Selectors',
          field: `phaseConfigurations.${phase}.preferredSelectors.${action}`,
          action,
        }));
      }

      for (const selector of selectors) {
        collectSlotReferenceIssues(selector, mergedSelectorSlots, `phaseConfigurations.${phase}.preferredSelectors.${action}`, issues, {
          phase,
          heading: 'Phase Preferred Selectors',
        });
      }
    }

    for (const [action, steps] of Object.entries(config.fallbackActions)) {
      if (!ACTION_KEYS.has(action)) {
        issues.push(error('invalid-phase-fallback-action-key', `phase ${phase} fallbackActions.${action} 不是支持的动作类型。`, 'section', {
          phase,
          heading: 'Phase Fallback Actions',
          field: `phaseConfigurations.${phase}.fallbackActions.${action}`,
          action,
        }));
      }

      for (const step of steps) {
        validateFallbackAction(step, mergedSelectorSlots, `phaseConfigurations.${phase}.fallbackActions.${action}`, issues, {
          phase,
          heading: 'Phase Fallback Actions',
        });
      }
    }

    for (const condition of config.doneConditions) {
      if (!isValidDoneCondition(condition)) {
        issues.push(error('invalid-phase-done-condition', `phase ${phase} doneCondition 格式不受支持: ${condition}`, 'section', {
          phase,
          heading: 'Phase Done Conditions',
          field: `phaseConfigurations.${phase}.doneConditions`,
        }));
      }
    }
  }

  return {
    kind: 'browser-workflow-lint-result',
    schemaVersion: BROWSER_WORKFLOW_LINT_SCHEMA_VERSION,
    filePath: input.filePath,
    workflowName: input.workflow.name,
    valid: !issues.some(issue => issue.severity === 'error'),
    issueCounts: countIssues(issues),
    issues,
  };
}

function validateFallbackAction(value: string, selectorSlots: Record<string, string[]>, context: string, issues: BrowserWorkflowLintIssue[], contextMeta: Partial<BrowserWorkflowLintIssue> = {}): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }

  if (/^(press:[^\s].*|wait:\d+|clickSelf|fillSelf)$/i.test(trimmed)) {
    return;
  }

  const match = trimmed.match(/^(click|fill):(.+)$/i);
  if (!match) {
    issues.push(error('invalid-fallback-action', `${context} 包含不支持的 fallback action: ${trimmed}`, contextMeta.location || 'frontmatter', {
      ...contextMeta,
      field: context,
    }));
    return;
  }

  const target = match[2];
  if (!target) {
    issues.push(error('invalid-fallback-action', `${context} 缺少 fallback action 目标: ${trimmed}`, contextMeta.location || 'frontmatter', {
      ...contextMeta,
      field: context,
    }));
    return;
  }

  collectSlotReferenceIssues(target.trim(), selectorSlots, context, issues, contextMeta);
}

function collectSlotReferenceIssues(value: string, selectorSlots: Record<string, string[]>, context: string, issues: BrowserWorkflowLintIssue[], contextMeta: Partial<BrowserWorkflowLintIssue> = {}): void {
  const slotMatch = value.trim().match(/^\$([a-zA-Z0-9_-]+)$/);
  if (!slotMatch) {
    return;
  }

  const slotName = slotMatch[1];
  if (!slotName) {
    return;
  }

  if (!selectorSlots[slotName] || selectorSlots[slotName].length === 0) {
    issues.push(error('unknown-selector-slot', `${context} 引用了未定义的 selector slot: $${slotName}`, contextMeta.location || 'frontmatter', {
      ...contextMeta,
      field: context,
      suggestion: {
        summary: '在 selectorSlots 或对应 phase 的 selectorSlots 中声明这个 slot。',
        example: `selectorSlots:\n  ${slotName}:\n    - css-selector`,
      },
    }));
  }
}

function isValidDoneCondition(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (DONE_CONDITION_PREFIXES.some(prefix => trimmed.startsWith(prefix))) {
    if (trimmed.startsWith('urlMatches:') || trimmed.startsWith('textMatches:')) {
      const pattern = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (!pattern) {
        return false;
      }
      try {
        const normalized = pattern.match(/^\/(.*)\/([a-z]*)$/i);
        if (normalized?.[1] !== undefined) {
          new RegExp(normalized[1], normalized[2] || '');
        } else {
          new RegExp(pattern, 'i');
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  return true;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function error(code: string, message: string, location: BrowserWorkflowLintIssue['location'], extra: Partial<BrowserWorkflowLintIssue> = {}): BrowserWorkflowLintIssue {
  return { severity: 'error', code, message, location, ...extra };
}

function warning(code: string, message: string, location: BrowserWorkflowLintIssue['location'], extra: Partial<BrowserWorkflowLintIssue> = {}): BrowserWorkflowLintIssue {
  return { severity: 'warning', code, message, location, ...extra };
}

function countIssues(issues: BrowserWorkflowLintIssue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter(issue => issue.severity === 'error').length,
    warnings: issues.filter(issue => issue.severity === 'warning').length,
  };
}

function collectInvalidPhaseDefinitions(rawContent: string, frontmatter: Record<string, unknown>): BrowserWorkflowLintIssue[] {
  const issues: BrowserWorkflowLintIssue[] = [];
  const rawPhases = frontmatter.phases;
  if (rawPhases && typeof rawPhases === 'object' && !Array.isArray(rawPhases)) {
    for (const phase of Object.keys(rawPhases as Record<string, unknown>)) {
      if (!isBrowserAgentPhase(phase)) {
        issues.push(error('invalid-phase-name', `frontmatter phases.${phase} 不是支持的页面阶段。`, 'frontmatter', {
          field: `phases.${phase}`,
          suggestion: {
            summary: `只使用支持的阶段名: ${BROWSER_AGENT_PHASES.join(', ')}`,
          },
        }));
      }
    }
  }

  for (const heading of PHASE_SECTION_HEADINGS) {
    const section = extractSection(rawContent, heading);
    if (!section) {
      continue;
    }

    for (const phaseName of extractPhaseSubheadings(section)) {
      if (!isBrowserAgentPhase(phaseName)) {
        issues.push(error('invalid-phase-name', `${heading} 中的阶段 ${phaseName} 不是支持的页面阶段。`, 'section', {
          heading,
          suggestion: {
            summary: `只使用支持的阶段名: ${BROWSER_AGENT_PHASES.join(', ')}`,
          },
          data: { phaseName },
        }));
      }
    }
  }

  return issues;
}

function isBrowserAgentPhase(value: string): value is BrowserAgentPhase {
  return PHASE_SET.has(value as BrowserAgentPhase);
}

function extractSection(content: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s+|^#\\s+|(?![\\s\\S]))`, 'im');
  return content.match(pattern)?.[1]?.trim() || '';
}

function extractPhaseSubheadings(section: string): string[] {
  const matches = section.matchAll(/^###\s+([^\r\n]+)\s*$/gim);
  return Array.from(matches).map(match => match[1]?.trim()).filter((value): value is string => Boolean(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateScriptBinding(binding: BrowserWorkflow['scriptBinding'], context: string, issues: BrowserWorkflowLintIssue[], meta: Partial<BrowserWorkflowLintIssue> = {}): void {
  if (!binding) {
    return;
  }

  const hasScripts = binding.initScriptPaths.length > 0
    || binding.initScripts.length > 0
    || binding.pageScriptPaths.length > 0
    || binding.pageScripts.length > 0
    || binding.userscriptPaths.length > 0
    || binding.userscriptInline.length > 0;

  if (!hasScripts && !binding.userscriptMode && !binding.userscriptRunAt) {
    issues.push(warning('empty-script-binding', `${context} 已声明，但没有任何实际脚本或模式配置。`, meta.location || 'frontmatter', {
      ...meta,
      field: context,
    }));
  }

  if ((binding.userscriptPaths.length > 0 || binding.userscriptInline.length > 0) && !binding.userscriptRunAt) {
    issues.push(warning('missing-userscript-run-at', `${context} 包含 userscript，但未显式声明 userscriptRunAt，当前会依赖默认时机。`, meta.location || 'frontmatter', {
      ...meta,
      field: context,
      suggestion: {
        summary: '显式声明 userscriptRunAt，避免脚本加载时机不清晰。',
        example: `${context.replace(/\.[^.]+$/, '')}:\n  userscriptRunAt: document-end`,
      },
    }));
  }
}

function validateScriptApis(apis: BrowserWorkflowScriptApi[] | undefined, context: string, issues: BrowserWorkflowLintIssue[], meta: Partial<BrowserWorkflowLintIssue> = {}): void {
  if (!apis || apis.length === 0) {
    return;
  }

  const seen = new Set<string>();
  for (const api of apis) {
    if (seen.has(api.name)) {
      issues.push(warning('duplicate-script-api', `${context} 存在重复的 script API 名称: ${api.name}`, meta.location || 'frontmatter', {
        ...meta,
        field: context,
      }));
    }
    seen.add(api.name);

    if (api.args.some(arg => !arg.name.trim())) {
      issues.push(error('invalid-script-api-args', `${context} 中 ${api.name} 的 args 包含空名称。`, meta.location || 'frontmatter', {
        ...meta,
        field: context,
      }));
    }

    if (api.returns && !api.returns.type && !api.returns.shape && !api.returns.description) {
      issues.push(error('invalid-script-api-returns', `${context} 中 ${api.name} 的 returns 为空对象。`, meta.location || 'frontmatter', {
        ...meta,
        field: context,
      }));
    }

    if (api.returns?.type === 'array' && !api.returns.shape) {
      issues.push(warning('array-script-api-returns-without-shape', `${context} 中 ${api.name} 声明返回数组，但没有提供元素 shape。`, meta.location || 'frontmatter', {
        ...meta,
        field: context,
        suggestion: {
          summary: '给 array 返回值补一个元素 shape，让 planner 更容易理解返回结构。',
          example: 'returns:\n  type: array\n  shape: { title: string; url: string }',
        },
      }));
    }

    if (api.returns?.type === 'object' && !api.returns.shape) {
      issues.push(warning('object-script-api-returns-without-shape', `${context} 中 ${api.name} 声明返回对象，但没有提供字段 shape。`, meta.location || 'frontmatter', {
        ...meta,
        field: context,
        suggestion: {
          summary: '给 object 返回值补一个 shape，减少 planner 对返回字段的猜测。',
          example: 'returns:\n  type: object\n  shape: { total: number; items: unknown[] }',
        },
      }));
    }
  }
}