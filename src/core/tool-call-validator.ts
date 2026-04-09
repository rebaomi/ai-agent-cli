import type { ToolCall, ToolResult } from '../types/index.js';
import { isDocxExportTool, isPdfExportTool, isPptxExportTool, isXlsxExportTool, retargetExportPath, selectPreferredExportTool } from './export-intent.js';
import type { IntentContract } from './tool-intent-contract.js';

export interface ToolCallRejection {
  toolCall: ToolCall;
  reason: string;
}

export interface ToolCallValidationResult {
  toolCalls: ToolCall[];
  corrections: string[];
  rejections: ToolCallRejection[];
}

export function validateToolCallsAgainstContract(
  contract: IntentContract,
  toolCalls: ToolCall[],
  availableTools: Iterable<string>,
): ToolCallValidationResult {
  const corrections: string[] = [];
  const rejections: ToolCallRejection[] = [];
  const validated: ToolCall[] = [];

  for (const toolCall of toolCalls) {
    const args = safeParseArgs(toolCall.function.arguments);
    const toolKind = classifyToolKind(toolCall.function.name);

    if (/^repl$/i.test(toolCall.function.name) && !looksLikeReplCode(args.code)) {
      rejections.push({
        toolCall,
        reason: 'repl 只接受可执行的 JavaScript 表达式或代码片段，不能把自然语言步骤描述直接传进去。',
      });
      continue;
    }

    if (contract.action === 'document_export') {
      if (toolKind === 'write' && isStructuredDocumentFormat(contract.targetFormat)) {
        const preferred = selectPreferredExportTool(contract.targetFormat, availableTools)
          || fallbackExportToolName(contract.targetFormat);

        if (!preferred) {
          rejections.push({
            toolCall,
            reason: `当前意图要求导出 ${contract.targetFormat.toUpperCase()}，但没有可用的导出工具。`,
          });
          continue;
        }

        validated.push(rewriteExportToolCall(toolCall, preferred, buildExportArgs(contract.targetFormat, args)));
        corrections.push(`${toolCall.function.name} 已按意图 contract 改写为 ${preferred}`);
        continue;
      }

      if (contract.targetFormat === 'pptx' && !isPptxExportTool(toolCall.function.name)) {
        const preferred = selectPreferredExportTool('pptx', availableTools) || 'pptx_create_from_text';
        validated.push(rewriteExportToolCall(toolCall, preferred, {
          output: retargetExportPath(args.output ?? args.out, '.pptx') || '$ARTIFACT_OUTPUT_DIR/exported-document.pptx',
          text: args.text ?? '$LAST_ASSISTANT_TEXT',
          title: typeof args.title === 'string' ? args.title : 'Presentation',
        }));
        corrections.push(`${toolCall.function.name} 已按意图 contract 改写为 ${preferred}`);
        continue;
      }

      if (contract.targetFormat === 'xlsx' && !isXlsxExportTool(toolCall.function.name)) {
        const preferred = selectPreferredExportTool('xlsx', availableTools) || 'xlsx_create_from_text';
        validated.push(rewriteExportToolCall(toolCall, preferred, {
          output: retargetExportPath(args.output ?? args.out, '.xlsx') || '$ARTIFACT_OUTPUT_DIR/exported-document.xlsx',
          text: args.text ?? '$LAST_ASSISTANT_TEXT',
          title: typeof args.title === 'string' ? args.title : 'Sheet1',
        }));
        corrections.push(`${toolCall.function.name} 已按意图 contract 改写为 ${preferred}`);
        continue;
      }

      if (toolKind === 'command') {
        rejections.push({
          toolCall,
          reason: `当前意图是文档导出，但 ${toolCall.function.name} 属于命令执行类工具。`,
        });
        continue;
      }

      if (contract.targetFormat === 'pdf' && isDocxExportTool(toolCall.function.name)) {
        const preferred = selectPreferredExportTool('pdf', availableTools);
        if (!preferred) {
          rejections.push({
            toolCall,
            reason: '当前意图要求导出 PDF，但没有可用的 PDF 导出工具。',
          });
          continue;
        }

        validated.push(rewriteExportToolCall(toolCall, preferred, {
          out: retargetExportPath(args.out ?? args.output, '.pdf') || '$ARTIFACT_OUTPUT_DIR/exported-document.pdf',
          text: args.text ?? '$LAST_ASSISTANT_TEXT',
          title: typeof args.title === 'string' ? args.title : 'exported document',
        }));
        corrections.push(`${toolCall.function.name} 已按意图 contract 改写为 ${preferred}`);
        continue;
      }

      if (contract.targetFormat === 'docx' && isPdfExportTool(toolCall.function.name)) {
        const preferred = selectPreferredExportTool('docx', availableTools);
        if (!preferred) {
          rejections.push({
            toolCall,
            reason: '当前意图要求导出 DOCX，但没有可用的 DOCX 导出工具。',
          });
          continue;
        }

        validated.push(rewriteExportToolCall(toolCall, preferred, {
          output: retargetExportPath(args.output ?? args.out, '.docx') || '$ARTIFACT_OUTPUT_DIR/exported-document.docx',
          text: args.text ?? '$LAST_ASSISTANT_TEXT',
          title: typeof args.title === 'string' ? args.title : 'exported document',
        }));
        corrections.push(`${toolCall.function.name} 已按意图 contract 改写为 ${preferred}`);
        continue;
      }
    }

    if (contract.action === 'file_read' && (toolKind === 'write' || toolKind === 'command' || toolKind === 'export')) {
      rejections.push({
        toolCall,
        reason: `当前意图是读取内容，但 ${toolCall.function.name} 属于 ${toolKind} 类工具。`,
      });
      continue;
    }

    if (contract.action === 'file_search' && (toolKind === 'write' || toolKind === 'command' || toolKind === 'export')) {
      rejections.push({
        toolCall,
        reason: `当前意图是搜索内容，但 ${toolCall.function.name} 属于 ${toolKind} 类工具。`,
      });
      continue;
    }

    if (contract.action === 'message_send') {
      if (/^push_news_to_lark$/i.test(toolCall.function.name)) {
        rejections.push({
          toolCall,
          reason: '当前意图是发送自定义飞书消息，但 push_news_to_lark 只用于抓取腾讯新闻并推送到飞书。请改用 send_lark_message，或使用 lark_shortcut 调用 im +messages-send。',
        });
        continue;
      }

      if (/^push_weather_to_lark$/i.test(toolCall.function.name)) {
        rejections.push({
          toolCall,
          reason: '当前意图是发送自定义飞书消息，但 push_weather_to_lark 只用于抓取天气并推送到飞书。请改用 send_lark_message，或使用 lark_shortcut 调用 im +messages-send。',
        });
        continue;
      }

      if (toolKind === 'command') {
        rejections.push({
          toolCall,
          reason: `当前意图是发送飞书消息，但 ${toolCall.function.name} 属于命令执行类工具。优先使用 send_lark_message 或 lark_shortcut。`,
        });
        continue;
      }

      const unresolvedPayload = extractUnresolvedMessagePayload(toolCall.function.name, args);
      if (unresolvedPayload) {
        rejections.push({
          toolCall,
          reason: `当前意图看起来是“先获取内容再发送”，但 ${toolCall.function.name} 准备直接发送未解析的占位文本“${unresolvedPayload}”。应先得到正文，再发送到飞书。`,
        });
        continue;
      }
    }

    if (contract.action === 'command_execute' && toolKind !== 'command') {
      rejections.push({
        toolCall,
        reason: `当前意图是执行命令，但 ${toolCall.function.name} 不是命令类工具。`,
      });
      continue;
    }

    validated.push(toolCall);
  }

  return { toolCalls: validated, corrections, rejections };
}

export function createRejectedToolResult(toolCallId: string, reason: string): ToolResult {
  return {
    tool_call_id: toolCallId,
    output: `Tool call rejected by intent contract: ${reason}`,
    is_error: true,
  };
}

function rewriteExportToolCall(toolCall: ToolCall, toolName: string, args: Record<string, unknown>): ToolCall {
  return {
    ...toolCall,
    function: {
      name: toolName,
      arguments: JSON.stringify(args),
    },
  };
}

function buildExportArgs(
  format: 'docx' | 'pdf' | 'xlsx' | 'pptx',
  args: Record<string, unknown>,
): Record<string, unknown> {
  const title = typeof args.title === 'string' ? args.title : defaultExportTitle(format);

  switch (format) {
    case 'pdf':
      return {
        out: retargetExportPath(readCandidatePath(args), '.pdf') || '$ARTIFACT_OUTPUT_DIR/exported-document.pdf',
        text: args.text ?? args.content ?? '$LAST_ASSISTANT_TEXT',
        title,
      };
    case 'xlsx':
      return {
        output: retargetExportPath(readCandidatePath(args), '.xlsx') || '$ARTIFACT_OUTPUT_DIR/exported-document.xlsx',
        text: args.text ?? args.content ?? '$LAST_ASSISTANT_TEXT',
        title,
      };
    case 'pptx':
      return {
        output: retargetExportPath(readCandidatePath(args), '.pptx') || '$ARTIFACT_OUTPUT_DIR/exported-document.pptx',
        text: args.text ?? args.content ?? '$LAST_ASSISTANT_TEXT',
        title,
      };
    case 'docx':
    default:
      return {
        output: retargetExportPath(readCandidatePath(args), '.docx') || '$ARTIFACT_OUTPUT_DIR/exported-document.docx',
        text: args.text ?? args.content ?? '$LAST_ASSISTANT_TEXT',
        title,
      };
  }
}

function readCandidatePath(args: Record<string, unknown>): string | undefined {
  const value = args.output ?? args.out ?? args.path;
  return typeof value === 'string' ? value : undefined;
}

function fallbackExportToolName(format: 'docx' | 'pdf' | 'xlsx' | 'pptx'): string | null {
  switch (format) {
    case 'docx':
      return 'docx_create_from_text';
    case 'pdf':
      return 'pdf_create_from_text';
    case 'xlsx':
      return 'xlsx_create_from_text';
    case 'pptx':
      return 'pptx_create_from_text';
    default:
      return null;
  }
}

function isStructuredDocumentFormat(
  value: IntentContract['targetFormat'],
): value is 'docx' | 'pdf' | 'xlsx' | 'pptx' {
  return value === 'docx' || value === 'pdf' || value === 'xlsx' || value === 'pptx';
}

function defaultExportTitle(format: 'docx' | 'pdf' | 'xlsx' | 'pptx'): string {
  switch (format) {
    case 'xlsx':
      return 'Sheet1';
    case 'pptx':
      return 'Presentation';
    default:
      return 'exported document';
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function classifyToolKind(name: string): 'read' | 'search' | 'write' | 'command' | 'export' | 'other' {
  if (/^(read_file|read_multiple_files|list_directory|file_info)$/i.test(name)) {
    return 'read';
  }

  if (/^(search_files|grep|glob)$/i.test(name)) {
    return 'search';
  }

  if (/^(write_file|edit_file|delete_file|copy_file|move_file|create_directory)$/i.test(name)) {
    return 'write';
  }

  if (/^(execute_command|repl)$/i.test(name)) {
    return 'command';
  }

  if (isDocxExportTool(name) || isPdfExportTool(name) || isXlsxExportTool(name) || isPptxExportTool(name)) {
    return 'export';
  }

  return 'other';
}

function looksLikeReplCode(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }

  const code = value.trim();
  const candidates = [
    code,
    `return (${code});`,
    `return ${code};`,
  ];

  for (const candidate of candidates) {
    try {
      new Function(candidate);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function extractUnresolvedMessagePayload(toolName: string, args: Record<string, unknown>): string | null {
  if (/^send_lark_message$/i.test(toolName)) {
    const payload = firstNonEmptyString(args.text, args.markdown, args.content);
    return isUnresolvedMessagePayload(payload) ? payload.trim() : null;
  }

  if (/^lark_shortcut$/i.test(toolName)) {
    const service = typeof args.service === 'string' ? args.service : '';
    const command = typeof args.command === 'string' ? args.command : '';
    const flags = args.flags && typeof args.flags === 'object' ? args.flags as Record<string, unknown> : {};
    if (/^im$/i.test(service) && /^\+messages-send$/i.test(command)) {
      const payload = firstNonEmptyString(flags.text, flags.markdown, flags.content);
      return isUnresolvedMessagePayload(payload) ? payload.trim() : null;
    }
  }

  return null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return '';
}

function isUnresolvedMessagePayload(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  return /^(什么|什么？|什么\?|内容是什么|全文是什么|原文是什么|这首诗内容是什么|这首诗全文是什么)$/i.test(normalized);
}