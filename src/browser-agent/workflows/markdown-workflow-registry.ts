import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { BROWSER_AGENT_PHASES, BROWSER_WORKFLOW_LINT_SCHEMA_VERSION, type BrowserAgentPhase, type BrowserAgentTask, type BrowserWorkflow, type BrowserWorkflowLintCodeCount, type BrowserWorkflowLintResult, type BrowserWorkflowLintSummary, type BrowserWorkflowResolution, type BrowserWorkflowScriptApi, type BrowserWorkflowScriptBinding } from '../domain/types.js';
import { resolveUserPath } from '../../utils/path-resolution.js';
import { lintWorkflowDocument } from './browser-workflow-linter.js';

export interface MarkdownWorkflowRegistryOptions {
  workspace?: string;
  appBaseDir?: string;
  workflowDir?: string;
  autoMatch?: boolean;
}

export class MarkdownWorkflowRegistry {
  constructor(private readonly options: MarkdownWorkflowRegistryOptions = {}) {}

  getWorkflowDir(): string {
    return this.resolveWorkflowDir();
  }

  async listWorkflows(): Promise<BrowserWorkflowResolution> {
    const workflowDir = this.resolveWorkflowDir();
    await fs.mkdir(workflowDir, { recursive: true });

    const { workflows, lintResults } = await this.loadAllWorkflows(workflowDir);
    workflows.sort((left, right) => right.priority - left.priority || left.name.localeCompare(right.name));

    return {
      workflowDir,
      workflows,
      lintResults,
    };
  }

  async lintWorkflows(): Promise<BrowserWorkflowLintSummary> {
    const workflowDir = this.resolveWorkflowDir();
    await fs.mkdir(workflowDir, { recursive: true });
    const { lintResults } = await this.loadAllWorkflows(workflowDir);
    return buildLintSummary(workflowDir, lintResults);
  }

  async lintWorkflow(inputPath: string): Promise<BrowserWorkflowLintResult> {
    const workflowDir = this.resolveWorkflowDir();
    await fs.mkdir(workflowDir, { recursive: true });
    return this.loadWorkflowReport(this.resolveWorkflowPath(inputPath, workflowDir), true);
  }

  async inspectWorkflow(inputPath: string): Promise<BrowserWorkflow> {
    const workflowDir = this.resolveWorkflowDir();
    await fs.mkdir(workflowDir, { recursive: true });
    return this.loadWorkflow(this.resolveWorkflowPath(inputPath, workflowDir), true);
  }

  async resolve(task: BrowserAgentTask): Promise<{ task: BrowserAgentTask; resolution: BrowserWorkflowResolution }> {
    const workflowDir = this.resolveWorkflowDir();
    await fs.mkdir(workflowDir, { recursive: true });

    let lintResults: BrowserWorkflowLintResult[] | undefined;
    const resolvedWorkflows: BrowserWorkflow[] = [];
    const explicitWorkflow = task.workflowPath
      ? await this.loadWorkflow(this.resolveWorkflowPath(task.workflowPath, workflowDir), true)
      : undefined;

    if (explicitWorkflow) {
      resolvedWorkflows.push(explicitWorkflow);
    }

    if (this.options.autoMatch !== false) {
      const loaded = await this.loadAllWorkflows(workflowDir);
      const allWorkflows = loaded.workflows;
      lintResults = loaded.lintResults;
      const urlHints = [
        task.startUrl,
        extractFirstUrl(task.goal),
        explicitWorkflow?.startUrl,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

      for (const workflow of allWorkflows) {
        if (resolvedWorkflows.some(item => item.sourcePath === workflow.sourcePath)) {
          continue;
        }

        if (urlHints.length === 0) {
          continue;
        }

        if (urlHints.some(url => this.matchesUrl(workflow, url))) {
          resolvedWorkflows.push(workflow);
        }
      }
    }

    resolvedWorkflows.sort((left, right) => {
      const explicitDelta = Number(Boolean(right.explicit)) - Number(Boolean(left.explicit));
      if (explicitDelta !== 0) {
        return explicitDelta;
      }

      return right.priority - left.priority;
    });

    return {
      task: {
        ...task,
        startUrl: task.startUrl || explicitWorkflow?.startUrl || resolvedWorkflows[0]?.startUrl,
      },
      resolution: {
        workflowDir,
        workflows: resolvedWorkflows,
        lintResults,
      },
    };
  }

  isWorkflowApplicable(workflow: BrowserWorkflow, url?: string): boolean {
    if (!url) {
      return Boolean(workflow.explicit);
    }

    return Boolean(workflow.explicit) || this.matchesUrl(workflow, url);
  }

  private resolveWorkflowDir(): string {
    const configured = this.options.workflowDir || 'browser-workflows';
    return resolveUserPath(configured, {
      workspace: this.options.workspace,
      appBaseDir: this.options.appBaseDir,
    });
  }

  private resolveWorkflowPath(inputPath: string, workflowDir: string): string {
    const directPath = resolveUserPath(inputPath, {
      workspace: this.options.workspace,
      appBaseDir: this.options.appBaseDir,
    });

    return this.tryWorkflowPathCandidates(inputPath, workflowDir, directPath);
  }

  private tryWorkflowPathCandidates(inputPath: string, workflowDir: string, directPath: string): string {
    const candidates = [
      directPath,
      path.join(workflowDir, inputPath),
      inputPath.endsWith('.md') ? undefined : path.join(workflowDir, `${inputPath}.md`),
      inputPath.endsWith('.md') ? undefined : `${directPath}.md`,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    for (const candidate of candidates) {
      try {
        const stat = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
        if (requirePathExistsSync(stat)) {
          return stat;
        }
      } catch {
        continue;
      }
    }

    return candidates[0] || directPath;
  }

  private async loadAllWorkflows(workflowDir: string): Promise<{ workflows: BrowserWorkflow[]; lintResults: BrowserWorkflowLintResult[] }> {
    const files = await this.collectMarkdownFiles(workflowDir, 2);
    const workflows: BrowserWorkflow[] = [];
    const lintResults: BrowserWorkflowLintResult[] = [];

    for (const file of files) {
      if (path.basename(file, path.extname(file)).toLowerCase() === 'readme') {
        continue;
      }

      const report = await this.loadWorkflowReport(file, false);
      lintResults.push(report);
      if (report.valid) {
        workflows.push(await this.loadWorkflow(file, false));
      }
    }

    return { workflows, lintResults };
  }

  private async collectMarkdownFiles(rootDir: string, depth: number): Promise<string[]> {
    const files: string[] = [];
    let entries: Array<import('fs').Dirent> = [];

    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) {
          files.push(...await this.collectMarkdownFiles(entryPath, depth - 1));
        }
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(entryPath);
      }
    }

    return files;
  }

  private async loadWorkflow(filePath: string, explicit: boolean): Promise<BrowserWorkflow> {
    const report = await this.loadWorkflowReport(filePath, explicit);
    if (!report.valid) {
      const details = report.issues.map(issue => `${issue.severity}:${issue.code}:${issue.message}`).join('; ');
      throw new Error(`Workflow 校验失败: ${filePath}${details ? ` -> ${details}` : ''}`);
    }

    const content = await fs.readFile(filePath, 'utf8');
    const frontmatter = parseFrontmatter(content).data;
    return this.buildWorkflow(filePath, content, frontmatter, explicit);
  }

  private async loadWorkflowReport(filePath: string, explicit: boolean): Promise<BrowserWorkflowLintResult> {
    const content = await fs.readFile(filePath, 'utf8');
    const frontmatterResult = parseFrontmatter(content);
    const workflow = this.buildWorkflow(filePath, content, frontmatterResult.data, explicit);

    return lintWorkflowDocument({
      filePath,
      rawContent: content,
      workflow,
      hasFrontmatter: frontmatterResult.hasFrontmatter,
      frontmatter: frontmatterResult.data,
    });
  }

  private buildWorkflow(filePath: string, content: string, frontmatter: Record<string, unknown>, explicit: boolean): BrowserWorkflow {
    const fallbackName = path.basename(filePath, path.extname(filePath));

    const doneConditions = Array.from(new Set(
      normalizeStringList(frontmatter.doneConditions)
        .concat(extractListSection(content, 'Done Conditions'))
        .map(normalizeDoneCondition)
        .filter(Boolean),
    ));

    return {
      name: asNonEmptyString(frontmatter.name) || fallbackName,
      description: asNonEmptyString(frontmatter.description) || extractSection(content, 'When to Use').replace(/\s+/g, ' ').trim() || `Browser workflow: ${fallbackName}`,
      sourcePath: filePath,
      startUrl: asNonEmptyString(frontmatter.startUrl) || asNonEmptyString(frontmatter.url),
      matchPatterns: normalizeStringList(frontmatter.match || frontmatter.matches || frontmatter.domains || frontmatter.sites),
      whenToUse: extractSection(content, 'When to Use').replace(/\s+/g, ' ').trim() || undefined,
      steps: extractListSection(content, 'Steps'),
      hints: extractListSection(content, 'Hints'),
      successCriteria: extractListSection(content, 'Success').concat(extractListSection(content, 'Success Criteria')),
      selectorSlots: normalizeActionTemplateMap(frontmatter.selectorSlots, extractActionTemplateSection(content, 'Selector Slots')),
      preferredSelectors: normalizeActionTemplateMap(frontmatter.preferredSelectors, extractActionTemplateSection(content, 'Preferred Selectors')),
      fallbackActions: normalizeActionTemplateMap(frontmatter.fallbackActions, extractActionTemplateSection(content, 'Fallback Actions')),
      doneConditions,
      scriptBinding: parseScriptBinding(frontmatter.scriptBinding || frontmatter.scripts),
      scriptApis: parseScriptApis(frontmatter.scriptApis || frontmatter.scriptAPI || frontmatter.scriptApi),
      phaseConfigurations: normalizePhaseConfigurations(frontmatter.phases, content),
      maxRetries: parseOptionalPriority(frontmatter.maxRetries),
      priority: parsePriority(frontmatter.priority),
      explicit,
    };
  }

  private matchesUrl(workflow: BrowserWorkflow, url: string): boolean {
    if (workflow.matchPatterns.length === 0) {
      return false;
    }

    const normalizedUrl = url.toLowerCase();
    let hostname = '';
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = '';
    }

    return workflow.matchPatterns.some(pattern => {
      const normalizedPattern = pattern.trim().toLowerCase();
      if (!normalizedPattern) {
        return false;
      }

      if (normalizedPattern.startsWith('/') && normalizedPattern.endsWith('/')) {
        try {
          return new RegExp(normalizedPattern.slice(1, -1), 'i').test(url);
        } catch {
          return false;
        }
      }

      if (hostname === normalizedPattern || hostname.endsWith(`.${normalizedPattern}`)) {
        return true;
      }

      return normalizedUrl.includes(normalizedPattern);
    });
  }
}

function parseFrontmatter(content: string): { hasFrontmatter: boolean; data: Record<string, unknown> } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) {
    return { hasFrontmatter: false, data: {} };
  }

  try {
    const parsed = parse(match[1]);
    return {
      hasFrontmatter: true,
      data: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {},
    };
  } catch {
    return { hasFrontmatter: true, data: {} };
  }
}

function extractSection(content: string, heading: string): string {
  const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$([\\s\\S]*?)(?=^##\\s+|^#\\s+|(?![\\s\\S]))`, 'im');
  return content.match(pattern)?.[1]?.trim() || '';
}

function extractListSection(content: string, heading: string): string[] {
  const section = extractSection(content, heading);
  if (!section) {
    return [];
  }

  return section
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line))
    .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
    .filter(Boolean);
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }

  return [];
}

function normalizeActionTemplateMap(frontmatterValue: unknown, sectionMap: Record<string, string[]>): Record<string, string[]> {
  const fromFrontmatter = parseActionTemplateMap(frontmatterValue);
  const mergedKeys = new Set([...Object.keys(fromFrontmatter), ...Object.keys(sectionMap)]);
  const normalized: Record<string, string[]> = {};

  for (const key of mergedKeys) {
    const values = [...(fromFrontmatter[key] || []), ...(sectionMap[key] || [])].map(item => item.trim()).filter(Boolean);
    if (values.length > 0) {
      normalized[key] = Array.from(new Set(values));
    }
  }

  return normalized;
}

function normalizePhaseConfigurations(frontmatterValue: unknown, content: string): Partial<Record<BrowserAgentPhase, BrowserWorkflow['phaseConfigurations'][BrowserAgentPhase]>> {
  const frontmatter = parsePhaseConfigMap(frontmatterValue);
  const sectionSteps = extractPhaseListSection(content, 'Phase Steps');
  const sectionHints = extractPhaseListSection(content, 'Phase Hints');
  const sectionSuccess = mergePhaseListMaps(
    extractPhaseListSection(content, 'Phase Success'),
    extractPhaseListSection(content, 'Phase Success Criteria'),
  );
  const sectionDoneConditions = normalizePhaseDoneConditions(extractPhaseListSection(content, 'Phase Done Conditions'));
  const sectionSelectorSlots = extractPhaseActionTemplateSection(content, 'Phase Selector Slots');
  const sectionPreferredSelectors = extractPhaseActionTemplateSection(content, 'Phase Preferred Selectors');
  const sectionFallbackActions = extractPhaseActionTemplateSection(content, 'Phase Fallback Actions');
  const phases = new Set<string>([
    ...Object.keys(frontmatter),
    ...Object.keys(sectionSteps),
    ...Object.keys(sectionHints),
    ...Object.keys(sectionSuccess),
    ...Object.keys(sectionDoneConditions),
    ...Object.keys(sectionSelectorSlots),
    ...Object.keys(sectionPreferredSelectors),
    ...Object.keys(sectionFallbackActions),
  ]);
  const normalized: Partial<Record<BrowserAgentPhase, BrowserWorkflow['phaseConfigurations'][BrowserAgentPhase]>> = {};

  for (const rawPhase of phases) {
    if (!isBrowserAgentPhase(rawPhase)) {
      continue;
    }

    const phase = rawPhase;
    const front = frontmatter[phase] || {};
    const steps = mergeStringLists(front.steps, sectionSteps[phase]);
    const hints = mergeStringLists(front.hints, sectionHints[phase]);
    const successCriteria = mergeStringLists(front.successCriteria, sectionSuccess[phase]);
    const doneConditions = mergeDoneConditionLists(front.doneConditions, sectionDoneConditions[phase]);
    const selectorSlots = normalizeActionTemplateMap(front.selectorSlots, sectionSelectorSlots[phase] || {});
    const preferredSelectors = normalizeActionTemplateMap(front.preferredSelectors, sectionPreferredSelectors[phase] || {});
    const fallbackActions = normalizeActionTemplateMap(front.fallbackActions, sectionFallbackActions[phase] || {});
    const scriptBinding = parseScriptBinding(front.scriptBinding || front.scripts);
    const scriptApis = parseScriptApis(front.scriptApis || front.scriptAPI || front.scriptApi);

    if (steps.length === 0
      && hints.length === 0
      && successCriteria.length === 0
      && doneConditions.length === 0
      && Object.keys(selectorSlots).length === 0
      && Object.keys(preferredSelectors).length === 0
      && Object.keys(fallbackActions).length === 0
      && !scriptBinding
      && (!scriptApis || scriptApis.length === 0)) {
      continue;
    }

    normalized[phase] = {
      phase,
      steps,
      hints,
      successCriteria,
      selectorSlots,
      preferredSelectors,
      fallbackActions,
      doneConditions,
      scriptBinding,
      scriptApis,
    };
  }

  return normalized;
}

function parseActionTemplateMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const list = normalizeStringList(raw);
    if (list.length > 0) {
      normalized[key] = list;
    }
  }

  return normalized;
}

function parsePhaseConfigMap(value: unknown): Partial<Record<BrowserAgentPhase, {
  steps?: string[];
  hints?: string[];
  successCriteria?: string[];
  doneConditions?: string[];
  selectorSlots?: unknown;
  preferredSelectors?: unknown;
  fallbackActions?: unknown;
  scriptBinding?: unknown;
  scripts?: unknown;
  scriptApis?: unknown;
  scriptAPI?: unknown;
  scriptApi?: unknown;
}>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Partial<Record<BrowserAgentPhase, {
    steps?: string[];
    hints?: string[];
    successCriteria?: string[];
    doneConditions?: string[];
    selectorSlots?: unknown;
    preferredSelectors?: unknown;
    fallbackActions?: unknown;
    scriptBinding?: unknown;
    scripts?: unknown;
    scriptApis?: unknown;
    scriptAPI?: unknown;
    scriptApi?: unknown;
  }>> = {};

  for (const [rawPhase, rawConfig] of Object.entries(value as Record<string, unknown>)) {
    if (!isBrowserAgentPhase(rawPhase) || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      continue;
    }

    const config = rawConfig as Record<string, unknown>;
    normalized[rawPhase] = {
      steps: normalizeStringList(config.steps),
      hints: normalizeStringList(config.hints),
      successCriteria: normalizeStringList(config.successCriteria || config.success),
      doneConditions: normalizeStringList(config.doneConditions).map(normalizeDoneCondition).filter(Boolean),
      selectorSlots: config.selectorSlots,
      preferredSelectors: config.preferredSelectors,
      fallbackActions: config.fallbackActions,
      scriptBinding: config.scriptBinding,
      scripts: config.scripts,
      scriptApis: config.scriptApis,
      scriptAPI: config.scriptAPI,
      scriptApi: config.scriptApi,
    };
  }

  return normalized;
}

function extractActionTemplateSection(content: string, heading: string): Record<string, string[]> {
  const lines = extractSection(content, heading).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const normalized: Record<string, string[]> = {};

  for (const line of lines) {
    const cleaned = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
    const separatorIndex = cleaned.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = cleaned.slice(0, separatorIndex).trim();
    const value = cleaned.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    if (!normalized[key]) {
      normalized[key] = [];
    }
    normalized[key].push(value);
  }

  return normalized;
}

function extractPhaseListSection(content: string, heading: string): Partial<Record<BrowserAgentPhase, string[]>> {
  const section = extractSection(content, heading);
  if (!section) {
    return {};
  }

  const normalized: Partial<Record<BrowserAgentPhase, string[]>> = {};
  for (const [rawPhase, block] of Object.entries(extractPhaseBlocks(section))) {
    if (!isBrowserAgentPhase(rawPhase)) {
      continue;
    }

    normalized[rawPhase] = block
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line))
      .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim())
      .filter(Boolean);
  }

  return normalized;
}

function extractPhaseActionTemplateSection(content: string, heading: string): Partial<Record<BrowserAgentPhase, Record<string, string[]>>> {
  const section = extractSection(content, heading);
  if (!section) {
    return {};
  }

  const normalized: Partial<Record<BrowserAgentPhase, Record<string, string[]>>> = {};
  for (const [rawPhase, block] of Object.entries(extractPhaseBlocks(section))) {
    if (!isBrowserAgentPhase(rawPhase)) {
      continue;
    }

    normalized[rawPhase] = extractActionTemplateMapFromSection(block);
  }

  return normalized;
}

function extractPhaseBlocks(section: string): Record<string, string> {
  const normalized: Record<string, string> = {};
  const lines = section.split(/\r?\n/);
  let currentPhase: string | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    if (!currentPhase) {
      buffer = [];
      return;
    }

    const block = buffer.join('\n').trim();
    if (block) {
      normalized[currentPhase] = block;
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.trim().match(/^###\s+([^\r\n]+)\s*$/i);
    if (headingMatch?.[1]) {
      flush();
      currentPhase = headingMatch[1].trim();
      continue;
    }

    if (currentPhase) {
      buffer.push(line);
    }
  }

  flush();

  return normalized;
}

function extractActionTemplateMapFromSection(section: string): Record<string, string[]> {
  const lines = section.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const normalized: Record<string, string[]> = {};

  for (const line of lines) {
    const cleaned = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '').trim();
    const separatorIndex = cleaned.indexOf(':');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = cleaned.slice(0, separatorIndex).trim();
    const value = cleaned.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }

    if (!normalized[key]) {
      normalized[key] = [];
    }
    normalized[key].push(value);
  }

  return normalized;
}

function mergePhaseListMaps(...maps: Array<Partial<Record<BrowserAgentPhase, string[]>>>): Partial<Record<BrowserAgentPhase, string[]>> {
  const normalized: Partial<Record<BrowserAgentPhase, string[]>> = {};
  for (const phase of BROWSER_AGENT_PHASES) {
    const values = mergeStringLists(...maps.map(map => map[phase]));
    if (values.length > 0) {
      normalized[phase] = values;
    }
  }
  return normalized;
}

function normalizePhaseDoneConditions(map: Partial<Record<BrowserAgentPhase, string[]>>): Partial<Record<BrowserAgentPhase, string[]>> {
  const normalized: Partial<Record<BrowserAgentPhase, string[]>> = {};
  for (const phase of BROWSER_AGENT_PHASES) {
    const values = (map[phase] || []).map(normalizeDoneCondition).filter(Boolean);
    if (values.length > 0) {
      normalized[phase] = Array.from(new Set(values));
    }
  }
  return normalized;
}

function mergeStringLists(...lists: Array<string[] | undefined>): string[] {
  return Array.from(new Set(lists.flatMap(list => list || []).map(item => item.trim()).filter(Boolean)));
}

function mergeDoneConditionLists(...lists: Array<string[] | undefined>): string[] {
  return Array.from(new Set(lists.flatMap(list => list || []).map(item => normalizeDoneCondition(item)).filter(Boolean)));
}

function isBrowserAgentPhase(value: string): value is BrowserAgentPhase {
  return (BROWSER_AGENT_PHASES as readonly string[]).includes(value);
}

function buildLintSummary(workflowDir: string, results: BrowserWorkflowLintResult[]): BrowserWorkflowLintSummary {
  const counts = {
    files: results.length,
    valid: results.filter(result => result.valid).length,
    invalid: results.filter(result => !result.valid).length,
    errors: results.reduce((sum, result) => sum + result.issueCounts.errors, 0),
    warnings: results.reduce((sum, result) => sum + result.issueCounts.warnings, 0),
  };
  const codeMap = new Map<string, BrowserWorkflowLintCodeCount>();

  for (const result of results) {
    for (const issue of result.issues) {
      const key = `${issue.severity}:${issue.code}`;
      const current = codeMap.get(key);
      if (current) {
        current.count += 1;
      } else {
        codeMap.set(key, {
          code: issue.code,
          severity: issue.severity,
          count: 1,
        });
      }
    }
  }

  return {
    kind: 'browser-workflow-lint-summary',
    schemaVersion: BROWSER_WORKFLOW_LINT_SCHEMA_VERSION,
    workflowDir,
    counts,
    codeCounts: [...codeMap.values()].sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    results,
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parsePriority(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 0;
}

function parseOptionalPriority(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function extractFirstUrl(input: string): string | undefined {
  return input.match(/https?:\/\/\S+/i)?.[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requirePathExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

function normalizeDoneCondition(value: string): string {
  return value.replace(/\s*:\s*/g, ':').trim();
}

function parseScriptBinding(value: unknown): BrowserWorkflowScriptBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const binding = value as Record<string, unknown>;
  const normalized: BrowserWorkflowScriptBinding = {
    initScriptPaths: normalizeStringList(binding.initScriptPaths || binding.initPaths),
    initScripts: normalizeStringList(binding.initScripts || binding.initInline),
    pageScriptPaths: normalizeStringList(binding.pageScriptPaths || binding.pagePaths),
    pageScripts: normalizeStringList(binding.pageScripts || binding.pageInline),
    userscriptPaths: normalizeStringList(binding.userscriptPaths || binding.userscripts || binding.userScriptPaths),
    userscriptInline: normalizeStringList(binding.userscriptInline || binding.userScriptInline || binding.inlineUserscripts),
    userscriptMode: binding.userscriptMode === 'on' || binding.userscriptMode === 'off' ? binding.userscriptMode : undefined,
    userscriptRunAt: binding.userscriptRunAt === 'document-start' || binding.userscriptRunAt === 'document-end'
      ? binding.userscriptRunAt
      : undefined,
  };

  if (normalized.initScriptPaths.length === 0
    && normalized.initScripts.length === 0
    && normalized.pageScriptPaths.length === 0
    && normalized.pageScripts.length === 0
    && normalized.userscriptPaths.length === 0
    && normalized.userscriptInline.length === 0
    && !normalized.userscriptMode
    && !normalized.userscriptRunAt) {
    return undefined;
  }

  return normalized;
}

function parseScriptApis(value: unknown): BrowserWorkflowScriptApi[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    .map(item => ({
      name: asNonEmptyString(item.name) || '',
      description: asNonEmptyString(item.description) || '',
      args: parseScriptApiArgs(item.args),
      returns: parseScriptApiReturns(item.returns),
    }))
    .filter(item => item.name && item.description);

  return normalized.length > 0 ? normalized : undefined;
}

function parseScriptApiArgs(value: unknown): BrowserWorkflowScriptApi['args'] {
  if (!Array.isArray(value)) {
    return [];
  }

  type BrowserWorkflowScriptApiArg = BrowserWorkflowScriptApi['args'][number];
  const normalized: BrowserWorkflowScriptApiArg[] = [];

  for (const item of value) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) {
        normalized.push({ name, required: true });
      }
      continue;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    const arg = item as Record<string, unknown>;
    const name = asNonEmptyString(arg.name);
    if (!name) {
      continue;
    }

    normalized.push({
      name,
      type: arg.type === 'string' || arg.type === 'number' || arg.type === 'boolean' || arg.type === 'json'
        ? arg.type
        : undefined,
      required: typeof arg.required === 'boolean' ? arg.required : undefined,
      description: asNonEmptyString(arg.description),
    });
  }

  return normalized;
}

function parseScriptApiReturns(value: unknown): BrowserWorkflowScriptApi['returns'] {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }

    const arrayMatch = normalized.match(/^array\s*<\s*(.+?)\s*>$/i);
    if (arrayMatch?.[1]) {
      return {
        type: 'array',
        shape: arrayMatch[1].trim(),
      };
    }

    const primitive = normalized.toLowerCase();
    if (primitive === 'string' || primitive === 'number' || primitive === 'boolean' || primitive === 'json' || primitive === 'array' || primitive === 'object' || primitive === 'void') {
      return { type: primitive };
    }

    if (/^\{[\s\S]*\}$/.test(normalized)) {
      return {
        type: 'object',
        shape: normalized,
      };
    }

    return {
      description: normalized,
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const returns = value as Record<string, unknown>;
  const type = returns.type === 'string' || returns.type === 'number' || returns.type === 'boolean' || returns.type === 'json' || returns.type === 'array' || returns.type === 'object' || returns.type === 'void'
    ? returns.type
    : undefined;
  const shape = asNonEmptyString(returns.shape);
  const description = asNonEmptyString(returns.description);

  if (!type && !shape && !description) {
    return undefined;
  }

  return {
    type,
    shape,
    description,
  };
}