import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { BrowserAgentSafetyConfig, BrowserAgentUserscriptConfig, BrowserScriptResultMismatchStrategy } from '../types/index.js';
import type { BrowserScriptResultContract } from '../browser-agent/domain/types.js';
import { formatScriptActionLogText, resolveScriptResultValidationHandling, validateScriptResultContract } from '../browser-agent/script-result-validation.js';
import { BrowserSafetyInterruptionError, SensitiveOperationGuard } from '../browser-agent/safety/sensitive-operation-guard.js';
import { resolveUserPath } from './path-resolution.js';

export type BrowserTarget = 'chrome' | 'edge' | 'chromium';

export type BrowserAutomationAction = {
  type: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  script?: string;
  api?: string;
  args?: unknown[];
  enabled?: boolean;
  expectResult?: BrowserScriptResultContract;
  timeoutMs?: number;
  path?: string;
  fullPage?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
};

export interface BrowserAutomationOptions {
  url: string;
  actions?: BrowserAutomationAction[];
  browser?: BrowserTarget;
  executablePath?: string;
  headless?: boolean;
  keepOpen?: boolean;
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
  userscripts?: BrowserAgentUserscriptConfig;
  expectResultMismatchStrategy?: BrowserScriptResultMismatchStrategy;
  resolveOutputPath: (requestedPath?: string) => string;
  safetyConfig?: BrowserAgentSafetyConfig;
  loadPlaywright?: () => Promise<PlaywrightModule>;
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
  locator: (selector: string) => {
    first: () => {
      click: (options?: Record<string, unknown>) => Promise<void>;
      fill: (value: string, options?: Record<string, unknown>) => Promise<void>;
      press: (key: string, options?: Record<string, unknown>) => Promise<void>;
      innerText: () => Promise<string>;
    };
  };
  evaluate: <T, A>(pageFunction: (arg: A) => T | Promise<T>, arg: A) => Promise<T>;
  screenshot: (options: Record<string, unknown>) => Promise<void>;
};

type PlaywrightModule = {
  chromium: {
    launch: (options: Record<string, unknown>) => Promise<PlaywrightBrowser>;
    launchPersistentContext: (userDataDir: string, options: Record<string, unknown>) => Promise<PlaywrightBrowserContext>;
  };
};

interface BrowserActionLog {
  index: number;
  type: string;
  selector?: string;
  url?: string;
  outputPath?: string;
  text?: string;
  api?: string;
  validation?: string;
}

function normalizeUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `https://${url}`;
}

function normalizeActionType(type: string): string {
  return type.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function shouldFallbackSubmitClick(selector: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/not visible|timeout/i.test(message)) {
    return false;
  }

  return /btnk|btnk|type\s*=\s*['"]submit['"]|button\[type=['"]submit['"]\]|input\[type=['"]submit['"]\]/i.test(selector);
}

function resolveSubmitFallbackSelector(pageUrl: string, selector: string): string | null {
  if (/google\./i.test(pageUrl) || /btnk/i.test(selector)) {
    return 'textarea[name="q"], input[name="q"]';
  }

  if (/baidu\./i.test(pageUrl) || /name=['"]wd['"]/i.test(selector)) {
    return 'textarea[name="wd"], input[name="wd"]';
  }

  if (/type\s*=\s*['"]submit['"]/i.test(selector) || /button\[type=['"]submit['"]\]|input\[type=['"]submit['"]\]/i.test(selector)) {
    return 'input[type="search"], textarea, input[type="text"]';
  }

  return null;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim())));
}

function getBrowserExecutableCandidates(browser: BrowserTarget): string[] {
  const homeDir = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const programFiles = process.env.PROGRAMFILES || 'C:/Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)';

  const envCandidates = browser === 'chrome'
    ? [process.env.AI_AGENT_BROWSER_PATH, process.env.CHROME_PATH]
    : browser === 'edge'
      ? [process.env.AI_AGENT_BROWSER_PATH, process.env.EDGE_PATH]
      : [process.env.AI_AGENT_BROWSER_PATH, process.env.CHROMIUM_PATH, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH];

  if (process.platform === 'win32') {
    if (browser === 'chrome') {
      return uniqueStrings([
        ...envCandidates,
        path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]);
    }

    if (browser === 'edge') {
      return uniqueStrings([
        ...envCandidates,
        path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]);
    }

    return uniqueStrings([
      ...envCandidates,
      path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }

  if (process.platform === 'darwin') {
    if (browser === 'chrome') {
      return uniqueStrings([
        ...envCandidates,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ]);
    }

    if (browser === 'edge') {
      return uniqueStrings([
        ...envCandidates,
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]);
    }

    return uniqueStrings([
      ...envCandidates,
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]);
  }

  if (browser === 'chrome') {
    return uniqueStrings([
      ...envCandidates,
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/snap/bin/chromium',
    ]);
  }

  if (browser === 'edge') {
    return uniqueStrings([
      ...envCandidates,
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    ]);
  }

  return uniqueStrings([
    ...envCandidates,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ]);
}

export function resolveBrowserExecutable(browser: BrowserTarget): string | undefined {
  for (const candidate of getBrowserExecutableCandidates(browser)) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    const module = await import('playwright');
    return module as unknown as PlaywrightModule;
  } catch {
    throw new Error('缺少 Playwright 运行环境。请先安装 playwright，并执行 npx playwright install chromium');
  }
}

export async function runBrowserAutomation(options: BrowserAutomationOptions): Promise<string> {
  const playwright = await (options.loadPlaywright ? options.loadPlaywright() : loadPlaywright());
  const browserTarget = options.browser || 'chrome';
  const guard = new SensitiveOperationGuard(options.safetyConfig);
  const startup = await buildBrowserAutomationStartupOptions(options, browserTarget);
  let browser: PlaywrightBrowser | undefined;
  let context: PlaywrightBrowserContext | undefined;
  let temporaryUserDataDir: string | undefined;
  let page: PlaywrightPage;
  let userscriptEnabled = options.userscripts?.enabled !== false;

  try {
    if (startup.usePersistentContext) {
      context = await playwright.chromium.launchPersistentContext(startup.userDataDir, startup.launchOptions);
      temporaryUserDataDir = startup.temporaryUserDataDir;
      for (const script of startup.initScripts) {
        await context.addInitScript(script);
      }
      page = context.pages()[0] || await context.newPage();
    } else {
      browser = await playwright.chromium.launch(startup.launchOptions);
      page = await browser.newPage();
      for (const script of startup.initScripts) {
        await page.addInitScript(script);
      }
    }

    const timeoutMs = Math.max(1000, options.timeoutMs ?? 15000);
    page.setDefaultTimeout(timeoutMs);

    const actionLogs: BrowserActionLog[] = [];
    await page.goto(normalizeUrl(options.url), { waitUntil: 'domcontentloaded' });
    await runBrowserAutomationPostLoadScripts(page, startup.pageScripts, startup.userscriptPageScripts);

    const initialPageText = await page.locator('body').first().innerText().catch(() => '');
    const pageAssessment = guard.checkPage({
      url: page.url(),
      title: await page.title(),
      visibleText: String(initialPageText || '').slice(0, 4000),
      interactiveSummary: [],
    });
    if (pageAssessment) {
      throw new BrowserSafetyInterruptionError(pageAssessment);
    }

    const actions = options.actions ?? [];
    for (const [index, action] of actions.entries()) {
      const actionAssessment = guard.checkAutomationAction(action, {
        url: page.url(),
        title: await page.title(),
        visibleText: String(initialPageText || '').slice(0, 4000),
        interactiveSummary: [],
      });
      if (actionAssessment) {
        throw new BrowserSafetyInterruptionError(actionAssessment);
      }

      const normalizedType = normalizeActionType(action.type);

      switch (normalizedType) {
        case 'goto': {
          const targetUrl = normalizeUrl(action.url || options.url);
          await page.goto(targetUrl, { waitUntil: action.waitUntil || 'domcontentloaded' });
          await runBrowserAutomationPostLoadScripts(page, startup.pageScripts, startup.userscriptPageScripts);
          actionLogs.push({ index, type: 'goto', url: targetUrl });
          break;
        }
        case 'click': {
          if (!action.selector) throw new Error(`第 ${index + 1} 个动作缺少 selector`);
          try {
            await page.locator(action.selector).first().click();
            actionLogs.push({ index, type: 'click', selector: action.selector });
          } catch (error) {
            const fallbackSelector = shouldFallbackSubmitClick(action.selector, error)
              ? resolveSubmitFallbackSelector(page.url(), action.selector)
              : null;
            if (!fallbackSelector) {
              throw error;
            }

            await page.locator(fallbackSelector).first().press('Enter');
            actionLogs.push({ index, type: 'click_fallback_press', selector: fallbackSelector });
          }
          break;
        }
        case 'fill': {
          if (!action.selector) throw new Error(`第 ${index + 1} 个动作缺少 selector`);
          await page.locator(action.selector).first().fill(action.value || '');
          actionLogs.push({ index, type: 'fill', selector: action.selector });
          break;
        }
        case 'press': {
          if (!action.selector) throw new Error(`第 ${index + 1} 个动作缺少 selector`);
          if (!action.key) throw new Error(`第 ${index + 1} 个动作缺少 key`);
          await page.locator(action.selector).first().press(action.key);
          actionLogs.push({ index, type: 'press', selector: action.selector });
          break;
        }
        case 'wait_for_selector':
        case 'waitforselector': {
          if (!action.selector) throw new Error(`第 ${index + 1} 个动作缺少 selector`);
          await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? timeoutMs });
          actionLogs.push({ index, type: 'wait_for_selector', selector: action.selector });
          break;
        }
        case 'wait':
        case 'wait_for_timeout':
        case 'waitfortimeout': {
          const delay = Math.max(0, action.timeoutMs ?? 1000);
          await page.waitForTimeout(delay);
          actionLogs.push({ index, type: 'wait' });
          break;
        }
        case 'extract_text':
        case 'extracttext': {
          const selector = action.selector || 'body';
          const text = (await page.locator(selector).first().innerText()).trim();
          actionLogs.push({ index, type: 'extract_text', selector, text });
          break;
        }
        case 'screenshot': {
          const outputPath = options.resolveOutputPath(action.path || path.join('browser', `screenshot-${Date.now()}-${index + 1}.png`));
          await fs.mkdir(path.dirname(outputPath), { recursive: true });
          await page.screenshot({ path: outputPath, fullPage: action.fullPage ?? true });
          actionLogs.push({ index, type: 'screenshot', outputPath });
          break;
        }
        case 'evaluate_script': {
          const script = action.script || action.value;
          if (!script?.trim()) {
            throw new Error(`第 ${index + 1} 个动作缺少 script`);
          }
          const result = await page.evaluate(executeBrowserAutomationScript, script);
          const validation = validateScriptResultContract(result, action.expectResult);
          const handling = resolveScriptResultValidationHandling(validation, options.expectResultMismatchStrategy, 'evaluate_script 动作返回值校验失败，');
          actionLogs.push({ index, type: 'evaluate_script', text: formatScriptActionLogText(result, validation), validation: handling.recordedValidation });
          break;
        }
        case 'call_userscript_api': {
          if (!action.api?.trim()) {
            throw new Error(`第 ${index + 1} 个动作缺少 api`);
          }
          const result = await page.evaluate(({ apiPath, args }) => {
            const runtime = globalThis as Record<string, unknown>;
            const segments = String(apiPath || '').split('.').map(item => item.trim()).filter(Boolean);
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
            return (target as (...input: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
          }, { apiPath: action.api, args: action.args || [] });
          const validation = validateScriptResultContract(result, action.expectResult);
          const handling = resolveScriptResultValidationHandling(validation, options.expectResultMismatchStrategy, `call_userscript_api(${action.api}) 返回值校验失败，`);
          actionLogs.push({ index, type: 'call_userscript_api', api: action.api, text: formatScriptActionLogText(result, validation), validation: handling.recordedValidation });
          break;
        }
        case 'toggle_userscript_mode': {
          userscriptEnabled = action.enabled ?? !userscriptEnabled;
          await page.evaluate((enabled: boolean) => {
            const runtime = globalThis as Record<string, unknown>;
            runtime.__AI_AGENT_USERSCRIPT_ENABLED__ = enabled;
            const bridge = (runtime.__AI_AGENT_BROWSER_RUNTIME ||= {}) as Record<string, unknown>;
            bridge.userscriptEnabled = enabled;
            return enabled;
          }, userscriptEnabled);
          actionLogs.push({ index, type: 'toggle_userscript_mode', text: userscriptEnabled ? 'on' : 'off' });
          break;
        }
        default:
          throw new Error(`不支持的浏览器动作: ${action.type}`);
      }
    }

    return JSON.stringify({
      browser: browserTarget,
      url: page.url(),
      title: await page.title(),
      keptOpen: options.keepOpen === true,
      actions: actionLogs,
    }, null, 2);
  } finally {
    if (options.keepOpen !== true) {
      if (context) {
        await context.close();
      } else if (browser) {
        await browser.close();
      }
      if (temporaryUserDataDir) {
        await fs.rm(temporaryUserDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

async function buildBrowserAutomationStartupOptions(options: BrowserAutomationOptions, browser: BrowserTarget): Promise<{
  launchOptions: Record<string, unknown>;
  usePersistentContext: boolean;
  userDataDir: string;
  temporaryUserDataDir?: string;
  initScripts: string[];
  pageScripts: string[];
  userscriptPageScripts: string[];
}> {
  const resolvedExtensions = (options.extensionPaths || []).map(item => resolveConfiguredPath(item, options));
  const usePersistentContext = Boolean(options.userDataDir?.trim()) || resolvedExtensions.length > 0;
  const { initScripts, pageScripts, userscriptPageScripts } = await loadConfiguredScripts(options);

  const launchOptions: Record<string, unknown> = {
    headless: resolvedExtensions.length > 0 ? false : options.headless !== false,
  };

  const explicitExecutablePath = options.executablePath?.trim();
  if (explicitExecutablePath) {
    launchOptions.executablePath = explicitExecutablePath;
  } else if (resolvedExtensions.length === 0) {
    if (browser === 'chromium') {
      const executablePath = resolveBrowserExecutable('chromium');
      if (executablePath) {
        launchOptions.executablePath = executablePath;
      }
    } else {
      const executablePath = resolveBrowserExecutable(browser);
      if (!executablePath) {
        const browserName = browser === 'chrome' ? 'Chrome' : 'Edge';
        throw new Error(`未找到可用的 ${browserName} 浏览器。可设置环境变量 AI_AGENT_BROWSER_PATH 或对应的浏览器路径变量后重试。`);
      }
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

  const configuredUserDataDir = options.userDataDir?.trim();
  if (configuredUserDataDir) {
    return {
      launchOptions,
      usePersistentContext: true,
      userDataDir: resolveConfiguredPath(configuredUserDataDir, options),
      initScripts,
      pageScripts,
      userscriptPageScripts,
    };
  }

  const temporaryUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-browser-'));
  return {
    launchOptions,
    usePersistentContext: true,
    userDataDir: temporaryUserDataDir,
    temporaryUserDataDir,
    initScripts,
    pageScripts,
    userscriptPageScripts,
  };
}

async function loadConfiguredScripts(options: BrowserAutomationOptions): Promise<{ initScripts: string[]; pageScripts: string[]; userscriptPageScripts: string[] }> {
  const userscripts = options.userscripts || {};
  const initPathScripts = await loadScriptContents(options.initScriptPaths || [], options);
  const pagePathScripts = await loadScriptContents(options.pageScriptPaths || [], options);
  const userscriptPathScripts = await loadScriptContents(userscripts.paths || [], options);
  const userscriptInline = (userscripts.inline || []).map(script => script.trim()).filter(Boolean);
  const runtimeBridgeScript = buildBrowserAutomationRuntimeBridge(userscripts.enabled !== false);

  const initScripts = [
    runtimeBridgeScript,
    ...(options.initScripts || []),
    ...initPathScripts,
    ...(userscripts.runAt === 'document-start'
      ? [...userscriptPathScripts, ...userscriptInline].map(script => wrapUserscriptSource(script))
      : []),
  ].map(script => script.trim()).filter(Boolean);

  const pageScripts = [
    ...(options.pageScripts || []),
    ...pagePathScripts,
  ].map(script => script.trim()).filter(Boolean);

  const userscriptPageScripts = userscripts.runAt !== 'document-start'
    ? [...userscriptPathScripts, ...userscriptInline].map(script => wrapUserscriptSource(script))
    : [];

  return { initScripts, pageScripts, userscriptPageScripts };
}

async function loadScriptContents(inputPaths: string[], options: BrowserAutomationOptions): Promise<string[]> {
  return Promise.all(
    inputPaths
      .map(value => value.trim())
      .filter(Boolean)
      .map(value => fs.readFile(resolveConfiguredPath(value, options), 'utf-8')),
  );
}

async function runBrowserAutomationPostLoadScripts(page: PlaywrightPage, pageScripts: string[], userscriptPageScripts: string[]): Promise<void> {
  for (const script of pageScripts) {
    await page.evaluate(executeBrowserAutomationScript, script);
  }

  for (const script of userscriptPageScripts) {
    await page.evaluate(executeBrowserAutomationScript, script);
  }
}

function buildBrowserAutomationRuntimeBridge(enabled: boolean): string {
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

function executeBrowserAutomationScript(source: string): unknown {
  const runtime = globalThis as unknown as { eval: (code: string) => unknown };
  return runtime.eval(source);
}

function buildChromiumExtensionArgs(extensionPaths: string[]): string[] {
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

function resolveConfiguredPath(inputPath: string, options: BrowserAutomationOptions): string {
  return resolveUserPath(inputPath, {
    workspace: options.workspace || process.cwd(),
    appBaseDir: options.appBaseDir,
    artifactOutputDir: options.artifactOutputDir,
    documentOutputDir: options.documentOutputDir,
  });
}