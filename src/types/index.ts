export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ToolCategory = 
  | 'file_operations'   // File read, write, edit, delete, glob, grep
  | 'execution'         // Bash, PowerShell, REPL
  | 'search_fetch'      // Web search, web fetch, browser
  | 'agents_tasks'      // Agent message, task queue, teams
  | 'planning'          // Enter/exit plan mode, worktree
  | 'mcp'               // MCP tools
  | 'system'            // Config, skills, cron, todo
  | 'experimental';     // LSP, sleep, etc

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  category?: ToolCategory;
}

export interface ToolResult {
  tool_call_id: string;
  output?: string;
  is_error?: boolean;
  errorType?: string;
  statusCode?: string;
  metadata?: Record<string, unknown>;
  content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>;
}

export interface LLMConfig {
  baseUrl: string;
  model: string;
  visionModel?: string;
  visionMaxImages?: number;
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
  systemPrompt?: string;
  enabled?: boolean;
  apiKey?: string;
}

export interface DeepSeekAutoReasoningConfig {
  enabled?: boolean;
  simpleTaskMaxChars?: number;
  simpleConversationMaxChars?: number;
  preferReasonerForToolMessages?: boolean;
  preferReasonerForPlanning?: boolean;
  preferReasonerForLongContext?: boolean;
}

export interface DeepSeekLLMConfig extends LLMConfig {
  reasoningModel?: string;
  autoReasoning?: DeepSeekAutoReasoningConfig;
}

export interface HybridLLMConfig {
  enabled?: boolean;
  localProvider: 'ollama' | 'deepseek' | 'kimi' | 'glm' | 'doubao' | 'minimax' | 'openai' | 'claude' | 'gemini';
  remoteProvider: 'ollama' | 'deepseek' | 'kimi' | 'glm' | 'doubao' | 'minimax' | 'openai' | 'claude' | 'gemini';
  simpleTaskMaxChars?: number;
  simpleConversationMaxChars?: number;
  preferRemoteForToolMessages?: boolean;
  localAvailabilityCacheMs?: number;
}

export interface DirectActionConversationModeConfig {
  enabled?: boolean;
  preambleThreshold?: number;
}

export interface DirectActionConfig {
  conversationMode?: DirectActionConversationModeConfig;
}

export type CommandExecutionMode = 'shell' | 'direct-only' | 'allowlist';

export type AgentInteractionMode = 'auto' | 'chat' | 'task';
export type FunctionMode = 'chat' | 'workflow';

export interface FunctionRoutingConfig {
  preferWorkflow?: boolean;
  allowAutoSwitchFromChatToWorkflow?: boolean;
  announceRouteDecisions?: boolean;
  socialChatKeywords?: string[];
  knowledgeChatKeywords?: string[];
  directActionKeywords?: string[];
  workflowKeywords?: string[];
  workflowSwitchKeywords?: string[];
  chatSwitchKeywords?: string[];
}

export const TASK_CONTEXT_SCHEMA_VERSION = 'task-context/v1' as const;
export const AGENT_GRAPH_STATE_SCHEMA_VERSION = 'agent-graph-state/v1' as const;
export const CONTEXT_BUS_SCHEMA_VERSION = 'context-bus/v1' as const;

export type AgentGraphNode = 'direct_action' | 'clarify' | 'plan' | 'execute_step' | 'pause_for_input' | 'resume' | 'finalize';
export type AgentCheckpointStatus = 'running' | 'waiting' | 'completed' | 'failed';
export type AgentGraphMode = 'fresh' | 'resume';
export type AgentGraphRoute = 'direct_action' | 'agent';

export interface AgentGraphCheckpoint {
  node: AgentGraphNode;
  status: AgentCheckpointStatus;
  updatedAt: string;
  summary?: string;
  input?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskBindingSnapshot {
  isFollowUp: boolean;
  effectiveInput: string;
  boundTask?: SessionTaskRecord;
}

export interface AgentPendingInteractionSnapshot {
  type: 'plan_execution' | 'write_file' | 'task_clarification' | 'plan_resume' | 'direct_action_execution';
  prompt?: string;
  originalTask?: string;
  hasPlan: boolean;
  hasResumeState: boolean;
}

export interface AgentPlanResumeSnapshot {
  originalTask: string;
  nextStepIndex: number;
  blockedStepDescription: string;
  blockedReason: string;
  resultCount: number;
}

export interface AgentToolBudgetSnapshot {
  iteration: number;
  toolCallCount: number;
  maxToolCallsPerTurn: number;
  maxIterations: number;
  lastStopReason: 'completed' | 'tool_limit' | 'max_iterations' | 'error';
  needsContinuation: boolean;
}

export interface UnifiedAgentState {
  state: 'IDLE' | 'THINKING' | 'TOOL_CALLING' | 'WAITING_CONFIRMATION' | 'RESPONDING';
  lastUserInput: string;
  runtimeMemoryContext?: string;
  messages: Message[];
  taskBinding?: AgentTaskBindingSnapshot;
  pendingInteraction?: AgentPendingInteractionSnapshot;
  planResume?: AgentPlanResumeSnapshot;
  toolBudget: AgentToolBudgetSnapshot;
  checkpoint?: AgentGraphCheckpoint;
}

export interface AgentGraphState extends UnifiedAgentState {
  schemaVersion: typeof AGENT_GRAPH_STATE_SCHEMA_VERSION;
  mode: AgentGraphMode;
  route: AgentGraphRoute;
  originalInput: string;
  effectiveInput: string;
  currentNode: AgentGraphNode;
  status: AgentCheckpointStatus;
  output?: string;
}

export type SessionTaskChannel = 'direct_action' | 'agent';
export type SessionTaskStatus = 'completed' | 'failed';

export interface SessionTaskRecord {
  id: string;
  channel: SessionTaskChannel;
  title: string;
  input: string;
  effectiveInput?: string;
  category?: string;
  handlerName?: string;
  status: SessionTaskStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTaskBindingRelation {
  sourceTask: SessionTaskRecord;
  targetTask?: SessionTaskRecord;
  targetTaskId: string;
  targetTaskTitle?: string;
}

export interface SessionTaskContextSnapshot {
  activeTask?: SessionTaskRecord;
  bindableTask?: SessionTaskRecord;
  recentTasks: SessionTaskRecord[];
  recentBindings: SessionTaskBindingRelation[];
  checkpoint?: AgentGraphCheckpoint;
}

export type ContextBusLayer = 'session' | 'task_stack' | 'graph' | 'agent' | 'cli';

export interface ContextBusSnapshotPayload {
  taskContext?: SessionTaskContextSnapshot;
  graphState?: AgentGraphState;
  agentState?: UnifiedAgentState;
  checkpoint?: AgentGraphCheckpoint;
  runtimeMemoryContext?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextBusSnapshot {
  id: string;
  layer: ContextBusLayer;
  scopeId: string;
  rootId: string;
  parentId?: string;
  taskId?: string;
  externalKey?: string;
  title?: string;
  payload: ContextBusSnapshotPayload;
  createdAt: string;
  updatedAt: string;
}

export interface ContextBusCurrentPointer {
  layer: ContextBusLayer;
  scopeId: string;
  snapshotId: string;
}

export interface ContextBusState {
  schemaVersion: typeof CONTEXT_BUS_SCHEMA_VERSION;
  snapshots: ContextBusSnapshot[];
  currentPointers: ContextBusCurrentPointer[];
}

export interface ContextBusQuery {
  layer?: ContextBusLayer | ContextBusLayer[];
  scopeId?: string;
  rootId?: string;
  parentId?: string;
  taskId?: string;
  text?: string;
  limit?: number;
}

export interface BrowserAgentObserveConfig {
  useScreenshotByDefault?: boolean;
  forceScreenshotAfterFailures?: number;
  fullPageScreenshot?: boolean;
  maxDomNodes?: number;
  maxTextChars?: number;
}

export interface BrowserAgentOptimizationConfig {
  enableStateCache?: boolean;
  enableDiffObservation?: boolean;
  enableRuleFastPath?: boolean;
  enableActionBatching?: boolean;
}

export interface BrowserAgentSafetyKeywordPolicy {
  global?: string[];
  financial?: string[];
  privacy?: string[];
  illegal?: string[];
}

export interface BrowserAgentSafetyDomainPolicy {
  name?: string;
  match: string[];
  allowKeywords?: BrowserAgentSafetyKeywordPolicy;
  blockKeywords?: BrowserAgentSafetyKeywordPolicy;
  blockFinancialActions?: boolean;
  blockPrivacyActions?: boolean;
  blockIllegalActions?: boolean;
}

export interface BrowserAgentSafetyConfig {
  enabled?: boolean;
  blockFinancialActions?: boolean;
  blockPrivacyActions?: boolean;
  blockIllegalActions?: boolean;
  allowKeywords?: BrowserAgentSafetyKeywordPolicy;
  blockKeywords?: BrowserAgentSafetyKeywordPolicy;
  domainPolicies?: BrowserAgentSafetyDomainPolicy[];
}

export interface BrowserAgentDebugConfig {
  saveTrace?: boolean;
  saveScreenshotsOnFailure?: boolean;
}

export interface BrowserAgentUserscriptConfig {
  paths?: string[];
  inline?: string[];
  runAt?: 'document-start' | 'document-end';
  enabled?: boolean;
}

export type BrowserScriptResultMismatchStrategy = 'record-only' | 'warn' | 'hard-fail';

export interface BrowserAgentConfig {
  enabled?: boolean;
  mode?: 'off' | 'hybrid' | 'smart';
  browser?: 'chrome' | 'edge' | 'chromium';
  headless?: boolean;
  timeoutMs?: number;
  userDataDir?: string;
  executablePath?: string;
  extensionPaths?: string[];
  initScriptPaths?: string[];
  initScripts?: string[];
  pageScriptPaths?: string[];
  pageScripts?: string[];
  userscripts?: BrowserAgentUserscriptConfig;
  workflowDir?: string;
  autoMatchWorkflows?: boolean;
  preferredLocalProvider?: 'ollama';
  fallbackProvider?: 'default' | 'deepseek' | 'kimi' | 'glm' | 'doubao' | 'minimax' | 'openai' | 'claude' | 'gemini';
  ollamaHealthCheckUrl?: string;
  ollamaHealthCacheMs?: number;
  plannerModel?: string;
  extractorModel?: string;
  visionProvider?: 'default' | 'ollama' | 'deepseek' | 'kimi' | 'glm' | 'doubao' | 'minimax' | 'openai' | 'claude' | 'gemini';
  expectResultMismatchStrategy?: BrowserScriptResultMismatchStrategy;
  maxSteps?: number;
  maxActionsPerPlan?: number;
  observe?: BrowserAgentObserveConfig;
  optimization?: BrowserAgentOptimizationConfig;
  safety?: BrowserAgentSafetyConfig;
  debug?: BrowserAgentDebugConfig;
}

export interface MemoryConfig {
  backend?: 'local' | 'mempalace' | 'hybrid';
  recallLimit?: number;
  enableSessionSync?: boolean;
  enableAutoArchive?: boolean;
}

export interface LarkMorningNewsConfig {
  userId?: string;
  chatId?: string;
  schedule?: string;
  timezone?: string;
  saveOutput?: boolean;
  title?: string;
}

export interface LarkRelayConfig {
  enabled?: boolean;
  autoSubscribe?: boolean;
  eventTypes?: string[];
  compact?: boolean;
  quiet?: boolean;
  allowedChatIds?: string[];
  allowedSenderIds?: string[];
  allowCommands?: boolean;
  downloadAttachments?: boolean;
  receiveDir?: string;
  cliBin?: string;
}

export interface NotificationsConfig {
  lark?: {
    morningNews?: LarkMorningNewsConfig;
    relay?: LarkRelayConfig;
  };
}

export interface WorkflowCheckpointConfig {
  enabled?: boolean;
  planApproval?: boolean;
  continuationApproval?: boolean;
  outboundApproval?: boolean;
  riskyDirectActionApproval?: boolean;
  announceCheckpoints?: boolean;
}

export type OutputChannelLevel = 'debug' | 'info' | 'warning' | 'error';

export interface OutputChannelConfig {
  enabled?: boolean;
  minLevel?: OutputChannelLevel;
}

export interface OutputConfig {
  pauseOnPermissionPrompt?: boolean;
  separateChannels?: boolean;
  process?: OutputChannelConfig;
  notification?: OutputChannelConfig;
  permission?: OutputChannelConfig;
}

export interface AgentConfig {
  defaultProvider?: string;
  ollama: LLMConfig;
  deepseek?: DeepSeekLLMConfig;
  kimi?: LLMConfig;
  glm?: LLMConfig;
  doubao?: LLMConfig;
  minimax?: LLMConfig;
  openai?: LLMConfig;
  claude?: LLMConfig;
  gemini?: LLMConfig;
  hybrid?: HybridLLMConfig;
  browserAgent?: BrowserAgentConfig;
  mcp?: MCPConfig[];
  lsp?: LSPServerConfig[];
  sandbox?: SandboxConfig;
  memory?: MemoryConfig;
  directAction?: DirectActionConfig;
  functionMode?: FunctionMode;
  functionRouting?: FunctionRoutingConfig;
  agentInteractionMode?: AgentInteractionMode;
  appBaseDir?: string;
  artifactOutputDir?: string;
  documentOutputDir?: string;
  workspace?: string;
  maxIterations?: number;
  maxToolCallsPerTurn?: number;
  autoContinueOnToolLimit?: boolean;
  maxContinuationTurns?: number;
  toolTimeout?: number;
  notifications?: NotificationsConfig;
  checkpoints?: WorkflowCheckpointConfig;
  output?: OutputConfig;
}

export interface MCPConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LSPServerConfig {
  name: string;
  command: string;
  args?: string[];
  languages?: string[];
  rootPatterns?: string[];
}

export interface SandboxConfig {
  enabled: boolean;
  allowedPaths?: string[];
  deniedPaths?: string[];
  timeout?: number;
  maxMemory?: number;
  allowCommandExecution?: boolean;
  allowBash?: boolean;
  allowPowerShell?: boolean;
  commandExecutionMode?: CommandExecutionMode;
  commandAllowlist?: string[];
  allowNetworkRequests?: boolean;
  allowBrowserOpen?: boolean;
  allowBrowserAutomation?: boolean;
}

export interface FileEdit {
  path: string;
  oldText?: string;
  newText?: string;
  create?: boolean;
  delete?: boolean;
}

export interface ReadFileResult {
  path: string;
  content: string;
  exists: boolean;
}

export interface WriteFileResult {
  path: string;
  success: boolean;
  error?: string;
}

export interface ExecuteResult {
  command: string;
  args?: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  duration?: number;
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface Diagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
}

export interface SymbolInfo {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
  containerName?: string;
}
