import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

export type BrowserTarget = 'chrome' | 'edge' | 'chromium';

export type BrowserAutomationAction = {
  type: string;
  selector?: string;
  value?: string;
  key?: string;
  url?: string;
  timeoutMs?: number;
  path?: string;
  fullPage?: boolean;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
};

export interface BrowserAutomationOptions {
  url: string;
  actions?: BrowserAutomationAction[];
  browser?: BrowserTarget;
  headless?: boolean;
  keepOpen?: boolean;
  timeoutMs?: number;
  resolveOutputPath: (requestedPath?: string) => string;
}

interface BrowserActionLog {
  index: number;
  type: string;
  selector?: string;
  url?: string;
  outputPath?: string;
  text?: string;
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

function resolvePlaywrightLaunchOptions(browser: BrowserTarget, headless: boolean): Record<string, unknown> {
  if (browser === 'chromium') {
    const executablePath = resolveBrowserExecutable('chromium');
    return executablePath ? { headless, executablePath } : { headless };
  }

  const executablePath = resolveBrowserExecutable(browser);
  if (!executablePath) {
    const browserName = browser === 'chrome' ? 'Chrome' : 'Edge';
    throw new Error(`未找到可用的 ${browserName} 浏览器。可设置环境变量 AI_AGENT_BROWSER_PATH 或对应的浏览器路径变量后重试。`);
  }

  return {
    headless,
    executablePath,
  };
}

async function loadPlaywright(): Promise<{ chromium: { launch: (options: Record<string, unknown>) => Promise<any> } }> {
  try {
    const module = await import('playwright');
    return module as unknown as { chromium: { launch: (options: Record<string, unknown>) => Promise<any> } };
  } catch {
    throw new Error('缺少 Playwright 运行环境。请先安装 playwright，并执行 npx playwright install chromium');
  }
}

export async function runBrowserAutomation(options: BrowserAutomationOptions): Promise<string> {
  const playwright = await loadPlaywright();
  const browserTarget = options.browser || 'chrome';
  const browser = await playwright.chromium.launch(resolvePlaywrightLaunchOptions(browserTarget, options.headless !== false));
  const page = await browser.newPage();

  try {
    const timeoutMs = Math.max(1000, options.timeoutMs ?? 15000);
    page.setDefaultTimeout(timeoutMs);

    const actionLogs: BrowserActionLog[] = [];
    await page.goto(normalizeUrl(options.url), { waitUntil: 'domcontentloaded' });

    const actions = options.actions ?? [];
    for (const [index, action] of actions.entries()) {
      const normalizedType = normalizeActionType(action.type);

      switch (normalizedType) {
        case 'goto': {
          const targetUrl = normalizeUrl(action.url || options.url);
          await page.goto(targetUrl, { waitUntil: action.waitUntil || 'domcontentloaded' });
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
      await browser.close();
    }
  }
}