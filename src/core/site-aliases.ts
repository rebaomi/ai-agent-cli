interface SiteAlias {
  pattern: RegExp;
  url: string;
}

const SITE_ALIASES: SiteAlias[] = [
  { pattern: /github/i, url: 'https://github.com' },
  { pattern: /gitlab/i, url: 'https://gitlab.com' },
  { pattern: /google|谷歌/i, url: 'https://www.google.com' },
  { pattern: /百度/i, url: 'https://www.baidu.com' },
  { pattern: /豆包|doubao/i, url: 'https://www.doubao.com/chat/' },
  { pattern: /网易\s*buff|\bbuff\b/i, url: 'https://buff.163.com' },
  { pattern: /飞书|lark/i, url: 'https://www.feishu.cn' },
  { pattern: /知乎/i, url: 'https://www.zhihu.com' },
  { pattern: /(?:bilibili|哔哩哔哩|b站)/i, url: 'https://www.bilibili.com' },
  { pattern: /掘金/i, url: 'https://juejin.cn' },
  { pattern: /v2ex/i, url: 'https://www.v2ex.com' },
  { pattern: /steam/i, url: 'https://store.steampowered.com' },
];

export function resolveKnownWebsiteUrl(input: string): string | null {
  for (const alias of SITE_ALIASES) {
    if (alias.pattern.test(input)) {
      return alias.url;
    }
  }

  return null;
}