import * as path from 'path';
import { promises as fs } from 'fs';
import type { DirectActionResult } from '../../direct-action-router.js';
import type { DirectActionHandler } from '../request-handler.js';
import type { ExternalSearchRuntime } from '../runtime-context.js';

export class ExternalSearchHandler implements DirectActionHandler {
  readonly name = 'external-search';

  constructor(private readonly runtime: ExternalSearchRuntime) {}

  canHandle(input: string): boolean {
    return /(百度|baidu|小红书|红书|xiaohongshu|redbook|xhs)/i.test(input);
  }

  async handle(input: string): Promise<DirectActionResult | null> {
    const baiduResult = await this.tryBaiduSearchWorkflow(input);
    if (baiduResult) {
      return baiduResult;
    }

    const xiaohongshuResult = await this.tryXiaohongshuSearchWorkflow(input);
    if (xiaohongshuResult) {
      return xiaohongshuResult;
    }

    return null;
  }

  private async tryBaiduSearchWorkflow(input: string): Promise<DirectActionResult | null> {
    if (!/(百度|baidu)/i.test(input) || !/(搜索|搜一下|搜|查询|查一下|查|百科|秒懂|智能搜索|ai搜索|AI搜索)/i.test(input)) {
      return null;
    }

    const parsed = this.parseBaiduSearchRequest(input);
    if (!parsed.query) {
      return {
        handled: true,
        title: '[Direct baidu_search]',
        output: '已识别为百度搜索请求，但缺少搜索关键词。可直接说“百度搜索 AI 智能体”或“百度百科 人工智能”。',
        isError: true,
      };
    }

    const scriptPath = path.join(this.getExternalSkillsRoot(), 'baidu-search', 'scripts', 'search.py');
    try {
      await fs.access(scriptPath);
    } catch {
      return {
        handled: true,
        title: '[Direct baidu_search]',
        output: '未检测到 baidu-search skill。可先安装百度搜索 skill 后再试。',
        isError: true,
      };
    }

    const apiKeyStatus = await this.getBaiduSkillApiKeyStatus();
    if (!apiKeyStatus.configured) {
      return {
        handled: true,
        title: '[Direct baidu_search]',
        output: `已检测到 baidu-search skill，但尚未配置百度千帆 API Key。请先编辑 ${apiKeyStatus.configPath}，填入 api_key。`,
        isError: true,
      };
    }

    const commandParts = [
      'python',
      this.quoteShellArg(scriptPath),
      this.quoteShellArg(parsed.query),
      '--json',
      '--api-type',
      parsed.apiType,
    ];

    if (parsed.limit) {
      commandParts.push('--limit', String(parsed.limit));
    }

    if (parsed.recency) {
      commandParts.push('--recency', parsed.recency);
    }

    if (parsed.sites.length > 0) {
      commandParts.push('--sites', ...parsed.sites.map(site => this.quoteShellArg(site)));
    }

    return this.runtime.executeBuiltInTool('execute_command', {
      command: commandParts.join(' '),
      timeout: 30000,
    }, '[Direct baidu_search]');
  }

  private async tryXiaohongshuSearchWorkflow(input: string): Promise<DirectActionResult | null> {
    if (!/(小红书|红书|xiaohongshu|redbook|xhs)/i.test(input) || !/(搜索|搜|检索|查|调研|总结|汇总)/i.test(input)) {
      return null;
    }

    const scriptPath = path.resolve(process.cwd(), 'scripts', 'xiaohongshu-extract.mjs');
    try {
      await fs.access(scriptPath);
    } catch {
      return {
        handled: true,
        title: '[Direct xiaohongshu_search]',
        output: '未检测到本地小红书抓取脚本 scripts/xiaohongshu-extract.mjs。',
        isError: true,
      };
    }

    const parsed = this.parseXiaohongshuSearchRequest(input);
    if (!parsed.keyword) {
      return {
        handled: true,
        title: '[Direct xiaohongshu_search]',
        output: '已识别为小红书搜索请求，但缺少关键词。可直接说“小红书搜索 AI 智能体 方案并总结”。',
        isError: true,
      };
    }

    const outputDir = this.runtime.resolveOutputArtifactPath(path.join('xiaohongshu', this.sanitizeSearchArtifactName(parsed.keyword)));
    return this.runtime.executeBuiltInTool('execute_command', {
      command: [
        'node',
        this.quoteShellArg(scriptPath),
        this.quoteShellArg(parsed.keyword),
        String(parsed.maxPosts),
        this.quoteShellArg(outputDir),
      ].join(' '),
      timeout: 0,
    }, '[Direct xiaohongshu_search]');
  }

  private getExternalSkillsRoot(): string {
    const overridden = process.env.AI_AGENT_CLI_EXTERNAL_SKILLS_DIR?.trim();
    if (overridden) {
      return overridden;
    }
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    return path.join(homeDir, '.agents', 'skills');
  }

  private async getBaiduSkillApiKeyStatus(): Promise<{ configured: boolean; configPath: string }> {
    const configPath = path.join(this.getExternalSkillsRoot(), 'baidu-search', 'scripts', 'config.json');
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as { api_key?: string };
      const apiKey = typeof parsed.api_key === 'string' ? parsed.api_key.trim() : '';
      return {
        configured: Boolean(apiKey) && !/YOUR_API_KEY_HERE/i.test(apiKey),
        configPath,
      };
    } catch {
      return { configured: false, configPath };
    }
  }

  private quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private sanitizeSearchArtifactName(value: string): string {
    return value
      .replace(/[<>:"/\\|?*]+/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 80)
      .replace(/^-+|-+$/g, '') || 'query';
  }

  private parseBaiduSearchRequest(input: string): {
    query: string;
    apiType: 'web_search' | 'baike' | 'miaodong_baike' | 'ai_chat';
    limit?: number;
    recency?: 'week' | 'month' | 'semiyear' | 'year';
    sites: string[];
  } {
    const apiType = /秒懂百科|视频百科/i.test(input)
      ? 'miaodong_baike'
      : /百度百科|\b百科\b/i.test(input)
        ? 'baike'
        : /(ai搜索|AI搜索|智能搜索|百度ai|百度AI|ai回答|AI回答)/i.test(input)
          ? 'ai_chat'
          : 'web_search';

    const limitMatch = input.match(/(?:前|top\s*)?(\d{1,2})\s*(?:条|个|篇)/i);
    const limit = limitMatch?.[1] ? Number(limitMatch[1]) : undefined;

    const recency: 'week' | 'month' | 'semiyear' | 'year' | undefined = /最近一周|过去一周|本周/i.test(input)
      ? 'week'
      : /最近一个月|过去一个月|本月/i.test(input)
        ? 'month'
        : /最近半年|过去半年/i.test(input)
          ? 'semiyear'
          : /最近一年|过去一年|近一年/i.test(input)
            ? 'year'
            : undefined;

    const sites = Array.from(new Set(Array.from(input.matchAll(/site:([a-z0-9.-]+\.[a-z]{2,})/gi)).map(match => match[1] || '').filter(Boolean)));

    const query = input
      .replace(/site:[a-z0-9.-]+\.[a-z]{2,}/gi, ' ')
      .replace(/(?:最近一周|过去一周|本周|最近一个月|过去一个月|本月|最近半年|过去半年|最近一年|过去一年|近一年)/gi, ' ')
      .replace(/(?:前|top\s*)?\d{1,2}\s*(?:条|个|篇)/gi, ' ')
      .replace(/请|帮我|麻烦|一下|用|通过/gi, ' ')
      .replace(/百度百科|秒懂百科|百度ai搜索|百度AI搜索|百度智能搜索|百度搜索|百度搜|百度查|百度一下|百度|搜索|搜一下|搜|查询|查一下|查/gi, ' ')
      .replace(/[：:，,。！？!?.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return { query, apiType, limit, recency, sites };
  }

  private parseXiaohongshuSearchRequest(input: string): { keyword: string; maxPosts: number } {
    const limitMatch = input.match(/(?:前|top\s*)?(\d{1,2})\s*(?:条|个|篇|帖子|笔记)/i);
    const maxPosts = limitMatch?.[1] ? Math.max(1, Math.min(50, Number(limitMatch[1]))) : 10;
    const keyword = input
      .replace(/(?:前|top\s*)?\d{1,2}\s*(?:条|个|篇|帖子|笔记)/gi, ' ')
      .replace(/请|帮我|麻烦|一下|用|通过|给我|我想|需要/gi, ' ')
      .replace(/小红书|红书|xiaohongshu|redbook|xhs|搜索|搜一下|搜|检索|查一下|查|调研|总结|汇总|分析/gi, ' ')
      .replace(/[：:，,。！？!?.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { keyword, maxPosts };
  }
}