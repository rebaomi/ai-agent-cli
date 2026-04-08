import type { MCPManager } from '../mcp/client.js';
import type { Tool, ToolResult } from '../types/index.js';
import type { BuiltInTools } from '../tools/builtin.js';
import type { SkillManager, SkillContext, SkillToolResult } from './skills.js';

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
}

export class ToolRegistry {
  private builtInTools: BuiltInTools;
  private mcpManager?: MCPManager;
  private skillManager?: SkillManager;
  private skillContextFactory?: () => SkillContext;
  private tools = new Map<string, RegisteredTool>();

  constructor(options: ToolRegistryOptions) {
    this.builtInTools = options.builtInTools;
    this.mcpManager = options.mcpManager;
    this.skillManager = options.skillManager;
    this.skillContextFactory = options.skillContextFactory;
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
    const tool = this.getTool(name);
    if (!tool) {
      return {
        tool_call_id: '',
        output: `Unknown tool: ${name}`,
        is_error: true,
      };
    }

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

      try {
        const result = await this.skillManager.executeTool(name, args, this.skillContextFactory());
        return this.normalizeSkillToolResult(result);
      } catch (error) {
        return {
          tool_call_id: '',
          output: this.normalizeSkillExecutionError(name, error),
          is_error: true,
        };
      }
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

  private normalizeSkillToolResult(result: SkillToolResult): ToolResult {
    return {
      tool_call_id: '',
      output: this.normalizeTextBlocks(result.content),
      content: result.content,
      is_error: result.isError,
    };
  }

  private normalizeTextBlocks(content: Array<{ type: 'text' | 'image' | 'resource'; text?: string }>): string {
    return content
      .filter(item => item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text || '')
      .join('\n');
  }

  private normalizeSkillExecutionError(name: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    if (this.isUnavailableDocxSkill(name, message)) {
      return [
        '无可用 docx skill。',
        '当前安装的 minimax-docx 不可用，原因是缺少可运行的 .NET SDK。',
        '可改用 PDF、Markdown 或 TXT 导出，或在安装 .NET SDK 后再试 DOCX。',
      ].join('\n');
    }

    if (this.isUnavailablePdfSkill(name, message)) {
      return [
        '无可用 pdf skill。',
        '当前安装的 minimax-pdf 不可用，原因是缺少 Playwright/Chromium 运行环境。',
        '可先执行 npm install -g playwright，并运行 npx playwright install chromium；或者先导出为 Markdown、TXT、DOCX。',
      ].join('\n');
    }

    return `Skill tool error: ${message}`;
  }

  private isUnavailableDocxSkill(name: string, message: string): boolean {
    if (!/docx/i.test(name)) {
      return false;
    }

    return /minimax-docx 当前不可用|缺少 .*\.net sdk|No \.NET SDKs were found|application 'run' does not exist|dotnet run/i.test(message);
  }

  private isUnavailablePdfSkill(name: string, message: string): boolean {
    if (!/pdf/i.test(name)) {
      return false;
    }

    return /playwright not found|npx playwright install chromium|chromium/i.test(message);
  }
}

export function createToolRegistry(options: ToolRegistryOptions): ToolRegistry {
  return new ToolRegistry(options);
}