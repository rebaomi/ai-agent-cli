import type { PermissionType } from './permission-manager.js';
import { extractResource, getToolPermission } from './tool-permissions.js';
import type { ToolExecutionContext, ToolExecutionMiddleware } from './tool-executor.js';
import type { RegisteredTool } from './tool-registry.js';

export interface ToolExecutionPermissionRequest {
  context: ToolExecutionContext;
  permissionType: PermissionType;
  resource?: string;
  description: string;
}

export interface ToolExecutionPermissionDecision {
  allowed: boolean;
  message?: string;
}

export interface ToolExecutionPermissionSubject {
  name: string;
  args: Record<string, unknown>;
  tool?: RegisteredTool;
}

export type ToolExecutionPermissionHandler = (
  request: ToolExecutionPermissionRequest,
) => Promise<ToolExecutionPermissionDecision> | ToolExecutionPermissionDecision;

export function createExecutionPermissionMiddleware(
  handler: ToolExecutionPermissionHandler,
): ToolExecutionMiddleware {
  return async (context, next) => {
    const request = resolveToolExecutionPermissionRequest({
      name: context.name,
      args: context.args,
      tool: context.tool,
    });
    if (!request) {
      return next(context);
    }

    const decision = await handler(request);
    if (decision.allowed) {
      return next(context);
    }

    return {
      tool_call_id: '',
      output: decision.message || buildPermissionDeniedMessage(request),
      is_error: true,
    };
  };
}

export function resolveToolExecutionPermissionRequest(subject: ToolExecutionPermissionSubject): ToolExecutionPermissionRequest | null {
  const mappedPermission = getToolPermission(subject.name);
  if (mappedPermission) {
    const resource = extractResource(subject.name, subject.args) || mappedPermission.resourceExtractor?.(subject.args);
    return {
      context: {
        name: subject.name,
        args: subject.args,
        tool: subject.tool || {
          name: subject.name,
          description: '',
          input_schema: {},
          source: 'builtin',
        },
      },
      permissionType: mappedPermission.permissionType,
      resource,
      description: `${subject.name}${resource ? ` on ${resource}` : ''}`,
    };
  }

  if (subject.tool?.source === 'skill') {
    return {
      context: {
        name: subject.name,
        args: subject.args,
        tool: subject.tool,
      },
      permissionType: 'tool_execute',
      resource: `skill_tool:${subject.name}`,
      description: `Execute skill tool: ${subject.name}`,
    };
  }

  return null;
}

export function buildPermissionDeniedMessage(request: ToolExecutionPermissionRequest): string {
  if (request.resource?.startsWith('skill_tool:')) {
    return `Permission denied: ${request.permissionType} (${request.resource})\n需要授权才能执行此技能工具。输入 /perm 查看权限设置。`;
  }

  return `Permission denied: ${request.permissionType}${request.resource ? ` (${request.resource})` : ''}\n需要授权才能执行此操作。输入 /perm 查看权限设置。`;
}