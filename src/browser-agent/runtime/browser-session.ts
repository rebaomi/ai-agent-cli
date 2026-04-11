import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveBrowserExecutable, type BrowserTarget } from '../../utils/browser-automation.js';
import { resolveUserPath } from '../../utils/path-resolution.js';
import type { BrowserActionProposal, BrowserInteractiveElement, BrowserPageDigest, BrowserWorkflowScriptBinding } from '../domain/types.js';
import type { BrowserScriptResultMismatchStrategy } from '../../types/index.js';
import { DOMSummarizer } from '../observe/dom-summarizer.js';
import { formatScriptActionOutput, resolveScriptResultValidationHandling, validateScriptResultContract } from '../script-result-validation.js';
import { resolveSelectorSlotValues, uniqueSelectorValues } from '../workflows/selector-slot-resolver.js';

export interface BrowserSessionOptions {
  browser?: BrowserTarget;
  executablePath?: string;
  headless?: boolean;
  timeoutMs?: number;
  workspace?: string;
  appBaseDir?: string;
  artifactOutputDir?: string;
  documentOutputDir?: string;
  userDataDir?: string;
  extensionPaths?: string[];
  initScriptPaths?: string[];
  initScripts?: string[];
  pageScriptPaths?: string[];
  pageScripts?: string[];
  userscripts?: {
    paths?: string[];
    inline?: string[];
    runAt?: 'document-start' | 'document-end';
    enabled?: boolean;
  };
  expectResultMismatchStrategy?: BrowserScriptResultMismatchStrategy;
}

export interface BrowserSessionObservationOptions {
  maxDomNodes: number;
  maxTextChars: number;
}

export interface BrowserSessionActionResult {
  summary: string;
  extractedText?: string;
}

export interface BrowserActionExecutionOptions {
  selectorSlots?: Record<string, string[]>;
  preferredSelectors?: string[];
  fallbackActions?: string[];
  maxRetries?: number;
}

type PlaywrightBrowser = {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
};

type PlaywrightBrowserContext = {
  newPage: () => Promise<PlaywrightPage>;
  close: () => Promise<void>;
  pages: () => PlaywrightPage[];
  addInitScript: (script: string) => Promise<void>;
};

type PlaywrightPage = {
  addInitScript: (script: string) => Promise<void>;
  goto: (url: string, options?: Record<string, unknown>) => Promise<void>;
  title: () => Promise<string>;
  url: () => string;
  setDefaultTimeout: (timeout: number) => void;
  waitForTimeout: (timeout: number) => Promise<void>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<void>;
  waitForLoadState: (state?: string, options?: Record<string, unknown>) => Promise<void>;
  locator: (selector: string) => {
    first: () => {
      click: (options?: Record<string, unknown>) => Promise<void>;
      fill: (value: string, options?: Record<string, unknown>) => Promise<void>;
      press: (key: string, options?: Record<string, unknown>) => Promise<void>;
      innerText: () => Promise<string>;
    };
  };
  evaluate: <T, A>(pageFunction: (arg: A) => T | Promise<T>, arg: A) => Promise<T>;
};

type PlaywrightModule = {
  chromium: {
    launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser>;
    launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<PlaywrightBrowserContext>;
  };
};

export class BrowserSession {
  private browser?: PlaywrightBrowser;
  private context?: PlaywrightBrowserContext;
  private page?: PlaywrightPage;
  private temporaryUserDataDir?: string;
  private userscriptEnabled: boolean;
  private readonly postLoadScriptsPromise: Promise<{ initScripts: string[]; pageScripts: string[]; userscriptPageScripts: string[] }>;
  private loadedInitScripts: string[] = [];
  private loadedPageScripts: string[] = [];
  private loadedUserscriptPageScripts: string[] = [];
  private readonly summarizer = new DOMSummarizer();

  constructor(private readonly options: BrowserSessionOptions = {}) {
    this.userscriptEnabled = options.userscripts?.enabled !== false;
    this.postLoadScriptsPromise = this.loadConfiguredScripts();
  }

  async start(startUrl?: string): Promise<void> {
    const playwright = await this.loadPlaywright();
    const startup = await this.buildStartupConfiguration();
    this.loadedInitScripts = [...startup.initScripts];
    this.loadedPageScripts = [...startup.pageScripts];
    this.loadedUserscriptPageScripts = [...startup.userscriptPageScripts];

    if (startup.usePersistentContext) {
      this.context = await playwright.chromium.launchPersistentContext(startup.userDataDir, startup.launchOptions);
      for (const script of startup.initScripts) {
        await this.context.addInitScript(script);
      }
      this.page = this.context.pages()[0] || await this.context.newPage();
    } else {
      this.browser = await playwright.chromium.launch(startup.launchOptions);
      this.page = await this.browser.newPage();
      for (const script of startup.initScripts) {
        await this.page.addInitScript(script);
      }
    }

    this.page.setDefaultTimeout(Math.max(1000, this.options.timeoutMs ?? 15000));

    const normalizedStartUrl = normalizeUrl(startUrl || 'about:blank');
    await this.page.goto(normalizedStartUrl, { waitUntil: 'domcontentloaded' });
    await this.runPostLoadScripts(normalizedStartUrl);
  }

  async observe(options: BrowserSessionObservationOptions): Promise<BrowserPageDigest> {
    const page = this.getPage();
    const snapshot = await page.evaluate(({ maxDomNodes, maxTextChars }) => {
      const runtime = globalThis as any;
      const win = runtime.window as any;
      const doc = runtime.document as any;
      const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();
      const isVisible = (element: any): boolean => {
        if (!element) {
          return false;
        }

        const style = win.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const inferRole = (element: any): string => {
        const tag = String(element.tagName || '').toLowerCase();
        return element.getAttribute('role') || tag || 'element';
      };

      const getElementText = (element: any): string => {
        const text = normalizeText(element.innerText || element.textContent || element.value || '');
        if (text) {
          return text.slice(0, 120);
        }

        const placeholder = normalizeText(element.getAttribute('placeholder') || '');
        if (placeholder) {
          return placeholder.slice(0, 120);
        }

        const ariaLabel = normalizeText(element.getAttribute('aria-label') || '');
        return ariaLabel.slice(0, 120);
      };

      const candidates = Array.from(doc.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])')) as any[];
      const interactiveElements: BrowserInteractiveElement[] = [];

      for (const candidate of candidates) {
        if (interactiveElements.length >= maxDomNodes || !isVisible(candidate)) {
          continue;
        }

        const id = candidate.getAttribute('data-ai-agent-id') || `ai-agent-${interactiveElements.length + 1}`;
        candidate.setAttribute('data-ai-agent-id', id);

        interactiveElements.push({
          id,
          selector: `[data-ai-agent-id="${id}"]`,
          role: inferRole(candidate),
          text: getElementText(candidate),
          type: normalizeText(candidate.getAttribute('type') || ''),
          placeholder: normalizeText(candidate.getAttribute('placeholder') || ''),
          href: normalizeText(candidate.getAttribute('href') || ''),
        });
      }

      const visibleText = normalizeText(doc.body?.innerText || '').slice(0, maxTextChars);
      const interactiveSummary = interactiveElements.slice(0, 20).map((element, index) => {
        const parts = [
          `${index + 1}. ${element.role}`,
          element.text || element.placeholder || '',
          element.href || '',
          element.selector,
        ].filter(Boolean);

        return parts.join(' | ');
      });

      return {
        url: win.location.href,
        title: doc.title || '',
        visibleText,
        interactiveElements,
        interactiveSummary,
      };
    }, options);

    return this.summarizer.summarize(snapshot);
  }

  async execute(action: BrowserActionProposal): Promise<BrowserSessionActionResult> {
    return this.executeWithOptions(action, {});
  }

  async executeWithOptions(action: BrowserActionProposal, options: BrowserActionExecutionOptions): Promise<BrowserSessionActionResult> {
    const page = this.getPage();
    const retryLimit = Math.max(1, Math.min(5, options.maxRetries ?? 2));

    switch (action.type) {
      case 'navigate': {
        const targetUrl = action.url || action.value;
        if (!targetUrl) {
          throw new Error('navigate 动作缺少 url');
        }

        const normalizedTargetUrl = normalizeUrl(targetUrl);
        await page.goto(normalizedTargetUrl, { waitUntil: 'domcontentloaded' });
        await this.runPostLoadScripts(normalizedTargetUrl);
        return { summary: `已跳转到 ${normalizedTargetUrl}` };
      }
      case 'click': {
        const selector = await this.runSelectorAction({
          action,
          selectorSlots: options.selectorSlots,
          preferredSelectors: options.preferredSelectors,
          retryLimit,
          execute: async candidate => {
            await page.locator(candidate).first().click();
            await this.waitForSettle();
          },
        }).catch(async error => {
          const fallbackSelector = await this.runFallbackActions(action, options.fallbackActions, retryLimit, options.selectorSlots);
          if (!fallbackSelector) {
            throw error;
          }
          return fallbackSelector;
        });

        return { summary: `已点击 ${selector}` };
      }
      case 'fill': {
        const selector = await this.runSelectorAction({
          action,
          selectorSlots: options.selectorSlots,
          preferredSelectors: options.preferredSelectors,
          retryLimit,
          execute: async candidate => {
            await page.locator(candidate).first().fill(action.value || '');
          },
        }).catch(async error => {
          const fallbackSelector = await this.runFallbackActions(action, options.fallbackActions, retryLimit, options.selectorSlots);
          return fallbackSelector || action.selector || options.preferredSelectors?.[0] || (() => { throw error; })();
        });

        return { summary: `已填写 ${selector}` };
      }
      case 'press': {
        const [selector] = this.resolveSelectorCandidates(action.selector, options.selectorSlots, options.preferredSelectors);
        if (!selector) {
          throw new Error('press 动作缺少 selector');
        }
        if (!action.key) {
          throw new Error('press 动作缺少 key');
        }

        await page.locator(selector).first().press(action.key);
        await this.waitForSettle();
        return { summary: `已在 ${selector} 按下 ${action.key}` };
      }
      case 'extract': {
        const [selector] = this.resolveSelectorCandidates(action.selector, options.selectorSlots, options.preferredSelectors);
        const resolvedSelector = selector || 'body';
        const extractedText = (await page.locator(resolvedSelector).first().innerText()).trim().slice(0, 4000);
        return {
          summary: `已提取 ${resolvedSelector} 的文本内容`,
          extractedText,
        };
      }
      case 'wait': {
        const timeout = resolveWaitMs(action.value);
        if (action.selector) {
          await page.waitForSelector(action.selector, { timeout });
          return { summary: `已等待 ${action.selector} 出现` };
        }

        await page.waitForTimeout(timeout);
        return { summary: `已等待 ${timeout}ms` };
      }
      case 'evaluate_script': {
        const script = action.script || action.value;
        if (!script?.trim()) {
          throw new Error('evaluate_script 动作缺少 script');
        }

        const result = await this.evaluateScript(script);
        const validation = validateScriptResultContract(result, action.expectResult);
        const handling = resolveScriptResultValidationHandling(validation, this.options.expectResultMismatchStrategy, 'evaluate_script 动作返回值校验失败，');
        return {
          summary: handling.displaySummary ? `已执行页面脚本，${handling.displaySummary}` : '已执行页面脚本',
          extractedText: formatScriptActionOutput(result, validation),
        };
      }
      case 'call_userscript_api': {
        if (!action.api?.trim()) {
          throw new Error('call_userscript_api 动作缺少 api');
        }

        const result = await this.callUserscriptApi(action.api, action.args || []);
        const validation = validateScriptResultContract(result, action.expectResult);
        const handling = resolveScriptResultValidationHandling(validation, this.options.expectResultMismatchStrategy, `call_userscript_api(${action.api}) 返回值校验失败，`);
        return {
          summary: handling.displaySummary ? `已调用用户脚本 API: ${action.api}，${handling.displaySummary}` : `已调用用户脚本 API: ${action.api}`,
          extractedText: formatScriptActionOutput(result, validation),
        };
      }
      case 'toggle_userscript_mode': {
        const enabled = action.enabled ?? !this.userscriptEnabled;
        await this.setUserscriptEnabled(enabled);
        return {
          summary: `已${enabled ? '开启' : '关闭'}用户脚本模式`,
        };
      }
      case 'done': {
        return { summary: action.reason || '任务完成' };
      }
      default:
        throw new Error(`不支持的动作类型: ${action.type}`);
    }
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    if (this.temporaryUserDataDir) {
      await fs.rm(this.temporaryUserDataDir, { recursive: true, force: true }).catch(() => undefined);
      this.temporaryUserDataDir = undefined;
    }
    this.context = undefined;
    this.browser = undefined;
    this.page = undefined;
    this.loadedInitScripts = [];
    this.loadedPageScripts = [];
    this.loadedUserscriptPageScripts = [];
  }

  async applyScriptBinding(binding: BrowserWorkflowScriptBinding): Promise<void> {
    const page = this.getPage();
    const initPathScripts = await this.loadScriptContents(binding.initScriptPaths);
    const pagePathScripts = await this.loadScriptContents(binding.pageScriptPaths);
    const userscriptPathScripts = await this.loadScriptContents(binding.userscriptPaths);
    const initScripts = [...binding.initScripts, ...initPathScripts];
    const pageScripts = [...binding.pageScripts, ...pagePathScripts];
    const userscriptScripts = [...binding.userscriptInline, ...userscriptPathScripts].map(script => wrapUserscriptSource(script));

    if (binding.userscriptMode) {
      await this.setUserscriptEnabled(binding.userscriptMode === 'on');
    }

    if (binding.userscriptRunAt === 'document-start') {
      for (const script of userscriptScripts) {
        if (!this.loadedInitScripts.includes(script)) {
          this.loadedInitScripts.push(script);
          if (this.context) {
            await this.context.addInitScript(script);
          } else {
            await page.addInitScript(script);
          }
          await page.evaluate(executeScriptSource, script);
        }
      }
    } else {
      for (const script of userscriptScripts) {
        if (!this.loadedUserscriptPageScripts.includes(script)) {
          this.loadedUserscriptPageScripts.push(script);
          await page.evaluate(executeScriptSource, script);
        }
      }
    }

    for (const script of initScripts) {
      if (!this.loadedInitScripts.includes(script)) {
        this.loadedInitScripts.push(script);
        if (this.context) {
          await this.context.addInitScript(script);
        } else {
          await page.addInitScript(script);
        }
        await page.evaluate(executeScriptSource, script);
      }
    }

    for (const script of pageScripts) {
      if (!this.loadedPageScripts.includes(script)) {
        this.loadedPageScripts.push(script);
        await page.evaluate(executeScriptSource, script);
      }
    }
  }

  private async buildStartupConfiguration(): Promise<{
    launchOptions: Record<string, unknown>;
    usePersistentContext: boolean;
    userDataDir: string;
    initScripts: string[];
    pageScripts: string[];
    userscriptPageScripts: string[];
  }> {
    const { initScripts, pageScripts, userscriptPageScripts } = await this.postLoadScriptsPromise;
    const resolvedExtensions = await this.resolveConfiguredPaths(this.options.extensionPaths || []);
    const usePersistentContext = resolvedExtensions.length > 0 || typeof this.options.userDataDir === 'string' && this.options.userDataDir.trim().length > 0;
    const launchOptions: Record<string, unknown> = {
      headless: resolvedExtensions.length > 0 ? false : this.options.headless ?? true,
    };

    const explicitExecutablePath = this.options.executablePath?.trim();
    if (explicitExecutablePath) {
      launchOptions.executablePath = explicitExecutablePath;
    } else if (resolvedExtensions.length === 0) {
      const executablePath = resolveBrowserExecutable(this.options.browser || 'chrome');
      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }
    }

    if (resolvedExtensions.length > 0) {
      launchOptions.channel = 'chromium';
      launchOptions.args = buildChromiumExtensionArgs(resolvedExtensions);
      launchOptions.ignoreDefaultArgs = ['--disable-extensions'];
    }

    if (!usePersistentContext) {
      return {
        launchOptions,
        usePersistentContext: false,
        userDataDir: '',
        initScripts,
        pageScripts,
        userscriptPageScripts,
      };
    }

    const userDataDir = this.options.userDataDir
      ? resolveConfiguredPath(this.options.userDataDir, this.options)
      : await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-browser-'));
    if (!this.options.userDataDir) {
      this.temporaryUserDataDir = userDataDir;
    }
    return {
      launchOptions,
      usePersistentContext: true,
      userDataDir,
      initScripts,
      pageScripts,
      userscriptPageScripts,
    };
  }

  private async loadConfiguredScripts(): Promise<{ initScripts: string[]; pageScripts: string[]; userscriptPageScripts: string[] }> {
    const userscripts = this.options.userscripts || {};
    const initPathScripts = await this.loadScriptContents(this.options.initScriptPaths || []);
    const pagePathScripts = await this.loadScriptContents(this.options.pageScriptPaths || []);
    const userscriptPathScripts = await this.loadScriptContents(userscripts.paths || []);
    const userscriptInline = (userscripts.inline || []).map(script => script.trim()).filter(Boolean);

    const runtimeBridgeScript = buildUserscriptRuntimeBridgeScript(this.userscriptEnabled);

    const initScripts = [
      runtimeBridgeScript,
      ...(this.options.initScripts || []),
      ...initPathScripts,
      ...(userscripts.runAt === 'document-start'
        ? [...userscriptPathScripts, ...userscriptInline].map(script => wrapUserscriptSource(script))
        : []),
    ].map(script => script.trim()).filter(Boolean);

    const pageScripts = [
      ...(this.options.pageScripts || []),
      ...pagePathScripts,
    ].map(script => script.trim()).filter(Boolean);

    const userscriptPageScripts = userscripts.runAt !== 'document-start'
      ? [...userscriptPathScripts, ...userscriptInline].map(script => wrapUserscriptSource(script))
      : [];

    return { initScripts, pageScripts, userscriptPageScripts };
  }

  private async loadScriptContents(inputPaths: string[]): Promise<string[]> {
    const resolvedPaths = await this.resolveConfiguredPaths(inputPaths);
    return Promise.all(resolvedPaths.map(filePath => fs.readFile(filePath, 'utf-8')));
  }

  private async resolveConfiguredPaths(inputPaths: string[]): Promise<string[]> {
    return inputPaths
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => resolveConfiguredPath(value, this.options));
  }

  private async runPostLoadScripts(currentUrl: string): Promise<void> {
    if (/^about:blank$/i.test(currentUrl)) {
      return;
    }

    const page = this.getPage();
    for (const script of this.loadedPageScripts) {
      await page.evaluate(executeScriptSource, script);
    }

    for (const script of this.loadedUserscriptPageScripts) {
      await page.evaluate(executeScriptSource, script);
    }
  }

  private async evaluateScript(script: string): Promise<unknown> {
    const page = this.getPage();
    return page.evaluate(executeScriptSource, script);
  }

  private async callUserscriptApi(apiPath: string, args: unknown[]): Promise<unknown> {
    const page = this.getPage();
    return page.evaluate(({ apiPath, args }) => {
      const runtime = globalThis as Record<string, unknown>;
      const segments = apiPath.split('.').map(segment => segment.trim()).filter(Boolean);
      if (segments.length === 0) {
        throw new Error('userscript apiPath 不能为空');
      }

      let target: unknown = runtime;
      for (const segment of segments) {
        if (!target || typeof target !== 'object' || !(segment in (target as Record<string, unknown>))) {
          throw new Error(`未找到用户脚本 API: ${apiPath}`);
        }
        target = (target as Record<string, unknown>)[segment];
      }

      if (typeof target !== 'function') {
        throw new Error(`用户脚本 API 不是函数: ${apiPath}`);
      }

      return (target as (...input: unknown[]) => unknown)(...args);
    }, { apiPath, args });
  }

  private async setUserscriptEnabled(enabled: boolean): Promise<void> {
    this.userscriptEnabled = enabled;
    const page = this.getPage();
    await page.evaluate((value: boolean) => {
      const runtime = globalThis as Record<string, unknown>;
      const bridge = (runtime.__AI_AGENT_BROWSER_RUNTIME ||= {}) as Record<string, unknown>;
      bridge.userscriptEnabled = value;
      runtime.__AI_AGENT_USERSCRIPT_ENABLED__ = value;
      return value;
    }, enabled);
  }

  private async waitForSettle(): Promise<void> {
    const page = this.getPage();
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 1500 });
    } catch {
      await page.waitForTimeout(300);
    }
  }

  private async runSelectorAction(input: {
    action: BrowserActionProposal;
    selectorSlots?: Record<string, string[]>;
    preferredSelectors?: string[];
    retryLimit: number;
    execute: (candidate: string) => Promise<void>;
  }): Promise<string> {
    const candidates = this.resolveSelectorCandidates(input.action.selector, input.selectorSlots, input.preferredSelectors).slice(0, input.retryLimit);
    if (candidates.length === 0) {
      throw new Error(`${input.action.type} 动作缺少可执行 selector`);
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await input.execute(candidate);
        return candidate;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError || `${input.action.type} selector 执行失败`));
  }

  private async runFallbackActions(action: BrowserActionProposal, fallbackActions: string[] | undefined, retryLimit: number, selectorSlots?: Record<string, string[]>): Promise<string | undefined> {
    if (!fallbackActions || fallbackActions.length === 0) {
      throw new Error(`${action.type} 动作失败且未配置 fallback actions`);
    }

    const page = this.getPage();
    const steps = fallbackActions.slice(0, retryLimit);
    for (const step of steps) {
      if (step.startsWith('wait:')) {
        const timeout = resolveWaitMs(step.slice('wait:'.length));
        await page.waitForTimeout(timeout);
        continue;
      }

      if (step.startsWith('press:')) {
        const [selector] = this.resolveSelectorCandidates(action.selector, selectorSlots);
        if (!selector) {
          continue;
        }
        await page.locator(selector).first().press(step.slice('press:'.length));
        await this.waitForSettle();
        return selector;
      }

      if (step === 'clickSelf') {
        const [selector] = this.resolveSelectorCandidates(action.selector, selectorSlots);
        if (!selector) {
          continue;
        }
        await page.locator(selector).first().click();
        await this.waitForSettle();
        return selector;
      }

      if (step === 'fillSelf') {
        const [selector] = this.resolveSelectorCandidates(action.selector, selectorSlots);
        if (!selector) {
          continue;
        }
        await page.locator(selector).first().fill(action.value || '');
        return selector;
      }

      if (step.startsWith('click:')) {
        const [selector] = this.resolveSelectorCandidates(step.slice('click:'.length).trim(), selectorSlots);
        if (!selector) {
          continue;
        }
        await page.locator(selector).first().click();
        await this.waitForSettle();
        return selector;
      }

      if (step.startsWith('fill:')) {
        const [selector] = this.resolveSelectorCandidates(step.slice('fill:'.length).trim(), selectorSlots);
        if (!selector) {
          continue;
        }
        await page.locator(selector).first().fill(action.value || '');
        return selector;
      }
    }

    return undefined;
  }

  private resolveSelectorCandidates(selector: string | undefined, selectorSlots?: Record<string, string[]>, preferredSelectors?: string[]): string[] {
    const selectorValues = resolveSelectorSlotValues(selector, selectorSlots);
    return uniqueSelectorValues([
      ...selectorValues,
      ...(selectorValues.length === 0 ? [selector] : []),
      ...(preferredSelectors || []).flatMap(item => resolveSelectorSlotValues(item, selectorSlots)),
      ...(preferredSelectors || []).filter(item => !item.trim().startsWith('$')),
    ]);
  }

  private getPage(): PlaywrightPage {
    if (!this.page) {
      throw new Error('浏览器页面尚未初始化');
    }

    return this.page;
  }

  private async loadPlaywright(): Promise<PlaywrightModule> {
    try {
      return await import('playwright') as unknown as PlaywrightModule;
    } catch {
      throw new Error('缺少 Playwright 运行环境。请先安装 playwright，并执行 npx playwright install chromium');
    }
  }
}

function executeScriptSource(source: string): unknown {
  const runtime = globalThis as unknown as { eval: (code: string) => unknown };
  return runtime.eval(source);
}

export function buildChromiumExtensionArgs(extensionPaths: string[]): string[] {
  const normalizedPaths = Array.from(new Set(extensionPaths.map(item => item.trim()).filter(Boolean)));
  if (normalizedPaths.length === 0) {
    return [];
  }

  const joined = normalizedPaths.join(',');
  return [
    `--disable-extensions-except=${joined}`,
    `--load-extension=${joined}`,
  ];
}

function buildUserscriptRuntimeBridgeScript(enabled: boolean): string {
  return `(() => {
    const runtime = globalThis;
    const stateKey = '__AI_AGENT_USERSCRIPT_STATE__';
    const parsePersistedState = () => {
      const currentName = typeof runtime.window?.name === 'string' ? runtime.window.name : '';
      const match = currentName.match(new RegExp('(?:^|\\n)' + stateKey + '=(true|false)(?:\\n|$)'));
      if (!match || !match[1]) {
        return undefined;
      }
      return match[1] === 'true';
    };
    const persistState = (value) => {
      if (!runtime.window) {
        return value;
      }
      const currentName = typeof runtime.window.name === 'string' ? runtime.window.name : '';
      const markerPattern = new RegExp('(?:^|\\n)' + stateKey + '=(?:true|false)(?=\\n|$)', 'g');
      const sanitized = currentName.replace(markerPattern, '').replace(/^\\n+|\\n+$/g, '');
      runtime.window.name = [sanitized, stateKey + '=' + String(Boolean(value))].filter(Boolean).join('\\n');
      return value;
    };
    const persistedEnabled = parsePersistedState();
    const bridge = runtime.__AI_AGENT_BROWSER_RUNTIME || {};
    bridge.userscriptEnabled = persistedEnabled ?? ${enabled ? 'true' : 'false'};
    bridge.toggleUserscriptMode = (value) => {
      bridge.userscriptEnabled = Boolean(value);
      runtime.__AI_AGENT_USERSCRIPT_ENABLED__ = bridge.userscriptEnabled;
      persistState(bridge.userscriptEnabled);
      return bridge.userscriptEnabled;
    };
    bridge.callUserscriptApi = (apiPath, ...args) => {
      const segments = String(apiPath || '').split('.').map(item => item.trim()).filter(Boolean);
      let target = runtime;
      for (const segment of segments) {
        if (!target || !(segment in target)) {
          throw new Error('未找到用户脚本 API: ' + apiPath);
        }
        target = target[segment];
      }
      if (typeof target !== 'function') {
        throw new Error('用户脚本 API 不是函数: ' + apiPath);
      }
      return target(...args);
    };
    runtime.__AI_AGENT_BROWSER_RUNTIME = bridge;
    runtime.__AI_AGENT_USERSCRIPT_ENABLED__ = bridge.userscriptEnabled;
    persistState(bridge.userscriptEnabled);
  })();`;
}

function wrapUserscriptSource(source: string): string {
  return `(() => {
    const runtime = globalThis;
    if (runtime.__AI_AGENT_BROWSER_RUNTIME && runtime.__AI_AGENT_BROWSER_RUNTIME.userscriptEnabled === false) {
      return;
    }
    ${source}
  })();`;
}

function resolveConfiguredPath(inputPath: string, options: BrowserSessionOptions): string {
  return resolveUserPath(inputPath, {
    workspace: options.workspace || process.cwd(),
    appBaseDir: options.appBaseDir,
    artifactOutputDir: options.artifactOutputDir,
    documentOutputDir: options.documentOutputDir,
  });
}

function normalizeUrl(url: string): string {
  if (/^(about:blank|data:,)$/i.test(url)) {
    return url;
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `https://${url}`;
}

function resolveWaitMs(value?: string): number {
  if (!value) {
    return 1000;
  }

  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return 1000;
  }

  return Math.max(0, numeric);
}
