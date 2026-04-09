import type { PermissionManager } from '../permission-manager.js';
import type { SkillContext, SkillManager } from '../skills.js';
import type { DirectActionResult } from '../direct-action-router.js';

export interface DirectActionLegacyFallbackServiceOptions {
  skillManager: SkillManager;
  permissionManager: PermissionManager;
  createSkillContext: () => SkillContext;
  hasBuiltInTool: (name: string) => boolean;
  executeBuiltInTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
  executeSkillTool: (name: string, args: Record<string, unknown>, title: string) => Promise<DirectActionResult>;
}

export class DirectActionLegacyFallbackService {
  constructor(private readonly options: DirectActionLegacyFallbackServiceOptions) {}

  async tryLegacyFallbacks(input: string): Promise<DirectActionResult | null> {
    const directToolResult = await this.tryExplicitToolCall(input);
    if (directToolResult) {
      return directToolResult;
    }

    const skillCommandResult = await this.trySkillCommand(input);
    if (skillCommandResult) {
      return skillCommandResult;
    }

    return this.trySkillMessageHooks(input);
  }

  private async trySkillMessageHooks(input: string): Promise<DirectActionResult | null> {
    const ctx = this.options.createSkillContext();

    for (const skill of this.options.skillManager.getEnabledSkills()) {
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

  private async trySkillCommand(input: string): Promise<DirectActionResult | null> {
    const [commandName, ...args] = input.split(/\s+/);
    if (!commandName) {
      return null;
    }

    const skillCommand = this.options.skillManager.getCommands().find(command => command.name === commandName);
    if (!skillCommand) {
      return null;
    }

    const granted = await this.options.permissionManager.requestPermission(
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

    const output = await this.options.skillManager.executeCommand(commandName, args, this.options.createSkillContext());
    return {
      handled: true,
      title: `[Skill:${skillCommand.skill}]`,
      output,
    };
  }

  private async tryExplicitToolCall(input: string): Promise<DirectActionResult | null> {
    const match = input.match(/^@tool\s+(\S+)\s*(.*)$/i);
    if (!match) {
      return null;
    }

    const toolName = match[1];
    const rawArgs = match[2]?.trim() || '{}';
    if (!toolName) {
      return null;
    }

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

    if (this.options.hasBuiltInTool(toolName)) {
      return this.options.executeBuiltInTool(toolName, args, `[Direct ${toolName}]`);
    }

    const skillTool = this.options.skillManager.getTools().find(tool => tool.name === toolName);
    if (skillTool) {
      return this.options.executeSkillTool(toolName, args, `[Skill:${skillTool.skill}]`);
    }

    return {
      handled: true,
      title: '[Direct tool]',
      output: `Unknown tool: ${toolName}`,
      isError: true,
    };
  }
}