import chalk from 'chalk';

export type ContentViolation = 
  | 'profanity' 
  | 'illegal' 
  | 'pornographic'
  | 'violence'
  | 'hate_speech'
  | 'spam';

export interface ModerationResult {
  isClean: boolean;
  violations: ContentViolation[];
  warnings: string[];
  sanitized?: string;
}

export interface ModerationConfig {
  strictMode: boolean;
  warnOnViolation: boolean;
  blockOnViolation: boolean;
  allowedLanguages: string[];
}

const PROFANITY_PATTERNS = [
  /\b(傻逼|智障|脑残|废物|垃圾|贱人|狗东西|滚蛋|他妈的|操|艹|肏)\b/gi,
  /\b(shit|fuck|damn|ass|hell|bitch|idiot|stupid|dumb)\b/gi,
];

const ILLEGAL_PATTERNS = [
  /hack|crack|pirate|盗刷|破解|外挂|作弊/gi,
  /毒品|吸毒|制毒|贩毒|drug/gi,
  /假币|伪造|仿造|counterfeit/gi,
  /赌博|博彩|lottery.*fraud/gi,
];

const PORN_PATTERNS = [
  /色情|黄片|成人|av\s*女优|nasty|xxx|porn|sexy.*girl/gi,
  /援交|约炮|一夜情|sugar.*baby|sugar.*daddy/gi,
];

const VIOLENCE_PATTERNS = [
  /杀人|谋杀|伤害|暴力|虐待/i,
  /恐怖分子|炸弹|炸药|武器/i,
  /自杀|自残/i,
];

const HATE_SPEECH_PATTERNS = [
  /种族歧视|性别歧视|地域歧视/i,
  /纳粹|极端|恐怖/gi,
];

export class ContentModerator {
  private config: ModerationConfig;
  private warningHistory: Map<string, number> = new Map();

  constructor(config?: Partial<ModerationConfig>) {
    this.config = {
      strictMode: config?.strictMode ?? false,
      warnOnViolation: config?.warnOnViolation ?? true,
      blockOnViolation: config?.blockOnViolation ?? false,
      allowedLanguages: config?.allowedLanguages ?? ['zh-CN', 'en'],
    };
  }

  moderate(content: string): ModerationResult {
    const violations: ContentViolation[] = [];
    const warnings: string[] = [];
    let sanitized = content;

    for (const pattern of PROFANITY_PATTERNS) {
      if (pattern.test(content)) {
        violations.push('profanity');
        warnings.push('检测到不文明用语，请注意文明交流');
        sanitized = sanitized.replace(pattern, '***');
        pattern.lastIndex = 0;
      }
    }

    for (const pattern of ILLEGAL_PATTERNS) {
      if (pattern.test(content)) {
        violations.push('illegal');
        warnings.push('检测到可能违法内容，系统已记录');
        break;
      }
    }

    for (const pattern of PORN_PATTERNS) {
      if (pattern.test(content)) {
        violations.push('pornographic');
        warnings.push('检测到不适宜内容，请理性交流');
        break;
      }
    }

    for (const pattern of VIOLENCE_PATTERNS) {
      if (pattern.test(content)) {
        violations.push('violence');
        warnings.push('检测到暴力相关内容，请保持理性');
        break;
      }
    }

    for (const pattern of HATE_SPEECH_PATTERNS) {
      if (pattern.test(content)) {
        violations.push('hate_speech');
        warnings.push('检测到歧视性言论，请尊重他人');
        break;
      }
    }

    const isClean = violations.length === 0;

    return {
      isClean,
      violations,
      warnings,
      sanitized: violations.length > 0 ? sanitized : undefined,
    };
  }

  moderateUserInput(content: string): { allowed: boolean; message?: string; sanitized?: string } {
    const result = this.moderate(content);

    if (result.isClean) {
      return { allowed: true };
    }

    const severity = this.getSeverity(result.violations);

    if (this.config.blockOnViolation || severity === 'high') {
      return {
        allowed: false,
        message: this.getBlockMessage(result.violations),
      };
    }

    if (this.config.warnOnViolation) {
      return {
        allowed: true,
        message: result.warnings.join('\n'),
        sanitized: result.sanitized,
      };
    }

    return { allowed: true };
  }

  moderateAIResponse(content: string): { allowed: boolean; sanitized?: string } {
    const result = this.moderate(content);

    if (result.isClean) {
      return { allowed: true };
    }

    const severity = this.getSeverity(result.violations);

    if (severity === 'high') {
      return {
        allowed: false,
      };
    }

    return {
      allowed: true,
      sanitized: result.sanitized || content,
    };
  }

  private getSeverity(violations: ContentViolation[]): 'low' | 'medium' | 'high' {
    if (violations.includes('illegal') || violations.includes('pornographic')) {
      return 'high';
    }
    if (violations.includes('violence') || violations.includes('hate_speech')) {
      return 'medium';
    }
    return 'low';
  }

  private getBlockMessage(violations: ContentViolation[]): string {
    if (violations.includes('illegal')) {
      return chalk.red('⚠️ 检测到违法内容，已被拦截。请勿传播或实施违法行为。');
    }
    if (violations.includes('pornographic')) {
      return chalk.red('⚠️ 检测到不适宜内容，请理性交流。');
    }
    if (violations.includes('profanity')) {
      return chalk.yellow('⚠️ 检测到不文明用语，请注意文明交流。');
    }
    return chalk.yellow('⚠️ 检测到不当内容，已被拦截。');
  }

  recordWarning(content: string): void {
    const hash = this.simpleHash(content);
    const count = (this.warningHistory.get(hash) || 0) + 1;
    this.warningHistory.set(hash, count);

    if (count >= 3) {
      console.log(chalk.red('\n⚠️ 您已多次发送类似内容，请注意交流方式。\n'));
    }
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString();
  }

  getWarningCount(): number {
    return this.warningHistory.size;
  }

  resetWarnings(): void {
    this.warningHistory.clear();
  }

  printWarningMessage(violations: ContentViolation[]): void {
    console.log(chalk.yellow('\n📝 温馨提示：'));
    
    if (violations.includes('profanity')) {
      console.log(chalk.yellow('  • 请使用文明用语，一起维护良好的交流环境'));
    }
    if (violations.includes('illegal')) {
      console.log(chalk.yellow('  • 请勿传播或讨论违法内容'));
    }
    if (violations.includes('pornographic')) {
      console.log(chalk.yellow('  • 请保持理性，专注有意义的话题'));
    }
    if (violations.includes('violence')) {
      console.log(chalk.yellow('  • 请保持冷静，远离暴力内容'));
    }
    if (violations.includes('hate_speech')) {
      console.log(chalk.yellow('  • 请尊重他人，避免歧视性言论'));
    }
    
    console.log(chalk.gray('  如有问题或建议，欢迎反馈给我们！\n'));
  }
}

export const contentModerator = new ContentModerator();

export function createModerator(config?: Partial<ModerationConfig>): ContentModerator {
  return new ContentModerator(config);
}
