import { looksLikeIncompleteStructuredDocument, looksLikePlaceholderContent, looksLikeToolErrorText } from '../utils/docx-validation.js';
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
    const invalidStructuredWrite = this.detectInvalidStructuredTextWrite(name, args);
    if (invalidStructuredWrite) {
      return invalidStructuredWrite;
    }

    if (!/docx_create_from_text|pdf_create_from_text|xlsx_create_from_text|pptx_create_from_text|txt_to_docx|minimax_docx_create_from_text|txt_to_pdf|minimax_pdf_text_to_pdf|txt_to_xlsx|txt_to_pptx/i.test(name)) {
      return null;
    }

    const sourceText = typeof args.text === 'string' ? args.text : '';
    if (looksLikeToolErrorText(sourceText)) {
      return '导出源内容包含上游工具报错文本，已停止导出。请先修复前一步，而不是把错误消息写入文档。';
    }

    if (looksLikePlaceholderContent(sourceText)) {
      return '导出源内容仍是占位稿或模板骨架，未包含真实正文。请先补全正文内容，再导出文档。';
    }

    return null;
  }

  private detectInvalidStructuredTextWrite(name: string, args: Record<string, unknown>): string | null {
    if (!/^(write_file)$/i.test(name)) {
      return null;
    }

    const targetPath = typeof args.path === 'string' ? args.path.trim() : '';
    const content = typeof args.content === 'string' ? args.content : '';
    if (!targetPath || !content || !/\.(txt|md|markdown)$/i.test(targetPath)) {
      return null;
    }

    if (/(template|模板|大纲|outline|draft|草稿)/i.test(targetPath) || /(模板|大纲|草稿)/i.test(content)) {
      return null;
    }

    if (looksLikeIncompleteStructuredDocument(content)) {
      return '写入的文本内容仍是占位稿或未完成报告骨架，未包含真实正文。请先补全内容，再保存为 TXT/Markdown。';
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