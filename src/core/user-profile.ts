import { promises as fs } from 'fs';
import * as path from 'path';

export interface UserPreferences {
  name?: string;
  language: string;
  timezone: string;
  personality: 'professional' | 'friendly' | 'humorous' | 'gentle' | 'energetic';
  communicationStyle: 'concise' | 'normal' | 'detailed';
  responseFormat: 'plain' | 'markdown' | 'structured';
}

export interface UserProfile {
  id: string;
  createdAt: number;
  updatedAt: number;
  preferences: UserPreferences;
  job?: string;
  purpose?: string;
  interests: string[];
  interactionCount: number;
  lastSeen: number;
  conversationTopics: string[];
  satisfactionScore?: number;
  complaintsCount: number;
  suggestionsCount: number;
}

export interface ChatBehavior {
  averageMessageLength: number;
  questionsPerConversation: number;
  tasksCompleted: number;
  commonCommands: string[];
  preferredTopics: string[];
  peakHours: number[];
}

export interface OnboardingData {
  job?: string;
  purpose?: string;
  experience?: string;
  interests?: string[];
  preferredStyle?: string;
}

export class UserProfileManager {
  private profileDir: string;
  private currentProfile?: UserProfile;
  private profileFile: string;
  private behaviorFile: string;

  constructor(baseDir?: string) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.profileDir = baseDir || path.join(homeDir, '.ai-agent-cli', 'profiles');
    this.profileFile = path.join(this.profileDir, 'current.json');
    this.behaviorFile = path.join(this.profileDir, 'behavior.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.profileDir, { recursive: true });
    await this.loadProfile();
  }

  async loadProfile(): Promise<UserProfile | null> {
    try {
      const content = await fs.readFile(this.profileFile, 'utf-8');
      this.currentProfile = JSON.parse(content);
      return this.currentProfile || null;
    } catch {
      return null;
    }
  }

  async saveProfile(): Promise<void> {
    if (this.currentProfile) {
      this.currentProfile.updatedAt = Date.now();
      await fs.writeFile(this.profileFile, JSON.stringify(this.currentProfile, null, 2), 'utf-8');
    }
  }

  async createProfile(data?: Partial<OnboardingData>): Promise<UserProfile> {
    const profile: UserProfile = {
      id: `user_${Date.now()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      preferences: {
        language: 'zh-CN',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        personality: 'friendly',
        communicationStyle: 'normal',
        responseFormat: 'markdown',
      },
      job: data?.job,
      purpose: data?.purpose,
      interests: data?.interests || [],
      interactionCount: 0,
      lastSeen: Date.now(),
      conversationTopics: [],
      complaintsCount: 0,
      suggestionsCount: 0,
    };

    this.currentProfile = profile;
    await this.saveProfile();
    return profile;
  }

  getProfile(): UserProfile | null {
    return this.currentProfile || null;
  }

  async updateFromOnboarding(data: OnboardingData): Promise<void> {
    if (!this.currentProfile) {
      await this.createProfile(data);
      return;
    }

    if (data.job) this.currentProfile.job = data.job;
    if (data.purpose) this.currentProfile.purpose = data.purpose;
    if (data.interests) this.currentProfile.interests = data.interests;
    
    if (data.experience) {
      const exp = data.experience.toLowerCase();
      if (exp.includes('新手') || exp.includes('初学')) {
        this.currentProfile.preferences.communicationStyle = 'detailed';
      } else if (exp.includes('熟练') || exp.includes('专家')) {
        this.currentProfile.preferences.communicationStyle = 'concise';
      }
    }

    if (data.preferredStyle) {
      const style = data.preferredStyle.toLowerCase();
      if (style.includes('专业')) this.currentProfile.preferences.personality = 'professional';
      else if (style.includes('幽默')) this.currentProfile.preferences.personality = 'humorous';
      else if (style.includes('温柔')) this.currentProfile.preferences.personality = 'gentle';
      else if (style.includes('活力')) this.currentProfile.preferences.personality = 'energetic';
      else this.currentProfile.preferences.personality = 'friendly';
    }

    await this.saveProfile();
  }

  recordInteraction(topic?: string): void {
    if (!this.currentProfile) return;
    
    this.currentProfile.interactionCount++;
    this.currentProfile.lastSeen = Date.now();
    
    if (topic && !this.currentProfile.conversationTopics.includes(topic)) {
      this.currentProfile.conversationTopics.push(topic);
    }

    this.saveProfile().catch(() => {});
  }

  recordFeedback(type: 'praise' | 'complaint' | 'suggestion'): void {
    if (!this.currentProfile) return;
    
    if (type === 'complaint') {
      this.currentProfile.complaintsCount++;
    } else if (type === 'suggestion') {
      this.currentProfile.suggestionsCount++;
    }
  }

  updatePreferences(prefs: Partial<UserPreferences>): void {
    if (!this.currentProfile) return;
    
    this.currentProfile.preferences = {
      ...this.currentProfile.preferences,
      ...prefs,
    };

    this.saveProfile().catch(() => {});
  }

  getPersonalityPrompt(): string {
    if (!this.currentProfile) return '友好、热情';
    
    const prompts: Record<string, string> = {
      professional: '专业、简洁、有条理',
      friendly: '友好、热情、亲切',
      humorous: '幽默、风趣、轻松',
      gentle: '温柔、耐心、关怀',
      energetic: '活力、积极、行动导向',
    };
    
    return prompts[this.currentProfile.preferences.personality] || '友好、热情';
  }

  getCommunicationStylePrompt(): string {
    if (!this.currentProfile) return '';
    
    const styles: Record<string, string> = {
      concise: '请简洁回答，控制在100字以内',
      normal: '请适度详细回答',
      detailed: '请详细解释，必要时举例说明',
    };
    
    return styles[this.currentProfile.preferences.communicationStyle] || '';
  }

  getUserContext(): string {
    if (!this.currentProfile) return '';
    
    const parts: string[] = [];
    
    if (this.currentProfile.job) {
      parts.push(`用户职业: ${this.currentProfile.job}`);
    }
    
    if (this.currentProfile.purpose) {
      parts.push(`使用目的: ${this.currentProfile.purpose}`);
    }
    
    if (this.currentProfile.interests.length > 0) {
      parts.push(`兴趣领域: ${this.currentProfile.interests.join(', ')}`);
    }
    
    if (this.currentProfile.conversationTopics.length > 0) {
      parts.push(`常聊话题: ${this.currentProfile.conversationTopics.join(', ')}`);
    }
    
    return parts.join('\n');
  }

  getSatisfactionScore(): number {
    if (!this.currentProfile) return 5;
    
    const total = this.currentProfile.interactionCount;
    if (total === 0) return 5;
    
    const praise = total - this.currentProfile.complaintsCount;
    const satisfaction = Math.min(10, Math.max(0, (praise / total) * 10));
    
    return Math.round(satisfaction * 10) / 10;
  }

  async reset(): Promise<void> {
    this.currentProfile = this.createDefaultProfile();
    await this.saveProfile();
  }

  private createDefaultProfile(): UserProfile {
    return {
      id: `user_${Date.now()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      preferences: {
        language: 'zh-CN',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        personality: 'friendly',
        communicationStyle: 'normal',
        responseFormat: 'markdown',
      },
      interests: [],
      interactionCount: 0,
      lastSeen: Date.now(),
      conversationTopics: [],
      complaintsCount: 0,
      suggestionsCount: 0,
    };
  }

  async exportProfile(): Promise<string> {
    if (!this.currentProfile) return '';
    
    return JSON.stringify(this.currentProfile, null, 2);
  }

  printProfile(): void {
    if (!this.currentProfile) {
      console.log('暂无用户档案');
      return;
    }

    const profile = this.currentProfile;
    
    console.log('\n👤 用户档案\n');
    console.log(`ID: ${profile.id}`);
    console.log(`创建时间: ${new Date(profile.createdAt).toLocaleString()}`);
    console.log(`交互次数: ${profile.interactionCount}`);
    console.log(`最近活跃: ${new Date(profile.lastSeen).toLocaleString()}`);
    
    if (profile.job) console.log(`职业: ${profile.job}`);
    if (profile.purpose) console.log(`使用目的: ${profile.purpose}`);
    
    console.log(`\n偏好设置:`);
    console.log(`  性格: ${profile.preferences.personality}`);
    console.log(`  沟通风格: ${profile.preferences.communicationStyle}`);
    console.log(`  响应格式: ${profile.preferences.responseFormat}`);
    
    if (profile.interests.length > 0) {
      console.log(`\n兴趣领域: ${profile.interests.join(', ')}`);
    }
    
    if (profile.conversationTopics.length > 0) {
      console.log(`常聊话题: ${profile.conversationTopics.join(', ')}`);
    }
    
    console.log(`\n满意度评分: ${this.getSatisfactionScore()}/10`);
    console.log(`投诉次数: ${profile.complaintsCount}`);
    console.log(`建议次数: ${profile.suggestionsCount}`);
    console.log();
  }
}

export const userProfileManager = new UserProfileManager();
