import type { DirectActionResult } from './direct-action-router.js';
import type { DirectActionRiskSummary } from './checkpoint-risk.js';
import { buildDirectActionRiskSummary } from './checkpoint-risk.js';
import type { DirectActionHandler } from './direct-actions/request-handler.js';
import type { ResolvedIntent } from './intent-resolver.js';
import type { SessionTaskRecord } from '../types/index.js';

export interface DirectActionDispatchInput {
  originalInput: string;
  effectiveInput: string;
  isFollowUp?: boolean;
  boundTask?: SessionTaskRecord;
}

export interface DirectActionDispatchContext extends DirectActionDispatchInput {
  intent?: ResolvedIntent;
}

export interface DirectActionDispatchPreview {
  handlerName: string;
  category: string;
  riskSummary: DirectActionRiskSummary;
}

export interface DirectActionDispatchServiceOptions {
  handlers: () => DirectActionHandler[];
  tryLegacyFallbacks: (input: string) => Promise<DirectActionResult | null>;
  resolveIntent?: (input: string) => Promise<ResolvedIntent | null>;
  conversationMode?: {
    enabled: boolean;
    preambleThreshold: number;
  };
  onConversationPreamble?: (message: string) => Promise<void> | void;
}

export class DirectActionDispatchService {
  constructor(private readonly options: DirectActionDispatchServiceOptions) {}

  async preview(input: DirectActionDispatchInput): Promise<DirectActionDispatchPreview | null> {
    const resolution = await this.resolveHandler(input);
    if (!resolution) {
      return null;
    }

    return {
      handlerName: resolution.handler.name,
      category: resolution.handler.name,
      riskSummary: buildDirectActionRiskSummary(resolution.handler.name, resolution.context.originalInput),
    };
  }

  async tryHandle(input: DirectActionDispatchInput): Promise<DirectActionResult | null> {
    const resolution = await this.resolveHandler(input);
    if (!resolution) {
      return this.options.tryLegacyFallbacks(input.effectiveInput.trim());
    }

    const { context, handler } = resolution;
    const preamble = this.buildConversationPreamble(handler.name, context);
      if (preamble) {
        await this.options.onConversationPreamble?.(preamble);
      }

    const result = await handler.handle(context.effectiveInput, context.intent, context);
    if (result) {
      return {
        ...result,
        handlerName: result.handlerName || handler.name,
        category: result.category || handler.name,
      };
    }

    return this.options.tryLegacyFallbacks(context.effectiveInput);
  }

  private async resolveHandler(input: DirectActionDispatchInput): Promise<{ handler: DirectActionHandler; context: DirectActionDispatchContext } | null> {
    const trimmed = input.effectiveInput.trim();
    if (!trimmed) {
      return null;
    }

    const intent = await this.options.resolveIntent?.(trimmed) ?? undefined;
    const context: DirectActionDispatchContext = {
      ...input,
      effectiveInput: trimmed,
      intent,
    };

    for (const handler of this.options.handlers()) {
      if (!(await handler.canHandle(trimmed, intent, context))) {
        continue;
      }

      return { handler, context };
    }

    return null;
  }

  private buildConversationPreamble(handlerName: string, context: DirectActionDispatchContext): string | null {
    const policy = this.options.conversationMode;
    if (!policy?.enabled) {
      return null;
    }

    let score = 0;
    if (context.isFollowUp) {
      score += 2;
    }
    if (context.originalInput.trim().length >= 18) {
      score += 1;
    }
    if (/(然后|再|继续|顺便|做完|处理一下|帮我|请|麻烦)/i.test(context.originalInput)) {
      score += 1;
    }
    if (['browser-action', 'document-action', 'external-search', 'lark-workflow'].includes(handlerName)) {
      score += 1;
    }

    if (score < policy.preambleThreshold) {
      return null;
    }

    if (context.isFollowUp && context.boundTask) {
      return '我先按刚才那个任务继续处理，做完告诉你结果。';
    }

    return this.resolvePreambleTemplate(handlerName, context);
  }

  private resolvePreambleTemplate(handlerName: string, context: DirectActionDispatchContext): string {
    const input = context.originalInput.trim();

    if (handlerName === 'browser-action') {
      if (/(打开|访问|进入|浏览|跳转到|官网|网页|网站|页面|首页|链接|url|URL|https?:\/\/)/i.test(input)) {
        return '我先打开看看，做完告诉你结果。';
      }

      if (/(搜索|搜一下|搜|查询|查一下|查|百度|谷歌|google|豆包|doubao)/i.test(input)) {
        return '我先查一下，做完告诉你结果。';
      }
    }

    if (handlerName === 'external-search') {
      return '我先查一下，做完告诉你结果。';
    }

    if (handlerName === 'file-action') {
      if (/(打开)/i.test(input)) {
        return '我先打开看看，做完告诉你结果。';
      }
      return '我先看一下文件，做完告诉你结果。';
    }

    if (handlerName === 'document-action') {
      return '我先整理成文档，做完告诉你结果。';
    }

    if (handlerName === 'lark-workflow') {
      return '我先整理好再发出去，做完告诉你结果。';
    }

    if (handlerName === 'memory-action') {
      return '我先记下来，做完告诉你结果。';
    }

    return '我先这么做，做完告诉你结果。';
  }
}