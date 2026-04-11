export type BrowserAgentMode = 'off' | 'hybrid' | 'smart';

export type BrowserAgentStepStatus = 'idle' | 'observing' | 'planning' | 'acting' | 'completed' | 'failed';
export type BrowserAgentRunStatus = 'completed' | 'failed' | 'safety_blocked' | 'max_steps';

export const BROWSER_AGENT_PHASES = ['unknown', 'landing', 'search-input', 'search-results', 'detail', 'form'] as const;
export type BrowserAgentPhase = typeof BROWSER_AGENT_PHASES[number];

export const BROWSER_WORKFLOW_LINT_SCHEMA_VERSION = 'browser-workflow-lint/v1' as const;

export type BrowserWorkflowLintSeverity = 'error' | 'warning';
export type BrowserWorkflowLintLocation = 'file' | 'frontmatter' | 'section';

export interface BrowserWorkflowLintFixSuggestion {
  summary: string;
  example?: string;
}

export interface BrowserWorkflowQuickFixDraft {
  code: string;
  severity: BrowserWorkflowLintSeverity;
  summary: string;
  example?: string;
  count: number;
  files: string[];
  phase?: BrowserAgentPhase;
  heading?: string;
}

export interface BrowserWorkflowLintIssue {
  severity: BrowserWorkflowLintSeverity;
  code: string;
  message: string;
  location: BrowserWorkflowLintLocation;
  field?: string;
  heading?: string;
  phase?: BrowserAgentPhase;
  action?: string;
  suggestion?: BrowserWorkflowLintFixSuggestion;
  data?: Record<string, unknown>;
}

export interface BrowserWorkflowLintIssueCounts {
  errors: number;
  warnings: number;
}

export interface BrowserWorkflowLintResult {
  kind: 'browser-workflow-lint-result';
  schemaVersion: typeof BROWSER_WORKFLOW_LINT_SCHEMA_VERSION;
  filePath: string;
  workflowName?: string;
  valid: boolean;
  issueCounts: BrowserWorkflowLintIssueCounts;
  issues: BrowserWorkflowLintIssue[];
}

export interface BrowserWorkflowLintCodeCount {
  code: string;
  severity: BrowserWorkflowLintSeverity;
  count: number;
}

export interface BrowserWorkflowLintSummaryCounts extends BrowserWorkflowLintIssueCounts {
  files: number;
  valid: number;
  invalid: number;
}

export interface BrowserWorkflowLintSummary {
  kind: 'browser-workflow-lint-summary';
  schemaVersion: typeof BROWSER_WORKFLOW_LINT_SCHEMA_VERSION;
  workflowDir: string;
  counts: BrowserWorkflowLintSummaryCounts;
  codeCounts: BrowserWorkflowLintCodeCount[];
  results: BrowserWorkflowLintResult[];
}

export interface BrowserSafetyInterruptionInfo {
  errorType: 'browser_safety_abort';
  statusCode: 'BROWSER_SAFETY_ABORTED';
  category: 'financial' | 'privacy' | 'illegal';
  stage: 'task' | 'request' | 'page' | 'action';
  matchedTerms: string[];
  matchedPolicy?: string;
  matchedSource?: 'built-in' | 'config-block';
  reason: string;
}

export interface BrowserPhaseSnapshot {
  phase: BrowserAgentPhase;
  confidence: number;
  signals: string[];
  transition?: string;
}

export interface BrowserWorkflowScriptBinding {
  initScriptPaths: string[];
  initScripts: string[];
  pageScriptPaths: string[];
  pageScripts: string[];
  userscriptPaths: string[];
  userscriptInline: string[];
  userscriptMode?: 'on' | 'off';
  userscriptRunAt?: 'document-start' | 'document-end';
}

export interface BrowserScriptResultContract {
  type?: 'string' | 'number' | 'boolean' | 'json' | 'array' | 'object' | 'void';
  shape?: string;
  description?: string;
}

export type BrowserScriptResultMismatchStrategy = 'record-only' | 'warn' | 'hard-fail';

export interface BrowserWorkflowScriptApi {
  name: string;
  description: string;
  args: Array<{
    name: string;
    type?: 'string' | 'number' | 'boolean' | 'json';
    required?: boolean;
    description?: string;
  }>;
  returns?: BrowserScriptResultContract;
}

export interface BrowserWorkflowPhaseConfig {
  phase: BrowserAgentPhase;
  steps: string[];
  hints: string[];
  successCriteria: string[];
  selectorSlots: Record<string, string[]>;
  preferredSelectors: Record<string, string[]>;
  fallbackActions: Record<string, string[]>;
  doneConditions: string[];
  scriptBinding?: BrowserWorkflowScriptBinding;
  scriptApis?: BrowserWorkflowScriptApi[];
}

export interface BrowserInteractiveElement {
  id: string;
  selector: string;
  role: string;
  text?: string;
  type?: string;
  placeholder?: string;
  href?: string;
}

export interface BrowserPageDigest {
  url: string;
  title: string;
  visibleText?: string;
  interactiveSummary?: string[];
  interactiveElements?: BrowserInteractiveElement[];
  screenshotPath?: string;
  fingerprint?: string;
}

export interface BrowserWorkflow {
  name: string;
  description: string;
  sourcePath: string;
  startUrl?: string;
  matchPatterns: string[];
  whenToUse?: string;
  steps: string[];
  hints: string[];
  successCriteria: string[];
  selectorSlots: Record<string, string[]>;
  preferredSelectors: Record<string, string[]>;
  fallbackActions: Record<string, string[]>;
  doneConditions: string[];
  phaseConfigurations: Partial<Record<BrowserAgentPhase, BrowserWorkflowPhaseConfig>>;
  scriptBinding?: BrowserWorkflowScriptBinding;
  scriptApis?: BrowserWorkflowScriptApi[];
  maxRetries?: number;
  priority: number;
  explicit?: boolean;
}

export interface BrowserWorkflowTemplateResult {
  name: string;
  filePath: string;
}

export interface BrowserWorkflowResolution {
  workflowDir: string;
  workflows: BrowserWorkflow[];
  lintResults?: BrowserWorkflowLintResult[];
}

export interface BrowserActionProposal {
  type: 'navigate' | 'click' | 'fill' | 'press' | 'extract' | 'wait' | 'evaluate_script' | 'call_userscript_api' | 'toggle_userscript_mode' | 'done';
  selector?: string;
  url?: string;
  value?: string;
  key?: string;
  script?: string;
  api?: string;
  args?: unknown[];
  enabled?: boolean;
  expectResult?: BrowserScriptResultContract;
  reason: string;
  confidence: number;
}

export interface BrowserExecutionTrace {
  step: number;
  status: BrowserAgentStepStatus;
  summary: string;
  url?: string;
  title?: string;
  phase?: BrowserAgentPhase;
  actions?: BrowserActionProposal[];
  timestamp: string;
}

export interface BrowserAgentTask {
  goal: string;
  startUrl?: string;
  maxSteps?: number;
  workflowPath?: string;
}

export interface BrowserAgentRunResult {
  success: boolean;
  status: BrowserAgentRunStatus;
  finalMessage: string;
  errorType?: string;
  statusCode?: string;
  safety?: BrowserSafetyInterruptionInfo;
  traces: BrowserExecutionTrace[];
  appliedWorkflows?: string[];
  workflowDir?: string;
}
