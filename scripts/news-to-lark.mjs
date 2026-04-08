#!/usr/bin/env node

import { exec, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

function parseArgs(argv) {
  const args = {
    type: 'morning',
    limit: 10,
    title: '',
    keyword: '',
    userId: '',
    chatId: '',
    save: false,
    dryRun: false,
    timezone: 'Asia/Shanghai',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case '--type':
        if (next) {
          args.type = next;
          index += 1;
        }
        break;
      case '--limit':
        if (next) {
          const limit = Number(next);
          if (Number.isFinite(limit) && limit > 0) {
            args.limit = Math.floor(limit);
          }
          index += 1;
        }
        break;
      case '--keyword':
        if (next) {
          args.keyword = next;
          index += 1;
        }
        break;
      case '--title':
        if (next) {
          args.title = next;
          index += 1;
        }
        break;
      case '--user-id':
        if (next) {
          args.userId = next;
          index += 1;
        }
        break;
      case '--chat-id':
        if (next) {
          args.chatId = next;
          index += 1;
        }
        break;
      case '--timezone':
        if (next) {
          args.timezone = next;
          index += 1;
        }
        break;
      case '--save':
        args.save = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function showHelp() {
  console.log(`Usage:
  node scripts/news-to-lark.mjs --type morning --user-id ou_xxx
  node scripts/news-to-lark.mjs --type hot --limit 8 --chat-id oc_xxx
  node scripts/news-to-lark.mjs --type search --keyword AI --chat-id oc_xxx --save

Options:
  --type <morning|evening|hot|search>   News type, default morning
  --limit <n>                           Hot/search limit, default 10
  --keyword <text>                      Required when type=search
  --title <text>                        Custom message title
  --user-id <ou_xxx>                    Send as DM to a user
  --chat-id <oc_xxx>                    Send to a group chat
  --save                                Also save the news text locally
  --dry-run                             Print the outgoing message without sending
  --timezone <tz>                       Timezone label for the header, default Asia/Shanghai
`);
}

function getCommandBinary(baseName) {
  if (process.platform === 'win32') {
    return `${baseName}.cmd`;
  }
  return baseName;
}

async function runCommand(command, args) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quoted = [command, ...args].map(quoteWindowsArg).join(' ');
    return execAsync(quoted, {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  }

  return execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function quoteWindowsArg(value) {
  if (!/[\s"]/g.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

async function fetchNews(options) {
  const npxBin = getCommandBinary('npx');
  switch (options.type) {
    case 'morning':
      return (await runCommand(npxBin, ['@tencentnews/cli', 'morning'])).stdout.trim();
    case 'evening':
      return (await runCommand(npxBin, ['@tencentnews/cli', 'evening'])).stdout.trim();
    case 'hot':
      return (await runCommand(npxBin, ['@tencentnews/cli', 'hot', '--limit', String(options.limit)])).stdout.trim();
    case 'search':
      if (!options.keyword) {
        throw new Error('type=search 时必须提供 --keyword');
      }
      return (await runCommand(npxBin, ['@tencentnews/cli', 'search', options.keyword, '--limit', String(options.limit)])).stdout.trim();
    default:
      throw new Error(`不支持的新闻类型: ${options.type}`);
  }
}

function formatTimestamp(timezone) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function defaultTitle(options) {
  switch (options.type) {
    case 'morning':
      return '今日早报';
    case 'evening':
      return '今日晚报';
    case 'hot':
      return `今日热点新闻 Top ${options.limit}`;
    case 'search':
      return `新闻搜索: ${options.keyword}`;
    default:
      return '新闻推送';
  }
}

function buildMessage(title, body, timezone) {
  const header = `${title}\n时间: ${formatTimestamp(timezone)}\n`;
  const maxBodyLength = 3600;
  const safeBody = body.length > maxBodyLength
    ? `${body.slice(0, maxBodyLength)}\n\n[内容过长，已截断]`
    : body;
  return `${header}\n${safeBody}`;
}

function buildOutputPath(options) {
  const dir = path.join(os.homedir(), '.ai-agent-cli', 'outputs', 'tencent-news');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = options.type === 'search' && options.keyword
    ? `search-${options.keyword.replace(/[^a-zA-Z0-9_-]+/g, '-')}`
    : options.type;
  return path.join(dir, `${stamp}-${suffix}.txt`);
}

async function maybeSaveOutput(options, message) {
  if (!options.save) {
    return null;
  }

  const outputPath = buildOutputPath(options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${message}\n`, 'utf-8');
  return outputPath;
}

async function sendToLark(options, text) {
  const targetArgs = options.chatId
    ? ['--chat-id', options.chatId]
    : ['--user-id', options.userId];

  const larkBin = process.env.LARK_CLI_BIN || getCommandBinary('lark-cli');
  const args = ['im', '+messages-send', ...targetArgs, '--text', text, '--as', 'bot'];
  return runCommand(larkBin, args);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    showHelp();
    return;
  }

  if (!options.userId && !options.chatId) {
    throw new Error('必须提供 --user-id 或 --chat-id 其中之一');
  }

  if (options.userId && options.chatId) {
    throw new Error('--user-id 和 --chat-id 只能二选一');
  }

  const title = options.title || defaultTitle(options);
  const news = await fetchNews(options);
  if (!news) {
    throw new Error('新闻内容为空');
  }

  const message = buildMessage(title, news, options.timezone);
  const savedPath = await maybeSaveOutput(options, message);

  if (options.dryRun) {
    console.log(message);
    if (savedPath) {
      console.log(`\nSaved to: ${savedPath}`);
    }
    return;
  }

  const result = await sendToLark(options, message);
  console.log(result.stdout.trim() || '消息已发送');
  if (result.stderr?.trim()) {
    console.error(result.stderr.trim());
  }
  if (savedPath) {
    console.log(`Saved to: ${savedPath}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});