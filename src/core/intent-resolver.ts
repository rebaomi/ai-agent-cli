import type { LLMProviderInterface } from '../llm/types.js';

export type IntentName = 'browser.search' | 'obsidian.note' | 'unknown';

export interface ResolvedIntent {
  name: IntentName;
  confidence: number;
  slots: Record<string, string | boolean>;
  source: 'llm' | 'fallback';
}

const INTENT_RESOLUTION_PROMPT = `你是一个意图识别器。请把用户输入识别成以下三类之一，并只返回 JSON：
1. browser.search
2. obsidian.note
3. unknown

返回格式：
{
  "name": "browser.search | obsidian.note | unknown",
  "confidence": 0.0,
  "slots": {
    "engine": "google | baidu | doubao",
    "query": "搜索关键词",
    "action": "read | search | write | append | update | create | list",
    "readonly": true
  }
}

规则：
- browser.search 用于“打开谷歌/百度/豆包并输入关键词”这类浏览器站内搜索或提问任务
- obsidian.note 仅用于 Obsidian / vault / 笔记 / 笔记库相关读写搜索任务
- 不确定时返回 unknown
- 只返回 JSON，不要解释`;

export class IntentResolver {
  constructor(private readonly llm?: Pick<LLMProviderInterface, 'generate'>) {}

  async resolve(input: string): Promise<ResolvedIntent> {
    const trimmed = input.trim();
    if (!trimmed) {
      return this.createUnknownIntent();
    }

    const llmIntent = await this.resolveWithLLM(trimmed);
    if (llmIntent) {
      return llmIntent;
    }

    return this.resolveWithFallback(trimmed);
  }

  private async resolveWithLLM(input: string): Promise<ResolvedIntent | null> {
    if (!this.llm) {
      return null;
    }

    try {
      const response = await this.llm.generate([
        { role: 'system', content: INTENT_RESOLUTION_PROMPT },
        { role: 'user', content: input },
      ]);
      return this.parseIntentResponse(response, input);
    } catch {
      return null;
    }
  }

  private parseIntentResponse(response: string, originalInput: string): ResolvedIntent | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    const jsonText = (jsonMatch?.[1] ?? jsonMatch?.[2] ?? '').trim();
    if (!jsonText) {
      return null;
    }

    try {
      const parsed = JSON.parse(jsonText) as {
        name?: string;
        confidence?: number;
        slots?: Record<string, string | boolean>;
      };
      if (!parsed || typeof parsed.name !== 'string') {
        return null;
      }

      const normalizedName = parsed.name.trim();
      if (normalizedName !== 'browser.search' && normalizedName !== 'obsidian.note' && normalizedName !== 'unknown') {
        return null;
      }

      const resolvedIntent: ResolvedIntent = {
        name: normalizedName,
        confidence: typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
        slots: parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {},
        source: 'llm',
      };

      if (resolvedIntent.name === 'browser.search' && !this.isExplicitBrowserSearchRequest(originalInput, resolvedIntent.slots)) {
        return this.createUnknownIntent();
      }

      return resolvedIntent;
    } catch {
      return null;
    }
  }

  private resolveWithFallback(input: string): ResolvedIntent {
    const browserIntent = this.detectBrowserSearchIntent(input);
    if (browserIntent) {
      return browserIntent;
    }

    const obsidianIntent = this.detectObsidianNoteIntent(input);
    if (obsidianIntent) {
      return obsidianIntent;
    }

    return this.createUnknownIntent();
  }

  private detectBrowserSearchIntent(input: string): ResolvedIntent | null {
    const engine = /google|谷歌/i.test(input)
      ? 'google'
      : /百度/i.test(input)
        ? 'baidu'
        : /豆包|doubao/i.test(input)
          ? 'doubao'
        : '';
    if (!engine) {
      return null;
    }

    const queryPatterns = [
      /(?:输入|搜索|查找|查询)(?:关键词|关键字)?[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
      /(?:关键词|关键字)[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
      /(?:在)?(?:google|谷歌|百度|豆包|doubao)(?:上)?(?:搜索|查找|查询|提问|发问)[：: ]*["“”']?([^"“”'，。,\.\n]+)["“”']?/i,
    ];

    for (const pattern of queryPatterns) {
      const query = input.match(pattern)?.[1]?.trim();
      if (query) {
        return {
          name: 'browser.search',
          confidence: 0.96,
          slots: { engine, query },
          source: 'fallback',
        };
      }
    }

    if (/(搜索|查找|查询|输入).*(关键词|关键字)?/i.test(input)) {
      return {
        name: 'browser.search',
        confidence: 0.75,
        slots: { engine },
        source: 'fallback',
      };
    }

    return null;
  }

  private isExplicitBrowserSearchRequest(input: string, slots: Record<string, string | boolean>): boolean {
    const trimmed = input.trim();
    const hasExplicitEngine = /(google|谷歌|百度|豆包|doubao)/i.test(trimmed)
      || typeof slots.engine === 'string' && /^(google|baidu|doubao)$/i.test(slots.engine);
    const hasBrowserSearchVerb = /(?:打开|访问|进入|浏览|跳转到).*(?:google|谷歌|百度|豆包|doubao|搜索页|搜索页面|官网|网站|网页)|(?:在)?(?:google|谷歌|百度|豆包|doubao)(?:上)?(?:搜索|查找|查询|提问|发问)|(?:用|通过).*(?:google|谷歌|百度|豆包|doubao).*(?:搜索|查找|查询)|(?:google|谷歌|百度|豆包|doubao).*(?:输入|搜索|查找|查询)/i.test(trimmed);

    return hasExplicitEngine && hasBrowserSearchVerb;
  }

  private detectObsidianNoteIntent(input: string): ResolvedIntent | null {
    if (!/(obsidian|vault|笔记|笔记库|md文件|markdown)/i.test(input)) {
      return null;
    }

    const action = /(追加)/i.test(input)
      ? 'append'
      : /(写入|保存)/i.test(input)
        ? 'write'
        : /(更新|修改)/i.test(input)
          ? 'update'
          : /(创建|新建)/i.test(input)
            ? 'create'
            : /(搜索|查找)/i.test(input)
                ? 'search'
                : /(列出)/i.test(input)
                  ? 'list'
                : 'read';
    const readonly = !/(写入|保存|追加|更新|修改|创建|新建)/i.test(input);

    return {
      name: 'obsidian.note',
      confidence: 0.92,
      slots: { action, readonly },
      source: 'fallback',
    };
  }

  private createUnknownIntent(): ResolvedIntent {
    return {
      name: 'unknown',
      confidence: 0,
      slots: {},
      source: 'fallback',
    };
  }
}
