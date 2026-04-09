export class DirectActionRoutingSupport {
  normalizePath(rawPath: string): string {
    return rawPath.replace(/^['"]|['"]$/g, '');
  }

  splitExplicitPaths(input: string): string[] {
    return input
      .split(/\s*(?:,|，|、|\s和\s|\s及\s|\s以及\s|\sand\s)\s*/i)
      .map(part => this.stripDirectorySuffix(this.normalizePath(part.trim())))
      .filter(part => this.looksLikePath(part));
  }

  stripDirectorySuffix(value: string): string {
    return value.replace(/\s*(?:目录|文件夹)$/i, '').trim();
  }

  normalizeSearchQuery(value: string): string {
    return value
      .replace(/^(?:关键词|关键字|内容|文本)\s*[：:]?\s*/i, '')
      .replace(/^['"“”]|['"“”]$/g, '')
      .trim();
  }

  normalizeGlobPattern(value: string): string {
    const normalized = value.trim().replace(/^\./, '');
    if (!normalized) {
      return '';
    }

    if (normalized.includes('*')) {
      return normalized.startsWith('**/') ? normalized : `**/${normalized}`;
    }

    return `**/*.${normalized}`;
  }

  private looksLikePath(value: string): boolean {
    if (!value) {
      return false;
    }

    return /[\\/]/.test(value)
      || /\.[a-z0-9]{1,8}$/i.test(value)
      || /^(?:\.\.?)(?:[\\/]|$)/.test(value)
      || /^[a-z]:[\\/]/i.test(value);
  }
}
