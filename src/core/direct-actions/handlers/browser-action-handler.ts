import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { BrowserActionRuntime } from '../runtime-context.js';

export class BrowserActionHandler implements DirectActionHandler {
  readonly name = 'browser-action';

  constructor(private readonly runtime: BrowserActionRuntime) {}

  canHandle(input: string): boolean {
    return /(打开|访问|进入|浏览|跳转到).*(网页|网站|首页|页面|官网|github|gitlab|google|百度|飞书|lark|https?:\/\/)/i.test(input);
  }

  async handle(input: string): Promise<DirectActionResult | null> {
    const automationRequest = this.buildAutomationRequest(input);
    if (automationRequest) {
      return this.runtime.executeBuiltInTool('browser_automate', automationRequest, '[Direct browser_automate]');
    }

    const url = this.resolveUrl(input);
    if (!url) {
      return null;
    }

    return this.runtime.executeBuiltInTool('open_browser', {
      url,
      background: false,
    }, '[Direct open_browser]');
  }

  private buildAutomationRequest(input: string): Record<string, unknown> | null {
    const query = this.extractSearchQuery(input);
    if (!query) {
      return null;
    }

    if (/google|谷歌/i.test(input)) {
      return {
        url: 'https://www.google.com',
        browser: 'chrome',
        headless: false,
        keepOpen: true,
        timeoutMs: 20000,
        actions: [
          { type: 'wait_for_selector', selector: 'textarea[name="q"], input[name="q"]', timeoutMs: 20000 },
          { type: 'fill', selector: 'textarea[name="q"], input[name="q"]', value: query },
          { type: 'press', selector: 'textarea[name="q"], input[name="q"]', key: 'Enter' },
          { type: 'wait_for_selector', selector: '#search', timeoutMs: 20000 },
        ],
      };
    }

    if (/百度/i.test(input)) {
      return {
        url: 'https://www.baidu.com',
        browser: 'chrome',
        headless: false,
        keepOpen: true,
        timeoutMs: 20000,
        actions: [
          { type: 'wait_for_selector', selector: 'textarea[name="wd"], input[name="wd"]', timeoutMs: 20000 },
          { type: 'fill', selector: 'textarea[name="wd"], input[name="wd"]', value: query },
          { type: 'press', selector: 'textarea[name="wd"], input[name="wd"]', key: 'Enter' },
          { type: 'wait_for_selector', selector: '#content_left', timeoutMs: 20000 },
        ],
      };
    }

    return null;
  }

  private extractSearchQuery(input: string): string | null {
    const patterns = [
      /(?:输入|搜索|查找|查询)(?:关键词|关键字)?[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
      /(?:关键词|关键字)[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern)?.[1]?.trim();
      if (match) {
        return match;
      }
    }

    return null;
  }

  private resolveUrl(input: string): string | null {
    const directUrl = input.match(/https?:\/\/[^\s]+/i)?.[0];
    if (directUrl) {
      return directUrl;
    }

    if (/github/i.test(input)) {
      return 'https://github.com';
    }

    if (/gitlab/i.test(input)) {
      return 'https://gitlab.com';
    }

    if (/google|谷歌/i.test(input)) {
      return 'https://www.google.com';
    }

    if (/百度/i.test(input)) {
      return 'https://www.baidu.com';
    }

    if (/(飞书|lark)/i.test(input)) {
      return 'https://www.feishu.cn';
    }

    return null;
  }
}