import type { Message, Tool } from '../../types/index.js';
import type { LLMProviderInterface, LLMResponse, LLMStreamChunk } from '../types.js';
import { DeepSeekClient } from './deepseek.js';

export interface DeepSeekAutoReasoningOptions {
  enabled?: boolean;
  simpleTaskMaxChars?: number;
  simpleConversationMaxChars?: number;
  preferReasonerForToolMessages?: boolean;
  preferReasonerForPlanning?: boolean;
  preferReasonerForLongContext?: boolean;
}

export interface DeepSeekRouteSnapshot {
  target: 'primary' | 'reasoning';
  model: string;
  reason:
    | 'auto_disabled'
    | 'simple_task'
    | 'complex_task'
    | 'tool_messages'
    | 'planning_task'
    | 'workflow_planning'
    | 'troubleshooting'
    | 'architecture_design'
    | 'stock_analysis'
    | 'long_form_summary'
    | 'long_context'
    | 'manual_primary'
    | 'manual_reasoning';
  timestamp: number;
}

export interface DeepSeekRouterClientOptions {
  apiKey: string;
  baseUrl: string;
  primaryModel: string;
  reasoningModel: string;
  temperature?: number;
  maxTokens?: number;
  autoReasoning?: DeepSeekAutoReasoningOptions;
  primaryProvider?: LLMProviderInterface;
  reasoningProvider?: LLMProviderInterface;
}

export class DeepSeekRouterClient implements LLMProviderInterface {
  readonly provider = 'deepseek' as const;

  private tools: Tool[] = [];
  private readonly primaryProvider: LLMProviderInterface;
  private readonly reasoningProvider: LLMProviderInterface;
  private autoReasoningEnabled: boolean;
  private forcedTarget: 'auto' | 'primary' | 'reasoning' = 'auto';
  private simpleTaskMaxChars: number;
  private simpleConversationMaxChars: number;
  private preferReasonerForToolMessages: boolean;
  private preferReasonerForPlanning: boolean;
  private preferReasonerForLongContext: boolean;
  private lastRouteSnapshot?: DeepSeekRouteSnapshot;

  constructor(private readonly options: DeepSeekRouterClientOptions) {
    this.primaryProvider = options.primaryProvider ?? new DeepSeekClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.primaryModel,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    this.reasoningProvider = options.reasoningProvider ?? new DeepSeekClient({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.reasoningModel,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    });
    this.autoReasoningEnabled = options.autoReasoning?.enabled ?? false;
    this.simpleTaskMaxChars = options.autoReasoning?.simpleTaskMaxChars ?? 120;
    this.simpleConversationMaxChars = options.autoReasoning?.simpleConversationMaxChars ?? 8000;
    this.preferReasonerForToolMessages = options.autoReasoning?.preferReasonerForToolMessages ?? true;
    this.preferReasonerForPlanning = options.autoReasoning?.preferReasonerForPlanning ?? true;
    this.preferReasonerForLongContext = options.autoReasoning?.preferReasonerForLongContext ?? true;
  }

  getLastRouteSnapshot(): DeepSeekRouteSnapshot | undefined {
    return this.lastRouteSnapshot ? { ...this.lastRouteSnapshot } : undefined;
  }

  isAutoReasoningEnabled(): boolean {
    return this.autoReasoningEnabled;
  }

  async chat(messages: Message[]): Promise<LLMResponse> {
    return this.pickClientForMessages(messages).chat(messages);
  }

  async *chatStream(messages: Message[]): AsyncGenerator<LLMStreamChunk> {
    const client = this.pickClientForMessages(messages);
    if (client.chatStream) {
      yield* client.chatStream(messages);
      return;
    }

    const response = await client.chat(messages);
    yield { content: response.content, done: true, toolCalls: response.toolCalls };
  }

  async generate(promptOrMessages: string | Message[]): Promise<string> {
    return this.pickClient(promptOrMessages).generate(promptOrMessages);
  }

  async *generateStream(promptOrMessages: string | Message[]): AsyncGenerator<LLMStreamChunk> {
    const client = this.pickClient(promptOrMessages);
    if (client.generateStream) {
      for await (const chunk of client.generateStream(promptOrMessages)) {
        yield chunk;
      }
      return;
    }

    yield { content: await client.generate(promptOrMessages), done: true };
  }

  setTools(tools: Tool[]): void {
    this.tools = tools;
    this.primaryProvider.setTools(tools);
    this.reasoningProvider.setTools(tools);
  }

  async checkConnection(): Promise<boolean> {
    const [primaryOk, reasoningOk] = await Promise.all([
      this.primaryProvider.checkConnection().catch(() => false),
      this.reasoningProvider.checkConnection().catch(() => false),
    ]);
    return primaryOk || reasoningOk;
  }

  getModel(): string {
    const mode = this.forcedTarget === 'auto'
      ? `auto=${this.autoReasoningEnabled ? 'on' : 'off'}`
      : `forced=${this.forcedTarget}`;
    return `deepseek(primary=${this.primaryProvider.getModel()}, reasoning=${this.reasoningProvider.getModel()}, ${mode})`;
  }

  setModel(model: string): void {
    if (model === 'auto:on') {
      this.autoReasoningEnabled = true;
      this.forcedTarget = 'auto';
      return;
    }

    if (model === 'auto:off') {
      this.autoReasoningEnabled = false;
      this.forcedTarget = 'primary';
      return;
    }

    if (model === 'auto') {
      this.forcedTarget = 'auto';
      return;
    }

    if (model === 'primary') {
      this.forcedTarget = 'primary';
      return;
    }

    if (model === 'reasoning') {
      this.forcedTarget = 'reasoning';
      return;
    }

    if (model.startsWith('primary:')) {
      this.primaryProvider.setModel(model.slice('primary:'.length));
      return;
    }

    if (model.startsWith('reasoning:')) {
      this.reasoningProvider.setModel(model.slice('reasoning:'.length));
      return;
    }

    this.primaryProvider.setModel(model);
  }

  private pickClient(promptOrMessages: string | Message[]): LLMProviderInterface {
    if (typeof promptOrMessages === 'string') {
      return this.pickClientForPrompt(promptOrMessages);
    }
    return this.pickClientForMessages(promptOrMessages);
  }

  private pickClientForPrompt(prompt: string): LLMProviderInterface {
    return this.selectTarget(prompt, prompt.length, false);
  }

  private pickClientForMessages(messages: Message[]): LLMProviderInterface {
    const latestUser = [...messages].reverse().find(message => message.role === 'user')?.content || '';
    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    const hasToolMessages = messages.some(message => message.role === 'tool' || (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0));
    return this.selectTarget(latestUser, totalChars, hasToolMessages);
  }

  private selectTarget(prompt: string, totalChars: number, hasToolMessages: boolean): LLMProviderInterface {
    if (this.forcedTarget === 'primary') {
      this.recordRoute('primary', 'manual_primary');
      return this.primaryProvider;
    }

    if (this.forcedTarget === 'reasoning') {
      this.recordRoute('reasoning', 'manual_reasoning');
      return this.reasoningProvider;
    }

    if (!this.autoReasoningEnabled) {
      this.recordRoute('primary', 'auto_disabled');
      return this.primaryProvider;
    }

    const planningReason = this.preferReasonerForPlanning ? this.detectPlanningReason(prompt) : null;
    if (planningReason) {
      this.recordRoute('reasoning', planningReason);
      return this.reasoningProvider;
    }

    if (hasToolMessages && this.preferReasonerForToolMessages && this.shouldPreferReasonerForToolMessages(prompt)) {
      this.recordRoute('reasoning', 'tool_messages');
      return this.reasoningProvider;
    }

    if (this.isSimpleTask(prompt, totalChars)) {
      this.recordRoute('primary', 'simple_task');
      return this.primaryProvider;
    }

    if (this.preferReasonerForLongContext && totalChars > this.simpleConversationMaxChars && !this.isOperationalTask(prompt)) {
      this.recordRoute('reasoning', 'long_context');
      return this.reasoningProvider;
    }

    this.recordRoute('primary', 'complex_task');
    return this.primaryProvider;
  }

  private recordRoute(target: 'primary' | 'reasoning', reason: DeepSeekRouteSnapshot['reason']): void {
    const provider = target === 'reasoning' ? this.reasoningProvider : this.primaryProvider;
    this.lastRouteSnapshot = {
      target,
      model: provider.getModel(),
      reason,
      timestamp: Date.now(),
    };
  }

  private isSimpleTask(prompt: string, totalChars: number): boolean {
    const normalized = prompt.trim();
    if (!normalized) {
      return true;
    }

    if (normalized.length > this.simpleTaskMaxChars || totalChars > this.simpleConversationMaxChars) {
      return false;
    }

    return !this.isPlanningTask(normalized);
  }

  private shouldPreferReasonerForToolMessages(prompt: string): boolean {
    const normalized = prompt.trim();
    if (!normalized || this.isOperationalTask(normalized)) {
      return false;
    }

    return this.isPlanningTask(normalized)
      || /(分析|总结|归纳|提炼|解释|判断|评估|排查|定位|原因|根因|复盘|对比|比较|review|analy[sz]e|summari[sz]e|explain|evaluate|investigate|compare)/i.test(normalized);
  }

  private isOperationalTask(prompt: string): boolean {
    return /(发给飞书|发到飞书|发送附件|发文件|上传|下载|保存成|保存为|导出成|导出为|转换成|转换为|读取文件|读文件|打开文件|查看文件|生成文档|生成ppt|生成pptx|生成word|发送给|send file|send to lark|upload|download|save as|export as|convert to)/i.test(prompt);
  }

  private detectPlanningReason(prompt: string): DeepSeekRouteSnapshot['reason'] | null {
    if (this.isTroubleshootingTask(prompt)) {
      return 'troubleshooting';
    }

    if (this.isArchitectureTask(prompt)) {
      return 'architecture_design';
    }

    if (this.isStockAnalysisTask(prompt)) {
      return 'stock_analysis';
    }

    if (this.isLongFormSummaryTask(prompt)) {
      return 'long_form_summary';
    }

    if (this.isPlanningOrWorkflowTask(prompt)) {
      return 'workflow_planning';
    }

    if (/(tradeoff|trade-off|multi-step|step by step|复杂|先.*再.*|并给出原因)/i.test(prompt)) {
      return 'planning_task';
    }

    return null;
  }

  private isPlanningTask(prompt: string): boolean {
    return this.detectPlanningReason(prompt) !== null;
  }

  private isPlanningOrWorkflowTask(prompt: string): boolean {
    return /(规划|计划|策划|方案|执行步骤|实施步骤|路线图|workflow|workflows|plan|planning|拆分步骤|分步骤|行动方案)/i.test(prompt);
  }

  private isTroubleshootingTask(prompt: string): boolean {
    return /(排查|调试|定位问题|定位原因|根因|故障|异常分析|问题复盘|修复建议|debug|debugging|troubleshoot|incident|postmortem)/i.test(prompt);
  }

  private isArchitectureTask(prompt: string): boolean {
    return /(架构|架构设计|系统设计|技术设计|模块设计|设计评审|架构评审|演进方案|重构方案|系统拆分|design architecture|system design)/i.test(prompt);
  }

  private isStockAnalysisTask(prompt: string): boolean {
    return /(股票分析|个股分析|证券分析|上市公司|财报分析|估值分析|行业景气|板块分析|投资逻辑|热点新闻.*股票|新闻.*股票|公司.*股票|行业.*股票|识别相关股票)/i.test(prompt);
  }

  private isLongFormSummaryTask(prompt: string): boolean {
    return /(长文总结|长文本总结|总结长文|长报告总结|长报告摘要|会议纪要总结|研报总结|文档总结|归纳总结|综合总结|总结并提炼|summary of|summarize)/i.test(prompt);
  }
}
