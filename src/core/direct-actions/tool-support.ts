import type { BuiltInTools } from '../../tools/builtin.js';
import type { PermissionManager } from '../permission-manager.js';
import { extractResource, getToolPermission } from '../tool-permissions.js';
import type { SkillContext, SkillManager } from '../skills.js';
import type { DirectActionResult } from '../direct-action-router.js';
import type { ConvertibleFormat } from './runtime-context.js';
import type { DirectActionArtifactSupport } from './artifact-support.js';
import type { DirectActionExportSupport } from './export-support.js';
import { executeSkillToolWithContext, skillToolResultToText } from '../skill-tool-execution.js';
import { DirectActionLegacyFallbackService } from './legacy-fallback-service.js';

export interface DirectActionToolSupportOptions {
  builtInTools: BuiltInTools;
  skillManager: SkillManager;
  permissionManager: PermissionManager;
  workspace: string;
  config: Record<string, unknown>;
  artifactSupport: DirectActionArtifactSupport;
  exportSupport: DirectActionExportSupport;
}

export class DirectActionToolSupport {
  private readonly legacyFallbackService: DirectActionLegacyFallbackService;

  constructor(private readonly options: DirectActionToolSupportOptions) {
    this.legacyFallbackService = new DirectActionLegacyFallbackService({
      skillManager: this.options.skillManager,
      permissionManager: this.options.permissionManager,
      createSkillContext: () => this.createSkillContext(),
      hasBuiltInTool: (name) => this.hasBuiltInTool(name),
      executeBuiltInTool: (name, args, title) => this.executeBuiltInTool(name, args, title),
      executeSkillTool: (name, args, title) => this.executeSkillTool(name, args, title),
    });
  }

  async tryLegacyFallbacks(input: string): Promise<DirectActionResult | null> {
    return this.legacyFallbackService.tryLegacyFallbacks(input);
  }

  async executeBuiltInTool(name: string, args: Record<string, unknown>, title: string): Promise<DirectActionResult> {
    const permission = getToolPermission(name);
    if (permission) {
      const resource = extractResource(name, args) || permission.resourceExtractor?.(args);
      const granted = await this.options.permissionManager.requestPermission(
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

    const result = await this.options.builtInTools.executeTool(name, args);
    const response = {
      handled: true,
      title,
      output: result.output || skillToolResultToText({ content: result.content?.filter(item => item.type === 'text').map(item => ({ type: 'text', text: item.text || '' })) || [] }),
      isError: result.is_error,
    };
    if (!response.isError) {
      await this.options.artifactSupport.rememberSuccessfulToolResult(name, args);
    }
    return response;
  }

  async executeSkillTool(name: string, args: Record<string, unknown>, title: string): Promise<DirectActionResult> {
    const skillTool = this.options.skillManager.getTools().find(tool => tool.name === name);
    if (!skillTool) {
      return {
        handled: true,
        title,
        output: `Unknown skill tool: ${name}`,
        isError: true,
      };
    }

    const granted = await this.options.permissionManager.requestPermission(
      'tool_execute',
      `skill_tool:${name}`,
      `Execute skill tool: ${name}`,
    );
    if (!granted) {
      return {
        handled: true,
        title,
        output: `Permission denied: skill tool ${name}`,
        isError: true,
      };
    }

    const result = await executeSkillToolWithContext(this.options.skillManager, name, args, this.createSkillContext());

    const response = {
      handled: true,
      title,
      output: result.output,
      isError: result.isError,
    };
    if (!response.isError) {
      await this.options.artifactSupport.rememberSuccessfulToolResult(name, args);
    }
    return response;
  }

  hasBuiltInTool(name: string): boolean {
    return this.options.builtInTools.getTools().some(tool => tool.name === name);
  }

  resolveDocumentExportTool(format: ConvertibleFormat): string | null {
    const availableToolNames = [
      ...this.options.builtInTools.getTools().map(tool => tool.name),
      ...this.options.skillManager.getTools().map(tool => tool.name),
    ];

    return this.options.exportSupport.resolveDocumentExportTool(format, availableToolNames);
  }

  private createSkillContext(): SkillContext {
    return {
      workspace: this.options.workspace,
      config: this.options.config,
      skillsDir: this.options.skillManager.getSkillsDir(),
    };
  }
}