import type { BrowserAutomationAction } from '../../utils/browser-automation.js';
import type { BrowserAgentSafetyConfig, BrowserAgentSafetyDomainPolicy, BrowserAgentSafetyKeywordPolicy } from '../../types/index.js';
import type { BrowserActionProposal, BrowserAgentTask, BrowserPageDigest, BrowserSafetyInterruptionInfo } from '../domain/types.js';

type SensitiveCategory = 'financial' | 'privacy' | 'illegal';
type AssessmentStage = 'task' | 'request' | 'page' | 'action';

export interface SensitiveOperationAssessment extends BrowserSafetyInterruptionInfo {
  blocked: boolean;
}

interface KeywordRule {
  category: SensitiveCategory;
  stage: AssessmentStage[];
  keywords: RegExp[];
}

interface ResolvedSafetyPolicy {
  allowKeywords: Required<BrowserAgentSafetyKeywordPolicy>;
  blockKeywords: Required<BrowserAgentSafetyKeywordPolicy>;
  blockFinancialActions: boolean;
  blockPrivacyActions: boolean;
  blockIllegalActions: boolean;
  matchedPolicy?: string;
}

export class BrowserSafetyInterruptionError extends Error {
  override readonly name = 'BrowserSafetyInterruptionError';
  readonly errorType = 'browser_safety_abort' as const;
  readonly statusCode = 'BROWSER_SAFETY_ABORTED' as const;

  constructor(readonly assessment: SensitiveOperationAssessment) {
    super(assessment.reason);
  }
}

const GOAL_RULES: KeywordRule[] = [
  {
    category: 'financial',
    stage: ['task', 'request', 'action'],
    keywords: [
      /(?:帮我|替我|自动|执行|完成|操作).{0,12}(?:提现|提取现金|支付|付款|转账|汇款|打款|充值|下单|购买|结账|收款)/i,
      /(?:withdraw|cashout|pay|payment|checkout|transfer|wire transfer|send money)/i,
    ],
  },
  {
    category: 'privacy',
    stage: ['task', 'request', 'action'],
    keywords: [
      /(?:帮我|替我|自动|执行|完成|操作|填写|提交|上传).{0,16}(?:身份证|手机号|手机号码|验证码|短信码|邮箱|住址|地址|真实姓名|银行卡号|卡号|cvv|cvc|支付密码|登录密码|人脸|护照|证件)/i,
      /(?:enter|fill|submit|upload).{0,16}(?:password|otp|verification code|sms code|id card|identity|passport|bank card|credit card|cvv|cvc|address|email|phone)/i,
    ],
  },
  {
    category: 'illegal',
    stage: ['task', 'request', 'action', 'page'],
    keywords: [
      /(?:诈骗|洗钱|刷单|伪造|办假证|赌博|黑产|盗号|撞库|钓鱼|外挂|破解|攻击|入侵|代提现|跑分|套现)/i,
      /(?:fraud|money laundering|phishing|credential stuffing|ddos|hack|cracker|fake id|gambling|cash out)/i,
    ],
  },
];

const PAGE_RULES: KeywordRule[] = [
  {
    category: 'financial',
    stage: ['page', 'action'],
    keywords: [
      /(?:收银台|立即支付|确认付款|支付金额|付款金额|去支付|提交订单|确认支付|银行卡支付|微信支付|支付宝支付|提现到银行卡|确认提现|确认转账|转账到)/i,
      /(?:checkout|pay now|confirm payment|bank transfer|withdraw to bank|confirm transfer|place order)/i,
    ],
  },
  {
    category: 'privacy',
    stage: ['page', 'action'],
    keywords: [
      /(?:短信验证码|手机验证码|输入验证码|身份证号码|银行卡号|信用卡号|cvv|cvc|支付密码|登录密码|实名认证|上传身份证|人脸识别|真实姓名|收货地址|联系号码)/i,
      /(?:verification code|otp|sms code|id number|bank card number|credit card number|cvv|cvc|payment password|real-name verification|face verification|shipping address)/i,
    ],
  },
];

const ACTION_RULES: KeywordRule[] = [
  {
    category: 'financial',
    stage: ['action', 'request'],
    keywords: [
      /(?:支付|付款|转账|提现|充值|结账|pay|payment|checkout|transfer|withdraw)/i,
    ],
  },
  {
    category: 'privacy',
    stage: ['action', 'request'],
    keywords: [
      /(?:验证码|身份证|手机号|邮箱|地址|银行卡|卡号|cvv|cvc|密码|实名|证件|otp|password|identity|passport|bank card|credit card|address|phone|email)/i,
    ],
  },
];

export class SensitiveOperationGuard {
  constructor(private readonly config: BrowserAgentSafetyConfig = {}) {}

  checkTask(task: BrowserAgentTask): SensitiveOperationAssessment | null {
    if (!this.isEnabled()) {
      return null;
    }

    return this.assessText({
      stage: 'task',
      text: [task.goal, task.startUrl].filter(Boolean).join('\n'),
      url: task.startUrl || extractFirstUrl(task.goal),
    });
  }

  checkAutomationRequest(input: { url: string; actions: BrowserAutomationAction[] }): SensitiveOperationAssessment | null {
    if (!this.isEnabled()) {
      return null;
    }

    const text = [
      input.url,
      ...input.actions.map(action => `${action.type} ${action.selector || ''} ${action.value || ''} ${action.key || ''} ${action.url || ''}`),
    ].join('\n');

    return this.assessText({ stage: 'request', text, url: input.url });
  }

  checkPage(digest: Pick<BrowserPageDigest, 'url' | 'title' | 'visibleText' | 'interactiveSummary'>): SensitiveOperationAssessment | null {
    if (!this.isEnabled()) {
      return null;
    }

    const interactive = digest.interactiveSummary?.join('\n') || '';
    const text = [digest.url, digest.title, digest.visibleText || '', interactive].join('\n');
    return this.assessText({ stage: 'page', text, url: digest.url });
  }

  checkAgentAction(action: BrowserActionProposal, digest?: Pick<BrowserPageDigest, 'url' | 'title' | 'visibleText' | 'interactiveSummary'>): SensitiveOperationAssessment | null {
    if (!this.isEnabled()) {
      return null;
    }

    return this.checkActionLike({
      type: action.type,
      selector: action.selector,
      value: action.value,
      key: action.key,
      url: action.url,
    }, digest);
  }

  checkAutomationAction(action: BrowserAutomationAction, digest?: Pick<BrowserPageDigest, 'url' | 'title' | 'visibleText' | 'interactiveSummary'>): SensitiveOperationAssessment | null {
    if (!this.isEnabled()) {
      return null;
    }

    return this.checkActionLike(action, digest);
  }

  private checkActionLike(
    action: { type?: string; selector?: string; value?: string; key?: string; url?: string },
    digest?: Pick<BrowserPageDigest, 'url' | 'title' | 'visibleText' | 'interactiveSummary'>,
  ): SensitiveOperationAssessment | null {
    const actionType = String(action.type || '').toLowerCase();
    if (!['click', 'fill', 'press', 'navigate', 'goto'].includes(actionType)) {
      return null;
    }

    const interactive = digest?.interactiveSummary?.join('\n') || '';
    const text = [
      action.type || '',
      action.selector || '',
      action.value || '',
      action.key || '',
      action.url || '',
      digest?.url || '',
      digest?.title || '',
      digest?.visibleText || '',
      interactive,
    ].join('\n');

    return this.assessText({ stage: 'action', text, url: digest?.url || action.url });
  }

  createInterruptionError(assessment: SensitiveOperationAssessment): BrowserSafetyInterruptionError {
    return new BrowserSafetyInterruptionError(assessment);
  }

  private assessText(input: { stage: AssessmentStage; text: string; url?: string }): SensitiveOperationAssessment | null {
    const text = input.text.trim();
    if (!text) {
      return null;
    }

    const policy = this.resolvePolicy(input.url);
    const forcedBlock = this.matchConfiguredKeywords(text, policy.blockKeywords);
    if (forcedBlock) {
      return this.createAssessment({
        category: forcedBlock.category,
        stage: input.stage,
        matchedTerms: forcedBlock.matchedTerms,
        matchedPolicy: policy.matchedPolicy,
        matchedSource: 'config-block',
      });
    }

    const rules = [
      ...GOAL_RULES.filter(rule => rule.stage.includes(input.stage)),
      ...PAGE_RULES.filter(rule => rule.stage.includes(input.stage)),
      ...ACTION_RULES.filter(rule => rule.stage.includes(input.stage)),
    ];

    for (const rule of rules) {
      if (!this.isCategoryEnabled(rule.category, policy)) {
        continue;
      }

      const matchedTerms = rule.keywords
        .map(pattern => text.match(pattern)?.[0]?.trim())
        .filter((value): value is string => Boolean(value));

      if (matchedTerms.length === 0) {
        continue;
      }

      if (this.isExplicitlyAllowed(text, rule.category, policy)) {
        continue;
      }

      return this.createAssessment({
        category: rule.category,
        stage: input.stage,
        matchedTerms: Array.from(new Set(matchedTerms)).slice(0, 3),
        matchedPolicy: policy.matchedPolicy,
        matchedSource: 'built-in',
      });
    }

    return null;
  }

  private createAssessment(input: {
    category: SensitiveCategory;
    stage: AssessmentStage;
    matchedTerms: string[];
    matchedPolicy?: string;
    matchedSource: 'built-in' | 'config-block';
  }): SensitiveOperationAssessment {
    return {
      blocked: true,
      errorType: 'browser_safety_abort',
      statusCode: 'BROWSER_SAFETY_ABORTED',
      category: input.category,
      stage: input.stage,
      matchedTerms: input.matchedTerms,
      matchedPolicy: input.matchedPolicy,
      matchedSource: input.matchedSource,
      reason: this.buildReason(input.category, input.matchedTerms, input.matchedPolicy),
    };
  }

  private resolvePolicy(url?: string): ResolvedSafetyPolicy {
    const matchedPolicies = (this.config.domainPolicies || []).filter(policy => this.matchesPolicy(policy, url));
    const matchedPolicyNames = matchedPolicies.map(policy => policy.name || policy.match.join(',')).filter(Boolean).join(' | ');

    return {
      allowKeywords: mergeKeywordPolicies(this.config.allowKeywords, ...matchedPolicies.map(policy => policy.allowKeywords)),
      blockKeywords: mergeKeywordPolicies(this.config.blockKeywords, ...matchedPolicies.map(policy => policy.blockKeywords)),
      blockFinancialActions: resolveBooleanOverride(this.config.blockFinancialActions !== false, matchedPolicies.map(policy => policy.blockFinancialActions)),
      blockPrivacyActions: resolveBooleanOverride(this.config.blockPrivacyActions !== false, matchedPolicies.map(policy => policy.blockPrivacyActions)),
      blockIllegalActions: resolveBooleanOverride(this.config.blockIllegalActions !== false, matchedPolicies.map(policy => policy.blockIllegalActions)),
      matchedPolicy: matchedPolicyNames || undefined,
    };
  }

  private matchesPolicy(policy: BrowserAgentSafetyDomainPolicy, url?: string): boolean {
    if (!url) {
      return false;
    }

    let hostname = '';
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = '';
    }

    const normalizedUrl = url.toLowerCase();
    return policy.match.some(pattern => {
      const normalizedPattern = pattern.trim().toLowerCase();
      if (!normalizedPattern) {
        return false;
      }

      if (normalizedPattern.startsWith('/') && normalizedPattern.endsWith('/')) {
        try {
          return new RegExp(normalizedPattern.slice(1, -1), 'i').test(url);
        } catch {
          return false;
        }
      }

      return hostname === normalizedPattern || hostname.endsWith(`.${normalizedPattern}`) || normalizedUrl.includes(normalizedPattern);
    });
  }

  private matchConfiguredKeywords(text: string, policy: Required<BrowserAgentSafetyKeywordPolicy>): { category: SensitiveCategory; matchedTerms: string[] } | null {
    for (const category of ['financial', 'privacy', 'illegal'] as SensitiveCategory[]) {
      const matches = findKeywordMatches(text, [...policy.global, ...policy[category]]);
      if (matches.length > 0) {
        return { category, matchedTerms: matches.slice(0, 3) };
      }
    }

    return null;
  }

  private isExplicitlyAllowed(text: string, category: SensitiveCategory, policy: ResolvedSafetyPolicy): boolean {
    return findKeywordMatches(text, [...policy.allowKeywords.global, ...policy.allowKeywords[category]]).length > 0;
  }

  private buildReason(category: SensitiveCategory, matchedTerms: string[], matchedPolicy?: string): string {
    const terms = matchedTerms.join('、');
    const policyHint = matchedPolicy ? `（命中策略: ${matchedPolicy}）` : '';
    if (category === 'financial') {
      return `检测到疑似金钱交易相关操作（${terms}）${policyHint}。为避免自动执行支付、提现、转账、下单等高风险行为，已停止浏览器自动化，请由用户本人手动完成。`;
    }

    if (category === 'privacy') {
      return `检测到疑似隐私或敏感信息提交操作（${terms}）${policyHint}。为避免自动填写或提交证件、验证码、密码、银行卡等个人信息，已停止浏览器自动化，请由用户本人手动完成。`;
    }

    return `检测到疑似违规或违法风险操作（${terms}）${policyHint}。已停止浏览器自动化，请由用户本人自行判断并处理。`;
  }

  private isEnabled(): boolean {
    return this.config.enabled !== false;
  }

  private isCategoryEnabled(category: SensitiveCategory, policy: ResolvedSafetyPolicy): boolean {
    if (category === 'financial') {
      return policy.blockFinancialActions;
    }

    if (category === 'privacy') {
      return policy.blockPrivacyActions;
    }

    return policy.blockIllegalActions;
  }
}

function mergeKeywordPolicies(...policies: Array<BrowserAgentSafetyKeywordPolicy | undefined>): Required<BrowserAgentSafetyKeywordPolicy> {
  const merged: Required<BrowserAgentSafetyKeywordPolicy> = {
    global: [],
    financial: [],
    privacy: [],
    illegal: [],
  };

  for (const policy of policies) {
    if (!policy) {
      continue;
    }

    for (const key of ['global', 'financial', 'privacy', 'illegal'] as const) {
      for (const keyword of policy[key] || []) {
        const normalized = keyword.trim();
        if (normalized && !merged[key].includes(normalized)) {
          merged[key].push(normalized);
        }
      }
    }
  }

  return merged;
}

function resolveBooleanOverride(baseValue: boolean, overrides: Array<boolean | undefined>): boolean {
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const value = overrides[index];
    if (typeof value === 'boolean') {
      return value;
    }
  }

  return baseValue;
}

function findKeywordMatches(text: string, keywords: string[]): string[] {
  const normalizedText = text.toLowerCase();
  const matches: string[] = [];
  for (const keyword of keywords) {
    const normalizedKeyword = keyword.trim().toLowerCase();
    if (!normalizedKeyword) {
      continue;
    }
    if (normalizedText.includes(normalizedKeyword)) {
      matches.push(keyword.trim());
    }
  }
  return Array.from(new Set(matches));
}

function extractFirstUrl(input: string): string | undefined {
  return input.match(/https?:\/\/\S+/i)?.[0];
}