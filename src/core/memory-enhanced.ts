import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import type { Message } from '../types/index.js';

export interface AgentMemory {
  agentId: string;
  agentName: string;
  role: string;
  shortTerm: MemoryEntry[];
  context: string;
  lastUpdated: number;
}

export interface MemoryEntry {
  id: string;
  type: 'task' | 'observation' | 'decision' | 'result' | 'error';
  content: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface TaskProgress {
  taskId: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'partial';
  progress: number;
  currentStep?: string;
  completedSteps: string[];
  pendingSteps: string[];
  result?: string;
  error?: string;
  agentId?: string;
  startedAt: number;
  updatedAt: number;
}

export interface LongTermMemory {
  userPreferences: Record<string, any>;
  projectContext: Record<string, any>;
  knowledgeBase: string[];
  organizationMemory: Record<string, AgentMemory>;
  taskHistory: TaskProgress[];
}

export class EnhancedMemoryManager {
  private baseDir: string;
  private longTermFile: string;
  private shortTermDir: string;
  private progressFile: string;
  
  private longTermMemory: LongTermMemory;
  private currentSessionId: string;
  private currentMessages: Message[] = [];
  private maxMessagesPerSession = 100;

  constructor(baseDir?: string) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.baseDir = baseDir || join(homeDir, '.ai-agent-cli', 'memory');
    this.longTermFile = join(this.baseDir, 'long-term.json');
    this.shortTermDir = join(this.baseDir, 'short-term');
    this.progressFile = join(this.baseDir, 'progress.json');
    this.currentSessionId = this.generateSessionId();
    
    this.longTermMemory = {
      userPreferences: {},
      projectContext: {},
      knowledgeBase: [],
      organizationMemory: {},
      taskHistory: [],
    };
  }

  private generateSessionId(): string {
    const now = new Date();
    return `session_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${Date.now()}`;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.shortTermDir, { recursive: true });
    await this.loadLongTermMemory();
    await this.loadCurrentSession();
  }

  private async loadLongTermMemory(): Promise<void> {
    try {
      const content = await fs.readFile(this.longTermFile, 'utf-8');
      this.longTermMemory = JSON.parse(content);
    } catch {
      this.longTermMemory = {
        userPreferences: {},
        projectContext: {},
        knowledgeBase: [],
        organizationMemory: {},
        taskHistory: [],
      };
    }
  }

  private async saveLongTermMemory(): Promise<void> {
    try {
      await fs.writeFile(this.longTermFile, JSON.stringify(this.longTermMemory, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save long-term memory:', error);
    }
  }

  private async loadCurrentSession(): Promise<void> {
    try {
      const sessionFile = join(this.shortTermDir, `${this.currentSessionId}.json`);
      const content = await fs.readFile(sessionFile, 'utf-8');
      this.currentMessages = JSON.parse(content);
    } catch {
      this.currentMessages = [];
    }
  }

  private async saveCurrentSession(): Promise<void> {
    try {
      const sessionFile = join(this.shortTermDir, `${this.currentSessionId}.json`);
      await fs.writeFile(sessionFile, JSON.stringify(this.currentMessages, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save current session:', error);
    }
  }

  addMessage(message: Message): void {
    this.currentMessages.push(message);
    
    if (this.currentMessages.length > this.maxMessagesPerSession) {
      this.currentMessages = this.currentMessages.slice(-this.maxMessagesPerSession);
    }
    
    this.saveCurrentSession().catch(console.error);
  }

  getMessages(): Message[] {
    return [...this.currentMessages];
  }

  setMessages(messages: Message[]): void {
    this.currentMessages = messages;
    this.saveCurrentSession().catch(console.error);
  }

  clearHistory(): void {
    this.currentMessages = [];
    this.saveCurrentSession().catch(console.error);
  }

  newSession(): void {
    this.currentSessionId = this.generateSessionId();
    this.currentMessages = [];
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  getContextSummary(maxLength = 500): string {
    const recent = this.currentMessages.slice(-10);
    const summary = recent.map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    return summary.length > maxLength ? summary.slice(0, maxLength) + '...' : summary;
  }

  async listSessions(): Promise<Array<{ id: string; messageCount: number; lastUpdated: number }>> {
    const sessions: Array<{ id: string; messageCount: number; lastUpdated: number }> = [];
    
    try {
      const files = await fs.readdir(this.shortTermDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(join(this.shortTermDir, file), 'utf-8');
          const messages = JSON.parse(content);
          if (Array.isArray(messages) && messages.length > 0) {
            const lastMsg = messages[messages.length - 1];
            sessions.push({
              id: file.replace('.json', ''),
              messageCount: messages.length,
              lastUpdated: lastMsg?.timestamp || 0,
            });
          }
        }
      }
    } catch {}

    return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  async loadSession(sessionId: string): Promise<boolean> {
    try {
      const sessionFile = join(this.shortTermDir, `${sessionId}.json`);
      const content = await fs.readFile(sessionFile, 'utf-8');
      this.currentSessionId = sessionId;
      this.currentMessages = JSON.parse(content);
      return true;
    } catch {
      return false;
    }
  }

  addAgentMemory(agent: AgentMemory): void {
    this.longTermMemory.organizationMemory[agent.agentId] = {
      ...agent,
      lastUpdated: Date.now(),
    };
    this.saveLongTermMemory();
  }

  getAgentMemory(agentId: string): AgentMemory | undefined {
    return this.longTermMemory.organizationMemory[agentId];
  }

  updateAgentMemory(agentId: string, update: Partial<AgentMemory>): void {
    if (this.longTermMemory.organizationMemory[agentId]) {
      this.longTermMemory.organizationMemory[agentId] = {
        ...this.longTermMemory.organizationMemory[agentId],
        ...update,
        lastUpdated: Date.now(),
      };
      this.saveLongTermMemory();
    }
  }

  addShortTermMemory(agentId: string, entry: Omit<MemoryEntry, 'id' | 'timestamp'>): void {
    const agentMemory = this.getAgentMemory(agentId);
    if (agentMemory) {
      const newEntry: MemoryEntry = {
        ...entry,
        id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now(),
      };
      agentMemory.shortTerm.push(newEntry);
      
      if (agentMemory.shortTerm.length > 50) {
        agentMemory.shortTerm = agentMemory.shortTerm.slice(-50);
      }
      
      this.updateAgentMemory(agentId, { shortTerm: agentMemory.shortTerm });
    }
  }

  getAgentShortTermMemory(agentId: string): MemoryEntry[] {
    return this.longTermMemory.organizationMemory[agentId]?.shortTerm || [];
  }

  clearAgentShortTermMemory(agentId: string): void {
    this.updateAgentMemory(agentId, { shortTerm: [] });
  }

  clearAllAgentShortTermMemory(): void {
    for (const agentId of Object.keys(this.longTermMemory.organizationMemory)) {
      this.clearAgentShortTermMemory(agentId);
    }
  }

  setUserPreference(key: string, value: any): void {
    this.longTermMemory.userPreferences[key] = value;
    this.saveLongTermMemory();
  }

  getUserPreference(key: string): any {
    return this.longTermMemory.userPreferences[key];
  }

  addToKnowledgeBase(knowledge: string): void {
    if (!this.longTermMemory.knowledgeBase.includes(knowledge)) {
      this.longTermMemory.knowledgeBase.push(knowledge);
      this.saveLongTermMemory();
    }
  }

  getKnowledgeBase(): string[] {
    return [...this.longTermMemory.knowledgeBase];
  }

  createTaskProgress(description: string, steps: string[]): TaskProgress {
    const progress: TaskProgress = {
      taskId: `task_${Date.now()}`,
      description,
      status: 'pending',
      progress: 0,
      completedSteps: [],
      pendingSteps: steps,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.longTermMemory.taskHistory.push(progress);
    this.saveLongTermMemory();
    return progress;
  }

  updateTaskProgress(taskId: string, update: Partial<TaskProgress>): void {
    const task = this.longTermMemory.taskHistory.find(t => t.taskId === taskId);
    if (task) {
      Object.assign(task, update, { updatedAt: Date.now() });
      task.progress = this.calculateProgress(task);
      this.saveLongTermMemory();
    }
  }

  private calculateProgress(task: TaskProgress): number {
    const total = task.completedSteps.length + task.pendingSteps.length;
    if (total === 0) return 0;
    return Math.round((task.completedSteps.length / total) * 100);
  }

  getTaskProgress(taskId: string): TaskProgress | undefined {
    return this.longTermMemory.taskHistory.find(t => t.taskId === taskId);
  }

  getActiveTasks(): TaskProgress[] {
    return this.longTermMemory.taskHistory.filter(
      t => t.status === 'pending' || t.status === 'in_progress'
    );
  }

  completeTask(taskId: string, result: string): void {
    this.updateTaskProgress(taskId, {
      status: 'completed',
      progress: 100,
      result,
    });
  }

  failTask(taskId: string, error: string): void {
    this.updateTaskProgress(taskId, {
      status: 'failed',
      error,
    });
  }

  getLongTermMemory(): LongTermMemory {
    return { ...this.longTermMemory };
  }

  getSharedContext(): string {
    const contextParts: string[] = [];
    
    if (Object.keys(this.longTermMemory.userPreferences).length > 0) {
      contextParts.push(`用户偏好: ${JSON.stringify(this.longTermMemory.userPreferences)}`);
    }
    
    if (this.longTermMemory.knowledgeBase.length > 0) {
      contextParts.push(`知识库: ${this.longTermMemory.knowledgeBase.join(', ')}`);
    }
    
    const activeTasks = this.getActiveTasks();
    if (activeTasks.length > 0) {
      contextParts.push(`进行中任务: ${activeTasks.map(t => `${t.description}(${t.progress}%)`).join(', ')}`);
    }
    
    return contextParts.join('\n');
  }
}

export function createEnhancedMemoryManager(baseDir?: string): EnhancedMemoryManager {
  return new EnhancedMemoryManager(baseDir);
}
