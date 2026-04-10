import type { LLMProviderInterface } from '../llm/types.js';
import type { Plan, Planner } from './planner.js';
import type { PendingInteraction } from './agent-interaction-service.js';

export interface AgentPlanningServiceOptions {
  llm: Pick<LLMProviderInterface, 'generate'>;
  planner?: Planner;
  generateDirectResponse: () => Promise<string>;
  onThinking: (content: string) => void;
  onPlanSummary: (summary: string, plan: Plan) => void;
  onSkillInstallNeeded?: (skills: string[]) => Promise<void>;
  getKnownGapNotice: () => string;
  setPendingInteraction: (pending: PendingInteraction) => void;
  setWaitingConfirmation: () => void;
  addAssistantMessage: (content: string) => void;
}

export class AgentPlanningService {
  constructor(private readonly options: AgentPlanningServiceOptions) {}

  async detectComplexTask(input: string): Promise<boolean> {
    const trimmedInput = input.trim();
    const inputLower = trimmedInput.toLowerCase();

    const simpleGreetings = [
      '你好', '您好', '嗨', 'hi', 'hello', 'hey',
      '早上好', '下午好', '晚上好', '在吗', '在不在',
    ];

    if (trimmedInput.length <= 12 && simpleGreetings.some(greeting => inputLower === greeting || inputLower.startsWith(`${greeting}呀`) || inputLower.startsWith(`${greeting}啊`))) {
      return false;
    }

    if (this.isCompositeLarkDeliveryTask(trimmedInput)) {
      return true;
    }

    if (this.isLikelyDirectTask(trimmedInput)) {
      return false;
    }

    const complexityIndicators = [
      '多个', 'several', 'multiple', 'various',
      '先', '然后', 'first', 'then', 'after that',
      '分', '步骤', 'steps', 'phases',
      '并且', '同时', 'and also', 'also',
      '以及', 'plus', 'as well as',
      '需要完成', 'need to', 'should',
      '帮我', 'help me',
    ];

    let matchCount = 0;
    for (const indicator of complexityIndicators) {
      if (inputLower.includes(indicator)) {
        matchCount += 1;
      }
    }

    if (trimmedInput.length > 200 || matchCount >= 2) {
      return true;
    }

    if (trimmedInput.length <= 20 && matchCount === 0) {
      return false;
    }

    try {
      const response = await this.options.llm.generate([
        { role: 'system', content: '你是一个任务复杂度分析专家。判断用户任务是否复杂（需要多个步骤或多种工具）。简单回复 "是" 或 "否"。' },
        { role: 'user', content: `分析这个任务是否复杂：${input}` },
      ]);

      const result = response.toLowerCase().trim();
      const negativePatterns = [/^否[。！!]?$/, /^不是[。！!]?$/, /^不复杂[。！!]?$/, /^简单[。！!]?$/, /^no[.!]?$/, /^not complex[.!]?$/];
      if (negativePatterns.some(pattern => pattern.test(result))) {
        return false;
      }

      const positivePatterns = [/^是[。！!]?$/, /^复杂[。！!]?$/, /^需要规划[。！!]?$/, /^yes[.!]?$/, /^complex[.!]?$/];
      if (positivePatterns.some(pattern => pattern.test(result))) {
        return true;
      }

      return false;
    } catch {
      return matchCount >= 2;
    }
  }

  isGenericPlan(plan: Plan, input: string): boolean {
    const normalizedInput = input.trim().toLowerCase();
    const genericMarkers = [
      '分析任务需求',
      '将任务拆分成清晰的步骤',
      '确定每个步骤需要的工具或操作',
      '开发一个网站应用',
      '分析数据并生成报告',
      '整理文件系统',
      '创建自动化工作流程',
      '或者其他任何复杂任务',
    ];

    if (plan.steps.length === 0) {
      return true;
    }

    const genericStepCount = plan.steps.filter(step => genericMarkers.includes(step.description.trim())).length;
    if (genericStepCount >= Math.max(2, Math.ceil(plan.steps.length / 2))) {
      return true;
    }

    if (normalizedInput.length <= 20 && plan.steps.length >= 3) {
      return true;
    }

    return false;
  }

  async chatWithPlanning(input: string): Promise<string> {
    this.options.onThinking('分析任务复杂度，准备规划步骤...');

    try {
      if (!this.options.planner) {
        return 'Planner not available, falling back to direct execution';
      }

      const planningInput = this.buildPlanningInput(input);
      const plan = await this.options.planner.createPlan(planningInput);
      if (this.isGenericPlan(plan, planningInput)) {
        this.options.onThinking('规划结果过于通用，回退到直接对话响应。');
        return this.options.generateDirectResponse();
      }

      if (plan.neededSkills && plan.neededSkills.length > 0 && this.options.onSkillInstallNeeded) {
        await this.options.onSkillInstallNeeded(plan.neededSkills);
      }

      const summary = this.buildPlanSummary(plan, input);
      this.options.setPendingInteraction({
        type: 'plan_execution',
        callback: () => {},
        plan,
        originalTask: input,
        prompt: summary,
      });
      this.options.setWaitingConfirmation();
      this.options.addAssistantMessage(summary);
      this.options.onPlanSummary(summary, plan);
      return summary;
    } catch {
      return this.options.generateDirectResponse();
    }
  }

  private buildPlanSummary(plan: Plan, input: string): string {
    let summary = '📋 **任务规划已创建**\n';
    const knownGapNotice = this.options.getKnownGapNotice();
    if (knownGapNotice) {
      summary = `${knownGapNotice}\n\n${summary}`;
    }

    summary += `**原任务**: ${plan.originalTask || input}\n\n`;
    summary += `**执行步骤** (${plan.steps.length} 步):\n`;
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      if (step) {
        summary += `${index + 1}. ${step.description}\n`;
      }
    }
    summary += '\n请确认是否执行上述计划（回复 "是" 或 "否"）。如果你还想补充输出目录、权限范围、约束或验收标准，也可以直接继续说，我会据此重规划。';
    return summary;
  }

  private isLikelyDirectTask(input: string): boolean {
    if (this.isCompositeLarkDeliveryTask(input)) {
      return false;
    }

    if (/(长期记忆|写入记忆|写进记忆|记住|记下来|存入记忆|用户信息|用户偏好|用户档案)/i.test(input)
      && /(我是|我喜欢|爱好|兴趣|偏好|习惯)/.test(input)) {
      return true;
    }

    const directActionPatterns = [
      /^(?:@tool)\b/i,
      /^(?:请)?(?:帮我)?(?:读取|查看|打开|列出|搜索|查找|grep|find)\b/i,
      /(?:打开|访问|进入|浏览|跳转到).*(?:网页|网站|首页|页面|官网|github|gitlab|google|百度|飞书|lark)/i,
      /(?:保存|导出|转成|转换成|转换为|生成|输出|整理成|整理为|写成).*(?:pdf|word|docx|ppt|pptx|xlsx|excel|飞书|lark)/i,
      /(?:发送|发(?:到|给|我)?|推送).*(?:飞书|lark|附件|文档|word|docx|ppt|pptx|pdf)/i,
      /(?:飞书|lark).*(?:发送|发(?:到|给|我)?|推送)/i,
      /^(?:read_file|list_directory|search_files|glob|read_multiple_files|execute_command)\b/i,
    ];
    const multiStepPattern = /然后|再|接着|之后|同时|并且|并把|再把|先.+再|first.+then|and then|after that/i;

    if (multiStepPattern.test(input)) {
      return false;
    }

    if (!directActionPatterns.some(pattern => pattern.test(input))) {
      return false;
    }

    return /[\\/]|\.[a-z0-9]{1,8}\b|pdf\b|word\b|docx\b|ppt\b|pptx\b|xlsx\b|excel\b|飞书|lark|目录|文件|关键词|内容|命令|新闻|上面的|刚刚|刚才|网页|网站|首页|页面|官网|github|gitlab|google|百度/i.test(input);
  }

  private buildPlanningInput(input: string): string {
    if (!this.isCompositeLarkDeliveryTask(input)) {
      return input;
    }

    const contentTask = this.extractContentTaskFromLarkDelivery(input);
    return [
      input.trim(),
      '执行要求：这是一个两步任务。先完成用户要发送的内容需求，产出可直接发送的最终正文；再把最终正文发送到飞书。不要直接发送原问题、占位词或未解析的问句。',
      `待先完成的内容需求：${contentTask || input.trim()}`,
    ].join('\n');
  }

  private isCompositeLarkDeliveryTask(input: string): boolean {
    if (!/(飞书|lark)/i.test(input) || !/(发送|发(?:到|给|我)?|推送|send)/i.test(input)) {
      return false;
    }

    if (/(?:内容是|内容为|正文是|正文为|文本是|文本为|markdown是|markdown为)\s*[：:]/i.test(input)) {
      return false;
    }

    if (/(新闻|热点|热榜|早报|晚报|小红书|redbook|xiaohongshu)/i.test(input)) {
      return false;
    }

    return /(?:内容|全文|原文|诗|诗词|文章|歌词|台词|简介|介绍|定义|意思|含义).{0,24}(?:是(?:什么|啥)|是什么)|(?:什么是|谁是).{0,24}(?:诗|诗词|文章|歌词|台词|简介|介绍|定义|意思|含义)|这首(?:诗|词|歌).{0,12}(?:内容|全文|原文).{0,8}(?:是(?:什么|啥)|是什么)/i.test(input);
  }

  private extractContentTaskFromLarkDelivery(input: string): string {
    return input
      .replace(/[，,。；;]?\s*(?:发(?:到|给|我)?|发送|推送)(?:到)?(?:我的)?飞书(?:群|里|上)?/gi, ' ')
      .replace(/[，,。；;]?\s*(?:飞书|lark)(?:群|消息)?(?:里|上)?/gi, ' ')
      .replace(/[，,。；;]?\s*(?:chat[_\-\s]?id|群id|群聊id)\s*(?:是|为|:|：)?\s*oc_[a-z0-9]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}