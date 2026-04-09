import { spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

export async function writePdfDocument(outputPath: string, text: string, title?: string): Promise<void> {
  const browsers = findHeadlessBrowsers();
  if (browsers.length === 0) {
    throw new Error('未找到可用的 Chromium/Edge 浏览器，无法生成 PDF。');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-cli-pdf-'));
  const htmlPath = path.join(tempDir, 'document.html');
  const profileDir = path.join(tempDir, 'browser-profile');

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(htmlPath, buildHtml(text, title), 'utf-8');
    await printWithAvailableBrowsers(browsers, htmlPath, outputPath, profileDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildHtml(text: string, title?: string): string {
  const safeTitle = escapeHtml((title || 'exported document').trim() || 'exported document');
  const body = text
    .replace(/\r/g, '')
    .split('\n')
    .map(line => `<p>${escapeHtml(line) || '&nbsp;'}</p>`)
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  <style>
    @page { size: A4; margin: 18mm 16mm; }
    body {
      font-family: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif;
      color: #111;
      line-height: 1.7;
      font-size: 14px;
      white-space: normal;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    p {
      margin: 0 0 8px;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  ${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findHeadlessBrowsers(): string[] {
  const envCandidates = [
    process.env.AI_AGENT_CLI_PDF_BROWSER,
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  const pathCandidates = process.env.PATH
    ? process.env.PATH.split(path.delimiter).flatMap(dir => [
        path.join(dir, 'msedge.exe'),
        path.join(dir, 'chrome.exe'),
        path.join(dir, 'chromium.exe'),
      ])
    : [];

  const commonCandidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];

  const uniqueCandidates = new Set<string>();
  for (const candidate of [...envCandidates, ...pathCandidates, ...commonCandidates]) {
    if (existsSync(candidate)) {
      uniqueCandidates.add(candidate);
    }
  }

  return [...uniqueCandidates];
}

async function printWithAvailableBrowsers(browserPaths: string[], htmlPath: string, outputPath: string, profileDir: string): Promise<void> {
  const failures: string[] = [];

  for (const browserPath of browserPaths) {
    try {
      await runHeadlessPrint(browserPath, htmlPath, outputPath, profileDir);
      await ensurePdfCreated(outputPath);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${browserPath}: ${message}`);
    }
  }

  throw new Error(failures.join('\n'));
}

async function runHeadlessPrint(browserPath: string, htmlPath: string, outputPath: string, profileDir: string): Promise<void> {
  const fileUrl = pathToFileURL(htmlPath).href;
  const baseArgs = [
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--enable-local-file-accesses',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=3000',
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${outputPath}`,
    fileUrl,
  ];

  const headlessVariants = ['--headless=new', '--headless'];
  const failures: string[] = [];

  for (const headlessArg of headlessVariants) {
    try {
      await spawnHeadlessPrint(browserPath, [headlessArg, ...baseArgs]);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${headlessArg}: ${message}`);
    }
  }

  throw new Error(failures.join('\n'));
}

async function spawnHeadlessPrint(browserPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('浏览器打印 PDF 超时')); 
    }, 15000);
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `浏览器打印 PDF 失败，退出码 ${code ?? 'unknown'}`));
        return;
      }
      resolve();
    });
  });
}

async function ensurePdfCreated(outputPath: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const stats = await fs.stat(outputPath);
      if (stats.size > 0) {
        return;
      }
    } catch {
      // Ignore transient missing-file errors while the browser flushes the PDF.
    }

    await new Promise(resolve => setTimeout(resolve, 150));
  }

  throw new Error('浏览器进程已退出，但未检测到生成的 PDF 文件。');
}