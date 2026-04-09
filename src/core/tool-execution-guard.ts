import { looksLikeToolErrorText } from '../utils/docx-validation.js';
import type { ToolResult } from '../types/index.js';
import { permissionManager } from './permission-manager.js';
import {
  buildPermissionDeniedMessage,
  resolveToolExecutionPermissionRequest,
} from './tool-execution-permissions.js';
import type { ToolRegistry } from './tool-registry.js';

export class ToolExecutionGuard {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  async authorize(name: string, args: Record<string, unknown>): Promise<ToolResult | null> {
    const exportInputError = this.detectInvalidExportInput(name, args);
    if (exportInputError) {
      return this.buildErrorResult(exportInputError);
    }

    const permissionRequest = resolveToolExecutionPermissionRequest({
      name,
      args,
      tool: this.toolRegistry.getTool(name),
    });
    if (!permissionRequest) {
      return null;
    }

    const granted = await permissionManager.requestPermission(
      permissionRequest.permissionType,
      permissionRequest.resource,
      permissionRequest.description,
    );

    if (granted) {
      return null;
    }

    return this.buildErrorResult(buildPermissionDeniedMessage(permissionRequest));
  }

  private detectInvalidExportInput(name: string, args: Record<string, unknown>): string | null {
    if (!/docx_create_from_text|pdf_create_from_text|xlsx_create_from_text|pptx_create_from_text|txt_to_docx|minimax_docx_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf|txt_to_xlsx|txt_to_pptx/i.test(name)) {
      return null;
    }

    const sourceText = typeof args.text === 'string' ? args.text : '';
    if (looksLikeToolErrorText(sourceText)) {
      return '导出源内容包含上游工具报错文本，已停止导出。请先修复前一步，而不是把错误消息写入文档。';
    }

    return null;
  }

  private buildErrorResult(message: string): ToolResult {
    return {
      tool_call_id: '',
      output: message,
      is_error: true,
    };
  }
}