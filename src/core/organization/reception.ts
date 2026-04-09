import chalk from 'chalk';
import type { OrganizationConfig, AgentMember } from './types.js';

export interface ReceptionConfig {
  enabled: boolean;
  agentId: string;
  welcomeMessage: string;
  followUpQuestions?: string[];
}

export class ReceptionAgent {
  private config: ReceptionConfig;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private currentStage: 'greeting' | 'collecting' | 'understanding' | 'confirmed' = 'greeting';
  private collectedInfo: Map<string, any> = new Map();
  private pendingQuestions: string[] = [];

  constructor(config: ReceptionConfig) {
    this.config = config;
  }

  getWelcomeMessage(): string {
    return this.config.welcomeMessage;
  }

  greet(): string {
    this.currentStage = 'greeting';
    return this.config.welcomeMessage;
  }

  processInput(input: string): { response: string; isComplete: boolean; context: any } {
    this.conversationHistory.push({ role: 'user', content: input });
    this.captureDetails(input);
    
    const lowerInput = input.toLowerCase();
    
    if (this.currentStage === 'greeting') {
      if (this.isAcknowledgment(lowerInput)) {
        this.currentStage = 'collecting';
        const response = this.askForDetails();
        this.conversationHistory.push({ role: 'assistant', content: response });
        return { response, isComplete: false, context: null };
      }
      return { response: '好的，请告诉我您的需求～', isComplete: false, context: null };
    }

    if (this.currentStage === 'collecting') {
      this.collectedInfo.set('userInput', input);

      const clarification = this.analyzeAndClarify();
      if (clarification.needMore) {
        this.currentStage = 'understanding';
        const response = clarification.question;
        this.conversationHistory.push({ role: 'assistant', content: response });
        return { response, isComplete: false, context: null };
      }
      
      this.currentStage = 'confirmed';
      const finalResponse = this.confirmUnderstanding(input);
      this.conversationHistory.push({ role: 'assistant', content: finalResponse });
      return { response: finalResponse, isComplete: true, context: this.buildContext() };
    }

    if (this.currentStage === 'understanding') {
      this.collectedInfo.set(`clarification_${Date.now()}`, input);
      const clarification = this.analyzeAndClarify();
      if (clarification.needMore) {
        const response = clarification.question;
        this.conversationHistory.push({ role: 'assistant', content: response });
        return { response, isComplete: false, context: null };
      }
      this.currentStage = 'confirmed';
      const finalResponse = this.confirmUnderstanding(this.collectedInfo.get('userInput') as string);
      this.conversationHistory.push({ role: 'assistant', content: finalResponse });
      return { response: finalResponse, isComplete: true, context: this.buildContext() };
    }

    if (this.currentStage === 'confirmed') {
      const response = '好的，我已经了解您的需求，正在为您协调团队处理中...';
      return { response, isComplete: true, context: this.buildContext() };
    }

    return { response: '请稍等...', isComplete: false, context: null };
  }

  private isAcknowledgment(input: string): boolean {
    const acknowledgments = [
      '好的', '可以', '嗯', '说', '开始', '要', '帮忙', '你好', 'hi', 'hello', 
      'yes', 'ok', 'okay', 'sure', 'go', 'start', 'help', 'please'
    ];
    return acknowledgments.some(word => input.includes(word));
  }

  private askForDetails(): string {
    const questions = [
      '\n\n为了更好地帮您处理，请告诉我：',
      '\n\n请问具体需要完成什么任务或解决什么问题？',
      '\n\n请详细描述一下您的需求，这样我可以更准确地为您服务。',
    ];
    return this.config.welcomeMessage + questions[Math.floor(Math.random() * questions.length)];
  }

  private analyzeAndClarify(): { needMore: boolean; question: string } {
    if (this.pendingQuestions.length === 0) {
      this.pendingQuestions = this.buildFollowUpQuestions();
    }

    const nextQuestion = this.pendingQuestions.shift();
    if (!nextQuestion) {
      return { needMore: false, question: '' };
    }

    return {
      needMore: true,
      question: nextQuestion,
    };
  }

  private confirmUnderstanding(input: string): string {
    const summary = this.summarizeUnderstanding(input);
    return `${summary}\n\n请确认我理解得是否正确。如果没问题，我将开始为您处理。`;
  }

  private summarizeUnderstanding(input: string): string {
    let summary = '好的，我已经理解了您的需求：\n\n';
    
    const tasks = this.extractTasks(input);
    if (tasks.length > 1) {
      summary += '您需要完成以下任务：\n';
      tasks.forEach((task, i) => {
        summary += `  ${i + 1}. ${task}\n`;
      });
    } else {
      summary += `主要内容：${input.slice(0, 100)}${input.length > 100 ? '...' : ''}`;
    }

    this.collectedInfo.set('summary', summary);
    return summary;
  }

  private extractTasks(input: string): string[] {
    const separators = /[,，、和然后首先其次最后同时并且及]/g;
    const parts = input.split(separators).map(s => s.trim()).filter(s => s.length > 0);
    return parts.length > 1 ? parts : [];
  }

  private buildContext(): any {
    return {
      originalInput: this.collectedInfo.get('userInput'),
      summary: this.collectedInfo.get('summary'),
      extractedTasks: this.extractTasks(this.collectedInfo.get('userInput') || ''),
      deliverable: this.collectedInfo.get('deliverable'),
      constraints: this.collectedInfo.get('constraints'),
      deadline: this.collectedInfo.get('deadline'),
      conversationHistory: [...this.conversationHistory],
      timestamp: Date.now(),
    };
  }

  private captureDetails(input: string): void {
    if (!this.collectedInfo.get('goal') && input.trim().length >= 10) {
      this.collectedInfo.set('goal', input.trim());
    }

    if (/(docx|word|pdf|ppt|excel|表格|文档|报告|文件|输出|导出|保存)/i.test(input)) {
      this.collectedInfo.set('deliverable', input.trim());
    }

    if (/(不要|不能|只要|优先|限制|约束|保留|兼容|权限)/.test(input)) {
      this.collectedInfo.set('constraints', input.trim());
    }

    if (/(今天|明天|本周|月底|尽快|截止|deadline|before)/i.test(input)) {
      this.collectedInfo.set('deadline', input.trim());
    }
  }

  private buildFollowUpQuestions(): string[] {
    const questions: string[] = [];
    const originalInput = String(this.collectedInfo.get('userInput') || '');

    if (originalInput.trim().length < 20 || !this.collectedInfo.get('goal')) {
      questions.push('我先确认目标：你最终希望我交付什么结果，或者帮你把哪件事推进到什么状态？');
    }

    if (/导出|生成|保存|写入|输出/i.test(originalInput) && !this.collectedInfo.get('deliverable')) {
      questions.push('这个结果要输出成什么格式、放到什么位置？如果有文件名要求，也一起说。');
    }

    if (!this.collectedInfo.get('constraints')) {
      questions.push('有没有不能碰的范围、权限限制、风格要求，或者你特别在意的验收标准？');
    }

    if (!this.collectedInfo.get('deadline')) {
      questions.push('这个需求有时间要求吗？比如现在先出最小可用结果，还是要一次做到完整。');
    }

    return questions.slice(0, 3);
  }

  getConversationHistory(): Array<{ role: 'user' | 'assistant'; content: string }> {
    return [...this.conversationHistory];
  }

  getCollectedInfo(): Map<string, any> {
    return new Map(this.collectedInfo);
  }

  reset(): void {
    this.conversationHistory = [];
    this.currentStage = 'greeting';
    this.collectedInfo.clear();
    this.pendingQuestions = [];
  }

  getStatus(): { stage: string; messageCount: number; infoCount: number } {
    return {
      stage: this.currentStage,
      messageCount: this.conversationHistory.length,
      infoCount: this.collectedInfo.size,
    };
  }
}

export function createReceptionAgent(config: OrganizationConfig | ReceptionConfig): ReceptionAgent | null {
  if ('enabled' in config && 'welcomeMessage' in config) {
    return new ReceptionAgent(config as ReceptionConfig);
  }
  
  const workflow = (config as OrganizationConfig).workflow;
  if (!workflow?.reception?.enabled) {
    return null;
  }

  return new ReceptionAgent({
    enabled: workflow.reception.enabled,
    agentId: workflow.reception.agentId,
    welcomeMessage: workflow.reception.welcomeMessage || '您好，请问有什么可以帮助您的？',
  });
}
