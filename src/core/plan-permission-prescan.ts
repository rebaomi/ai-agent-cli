import type { Plan } from './planner.js';
import type { PermissionManager, PermissionType } from './permission-manager.js';
import { getToolPermission } from './tool-permissions.js';

export interface PlannedPermissionRequirement {
  type: PermissionType;
  resource?: string;
  toolName: string;
  stepIndex: number;
  stepDescription: string;
  isDangerous: boolean;
}

type PermissionInspector = Pick<PermissionManager, 'isGranted' | 'isDangerous'>;

const FALLBACK_DANGEROUS_TYPES = new Set<PermissionType>([
  'command_execute',
  'file_delete',
  'file_move',
  'network_request',
  'browser_automation',
]);

export function collectPlanPermissionRequirements(
  plan: Plan,
  permissionManager?: PermissionInspector,
): PlannedPermissionRequirement[] {
  const requirements: PlannedPermissionRequirement[] = [];
  const seen = new Set<string>();

  for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
    const step = plan.steps[stepIndex];
    if (!step?.toolCalls?.length) {
      continue;
    }

    for (const toolCall of step.toolCalls) {
      const mapping = getToolPermission(toolCall.name);
      if (!mapping) {
        continue;
      }

      const resource = mapping.resourceExtractor?.(toolCall.args) || undefined;
      if (permissionManager?.isGranted(mapping.permissionType, resource)) {
        continue;
      }

      const key = `${mapping.permissionType}:${resource || '*'}:${toolCall.name}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const isDangerous = permissionManager
        ? permissionManager.isDangerous(mapping.permissionType, resource)
        : FALLBACK_DANGEROUS_TYPES.has(mapping.permissionType);

      requirements.push({
        type: mapping.permissionType,
        resource,
        toolName: toolCall.name,
        stepIndex,
        stepDescription: step.description,
        isDangerous,
      });
    }
  }

  return requirements;
}

export function buildPlanPermissionBatchPrompt(requirements: PlannedPermissionRequirement[]): string {
  const lines: string[] = [
    '',
    '🔐 计划执行前权限预检查',
    '',
    '下面这些计划步骤预计会触发危险权限。为了避免执行过程中被权限提示打断，可以现在一次性确认：',
    '',
  ];

  requirements.forEach((requirement, index) => {
    const resourceText = requirement.resource ? ` | 资源: ${requirement.resource}` : '';
    lines.push(
      `${index + 1}. 第 ${requirement.stepIndex + 1} 步 ${requirement.stepDescription}`,
      `   权限: ${formatPermissionLabel(requirement.type)}${resourceText}`,
      `   工具: ${requirement.toolName}`,
    );
  });

  lines.push(
    '',
    '输入:',
    '  yes  - 仅授权当前列出的操作',
    '  task - 授权当前任务内同类操作',
    '  batch - 授权当前任务内同类操作',
    '  all  - 永久授权这些权限类型',
    '  10m / 1h / 24h - 限时授权这些权限类型',
    '  no   - 不预授权，后续执行时再逐项确认',
  );

  return lines.join('\n');
}

function formatPermissionLabel(type: PermissionType): string {
  const labels: Record<PermissionType, string> = {
    file_read: '读取文件',
    file_write: '写入文件',
    file_delete: '删除文件',
    file_copy: '复制文件',
    file_move: '移动文件',
    directory_create: '创建目录',
    directory_list: '列出目录',
    command_execute: '执行命令',
    env_read: '读取环境变量',
    process_list: '查看进程列表',
    network_request: '发起网络请求',
    browser_open: '打开浏览器',
    browser_automation: '自动操作浏览器',
    mcp_access: '访问 MCP 服务',
    tool_execute: '执行工具',
    clipboard_read: '读取剪贴板',
    clipboard_write: '写入剪贴板',
  };

  return labels[type];
}