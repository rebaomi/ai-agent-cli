import chalk from 'chalk';
import type { Agent } from './agent.js';

export type AgentPersonality = 'professional' | 'friendly' | 'humorous' | 'gentle' | 'energetic';

export interface TopicConfig {
  name: string;
  keywords: string[];
  agentRole: string;
  defaultSkills: string[];
  description: string;
}

export interface UserFeedback {
  type: 'praise' | 'complaint' | 'suggestion';
  content: string;
  timestamp: number;
  topic?: string;
}

export interface ReceptionConfig {
  personality: AgentPersonality;
  autoCreateAgent: boolean;
  collectFeedback: boolean;
}

export const TOPIC_CONFIGS: TopicConfig[] = [
  {
    name: '美食',
    keywords: ['好吃', '餐厅', '菜谱', '烹饪', '食物', '美食', '做法', '推荐', '味道', '小吃'],
    agentRole: 'food_expert',
    defaultSkills: ['search_recipe', 'restaurant_recommend', 'cooking_tips'],
    description: '美食专家',
  },
  {
    name: '旅游',
    keywords: ['旅游', '旅行', '景点', '攻略', '酒店', '机票', '度假', '出国', '签证'],
    agentRole: 'travel_expert',
    defaultSkills: ['travel_search', 'hotel_recommend', 'itinerary_planner'],
    description: '旅游顾问',
  },
  {
    name: '金融',
    keywords: ['股票', '基金', '理财', '投资', '保险', '债券', '期货', '外汇', '银行'],
    agentRole: 'finance_expert',
    defaultSkills: ['stock_analysis', 'investment_advice', 'financial_news'],
    description: '财经顾问',
  },
  {
    name: '编程',
    keywords: ['代码', '编程', '开发', 'bug', '调试', 'api', '函数', '算法', '程序员', '软件'],
    agentRole: 'executor',
    defaultSkills: ['code_search', 'debug_assist', 'documentation'],
    description: '编程助手',
  },
  {
    name: '健康',
    keywords: ['健康', '养生', '运动', '健身', '减肥', '饮食', '睡眠', '医生', '医院'],
    agentRole: 'health_expert',
    defaultSkills: ['health_advice', 'exercise_guide', 'nutrition_info'],
    description: '健康顾问',
  },
  {
    name: '教育',
    keywords: ['学习', '教育', '学校', '考试', '培训', '课程', '老师', '作业', '辅导'],
    agentRole: 'education_expert',
    defaultSkills: ['learning_guide', 'tutoring', 'course_recommend'],
    description: '教育顾问',
  },
  {
    name: '娱乐',
    keywords: ['电影', '音乐', '游戏', '综艺', '电视剧', '追星', '明星', '演唱会'],
    agentRole: 'entertainment_expert',
    defaultSkills: ['movie_recommend', 'music_search', 'game_info'],
    description: '娱乐顾问',
  },
  {
    name: '购物',
    keywords: ['购物', '买', '商品', '优惠', '打折', '淘宝', '京东', '推荐', '比较'],
    agentRole: 'shopping_expert',
    defaultSkills: ['product_search', 'price_compare', 'deal_finder'],
    description: '购物顾问',
  },
];

export const PERSONALITY_PROMPTS: Record<AgentPersonality, { greeting: string; style: string; errorMessage: string }> = {
  professional: {
    greeting: '您好，很高兴为您服务。请问有什么可以帮到您的？',
    style: '专业、礼貌、简洁',
    errorMessage: '抱歉，暂时无法处理您的请求，请稍后重试或换个方式描述您的问题。',
  },
  friendly: {
    greeting: '嗨~ 有什么需要帮忙的吗？我随时为你效劳！😊',
    style: '友好、热情、亲切',
    errorMessage: '哎呀，好像遇到点小问题呢～要不换个说法试试？',
  },
  humorous: {
    greeting: '哈喽！我是你的幽默小助手～今天想聊点什么有趣的呢？😄',
    style: '幽默、风趣、轻松',
    errorMessage: '呃，这个问题把我难住了...要不你换个姿势再问一次？🤔',
  },
  gentle: {
    greeting: '你好呀~ 不要着急，慢慢告诉我你想了解什么，我会尽力帮助你的 🌸',
    style: '温柔、耐心、关怀',
    errorMessage: '不好意思呢，这个问题我还在学习中...可以帮你换个方式吗？',
  },
  energetic: {
    greeting: '嘿！准备好开始了吗？让我来帮你搞定一切！💪',
    style: '活力、积极、行动导向',
    errorMessage: '搞定了！这个有点棘手，但我们一定能找到办法的！',
  },
};

export class TopicDetector {
  private topics: TopicConfig[] = TOPIC_CONFIGS;
  private conversationHistory: Array<{ input: string; topic?: string }> = [];

  detectTopic(input: string): TopicConfig | undefined {
    const lowerInput = input.toLowerCase();
    
    for (const topic of this.topics) {
      for (const keyword of topic.keywords) {
        if (lowerInput.includes(keyword)) {
          this.conversationHistory.push({ input, topic: topic.name });
          return topic;
        }
      }
    }
    
    this.conversationHistory.push({ input, topic: undefined });
    return undefined;
  }

  getConversationTopics(): string[] {
    const topics = this.conversationHistory
      .map(h => h.topic)
      .filter((t): t is string => t !== undefined);
    return [...new Set(topics)];
  }

  getDetectedTopicConfidence(input: string): Array<{ topic: TopicConfig; confidence: number }> {
    const lowerInput = input.toLowerCase();
    const results: Array<{ topic: TopicConfig; confidence: number }> = [];

    for (const topic of this.topics) {
      let matches = 0;
      for (const keyword of topic.keywords) {
        if (lowerInput.includes(keyword)) {
          matches++;
        }
      }
      if (matches > 0) {
        results.push({
          topic,
          confidence: matches / topic.keywords.length,
        });
      }
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}

export class FeedbackCollector {
  private feedbacks: UserFeedback[] = [];
  private feedbackPatterns = {
    praise: [/不错|很好|谢谢|棒|厉害|专业|满意|good|nice|great|thanks/],
    complaint: [/不好|差|失望|糟糕|垃圾|烂|问题|错误|bug|fail|wrong|bad|terrible/],
    suggestion: [/建议|希望|能不能|可以改进|should|could|maybe|suggest/],
  };

  analyzeFeedback(input: string): UserFeedback | null {
    const lowerInput = input.toLowerCase();

    for (const pattern of this.feedbackPatterns.praise) {
      if (pattern.test(lowerInput)) {
        const feedback: UserFeedback = {
          type: 'praise',
          content: input,
          timestamp: Date.now(),
        };
        this.feedbacks.push(feedback);
        return feedback;
      }
    }

    for (const pattern of this.feedbackPatterns.complaint) {
      if (pattern.test(lowerInput)) {
        const feedback: UserFeedback = {
          type: 'complaint',
          content: input,
          timestamp: Date.now(),
        };
        this.feedbacks.push(feedback);
        return feedback;
      }
    }

    for (const pattern of this.feedbackPatterns.suggestion) {
      if (pattern.test(lowerInput)) {
        const feedback: UserFeedback = {
          type: 'suggestion',
          content: input,
          timestamp: Date.now(),
        };
        this.feedbacks.push(feedback);
        return feedback;
      }
    }

    return null;
  }

  getRecentFeedback(count = 10): UserFeedback[] {
    return this.feedbacks.slice(-count);
  }

  getFeedbackSummary(): { praise: number; complaints: number; suggestions: number } {
    return {
      praise: this.feedbacks.filter(f => f.type === 'praise').length,
      complaints: this.feedbacks.filter(f => f.type === 'complaint').length,
      suggestions: this.feedbacks.filter(f => f.type === 'suggestion').length,
    };
  }

  exportImprovements(): string {
    const complaints = this.feedbacks.filter(f => f.type === 'complaint');
    const suggestions = this.feedbacks.filter(f => f.type === 'suggestion');
    
    let report = '# 用户反馈改进报告\n\n';
    
    if (complaints.length > 0) {
      report += '## 投诉/问题\n';
      complaints.forEach(c => {
        report += `- ${c.content} (${new Date(c.timestamp).toLocaleString()})\n`;
      });
      report += '\n';
    }
    
    if (suggestions.length > 0) {
      report += '## 建议\n';
      suggestions.forEach(s => {
        report += `- ${s.content} (${new Date(s.timestamp).toLocaleString()})\n`;
      });
    }
    
    return report;
  }
}

export class SkillMatcher {
  async searchSkills(topic: string): Promise<string[]> {
    const skillRegistry: Record<string, string[]> = {
      '美食': ['recipe-skill', 'restaurant-skill', 'cooking-skill'],
      '旅游': ['travel-skill', 'hotel-skill', 'flight-skill'],
      '金融': ['stock-skill', 'investment-skill', 'finance-skill'],
      '编程': ['code-skill', 'debug-skill', 'docs-skill'],
      '健康': ['health-skill', 'fitness-skill', 'nutrition-skill'],
      '教育': ['tutoring-skill', 'course-skill', 'learning-skill'],
      '娱乐': ['movie-skill', 'music-skill', 'game-skill'],
      '购物': ['shopping-skill', 'price-skill', 'deal-skill'],
    };
    
    return skillRegistry[topic] || [];
  }

  async loadSkillsForTopic(topic: string): Promise<{ name: string; loaded: boolean }[]> {
    const skillNames = await this.searchSkills(topic);
    return skillNames.map(name => ({
      name,
      loaded: true,
    }));
  }
}

export class ReceptionManager {
  private config: ReceptionConfig;
  private topicDetector: TopicDetector;
  private feedbackCollector: FeedbackCollector;
  private skillMatcher: SkillMatcher;
  private currentTopic?: TopicConfig;
  private currentPersonality: AgentPersonality;
  private createdAgents: Map<string, Agent> = new Map();

  constructor(config?: Partial<ReceptionConfig>) {
    this.config = {
      personality: config?.personality || 'friendly',
      autoCreateAgent: config?.autoCreateAgent ?? true,
      collectFeedback: config?.collectFeedback ?? true,
    };
    this.topicDetector = new TopicDetector();
    this.feedbackCollector = new FeedbackCollector();
    this.skillMatcher = new SkillMatcher();
    this.currentPersonality = this.config.personality;
  }

  greet(): string {
    const prompt = PERSONALITY_PROMPTS[this.currentPersonality];
    return prompt.greeting;
  }

  processUserInput(input: string): {
    topic?: TopicConfig;
    shouldCreateAgent: boolean;
    skills: string[];
    response: string;
  } {
    const feedback = this.feedbackCollector.analyzeFeedback(input);
    if (feedback) {
      console.log(chalk.gray(`📝 收集到用户反馈: ${feedback.type}`));
    }

    const topic = this.topicDetector.detectTopic(input);
    this.currentTopic = topic;

    const personality = PERSONALITY_PROMPTS[this.currentPersonality];
    
    let response: string;
    if (topic) {
      response = `好的，您想了解关于「${topic.name}」的话题。我可以为您创建一个专业的${topic.description}来帮助您。`;
      if (this.config.autoCreateAgent) {
        response += '\n正在准备相关技能...';
      }
    } else {
      response = personality.greeting;
    }

    return {
      topic,
      shouldCreateAgent: this.config.autoCreateAgent && !!topic,
      skills: topic ? topic.defaultSkills : [],
      response,
    };
  }

  getPersonalityPrompt(): string {
    return PERSONALITY_PROMPTS[this.currentPersonality].style;
  }

  setPersonality(personality: AgentPersonality): void {
    this.currentPersonality = personality;
  }

  getAvailablePersonalities(): AgentPersonality[] {
    return Object.keys(PERSONALITY_PROMPTS) as AgentPersonality[];
  }

  getPersonalityInfo(personality: AgentPersonality): { name: string; style: string } {
    const info = PERSONALITY_PROMPTS[personality];
    return {
      name: personality,
      style: info.style,
    };
  }

  createAgentForTopic(topic: TopicConfig, agent: Agent): string {
    const agentId = `agent_${topic.name}_${Date.now()}`;
    this.createdAgents.set(agentId, agent);
    return agentId;
  }

  getFeedbackSummary(): { praise: number; complaints: number; suggestions: number } {
    return this.feedbackCollector.getFeedbackSummary();
  }

  exportImprovements(): string {
    return this.feedbackCollector.exportImprovements();
  }

  showHelp(): void {
    console.log(`
${chalk.bold('接待系统命令:')}

${chalk.cyan('/reception personality [name]')}  设置接待员性格
${chalk.cyan('/reception topics')}             查看可识别的话题
${chalk.cyan('/reception feedback')}          查看用户反馈摘要
${chalk.cyan('/reception skills')}             查看可用的技能

${chalk.bold('可用的接待员性格:')}
professional.padEnd(15) - ${PERSONALITY_PROMPTS.professional.style}
friendly.padEnd(15) - ${PERSONALITY_PROMPTS.friendly.style}
humorous.padEnd(15) - ${PERSONALITY_PROMPTS.humorous.style}
gentle.padEnd(15) - ${PERSONALITY_PROMPTS.gentle.style}
energetic.padEnd(15) - ${PERSONALITY_PROMPTS.energetic.style}
`);
  }
}
