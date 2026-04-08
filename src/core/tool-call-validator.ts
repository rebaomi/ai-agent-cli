import type { ToolCall, ToolResult } from '../types/index.js';
import { isDocxExportTool, isPdfExportTool, retargetExportPath, selectPreferredExportTool } from './export-intent.js';
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

    if (contract.action === 'document_export') {
      if (contract.targetFormat === 'pptx') {
        rejections.push({
          toolCall,
          reason: '当前意图要求导出 PPT/PPTX，但当前工具集中没有可执行的 PPT 导出工具。可改为生成 PPT 大纲、逐页文案，或先导出 PDF/DOCX 后手动转换。',
        });
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

  if (isDocxExportTool(name) || isPdfExportTool(name)) {
    return 'export';
  }

  return 'other';
}