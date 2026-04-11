import type { LLMProviderInterface } from '../../llm/types.js';
import type { BrowserAgentConfig } from '../../types/index.js';
import type { BrowserActionProposal, BrowserAgentRunResult, BrowserAgentTask, BrowserExecutionTrace, BrowserPageDigest, BrowserPhaseSnapshot, BrowserWorkflow, BrowserWorkflowResolution, BrowserWorkflowScriptBinding } from '../domain/types.js';
import { BrowserActionPlanner } from '../planner/action-planner.js';
import { SitePhaseMachine } from '../phase/site-phase-machine.js';
import { BrowserSession } from '../runtime/browser-session.js';
import { SensitiveOperationGuard } from '../safety/sensitive-operation-guard.js';

export interface BrowserAgentRunnerOptions {
  plannerClient: LLMProviderInterface;
  extractorClient: LLMProviderInterface;
  browserAgentConfig: BrowserAgentConfig;
  workflowResolution?: BrowserWorkflowResolution;
  workspace?: string;
  appBaseDir?: string;
  artifactOutputDir?: string;
  documentOutputDir?: string;
}

export class BrowserAgentRunner {
  constructor(private readonly options: BrowserAgentRunnerOptions) {}

  async run(task: BrowserAgentTask): Promise<BrowserAgentRunResult> {
    const traces: BrowserExecutionTrace[] = [];
    const extractedTexts: string[] = [];
    const guard = new SensitiveOperationGuard(this.options.browserAgentConfig.safety);
    const workflowScriptBinding = this.collectWorkflowScriptBinding(this.options.workflowResolution?.workflows || []);
    const session = new BrowserSession({
      browser: this.options.browserAgentConfig.browser || 'chrome',
      executablePath: this.options.browserAgentConfig.executablePath,
      headless: this.options.browserAgentConfig.headless ?? true,
      timeoutMs: this.options.browserAgentConfig.timeoutMs ?? 15000,
      workspace: this.options.workspace || process.cwd(),
      appBaseDir: this.options.appBaseDir,
      artifactOutputDir: this.options.artifactOutputDir,
      documentOutputDir: this.options.documentOutputDir,
      userDataDir: this.options.browserAgentConfig.userDataDir,
      extensionPaths: [
        ...(this.options.browserAgentConfig.extensionPaths || []),
      ],
      initScriptPaths: [
        ...(this.options.browserAgentConfig.initScriptPaths || []),
        ...(workflowScriptBinding?.initScriptPaths || []),
      ],
      initScripts: [
        ...(this.options.browserAgentConfig.initScripts || []),
        ...(workflowScriptBinding?.initScripts || []),
      ],
      pageScriptPaths: [
        ...(this.options.browserAgentConfig.pageScriptPaths || []),
        ...(workflowScriptBinding?.pageScriptPaths || []),
      ],
      pageScripts: [
        ...(this.options.browserAgentConfig.pageScripts || []),
        ...(workflowScriptBinding?.pageScripts || []),
      ],
      userscripts: {
        ...(this.options.browserAgentConfig.userscripts || {}),
        paths: [
          ...((this.options.browserAgentConfig.userscripts?.paths) || []),
          ...(workflowScriptBinding?.userscriptPaths || []),
        ],
        inline: [
          ...((this.options.browserAgentConfig.userscripts?.inline) || []),
          ...(workflowScriptBinding?.userscriptInline || []),
        ],
        runAt: workflowScriptBinding?.userscriptRunAt || this.options.browserAgentConfig.userscripts?.runAt,
        enabled: workflowScriptBinding?.userscriptMode
          ? workflowScriptBinding.userscriptMode === 'on'
          : this.options.browserAgentConfig.userscripts?.enabled,
      },
      expectResultMismatchStrategy: this.options.browserAgentConfig.expectResultMismatchStrategy,
    });
    const planner = new BrowserActionPlanner({
      plannerClient: this.options.plannerClient,
      maxActionsPerPlan: Math.max(1, this.options.browserAgentConfig.maxActionsPerPlan ?? 2),
    });
    const phaseMachine = new SitePhaseMachine();
    const maxSteps = Math.max(1, task.maxSteps ?? this.options.browserAgentConfig.maxSteps ?? 8);
    const enableDiffObservation = this.options.browserAgentConfig.optimization?.enableDiffObservation !== false;
    const enableRuleFastPath = this.options.browserAgentConfig.optimization?.enableRuleFastPath !== false;
    const appliedPhaseScriptBindings = new Set<string>();
    let traceStep = 1;
    let previousDigest: BrowserPageDigest | undefined;
    let currentPhase: BrowserPhaseSnapshot | undefined;

    const taskAssessment = guard.checkTask(task);
    if (taskAssessment) {
      traces.push(this.createTrace(traceStep++, 'failed', taskAssessment.reason));
      return {
        success: false,
        status: 'safety_blocked',
        finalMessage: taskAssessment.reason,
        errorType: taskAssessment.errorType,
        statusCode: taskAssessment.statusCode,
        safety: taskAssessment,
        traces,
        appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
        workflowDir: this.options.workflowResolution?.workflowDir,
      };
    }

    try {
      await session.start(task.startUrl);

      for (let step = 0; step < maxSteps; step += 1) {
        const digest = await session.observe({
          maxDomNodes: this.options.browserAgentConfig.observe?.maxDomNodes ?? 120,
          maxTextChars: this.options.browserAgentConfig.observe?.maxTextChars ?? 4000,
        });
        currentPhase = phaseMachine.advance(digest);
        const workflows = this.getApplicableWorkflows(digest.url);
        await this.applyPhaseScriptBindings(session, workflows, currentPhase, appliedPhaseScriptBindings);
        const diffSummary = enableDiffObservation ? this.describeDigestDiff(previousDigest, digest) : undefined;
        traces.push(this.createTrace(traceStep++, 'observing', this.createObservationSummary(digest, diffSummary, currentPhase), digest, undefined, currentPhase));

        const pageAssessment = guard.checkPage(digest);
        if (pageAssessment) {
          traces.push(this.createTrace(traceStep++, 'failed', pageAssessment.reason, digest));
          return {
            success: false,
            status: 'safety_blocked',
            finalMessage: pageAssessment.reason,
            errorType: pageAssessment.errorType,
            statusCode: pageAssessment.statusCode,
            safety: pageAssessment,
            traces,
            appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
            workflowDir: this.options.workflowResolution?.workflowDir,
          };
        }

        const matchedDoneCondition = this.matchDoneConditions(workflows, digest, extractedTexts, currentPhase);
        if (matchedDoneCondition) {
          const finalMessage = await this.buildFinalMessage(task, digest, extractedTexts, `命中 workflow 完成条件: ${matchedDoneCondition}`);
          traces.push(this.createTrace(traceStep++, 'completed', `Workflow done condition matched: ${matchedDoneCondition}`, digest));
          return {
            success: true,
            status: 'completed',
            finalMessage,
            traces,
            appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
            workflowDir: this.options.workflowResolution?.workflowDir,
          };
        }

        const plan = await planner.createPlan(task, digest, traces, {
          previousDigest,
          diffSummary,
          allowFastPath: enableRuleFastPath,
          workflows,
          phase: currentPhase,
        });
        const plannedActions = plan.actions.length > 0
          ? plan.actions
          : [{ type: 'extract', selector: 'body', reason: '未规划出动作，退回页面内容提取', confidence: 0.1 } satisfies BrowserActionProposal];

        traces.push(this.createTrace(traceStep++, 'planning', this.createPlanSummary(plan.source, plan.finalMessage, plannedActions, currentPhase), digest, plannedActions, currentPhase));

        for (const action of plannedActions) {
          const actionAssessment = guard.checkAgentAction(action, digest);
          if (actionAssessment) {
            traces.push(this.createTrace(traceStep++, 'failed', actionAssessment.reason, digest, [action], currentPhase));
            return {
              success: false,
              status: 'safety_blocked',
              finalMessage: actionAssessment.reason,
              errorType: actionAssessment.errorType,
              statusCode: actionAssessment.statusCode,
              safety: actionAssessment,
              traces,
              appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
              workflowDir: this.options.workflowResolution?.workflowDir,
            };
          }

          if (action.type === 'done') {
            const finalMessage = await this.buildFinalMessage(task, digest, extractedTexts, plan.finalMessage || action.reason || '任务已完成');
            traces.push(this.createTrace(traceStep++, 'completed', finalMessage, digest, [action], currentPhase));
            return {
              success: true,
              status: 'completed',
              finalMessage,
              traces,
              appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
              workflowDir: this.options.workflowResolution?.workflowDir,
            };
          }

          const actionResult = await session.executeWithOptions(action, this.buildExecutionOptions(workflows, action.type, currentPhase));
          if (actionResult.extractedText) {
            extractedTexts.push(actionResult.extractedText);
          }

          traces.push(this.createTrace(traceStep++, 'acting', actionResult.summary, undefined, [action], currentPhase));
        }

        previousDigest = digest;
      }

      const finalDigest = await session.observe({
        maxDomNodes: this.options.browserAgentConfig.observe?.maxDomNodes ?? 120,
        maxTextChars: this.options.browserAgentConfig.observe?.maxTextChars ?? 4000,
      });
      const finalMessage = await this.buildFinalMessage(task, finalDigest, extractedTexts, `已达到最大步数 ${maxSteps}，返回当前页面信息供后续判断。`);

      return {
        success: extractedTexts.length > 0,
        status: extractedTexts.length > 0 ? 'max_steps' : 'failed',
        finalMessage,
        traces,
        appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
        workflowDir: this.options.workflowResolution?.workflowDir,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      traces.push(this.createTrace(traceStep, 'failed', message));
      return {
        success: false,
        status: 'failed',
        finalMessage: `Browser Agent 执行失败: ${message}`,
        traces,
        appliedWorkflows: this.options.workflowResolution?.workflows.map(workflow => workflow.name),
        workflowDir: this.options.workflowResolution?.workflowDir,
      };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  createObservationSummary(digest: BrowserPageDigest, diffSummary?: string, phase?: BrowserPhaseSnapshot): string {
    const parts = [
      `URL: ${digest.url}`,
      `Title: ${digest.title}`,
    ];

    if (phase) {
      parts.push(`Phase: ${phase.phase} (${phase.confidence.toFixed(2)})${phase.transition ? ` ${phase.transition}` : ''}`);
    }

    if (diffSummary) {
      parts.push(`Diff: ${diffSummary}`);
    }

    if (digest.interactiveSummary?.length) {
      parts.push(`Interactive: ${digest.interactiveSummary.join('; ')}`);
    }

    if (digest.visibleText) {
      parts.push(`Text: ${digest.visibleText.slice(0, 500)}`);
    }

    return parts.join('\n');
  }

  private createPlanSummary(source: 'rule' | 'llm', finalMessage: string | undefined, actions: BrowserActionProposal[], phase?: BrowserPhaseSnapshot): string {
    const actionSummary = actions.map(action => `${action.type}${action.selector ? `(${action.selector})` : action.url ? `(${action.url})` : ''}: ${action.reason}`).join('; ');
    const head = `Plan Source: ${source}${phase ? ` | Phase: ${phase.phase}` : ''}`;
    if (finalMessage) {
      return `${head}\n${finalMessage}\n${actionSummary}`;
    }

    return `${head}\n${actionSummary}`;
  }

  private describeDigestDiff(previousDigest: BrowserPageDigest | undefined, currentDigest: BrowserPageDigest): string | undefined {
    if (!previousDigest) {
      return '首次观察';
    }

    const changes: string[] = [];
    if (previousDigest.url !== currentDigest.url) {
      changes.push(`URL 从 ${previousDigest.url} 变为 ${currentDigest.url}`);
    }
    if (previousDigest.title !== currentDigest.title) {
      changes.push(`标题从 ${previousDigest.title} 变为 ${currentDigest.title}`);
    }
    if (previousDigest.fingerprint === currentDigest.fingerprint) {
      changes.push('页面指纹未变化');
    }

    const previousInteractive = new Set(previousDigest.interactiveSummary || []);
    const currentInteractive = new Set(currentDigest.interactiveSummary || []);
    const addedInteractive = [...currentInteractive].filter(item => !previousInteractive.has(item)).slice(0, 3);
    const removedInteractive = [...previousInteractive].filter(item => !currentInteractive.has(item)).slice(0, 3);

    if (addedInteractive.length > 0) {
      changes.push(`新增交互项: ${addedInteractive.join(' | ')}`);
    }
    if (removedInteractive.length > 0) {
      changes.push(`消失交互项: ${removedInteractive.join(' | ')}`);
    }

    const previousText = previousDigest.visibleText || '';
    const currentText = currentDigest.visibleText || '';
    if (previousText !== currentText) {
      const sharedPrefixLength = getSharedPrefixLength(previousText, currentText);
      const nextSnippet = currentText.slice(sharedPrefixLength, sharedPrefixLength + 120).trim();
      if (nextSnippet) {
        changes.push(`文本变化片段: ${nextSnippet}`);
      }
    }

    return changes.length > 0 ? changes.join('；') : '页面无明显变化';
  }

  private getApplicableWorkflows(url?: string): BrowserWorkflow[] {
    const workflows = this.options.workflowResolution?.workflows || [];
    if (!url) {
      return workflows.filter(workflow => workflow.explicit).slice(0, 3);
    }

    return workflows
      .filter(workflow => workflow.explicit || this.matchesWorkflowUrl(workflow, url))
      .slice(0, 3);
  }

  private matchesWorkflowUrl(workflow: BrowserWorkflow, url: string): boolean {
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

      return hostname === normalizedPattern || hostname.endsWith(`.${normalizedPattern}`) || normalizedUrl.includes(normalizedPattern);
    });
  }

  private buildExecutionOptions(workflows: BrowserWorkflow[], actionType: BrowserActionProposal['type'], phase?: BrowserPhaseSnapshot): {
    selectorSlots?: Record<string, string[]>;
    preferredSelectors?: string[];
    fallbackActions?: string[];
    maxRetries?: number;
  } {
    const selectorSlots = this.collectSelectorSlots(workflows, phase);
    const preferredSelectors = workflows.flatMap(workflow => [
      ...(workflow.preferredSelectors[actionType] || []),
      ...((phase ? workflow.phaseConfigurations[phase.phase]?.preferredSelectors[actionType] : undefined) || []),
    ]);
    const fallbackActions = workflows.flatMap(workflow => [
      ...(workflow.fallbackActions[actionType] || []),
      ...((phase ? workflow.phaseConfigurations[phase.phase]?.fallbackActions[actionType] : undefined) || []),
    ]);
    const maxRetries = workflows
      .map(workflow => workflow.maxRetries)
      .find((value): value is number => typeof value === 'number' && Number.isFinite(value));

    return {
      selectorSlots: Object.keys(selectorSlots).length > 0 ? selectorSlots : undefined,
      preferredSelectors: preferredSelectors.length > 0 ? Array.from(new Set(preferredSelectors)) : undefined,
      fallbackActions: fallbackActions.length > 0 ? Array.from(new Set(fallbackActions)) : undefined,
      maxRetries,
    };
  }

  private collectWorkflowScriptBinding(workflows: BrowserWorkflow[]): BrowserWorkflowScriptBinding | undefined {
    const merged: BrowserWorkflowScriptBinding = {
      initScriptPaths: [],
      initScripts: [],
      pageScriptPaths: [],
      pageScripts: [],
      userscriptPaths: [],
      userscriptInline: [],
    };

    let userscriptMode: BrowserWorkflowScriptBinding['userscriptMode'];
    let userscriptRunAt: BrowserWorkflowScriptBinding['userscriptRunAt'];

    for (const workflow of workflows) {
      const binding = workflow.scriptBinding;
      if (!binding) {
        continue;
      }

      pushUnique(merged.initScriptPaths, binding.initScriptPaths);
      pushUnique(merged.initScripts, binding.initScripts);
      pushUnique(merged.pageScriptPaths, binding.pageScriptPaths);
      pushUnique(merged.pageScripts, binding.pageScripts);
      pushUnique(merged.userscriptPaths, binding.userscriptPaths);
      pushUnique(merged.userscriptInline, binding.userscriptInline);

      userscriptMode = userscriptMode || binding.userscriptMode;
      userscriptRunAt = userscriptRunAt || binding.userscriptRunAt;
    }

    if (userscriptMode) {
      merged.userscriptMode = userscriptMode;
    }
    if (userscriptRunAt) {
      merged.userscriptRunAt = userscriptRunAt;
    }

    if (merged.initScriptPaths.length === 0
      && merged.initScripts.length === 0
      && merged.pageScriptPaths.length === 0
      && merged.pageScripts.length === 0
      && merged.userscriptPaths.length === 0
      && merged.userscriptInline.length === 0
      && !merged.userscriptMode
      && !merged.userscriptRunAt) {
      return undefined;
    }

    return merged;
  }

  private async applyPhaseScriptBindings(
    session: BrowserSession,
    workflows: BrowserWorkflow[],
    phase: BrowserPhaseSnapshot | undefined,
    appliedBindings: Set<string>,
  ): Promise<void> {
    if (!phase) {
      return;
    }

    for (const workflow of workflows) {
      const binding = workflow.phaseConfigurations[phase.phase]?.scriptBinding;
      if (!binding) {
        continue;
      }

      const key = `${workflow.sourcePath}#${phase.phase}`;
      if (appliedBindings.has(key)) {
        continue;
      }

      await session.applyScriptBinding(binding);
      appliedBindings.add(key);
    }
  }

  private collectSelectorSlots(workflows: BrowserWorkflow[], phase?: BrowserPhaseSnapshot): Record<string, string[]> {
    const merged: Record<string, string[]> = {};
    for (const workflow of workflows) {
      for (const [key, selectors] of Object.entries(workflow.selectorSlots)) {
        if (!merged[key]) {
          merged[key] = [];
        }
        for (const selector of selectors) {
          if (!merged[key].includes(selector)) {
            merged[key].push(selector);
          }
        }
      }

      const phaseSelectors = phase ? workflow.phaseConfigurations[phase.phase]?.selectorSlots : undefined;
      for (const [key, selectors] of Object.entries(phaseSelectors || {})) {
        if (!merged[key]) {
          merged[key] = [];
        }
        for (const selector of selectors) {
          if (!merged[key].includes(selector)) {
            merged[key].push(selector);
          }
        }
      }
    }

    return merged;
  }

  private matchDoneConditions(workflows: BrowserWorkflow[], digest: BrowserPageDigest, extractedTexts: string[], phase?: BrowserPhaseSnapshot): string | null {
    const extractionPreview = extractedTexts.slice(-2).join('\n');

    for (const workflow of workflows) {
      const conditions = [
        ...workflow.doneConditions,
        ...((phase ? workflow.phaseConfigurations[phase.phase]?.doneConditions : undefined) || []),
      ];
      for (const condition of conditions) {
        if (this.matchesDoneCondition(condition, digest, extractionPreview)) {
          return `${workflow.name}: ${condition}`;
        }
      }
    }

    return null;
  }

  private matchesDoneCondition(condition: string, digest: BrowserPageDigest, extractedText: string): boolean {
    const trimmed = condition.trim();
    if (!trimmed) {
      return false;
    }

    if (trimmed.startsWith('urlIncludes:')) {
      return digest.url.toLowerCase().includes(trimmed.slice('urlIncludes:'.length).trim().toLowerCase());
    }

    if (trimmed.startsWith('titleIncludes:')) {
      return digest.title.toLowerCase().includes(trimmed.slice('titleIncludes:'.length).trim().toLowerCase());
    }

    if (trimmed.startsWith('textIncludes:')) {
      const needle = trimmed.slice('textIncludes:'.length).trim().toLowerCase();
      return `${digest.visibleText || ''}\n${extractedText}`.toLowerCase().includes(needle);
    }

    if (trimmed.startsWith('urlMatches:')) {
      return this.matchesRegexCondition(trimmed.slice('urlMatches:'.length).trim(), digest.url);
    }

    if (trimmed.startsWith('textMatches:')) {
      return this.matchesRegexCondition(trimmed.slice('textMatches:'.length).trim(), `${digest.visibleText || ''}\n${extractedText}`);
    }

    return `${digest.visibleText || ''}\n${extractedText}`.toLowerCase().includes(trimmed.toLowerCase());
  }

  private matchesRegexCondition(pattern: string, value: string): boolean {
    const normalized = pattern.trim();
    if (!normalized) {
      return false;
    }

    const match = normalized.match(/^\/(.*)\/([a-z]*)$/i);
    if (match?.[1]) {
      try {
        return new RegExp(match[1], match[2] || 'i').test(value);
      } catch {
        return false;
      }
    }

    try {
      return new RegExp(normalized, 'i').test(value);
    } catch {
      return value.toLowerCase().includes(normalized.toLowerCase());
    }
  }

  private async buildFinalMessage(task: BrowserAgentTask, digest: BrowserPageDigest, extractedTexts: string[], fallback: string): Promise<string> {
    const extractionPreview = extractedTexts.slice(-2).join('\n\n---\n\n').slice(0, 4000);
    const prompt = [
      '你是浏览器自动化结果总结器。',
      '请根据任务目标和当前页面状态输出简洁中文结论。',
      `任务目标: ${task.goal}`,
      `当前 URL: ${digest.url}`,
      `当前标题: ${digest.title}`,
      `页面摘要: ${digest.visibleText || ''}`,
      `提取到的内容: ${extractionPreview || '无'}`,
      `如果信息不足，请直接输出这句回退结果: ${fallback}`,
    ].join('\n');

    try {
      const result = await this.options.extractorClient.generate(prompt);
      return result.trim() || fallback;
    } catch {
      return fallback;
    }
  }

  private createTrace(step: number, status: BrowserExecutionTrace['status'], summary: string, digest?: BrowserPageDigest, actions?: BrowserActionProposal[], phase?: BrowserPhaseSnapshot): BrowserExecutionTrace {
    return {
      step,
      status,
      summary,
      url: digest?.url,
      title: digest?.title,
      phase: phase?.phase,
      actions,
      timestamp: new Date().toISOString(),
    };
  }
}

function pushUnique(target: string[], values: string[] | undefined): void {
  for (const value of values || []) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function getSharedPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }

  return index;
}
