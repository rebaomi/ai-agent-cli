import type { MCPManager } from '../mcp/client.js';
import type { Tool, ToolResult } from '../types/index.js';
import type { BuiltInTools } from '../tools/builtin.js';
import type { SkillManager, SkillContext, SkillToolResult } from './skills.js';
import {
  createExecutionPermissionMiddleware,
  type ToolExecutionPermissionHandler,
} from './tool-execution-permissions.js';
import {
  ToolExecutor,
  type ToolExecutionAuditHandler,
  type ToolExecutionAuditOptions,
  type ToolExecutionEventHandler,
  type ToolExecutionMiddleware,
} from './tool-executor.js';

export type ToolSource = 'builtin' | 'skill' | 'mcp';

export interface RegisteredTool extends Tool {
  source: ToolSource;
  serverName?: string;
  skillName?: string;
}

export interface ToolRegistryOptions {
  builtInTools: BuiltInTools;
  mcpManager?: MCPManager;
  skillManager?: SkillManager;
  skillContextFactory?: () => SkillContext;
  executionMiddlewares?: ToolExecutionMiddleware[];
  onExecutionEvent?: ToolExecutionEventHandler;
  onAuditRecord?: ToolExecutionAuditHandler;
  auditOptions?: ToolExecutionAuditOptions;
  onPermissionCheck?: ToolExecutionPermissionHandler;
}

export class ToolRegistry {
  private builtInTools: BuiltInTools;
  private mcpManager?: MCPManager;
  private skillManager?: SkillManager;
  private skillContextFactory?: () => SkillContext;
  private tools = new Map<string, RegisteredTool>();
  private executor: ToolExecutor;

  constructor(options: ToolRegistryOptions) {
    this.builtInTools = options.builtInTools;
    this.mcpManager = options.mcpManager;
    this.skillManager = options.skillManager;
    this.skillContextFactory = options.skillContextFactory;
    this.executor = new ToolExecutor({
      builtInTools: this.builtInTools,
      mcpManager: this.mcpManager,
      skillManager: this.skillManager,
      skillContextFactory: this.skillContextFactory,
      getTool: (name) => this.getTool(name),
      middlewares: [
        ...(options.onPermissionCheck ? [createExecutionPermissionMiddleware(options.onPermissionCheck)] : []),
        ...(options.executionMiddlewares ?? []),
      ],
      onExecutionEvent: options.onExecutionEvent,
      onAuditRecord: options.onAuditRecord,
      auditOptions: options.auditOptions,
    });
  }

  async refresh(): Promise<void> {
    this.tools.clear();

    for (const tool of this.builtInTools.getTools()) {
      this.tools.set(tool.name, {
        ...tool,
        source: 'builtin',
      });
    }

    if (this.skillManager) {
      for (const tool of this.skillManager.getTools()) {
        if (this.tools.has(tool.name)) {
          continue;
        }
        this.tools.set(tool.name, {
          name: tool.name,
          description: `[skill:${tool.skill}] ${tool.description}`,
          input_schema: tool.inputSchema,
          category: 'system',
          source: 'skill',
          skillName: tool.skill,
        });
      }
    }

    if (this.mcpManager) {
      const mcpTools = await this.mcpManager.listAllTools();
      for (const { server, tool } of mcpTools) {
        this.tools.set(`${server}_${tool.name}`, {
          name: `${server}_${tool.name}`,
          description: `[${server}] ${tool.description}`,
          input_schema: tool.inputSchema as Record<string, unknown>,
          category: 'mcp',
          source: 'mcp',
          serverName: server,
        });
      }
    }
  }

  listTools(): Tool[] {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      category: tool.category,
    }));
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return this.executor.execute(name, args);
  }

  useExecutionMiddleware(middleware: ToolExecutionMiddleware): void {
    this.executor.use(middleware);
  }
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  return new ToolRegistry(options);
}