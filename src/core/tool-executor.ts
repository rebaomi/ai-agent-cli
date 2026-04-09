import type { MCPManager } from '../mcp/client.js';
import type { ToolResult } from '../types/index.js';
import type { BuiltInTools } from '../tools/builtin.js';
import type { SkillManager, SkillContext } from './skills.js';
import type { RegisteredTool } from './tool-registry.js';
import { normalizeSkillExecutionError } from './skill-execution-error.js';
import { executeSkillToolWithContext } from './skill-tool-execution.js';

export interface ToolExecutionContext {
  name: string;
  args: Record<string, unknown>;
  tool: RegisteredTool;
}

export type ToolExecutionHandler = (context: ToolExecutionContext) => Promise<ToolResult>;
export type ToolExecutionMiddleware = (context: ToolExecutionContext, next: ToolExecutionHandler) => Promise<ToolResult>;

export interface ToolExecutionStartEvent {
  phase: 'start';
  context: ToolExecutionContext;
}

export interface ToolExecutionFinishEvent {
  phase: 'finish';
  context: ToolExecutionContext;
  result: ToolResult;
  durationMs: number;
}

export interface ToolExecutionErrorEvent {
  phase: 'error';
  context: ToolExecutionContext;
  error: unknown;
  durationMs: number;
}

export type ToolExecutionEvent = ToolExecutionStartEvent | ToolExecutionFinishEvent | ToolExecutionErrorEvent;
export type ToolExecutionEventHandler = (event: ToolExecutionEvent) => void;

export interface ToolExecutionAuditRecord {
  toolName: string;
  toolSource: RegisteredTool['source'];
  serverName?: string;
  skillName?: string;
  argsPreview: string;
  outputPreview: string;
  isError: boolean;
  durationMs: number;
  status: 'completed' | 'threw';
}

export interface ToolExecutionAuditOptions {
  maxArgsPreviewLength?: number;
  maxOutputPreviewLength?: number;
}

export type ToolExecutionAuditHandler = (record: ToolExecutionAuditRecord) => void;

export interface ToolExecutorOptions {
  builtInTools: BuiltInTools;
  mcpManager?: MCPManager;
  skillManager?: SkillManager;
  skillContextFactory?: () => SkillContext;
  getTool: (name: string) => RegisteredTool | undefined;
  middlewares?: ToolExecutionMiddleware[];
  onExecutionEvent?: ToolExecutionEventHandler;
  onAuditRecord?: ToolExecutionAuditHandler;
  auditOptions?: ToolExecutionAuditOptions;
}

export class ToolExecutor {
  private builtInTools: BuiltInTools;
  private mcpManager?: MCPManager;
  private skillManager?: SkillManager;
  private skillContextFactory?: () => SkillContext;
  private getToolByName: (name: string) => RegisteredTool | undefined;
  private middlewares: ToolExecutionMiddleware[];

  constructor(options: ToolExecutorOptions) {
    this.builtInTools = options.builtInTools;
    this.mcpManager = options.mcpManager;
    this.skillManager = options.skillManager;
    this.skillContextFactory = options.skillContextFactory;
    this.getToolByName = options.getTool;
    this.middlewares = [
      createExecutionErrorBoundaryMiddleware(),
      ...(options.onExecutionEvent ? [createExecutionLifecycleMiddleware(options.onExecutionEvent)] : []),
      ...(options.onAuditRecord ? [createExecutionAuditMiddleware(options.onAuditRecord, options.auditOptions)] : []),
      ...(options.middlewares ?? []),
    ];
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.getToolByName(name);
    if (!tool) {
      return {
        tool_call_id: '',
        output: `Unknown tool: ${name}`,
        is_error: true,
      };
    }

    const context: ToolExecutionContext = {
      name,
      args,
      tool,
    };

    return this.createExecutionPipeline()(context);
  }

  use(middleware: ToolExecutionMiddleware): void {
    this.middlewares.push(middleware);
  }

  private createExecutionPipeline(): ToolExecutionHandler {
    return this.middlewares.reduceRight<ToolExecutionHandler>(
      (next, middleware) => async (context) => middleware(context, next),
      (context) => this.executeResolvedTool(context),
    );
  }

  private async executeResolvedTool(context: ToolExecutionContext): Promise<ToolResult> {
    const { name, args, tool } = context;

    if (tool.source === 'builtin') {
      return this.builtInTools.executeTool(name, args);
    }

    if (tool.source === 'skill') {
      if (!this.skillManager || !this.skillContextFactory) {
        return {
          tool_call_id: '',
          output: `Skill tool unavailable: ${name}`,
          is_error: true,
        };
      }

      const result = await executeSkillToolWithContext(this.skillManager, name, args, this.skillContextFactory());
      return {
        tool_call_id: '',
        output: result.output,
        content: result.content,
        is_error: result.isError,
      };
    }

    if (tool.source === 'mcp') {
      if (!this.mcpManager || !tool.serverName) {
        return {
          tool_call_id: '',
          output: `MCP tool unavailable: ${name}`,
          is_error: true,
        };
      }

      try {
        const toolName = name.slice(tool.serverName.length + 1);
        const result = await this.mcpManager.callTool(tool.serverName, toolName, args);
        return {
          tool_call_id: '',
          output: this.normalizeTextBlocks(result.content),
          content: result.content,
          is_error: result.isError,
        };
      } catch (error) {
        return {
          tool_call_id: '',
          output: `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
          is_error: true,
        };
      }
    }

    return {
      tool_call_id: '',
      output: `Unsupported tool source: ${tool.source}`,
      is_error: true,
    };
  }

  private normalizeTextBlocks(content: Array<{ type: 'text' | 'image' | 'resource'; text?: string }>): string {
    return content
      .filter(item => item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text || '')
      .join('\n');
  }

}

export function createExecutionLifecycleMiddleware(onEvent: ToolExecutionEventHandler): ToolExecutionMiddleware {
  return async (context, next) => {
    const startedAt = Date.now();
    onEvent({
      phase: 'start',
      context,
    });

    try {
      const result = await next(context);
      onEvent({
        phase: 'finish',
        context,
        result,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      onEvent({
        phase: 'error',
        context,
        error,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  };
}

export function createExecutionErrorBoundaryMiddleware(): ToolExecutionMiddleware {
  return async (context, next) => {
    try {
      return await next(context);
    } catch (error) {
      return {
        tool_call_id: '',
        output: normalizeUnhandledToolError(context, error),
        is_error: true,
      };
    }
  };
}

export function createExecutionAuditMiddleware(
  onAuditRecord: ToolExecutionAuditHandler,
  options: ToolExecutionAuditOptions = {},
): ToolExecutionMiddleware {
  const maxArgsPreviewLength = options.maxArgsPreviewLength ?? 240;
  const maxOutputPreviewLength = options.maxOutputPreviewLength ?? 240;

  return async (context, next) => {
    const startedAt = Date.now();

    try {
      const result = await next(context);
      onAuditRecord({
        toolName: context.name,
        toolSource: context.tool.source,
        serverName: context.tool.serverName,
        skillName: context.tool.skillName,
        argsPreview: truncatePreview(safeJsonStringify(context.args), maxArgsPreviewLength),
        outputPreview: truncatePreview(result.output || normalizeContentPreview(result.content), maxOutputPreviewLength),
        isError: result.is_error === true,
        durationMs: Date.now() - startedAt,
        status: 'completed',
      });
      return result;
    } catch (error) {
      onAuditRecord({
        toolName: context.name,
        toolSource: context.tool.source,
        serverName: context.tool.serverName,
        skillName: context.tool.skillName,
        argsPreview: truncatePreview(safeJsonStringify(context.args), maxArgsPreviewLength),
        outputPreview: truncatePreview(error instanceof Error ? error.message : String(error), maxOutputPreviewLength),
        isError: true,
        durationMs: Date.now() - startedAt,
        status: 'threw',
      });
      throw error;
    }
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable args]';
  }
}

function normalizeContentPreview(content?: Array<{ type: 'text' | 'image' | 'resource'; text?: string }>): string {
  if (!Array.isArray(content) || content.length === 0) {
    return '';
  }

  return content
    .map(item => {
      if (item.type === 'text') {
        return item.text || '';
      }

      return `[${item.type}]`;
    })
    .filter(Boolean)
    .join('\n');
}

function truncatePreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeUnhandledToolError(context: ToolExecutionContext, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (context.tool.source === 'builtin') {
    return `Built-in tool error: ${message}`;
  }

  if (context.tool.source === 'mcp') {
    return `MCP tool error: ${message}`;
  }

  return `Tool execution error: ${message}`;
}