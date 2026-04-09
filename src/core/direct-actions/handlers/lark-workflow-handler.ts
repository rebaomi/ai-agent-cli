import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { LarkWorkflowRuntime } from '../runtime-context.js';

export class LarkWorkflowHandler implements DirectActionHandler {
  readonly name = 'lark-workflow';

  constructor(private readonly runtime: LarkWorkflowRuntime) {}

  canHandle(input: string): boolean {
    return this.isDeterministicLarkDeliveryRequest(input);
  }

  handle(input: string): Promise<DirectActionResult | null> {
    return this.runtime.handleLarkWorkflow(input);
  }

  private isDeterministicLarkDeliveryRequest(input: string): boolean {
    if (!/(飞书|lark)/i.test(input) || !/(发送|发(?:到|给|我)?|推送|send)/i.test(input)) {
      return false;
    }

    if (/(?:内容是|内容为|正文是|正文为|文本是|文本为|markdown是|markdown为)\s*[：:]/i.test(input)) {
      return true;
    }

    if (/(刚刚|刚才|上面|上一条|最近生成的|前面那个|这个文件|该文件)/i.test(input)) {
      return true;
    }

    if (/(新闻|热点|热榜|早报|晚报|小红书|redbook|xiaohongshu|xhs)/i.test(input)) {
      return true;
    }

    if (/(word|docx|pdf|ppt|pptx|xlsx|excel|附件|文件)/i.test(input)) {
      return true;
    }

    return false;
  }
}