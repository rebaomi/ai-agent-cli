import type { Message } from '../types/index.js';

export interface PlannedToolArgsResolverOptions {
  workspace: string;
  artifactOutputDir: string;
  getMessages: () => Message[];
  getLastReusableContent: () => string;
}

export class PlannedToolArgsResolver {
  constructor(private readonly options: PlannedToolArgsResolverOptions) {}

  resolve(args: Record<string, unknown>): Record<string, unknown> {
    return this.resolvePlaceholderValue(args, {
      workspace: this.options.workspace,
      artifactOutputDir: this.options.artifactOutputDir,
      lastAssistantText: this.getLatestReusableText(),
    }) as Record<string, unknown>;
  }

  private resolvePlaceholderValue(
    value: unknown,
    runtime: { workspace: string; artifactOutputDir: string; lastAssistantText: string },
  ): unknown {
    if (typeof value === 'string') {
      return value
        .replace(/\$WORKSPACE/g, runtime.workspace)
        .replace(/\$ARTIFACT_OUTPUT_DIR/g, runtime.artifactOutputDir)
        .replace(/\$LAST_ASSISTANT_TEXT/g, runtime.lastAssistantText || '');
    }

    if (Array.isArray(value)) {
      return value.map(item => this.resolvePlaceholderValue(item, runtime));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, this.resolvePlaceholderValue(nested, runtime)]),
      );
    }

    return value;
  }

  private getLatestReusableText(): string {
    const pinned = this.options.getLastReusableContent().trim();
    if (pinned) {
      return pinned;
    }

    const messages = this.options.getMessages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message?.role !== 'assistant' && message?.role !== 'tool') {
        continue;
      }
      const content = message.content?.trim();
      if (content && this.isReusableTextContent(content, message.role)) {
        return content;
      }
    }

    return '';
  }

  private isReusableTextContent(content: string, role: Message['role']): boolean {
    const normalized = content.trim();
    if (!normalized) {
      return false;
    }

    if (/^Using tool\.\.\.$/i.test(normalized)) {
      return false;
    }

    if (/^##\s*[✅❌⚠].*任务(?:完成|失败)/.test(normalized) || /\*\*原始任务\*\*/.test(normalized) || /\*\*完成进度\*\*/.test(normalized)) {
      return false;
    }

    if (/^\[步骤\s*\d+\]/.test(normalized)) {
      return false;
    }

    if (/^\[(?:write_file|read_file|read_multiple_files|search_files|glob|copy_file|move_file|txt_to_docx|txt_to_pdf|txt_to_xlsx|txt_to_pptx|docx_create_from_text|pdf_create_from_text|xlsx_create_from_text|pptx_create_from_text|execute_command)\]/i.test(normalized)) {
      return false;
    }

    if (/^(?:File written successfully:|Created report document:|Created PDF document:|Created spreadsheet document:|Created presentation document:|Permission denied:|Tool call rejected by intent contract:|Error:)/i.test(normalized)) {
      return false;
    }

    if (role === 'assistant' && /^我需要先.+?(?:规划|查看|读取|分析)/.test(normalized)) {
      return false;
    }

    return true;
  }
}