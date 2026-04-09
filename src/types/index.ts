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
  content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string; data?: string; mimeType?: string }>;
}

export interface LLMConfig {
  baseUrl: string;
  model: string;
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
  cliBin?: string;
}

export interface NotificationsConfig {
  lark?: {
    morningNews?: LarkMorningNewsConfig;
    relay?: LarkRelayConfig;
  };
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
  mcp?: MCPConfig[];
  lsp?: LSPServerConfig[];
  sandbox?: SandboxConfig;
  memory?: MemoryConfig;
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
