import { BuiltInTools } from '../tools/builtin.js';
import { SkillManager, SkillContext, SkillToolResult } from './skills.js';
import { PermissionManager } from './permission-manager.js';
import { extractResource, getToolPermission } from './tool-permissions.js';

export interface DirectActionResult {
  handled: boolean;
  title?: string;
  output?: string;
  isError?: boolean;
}

export interface DirectActionRouterOptions {
  builtInTools: BuiltInTools;
  skillManager: SkillManager;
  permissionManager: PermissionManager;
  workspace: string;
  config?: unknown;
}

export class DirectActionRouter {
  private builtInTools: BuiltInTools;
  private skillManager: SkillManager;
  private permissionManager: PermissionManager;
  private workspace: string;
  private config: Record<string, unknown>;

  constructor(options: DirectActionRouterOptions) {
    this.builtInTools = options.builtInTools;
    this.skillManager = options.skillManager;
    this.permissionManager = options.permissionManager;
    this.workspace = options.workspace;
    this.config = (options.config && typeof options.config === 'object' ? options.config as Record<string, unknown> : {});
  }

  async tryHandle(input: string): Promise<DirectActionResult | null> {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const hookResult = await this.trySkillMessageHooks(trimmed);
    if (hookResult) return hookResult;

    const builtInResult = await this.tryBuiltInFileAction(trimmed);
    if (builtInResult) return builtInResult;

    const skillCommandResult = await this.trySkillCommand(trimmed);
    if (skillCommandResult) return skillCommandResult;

    const directToolResult = await this.tryExplicitToolCall(trimmed);
    if (directToolResult) return directToolResult;

    return null;
  }

  private async trySkillMessageHooks(input: string): Promise<DirectActionResult | null> {
    const ctx = this.createSkillContext();

    for (const skill of this.skillManager.getEnabledSkills()) {
      const result = await skill.hooks?.onMessage?.(input, ctx);
      if (result) {
        return {
          handled: true,
          title: `[Skill:${skill.name}]`,
          output: result,
        };
      }
    }

    return null;
  }

  private async tryBuiltInFileAction(input: string): Promise<DirectActionResult | null> {
    const readPatterns = [
      /^(?:read_file|读取文件|读取|查看文件|查看|打开文件|打开)\s+(.+)$/i,
      /^(?:请)?(?:帮我)?(?:读取|查看|打开)\s+(.+)$/i,
    ];
    const listPatterns = [
      /^(?:list_directory|列出目录|列出文件|查看目录)\s+(.+)$/i,
    ];

    for (const pattern of readPatterns) {
      const match = input.match(pattern);
      const filePath = match?.[1]?.trim();
      if (filePath) {
        return this.executeBuiltInTool('read_file', { path: this.normalizePath(filePath) }, '[Direct read_file]');
      }
    }

    for (const pattern of listPatterns) {
      const match = input.match(pattern);
      const dirPath = match?.[1]?.trim();
      if (dirPath) {
        return this.executeBuiltInTool('list_directory', { path: this.normalizePath(dirPath) }, '[Direct list_directory]');
      }
    }

    return null;
  }

  private async trySkillCommand(input: string): Promise<DirectActionResult | null> {
    const [commandName, ...args] = input.split(/\s+/);
    if (!commandName) return null;

    const skillCommand = this.skillManager.getCommands().find(command => command.name === commandName);
    if (!skillCommand) return null;

    const granted = await this.permissionManager.requestPermission(
      'tool_execute',
      `skill_command:${commandName}`,
      `Execute skill command: ${commandName}`,
    );
    if (!granted) {
      return {
        handled: true,
        title: `[Skill:${skillCommand.skill}]`,
        output: `Permission denied: skill command ${commandName}`,
        isError: true,
      };
    }

    const output = await this.skillManager.executeCommand(commandName, args, this.createSkillContext());
    return {
      handled: true,
      title: `[Skill:${skillCommand.skill}]`,
      output,
    };
  }

  private async tryExplicitToolCall(input: string): Promise<DirectActionResult | null> {
    const match = input.match(/^@tool\s+(\S+)\s*(.*)$/i);
    if (!match) return null;

    const toolName = match[1];
    const rawArgs = match[2]?.trim() || '{}';
    if (!toolName) return null;

    let args: Record<string, unknown>;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return {
        handled: true,
        title: '[Direct tool]',
        output: 'Invalid JSON arguments for @tool call',
        isError: true,
      };
    }

    const builtInNames = new Set(this.builtInTools.getTools().map(tool => tool.name));
    if (builtInNames.has(toolName)) {
      return this.executeBuiltInTool(toolName, args, `[Direct ${toolName}]`);
    }

    const skillTool = this.skillManager.getTools().find(tool => tool.name === toolName);
    if (skillTool) {
      const granted = await this.permissionManager.requestPermission(
        'tool_execute',
        `skill_tool:${toolName}`,
        `Execute skill tool: ${toolName}`,
      );
      if (!granted) {
        return {
          handled: true,
          title: `[Skill:${skillTool.skill}]`,
          output: `Permission denied: skill tool ${toolName}`,
          isError: true,
        };
      }

      const result = await this.skillManager.executeTool(toolName, args, this.createSkillContext());
      return {
        handled: true,
        title: `[Skill:${skillTool.skill}]`,
        output: this.skillToolResultToText(result),
        isError: result.isError,
      };
    }

    return {
      handled: true,
      title: '[Direct tool]',
      output: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }

  private async executeBuiltInTool(name: string, args: Record<string, unknown>, title: string): Promise<DirectActionResult> {
    const permission = getToolPermission(name);
    if (permission) {
      const resource = extractResource(name, args) || permission.resourceExtractor?.(args);
      const granted = await this.permissionManager.requestPermission(
        permission.permissionType,
        resource,
        `${name}${resource ? ` on ${resource}` : ''}`,
      );
      if (!granted) {
        return {
          handled: true,
          title,
          output: `Permission denied: ${permission.permissionType}${resource ? ` (${resource})` : ''}`,
          isError: true,
        };
      }
    }

    const result = await this.builtInTools.executeTool(name, args);
    return {
      handled: true,
      title,
      output: result.output || this.skillToolResultToText({ content: result.content?.filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text || '' })) || [] }),
      isError: result.is_error,
    };
  }

  private createSkillContext(): SkillContext {
    return {
      workspace: this.workspace,
      config: this.config,
      skillsDir: this.skillManager.getSkillsDir(),
    };
  }

  private skillToolResultToText(result: SkillToolResult): string {
    return result.content.map(item => item.text).join('\n');
  }

  private normalizePath(rawPath: string): string {
    const unquoted = rawPath.replace(/^['"]|['"]$/g, '');
    return unquoted;
  }
}

export function createDirectActionRouter(options: DirectActionRouterOptions): DirectActionRouter {
  return new DirectActionRouter(options);
}