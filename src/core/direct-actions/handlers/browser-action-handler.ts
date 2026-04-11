import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionDispatchContext } from '../../direct-action-dispatch-service.js';
import type { ResolvedIntent } from '../../intent-resolver.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { BrowserActionRuntime } from '../runtime-context.js';
import type { Message } from '../../../types/index.js';
import { resolveKnownWebsiteUrl } from '../../site-aliases.js';

type BrowserEngine = 'google' | 'baidu' | 'doubao';

interface BrowserSearchContext {
  engine: BrowserEngine | '';
  query: string;
  url: string;
}

export class BrowserActionHandler implements DirectActionHandler {
  readonly name = 'browser-action';

  constructor(private readonly runtime: BrowserActionRuntime) {}

  canHandle(input: string, intent?: ResolvedIntent, context?: DirectActionDispatchContext): boolean {
    if (intent?.name === 'browser.search' && this.isExplicitBrowserSearchRequest(input, intent)) {
      return true;
    }

    if (this.isSmartBrowserTask(input)) {
      return true;
    }

    return (/^(?:帮我|请|麻烦)?(?:打开|访问|进入|浏览|跳转到)/i.test(input) && !!this.resolveUrl(input))
      || /(打开|访问|进入|浏览|跳转到).*(网页|网站|首页|页面|官网|github|gitlab|google|谷歌|百度|豆包|doubao|飞书|lark|https?:\/\/)/i.test(input)
      || /(google|谷歌|百度|豆包|doubao).*(输入|搜索|查找|查询).*(关键词|关键字)?/i.test(input)
      || this.isBrowserFollowUp(input)
      || Boolean(context?.isFollowUp && context?.boundTask?.category === 'browser-action');
  }

  async handle(input: string, intent?: ResolvedIntent, context?: DirectActionDispatchContext): Promise<DirectActionResult | null> {
    if (this.isSmartBrowserTask(input)) {
      return this.runtime.executeBuiltInTool('browser_agent_run', {
        goal: input,
        startUrl: this.extractStartUrl(input) || this.resolveUrl(input) || undefined,
      }, '[Direct browser_agent_run]');
    }

    const searchContext = this.resolveSearchContext(input, intent, context);
    const directOpenUrl = this.buildDirectOpenUrl(searchContext);
    if (directOpenUrl) {
      const result = await this.runtime.executeBuiltInTool('open_browser', {
        url: directOpenUrl,
        background: false,
      }, '[Direct open_browser]');
      return {
        ...result,
        category: 'browser-action',
        metadata: {
          engine: searchContext.engine,
          query: searchContext.query,
          url: directOpenUrl,
        },
      };
    }

    const automationRequest = this.buildAutomationRequest(searchContext);
    if (automationRequest) {
      const result = await this.runtime.executeBuiltInTool('browser_automate', automationRequest, '[Direct browser_automate]');
      return {
        ...result,
        category: 'browser-action',
        metadata: {
          engine: searchContext.engine,
          query: searchContext.query,
          url: searchContext.url,
        },
      };
    }

    const url = searchContext.url || this.resolveUrl(input);
    if (!url) {
      return null;
    }

    const result = await this.runtime.executeBuiltInTool('open_browser', {
      url,
      background: false,
    }, '[Direct open_browser]');
    return {
      ...result,
      category: 'browser-action',
      metadata: {
        engine: searchContext.engine,
        query: searchContext.query,
        url,
      },
    };
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

  private resolveSearchContext(input: string, intent?: ResolvedIntent, context?: DirectActionDispatchContext): BrowserSearchContext {
    const boundTaskMetadata = context?.boundTask?.metadata && typeof context.boundTask.metadata === 'object'
      ? context.boundTask.metadata as Record<string, unknown>
      : undefined;
    let engine = this.resolveEngine(input, intent);
    let query = typeof intent?.slots.query === 'string' && intent.slots.query.trim()
      ? intent.slots.query.trim()
      : this.extractSearchQuery(input) || '';

    if ((!engine || !query) && context?.isFollowUp && context?.boundTask?.category === 'browser-action') {
      if (!engine && typeof boundTaskMetadata?.engine === 'string') {
        engine = boundTaskMetadata.engine as BrowserEngine;
      }
      if (!query && typeof boundTaskMetadata?.query === 'string') {
        query = boundTaskMetadata.query;
      }
    }

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

  private isExplicitBrowserSearchRequest(input: string, intent?: ResolvedIntent): boolean {
    const trimmed = input.trim();
    const slotEngine = typeof intent?.slots.engine === 'string' ? intent.slots.engine.trim().toLowerCase() : '';
    const hasExplicitEngine = /google|谷歌|百度|豆包|doubao/i.test(trimmed)
      || slotEngine === 'google'
      || slotEngine === 'baidu'
      || slotEngine === 'doubao';
    const hasBrowserSearchVerb = /(?:打开|访问|进入|浏览|跳转到).*(?:google|谷歌|百度|豆包|doubao|搜索页|搜索页面|官网|网站|网页)|(?:在)?(?:google|谷歌|百度|豆包|doubao)(?:上)?(?:搜索|查找|查询|提问|发问)|(?:用|通过).*(?:google|谷歌|百度|豆包|doubao).*(?:搜索|查找|查询)|(?:google|谷歌|百度|豆包|doubao).*(?:输入|搜索|查找|查询)/i.test(trimmed);

    return hasExplicitEngine && hasBrowserSearchVerb;
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

  private isSmartBrowserTask(input: string): boolean {
    return /(自动操作浏览器|浏览器代理|智能浏览器|自动浏览网页)/i.test(input)
      || /(?:用|通过).{0,6}浏览器.{0,20}(?:完成|处理|执行|搞定)/i.test(input)
      || /(?:在|去).{0,12}(?:网页|网站|页面).{0,30}(?:完成|处理|执行|操作)/i.test(input)
      || this.isCompositeBrowserInteractionTask(input);
  }

  private isCompositeBrowserInteractionTask(input: string): boolean {
    const hasNavigationIntent = /^(?:帮我|请|麻烦)?(?:打开|访问|进入|浏览|跳转到)/i.test(input)
      || /(?:打开|访问|进入|浏览|跳转到).*(?:网页|网站|页面|首页|官网|链接|url|URL|浏览器|标签页)/i.test(input);
    const hasBrowserTarget = Boolean(this.resolveUrl(input))
      || /(?:网页|网站|页面|首页|官网|链接|url|URL|浏览器|标签页)/i.test(input);

    if (!hasBrowserTarget) {
      return false;
    }

    const advancedActionMatches = input.match(/点击|点开|滚动|下拉|上滑|输入|填写|选择|勾选|提交|登录|截图|提取|抓取|复制|展开|关闭|切换|等待/gi) || [];
    const hasSequentialFlow = /然后|再|接着|之后|继续|并且|同时|并|完成后|后再|后继续|打开.+(?:点击|点开|滚动|下拉|上滑|输入|填写|选择|勾选|提交|登录|截图|提取|抓取|复制|展开|关闭|切换|等待)/i.test(input);
    const hasAdvancedAction = advancedActionMatches.length >= 1;
    const hasMultipleAdvancedActions = advancedActionMatches.length >= 2;

    return hasMultipleAdvancedActions
      || (hasAdvancedAction && hasSequentialFlow)
      || (hasNavigationIntent && hasAdvancedAction);
  }

  private extractStartUrl(input: string): string | null {
    return input.match(/https?:\/\/[^\s]+/i)?.[0] || null;
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

    return resolveKnownWebsiteUrl(input);
  }
}