import type { DirectActionResult } from '../../direct-action-router.js';
import type { ResolvedIntent } from '../../intent-resolver.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { BrowserActionRuntime } from '../runtime-context.js';
import type { Message } from '../../../types/index.js';

type BrowserEngine = 'google' | 'baidu' | 'doubao';

interface BrowserSearchContext {
  engine: BrowserEngine | '';
  query: string;
  url: string;
}

export class BrowserActionHandler implements DirectActionHandler {
  readonly name = 'browser-action';

  constructor(private readonly runtime: BrowserActionRuntime) {}

  canHandle(input: string, intent?: ResolvedIntent): boolean {
    if (intent?.name === 'browser.search') {
      return true;
    }

    return /(打开|访问|进入|浏览|跳转到).*(网页|网站|首页|页面|官网|github|gitlab|google|谷歌|百度|豆包|doubao|飞书|lark|https?:\/\/)/i.test(input)
      || /(google|谷歌|百度|豆包|doubao).*(输入|搜索|查找|查询).*(关键词|关键字)?/i.test(input)
      || this.isBrowserFollowUp(input);
  }

  async handle(input: string, intent?: ResolvedIntent): Promise<DirectActionResult | null> {
    const context = this.resolveSearchContext(input, intent);
    const directOpenUrl = this.buildDirectOpenUrl(context);
    if (directOpenUrl) {
      return this.runtime.executeBuiltInTool('open_browser', {
        url: directOpenUrl,
        background: false,
      }, '[Direct open_browser]');
    }

    const automationRequest = this.buildAutomationRequest(context);
    if (automationRequest) {
      return this.runtime.executeBuiltInTool('browser_automate', automationRequest, '[Direct browser_automate]');
    }

    const url = context.url || this.resolveUrl(input);
    if (!url) {
      return null;
    }

    return this.runtime.executeBuiltInTool('open_browser', {
      url,
      background: false,
    }, '[Direct open_browser]');
  }

  private buildDirectOpenUrl(context: BrowserSearchContext): string | null {
    if (!context.query) {
      return null;
    }

    if (context.engine === 'google') {
      return `https://www.google.com/search?q=${encodeURIComponent(context.query)}`;
    }

    if (context.engine === 'baidu') {
      return `https://www.baidu.com/s?wd=${encodeURIComponent(context.query)}`;
    }

    return null;
  }

  private buildAutomationRequest(context: BrowserSearchContext): Record<string, unknown> | null {
    if (!context.query || !context.engine) {
      return null;
    }

    if (context.engine === 'doubao') {
      return {
        url: 'https://www.doubao.com/chat/',
        browser: 'chrome',
        headless: false,
        keepOpen: true,
        timeoutMs: 25000,
        actions: [
          { type: 'wait_for_selector', selector: 'textarea, div[contenteditable="true"], [role="textbox"]', timeoutMs: 25000 },
          { type: 'fill', selector: 'textarea, div[contenteditable="true"], [role="textbox"]', value: context.query },
          { type: 'press', selector: 'textarea, div[contenteditable="true"], [role="textbox"]', key: 'Enter' },
          { type: 'wait', timeoutMs: 1500 },
        ],
      };
    }

    return null;
  }

  private resolveSearchContext(input: string, intent?: ResolvedIntent): BrowserSearchContext {
    let engine = this.resolveEngine(input, intent);
    let query = typeof intent?.slots.query === 'string' && intent.slots.query.trim()
      ? intent.slots.query.trim()
      : this.extractSearchQuery(input) || '';

    if ((!engine || !query) && this.isBrowserFollowUp(input)) {
      const recent = this.findRecentBrowserContext(this.runtime.getConversationMessages());
      if (!engine) {
        engine = recent.engine;
      }
      if (!query) {
        query = recent.query;
      }
    }

    return {
      engine,
      query,
      url: this.resolveUrl(input) || this.resolveUrlFromEngine(engine),
    };
  }

  private extractSearchQuery(input: string): string | null {
    const patterns = [
      /(?:输入|搜索|查找|查询)(?:关键词|关键字)?[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
      /(?:关键词|关键字)[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
      /(?:google|谷歌|百度|豆包|doubao)(?:网页|网站|搜索页|首页|官网|chat)?[，,\s]*.*?(?:输入|搜索|查找|查询)(?:关键词|关键字)?[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
      /(?:在)?(?:google|谷歌|百度|豆包|doubao)(?:上)?(?:搜索|查找|查询|提问|发问)[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern)?.[1]?.trim();
      if (match) {
        return match;
      }
    }

    return null;
  }

  private resolveEngine(input: string, intent?: ResolvedIntent): BrowserEngine | '' {
    const slotEngine = typeof intent?.slots.engine === 'string' ? intent.slots.engine.trim().toLowerCase() : '';
    if (slotEngine === 'google' || slotEngine === 'baidu' || slotEngine === 'doubao') {
      return slotEngine;
    }

    if (/google|谷歌/i.test(input)) {
      return 'google';
    }

    if (/百度/i.test(input)) {
      return 'baidu';
    }

    if (/豆包|doubao/i.test(input)) {
      return 'doubao';
    }

    return '';
  }

  private resolveUrlFromEngine(engine: BrowserEngine | ''): string {
    if (engine === 'google') {
      return 'https://www.google.com';
    }

    if (engine === 'baidu') {
      return 'https://www.baidu.com';
    }

    if (engine === 'doubao') {
      return 'https://www.doubao.com/chat/';
    }

    return '';
  }

  private isBrowserFollowUp(input: string): boolean {
    return /(?:刚才|刚刚|上面|上一条|前面|这次|继续|重新|还是|仍然|你).{0,20}(?:没有|没).{0,12}(?:输入|填入|搜索|查找)/i.test(input)
      || /(?:继续|重新).{0,8}(?:输入|搜索|查找).{0,8}(?:关键词|关键字)/i.test(input)
      || /(?:没有|没).{0,8}(?:输入|填入).{0,8}(?:关键词|关键字)/i.test(input);
  }

  private findRecentBrowserContext(messages: Message[]): BrowserSearchContext {
    for (const message of [...messages].reverse()) {
      if (message.role !== 'user') {
        continue;
      }

      const engine = this.resolveEngine(message.content);
      const query = this.extractSearchQuery(message.content) || '';
      if (!engine && !query) {
        continue;
      }

      return {
        engine,
        query,
        url: this.resolveUrl(message.content) || this.resolveUrlFromEngine(engine),
      };
    }

    return { engine: '', query: '', url: '' };
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

    if (/豆包|doubao/i.test(input)) {
      return 'https://www.doubao.com/chat/';
    }

    if (/(飞书|lark)/i.test(input)) {
      return 'https://www.feishu.cn';
    }

    return null;
  }
}