import type { Plan, PlanStep } from './planner.js';
import type { ToolCall } from '../types/index.js';

export type CheckpointRiskKind =
  | 'command_execute'
  | 'file_write'
  | 'file_delete'
  | 'browser_open'
  | 'browser_automation'
  | 'network_request'
  | 'outbound_delivery'
  | 'external_workflow';

export type CheckpointRiskLevel = 'medium' | 'high';

export interface CheckpointRiskItem {
  kind: CheckpointRiskKind;
  level: CheckpointRiskLevel;
  title: string;
  detail: string;
  toolName?: string;
  stepId?: string;
}

export interface PlanCheckpointRiskSummary {
  items: CheckpointRiskItem[];
  hasOutboundDelivery: boolean;
  hasRiskyActions: boolean;
}

export interface DirectActionRiskSummary {
  handlerName: string;
  category: string;
  level: 'low' | 'medium' | 'high';
  items: CheckpointRiskItem[];
  hasOutboundDelivery: boolean;
  hasRiskyActions: boolean;
}

export interface StepCheckpointRiskSummary {
  stepId: string;
  stepDescription: string;
  items: CheckpointRiskItem[];
  hasOutboundDelivery: boolean;
  hasRiskyActions: boolean;
}

export interface ToolCheckpointRiskSummary {
  items: CheckpointRiskItem[];
  hasOutboundDelivery: boolean;
  hasRiskyActions: boolean;
}

export function summarizePlanCheckpointRisks(plan: Plan): PlanCheckpointRiskSummary {
  const items: CheckpointRiskItem[] = [];

  for (const step of plan.steps) {
    for (const toolCall of step.toolCalls || []) {
      const risk = classifyToolRisk(toolCall.name, toolCall.args, step.id);
      if (risk) {
        items.push(risk);
      }
    }
  }

  return {
    items,
    hasOutboundDelivery: items.some((item) => item.kind === 'outbound_delivery'),
    hasRiskyActions: items.some((item) => item.level === 'high' || item.kind === 'command_execute' || item.kind === 'browser_automation' || item.kind === 'external_workflow'),
  };
}

export function buildPlanCheckpointRiskText(plan: Plan): string | null {
  const summary = summarizePlanCheckpointRisks(plan);
  if (summary.items.length === 0) {
    return null;
  }

  const lines = summary.items.slice(0, 8).map((item, index) => `${index + 1}. ${item.title}: ${item.detail}`);
  if (summary.items.length > 8) {
    lines.push(`... 其余 ${summary.items.length - 8} 项风险动作已省略`);
  }

  return ['**本轮潜在危险操作**:', ...lines].join('\n');
}

export function buildDirectActionRiskSummary(handlerName: string, input: string): DirectActionRiskSummary {
  const items: CheckpointRiskItem[] = [];
  const normalizedHandler = handlerName.trim();
  const normalizedInput = input.trim();

  if (normalizedHandler === 'lark-workflow') {
    items.push({
      kind: 'outbound_delivery',
      level: 'high',
      title: '外发到飞书',
      detail: '会向飞书发送消息、Markdown 或文件附件',
    });
  }

  if (normalizedHandler === 'external-search') {
    items.push({
      kind: 'external_workflow',
      level: 'high',
      title: '外部脚本执行',
      detail: '会调用外部搜索脚本或命令，并可能访问公网资源',
    });
  }

  if (normalizedHandler === 'browser-action') {
    if (isHighRiskBrowserRequest(normalizedInput)) {
      items.push({
        kind: 'browser_automation',
        level: 'high',
        title: '浏览器自动化',
        detail: '会自动执行页面输入、点击、提交或智能网页操作',
      });
    } else {
      items.push({
        kind: 'browser_open',
        level: 'medium',
        title: '打开浏览器',
        detail: '会直接打开网页或触发搜索页跳转',
      });
    }
  }

  if ((normalizedHandler === 'file-action' || normalizedHandler === 'obsidian-note') && /(写入|保存|覆盖|替换|修改|编辑|删除|追加|新建|创建)/i.test(normalizedInput)) {
    items.push({
      kind: 'file_write',
      level: /删除|覆盖|替换/i.test(normalizedInput) ? 'high' : 'medium',
      title: '文件内容变更',
      detail: '会直接写入、修改、追加或覆盖现有文件',
    });
  }

  const level = items.some((item) => item.level === 'high')
    ? 'high'
    : items.length > 0
      ? 'medium'
      : 'low';

  return {
    handlerName: normalizedHandler,
    category: normalizedHandler,
    level,
    items,
    hasOutboundDelivery: items.some((item) => item.kind === 'outbound_delivery'),
    hasRiskyActions: items.some((item) => item.level === 'high' || item.kind === 'external_workflow' || item.kind === 'browser_automation' || item.kind === 'command_execute'),
  };
}

export function buildDirectActionCheckpointPrompt(summary: DirectActionRiskSummary, originalInput: string): string {
  const lines = [
    '## 待确认的 direct action',
    '',
    `原请求: ${originalInput}`,
  ];

  if (summary.items.length > 0) {
    lines.push('', '**本次会执行的风险动作**:');
    for (const item of summary.items) {
      lines.push(`- ${item.title}: ${item.detail}`);
    }
  }

  lines.push('', '请确认是否执行该操作（回复“是”或“否”）。如果你要调整目标站点、发送范围、文件路径或其他限制，也可以直接继续说。');
  return lines.join('\n');
}

function classifyToolRisk(name: string, args: Record<string, unknown>, stepId?: string): CheckpointRiskItem | null {
  const toolName = name.trim();

  if (toolName === 'execute_command') {
    return {
      kind: 'command_execute',
      level: 'high',
      title: '执行命令',
      detail: truncateDetail(String(args.command || '未提供命令')),
      toolName,
      stepId,
    };
  }

  if (['write_file', 'edit_file', 'copy_file', 'move_file', 'create_directory'].includes(toolName)) {
    return {
      kind: 'file_write',
      level: toolName === 'move_file' ? 'high' : 'medium',
      title: '写入或变更文件',
      detail: truncateDetail(String(args.path || args.filePath || args.destination || args.source || '文件路径未提供')),
      toolName,
      stepId,
    };
  }

  if (toolName === 'delete_file') {
    return {
      kind: 'file_delete',
      level: 'high',
      title: '删除文件',
      detail: truncateDetail(String(args.path || '文件路径未提供')),
      toolName,
      stepId,
    };
  }

  if (toolName === 'open_browser') {
    return {
      kind: 'browser_open',
      level: 'medium',
      title: '打开浏览器',
      detail: truncateDetail(String(args.url || '目标 URL 未提供')),
      toolName,
      stepId,
    };
  }

  if (toolName === 'browser_automate' || toolName === 'browser_agent_run') {
    return {
      kind: 'browser_automation',
      level: 'high',
      title: '浏览器自动化',
      detail: truncateDetail(String(args.url || args.startUrl || args.goal || '浏览器自动化目标未提供')),
      toolName,
      stepId,
    };
  }

  if (toolName === 'web_search' || toolName === 'fetch_url') {
    return {
      kind: 'network_request',
      level: 'medium',
      title: '访问网络资源',
      detail: truncateDetail(String(args.query || args.url || '网络请求目标未提供')),
      toolName,
      stepId,
    };
  }

  if (toolName === 'send_lark_message' || toolName === 'push_news_to_lark') {
    return {
      kind: 'outbound_delivery',
      level: 'high',
      title: '对外发送内容',
      detail: truncateDetail(String(args.chatId || args.userId || '飞书目标未提供')),
      toolName,
      stepId,
    };
  }

  return null;
}

function isHighRiskBrowserRequest(input: string): boolean {
  return /(自动化|填写|输入|点击|提交|登录|密码|验证码|支付|转账|下单|购买|删除|发布|上传|发送|执行)/i.test(input);
}

function truncateDetail(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

export function summarizeStepCheckpointRisks(step: PlanStep): StepCheckpointRiskSummary {
  const items = (step.toolCalls || [])
    .map((toolCall) => classifyToolRisk(toolCall.name, toolCall.args, step.id))
    .filter((item): item is CheckpointRiskItem => !!item);

  return {
    stepId: step.id,
    stepDescription: step.description,
    items,
    hasOutboundDelivery: items.some((item) => item.kind === 'outbound_delivery'),
    hasRiskyActions: items.some((item) => item.level === 'high' || item.kind === 'command_execute' || item.kind === 'browser_automation' || item.kind === 'external_workflow'),
  };
}

export function buildStepCheckpointPrompt(step: PlanStep, summary: StepCheckpointRiskSummary, stepIndex: number, totalSteps: number): string {
  const lines = [
    '## 待确认的计划步骤',
    '',
    `当前步骤: ${stepIndex + 1}/${totalSteps}`,
    `步骤描述: ${step.description}`,
  ];

  if (summary.items.length > 0) {
    lines.push('', '**本步骤会执行的风险动作**:');
    for (const item of summary.items) {
      lines.push(`- ${item.title}: ${item.detail}`);
    }
  }

  lines.push('', '请确认是否执行该步骤（回复“是”或“否”）。回复“否”会跳过当前步骤并继续后续步骤。');
  return lines.join('\n');
}

export function buildStepResultCheckpointPrompt(
  step: PlanStep,
  summary: StepCheckpointRiskSummary,
  stepIndex: number,
  totalSteps: number,
  stepResult: string,
): string {
  const lines = [
    '## 待验收的步骤结果',
    '',
    `当前步骤: ${stepIndex + 1}/${totalSteps}`,
    `步骤描述: ${step.description}`,
  ];

  if (summary.items.length > 0) {
    lines.push('', '**本步骤涉及的风险动作**:');
    for (const item of summary.items) {
      lines.push(`- ${item.title}: ${item.detail}`);
    }
  }

  lines.push('', '**当前步骤结果预览**:');
  lines.push(truncateDetail(stepResult || '(无输出)'));
  lines.push('', '请确认是否验收当前结果（回复“是”或“否”）。如果你要改路径、改目标、改命令或补充验收要求，也可以直接继续说，我会带着这些修改重做当前步骤。');
  return lines.join('\n');
}

export function summarizeToolCallCheckpointRisks(toolCalls: ToolCall[]): ToolCheckpointRiskSummary {
  const items = toolCalls
    .map((toolCall) => classifyToolRisk(toolCall.function.name, parseToolCallArgs(toolCall)))
    .filter((item): item is CheckpointRiskItem => !!item);

  return {
    items,
    hasOutboundDelivery: items.some((item) => item.kind === 'outbound_delivery'),
    hasRiskyActions: items.some((item) => item.level === 'high' || item.kind === 'command_execute' || item.kind === 'browser_automation' || item.kind === 'external_workflow'),
  };
}

export function buildToolCheckpointPrompt(originalInput: string, summary: ToolCheckpointRiskSummary): string {
  const lines = [
    '## 待确认的预测工具执行',
    '',
    `原请求: ${originalInput}`,
  ];

  if (summary.items.length > 0) {
    lines.push('', '**本轮预测到的风险工具动作**:');
    for (const item of summary.items) {
      lines.push(`- ${item.title}: ${item.detail}`);
    }
  }

  lines.push('', '请确认是否执行这些工具（回复“是”或“否”）。如果你要改路径、改目标、改命令或补充约束，也可以直接继续说，我会先按你的修改重算这轮动作。');
  return lines.join('\n');
}

function parseToolCallArgs(toolCall: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}