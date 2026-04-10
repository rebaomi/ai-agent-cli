import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import type { Message } from '../types/index.js';
import { safeJsonStringify } from '../utils/unicode.js';

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

export type MemoryPalaceZone =
  | 'entrance'
  | 'identity'
  | 'project'
  | 'knowledge'
  | 'tasks'
  | 'agents'
  | 'archive';

export interface MemoryPalaceItem {
  id: string;
  anchor: string;
  title: string;
  content: string;
  zone: MemoryPalaceZone;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, any>;
}

export interface MemoryPalaceRoom {
  id: string;
  name: string;
  zone: MemoryPalaceZone;
  description: string;
  landmarks: string[];
  memories: MemoryPalaceItem[];
  exits: string[];
  lastVisited: number;
}

export interface MemoryPalaceRoute {
  from: string;
  to: string;
  label: string;
}

export interface MemoryPalace {
  name: string;
  entranceRoomId: string;
  currentRoomId: string;
  rooms: Record<string, MemoryPalaceRoom>;
  routes: MemoryPalaceRoute[];
  updatedAt: number;
}

export interface LongTermMemory {
  userPreferences: Record<string, any>;
  projectContext: Record<string, any>;
  knowledgeBase: string[];
  organizationMemory: Record<string, AgentMemory>;
  taskHistory: TaskProgress[];
  memoryPalace: MemoryPalace;
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
    
    this.longTermMemory = this.createDefaultLongTermMemory();
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

  private createDefaultLongTermMemory(): LongTermMemory {
    return {
      userPreferences: {},
      projectContext: {},
      knowledgeBase: [],
      organizationMemory: {},
      taskHistory: [],
      memoryPalace: this.createDefaultMemoryPalace(),
    };
  }

  private createDefaultMemoryPalace(): MemoryPalace {
    const now = Date.now();
    const room = (
      id: string,
      name: string,
      zone: MemoryPalaceZone,
      description: string,
      landmarks: string[],
      exits: string[],
    ): MemoryPalaceRoom => ({
      id,
      name,
      zone,
      description,
      landmarks,
      memories: [],
      exits,
      lastVisited: now,
    });

    const rooms: Record<string, MemoryPalaceRoom> = {
      propylaea: room('propylaea', '前厅 Propylaea', 'entrance', '进入记忆宫殿的总入口，用于导航各个记忆区域。', ['石柱', '火炬', '总览地图'], ['oikos', 'agora', 'bibliotheke']),
      oikos: room('oikos', '居所 Oikos', 'identity', '记录用户身份、偏好与沟通习惯。', ['铜镜', '衣柜', '姓名卷轴'], ['propylaea', 'agora', 'mnemosyne_archive']),
      agora: room('agora', '广场 Agora', 'project', '记录项目背景、工作区状态和当前关注主题。', ['市场石碑', '项目看板', '路线图'], ['propylaea', 'ergasterion', 'bibliotheke']),
      bibliotheke: room('bibliotheke', '图书馆 Bibliotheke', 'knowledge', '存放稳定知识、经验规则与可复用结论。', ['卷轴架', '油灯', '索引台'], ['propylaea', 'agora', 'stoa']),
      ergasterion: room('ergasterion', '工坊 Ergasterion', 'tasks', '记录任务进度、步骤、失败点与产出。', ['工作台', '工具墙', '任务板'], ['agora', 'stoa', 'mnemosyne_archive']),
      stoa: room('stoa', '柱廊 Stoa', 'agents', '记录 Agent 角色、协作上下文和观察。', ['长廊', '角色徽章', '协作公告板'], ['bibliotheke', 'ergasterion', 'mnemosyne_archive']),
      mnemosyne_archive: room('mnemosyne_archive', '记忆档案馆 Mnemosyne', 'archive', '归档重要结论、旧任务和会话痕迹。', ['石柜', '封蜡箱', '年代索引'], ['oikos', 'ergasterion', 'stoa']),
    };

    return {
      name: 'Temple of Mnemosyne',
      entranceRoomId: 'propylaea',
      currentRoomId: 'propylaea',
      rooms,
      routes: [
        { from: 'propylaea', to: 'oikos', label: '左侧回廊' },
        { from: 'propylaea', to: 'agora', label: '中央大道' },
        { from: 'propylaea', to: 'bibliotheke', label: '右侧阶梯' },
        { from: 'agora', to: 'ergasterion', label: '工匠小径' },
        { from: 'bibliotheke', to: 'stoa', label: '知识柱廊' },
        { from: 'ergasterion', to: 'mnemosyne_archive', label: '归档门' },
        { from: 'stoa', to: 'mnemosyne_archive', label: '回声长廊' },
        { from: 'oikos', to: 'mnemosyne_archive', label: '私室暗门' },
      ],
      updatedAt: now,
    };
  }

  private async loadLongTermMemory(): Promise<void> {
    try {
      const content = await fs.readFile(this.longTermFile, 'utf-8');
      const parsed = JSON.parse(content) as Partial<LongTermMemory>;
      this.longTermMemory = {
        ...this.createDefaultLongTermMemory(),
        ...parsed,
        userPreferences: parsed.userPreferences || {},
        projectContext: parsed.projectContext || {},
        knowledgeBase: Array.isArray(parsed.knowledgeBase) ? parsed.knowledgeBase : [],
        organizationMemory: parsed.organizationMemory || {},
        taskHistory: Array.isArray(parsed.taskHistory) ? parsed.taskHistory : [],
        memoryPalace: parsed.memoryPalace ? this.normalizeMemoryPalace(parsed.memoryPalace) : this.createDefaultMemoryPalace(),
      };
    } catch {
      this.longTermMemory = this.createDefaultLongTermMemory();
    }
  }

  private normalizeMemoryPalace(memoryPalace: Partial<MemoryPalace>): MemoryPalace {
    const defaults = this.createDefaultMemoryPalace();
    const mergedRooms: Record<string, MemoryPalaceRoom> = { ...defaults.rooms };
    const entranceRoom = defaults.rooms.propylaea as MemoryPalaceRoom;

    for (const [roomId, room] of Object.entries(memoryPalace.rooms || {})) {
      const fallbackRoom = defaults.rooms[roomId] ?? entranceRoom;
      mergedRooms[roomId] = {
        ...fallbackRoom,
        ...room,
        memories: Array.isArray(room.memories) ? room.memories : fallbackRoom.memories,
        exits: Array.isArray(room.exits) ? room.exits : fallbackRoom.exits,
        landmarks: Array.isArray(room.landmarks) ? room.landmarks : fallbackRoom.landmarks,
      };
    }

    return {
      ...defaults,
      ...memoryPalace,
      rooms: mergedRooms,
      routes: Array.isArray(memoryPalace.routes) ? memoryPalace.routes : defaults.routes,
      entranceRoomId: memoryPalace.entranceRoomId || defaults.entranceRoomId,
      currentRoomId: memoryPalace.currentRoomId || defaults.currentRoomId,
      updatedAt: memoryPalace.updatedAt || defaults.updatedAt,
    };
  }

  private async saveLongTermMemory(): Promise<void> {
    try {
      await fs.writeFile(this.longTermFile, safeJsonStringify(this.longTermMemory, 2), 'utf-8');
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
      await fs.writeFile(sessionFile, safeJsonStringify(this.currentMessages, 2), 'utf-8');
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
    this.upsertPalaceMemory('stoa', `agent:${agent.agentId}`, {
      title: `${agent.agentName} (${agent.role})`,
      content: agent.context || `${agent.agentName} has ${agent.shortTerm.length} short-term memories.`,
      zone: 'agents',
      tags: ['agent', agent.role, agent.agentId],
      metadata: {
        agentId: agent.agentId,
        agentName: agent.agentName,
        role: agent.role,
        shortTermCount: agent.shortTerm.length,
      },
    });
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
      const agent = this.longTermMemory.organizationMemory[agentId];
      this.upsertPalaceMemory('stoa', `agent:${agentId}`, {
        title: `${agent.agentName} (${agent.role})`,
        content: agent.context || `${agent.agentName} has ${agent.shortTerm.length} short-term memories.`,
        zone: 'agents',
        tags: ['agent', agent.role, agentId],
        metadata: {
          agentId,
          agentName: agent.agentName,
          role: agent.role,
          shortTermCount: agent.shortTerm.length,
        },
      });
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

      this.upsertPalaceMemory('stoa', `agent-entry:${agentId}:${newEntry.id}`, {
        title: `${agentId} · ${newEntry.type}`,
        content: newEntry.content,
        zone: 'agents',
        tags: ['agent-entry', agentId, newEntry.type],
        metadata: newEntry.metadata,
      });
      
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
    this.upsertPalaceMemory('oikos', `preference:${key}`, {
      title: `Preference · ${key}`,
      content: typeof value === 'string' ? value : JSON.stringify(value),
      zone: 'identity',
      tags: ['preference', key],
      metadata: { key, value },
    });
    this.saveLongTermMemory();
  }

  getUserPreference(key: string): any {
    return this.longTermMemory.userPreferences[key];
  }

  addToKnowledgeBase(knowledge: string): void {
    if (!this.longTermMemory.knowledgeBase.includes(knowledge)) {
      this.longTermMemory.knowledgeBase.push(knowledge);
      this.upsertPalaceMemory('bibliotheke', `knowledge:${knowledge}`, {
        title: `Knowledge`,
        content: knowledge,
        zone: 'knowledge',
        tags: ['knowledge'],
      });
      this.saveLongTermMemory();
    }
  }

  setProjectContext(key: string, value: any): void {
    this.longTermMemory.projectContext[key] = value;
    this.upsertPalaceMemory('agora', `project:${key}`, {
      title: `Project · ${key}`,
      content: typeof value === 'string' ? value : JSON.stringify(value),
      zone: 'project',
      tags: ['project', key],
      metadata: { key, value },
    });
    this.saveLongTermMemory();
  }

  getProjectContext(key: string): any {
    return this.longTermMemory.projectContext[key];
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
    this.upsertPalaceMemory('ergasterion', `task:${progress.taskId}`, {
      title: description,
      content: `Task created with ${steps.length} planned steps.`,
      zone: 'tasks',
      tags: ['task', progress.status],
      metadata: {
        taskId: progress.taskId,
        steps,
        progress: progress.progress,
      },
    });
    this.saveLongTermMemory();
    return progress;
  }

  updateTaskProgress(taskId: string, update: Partial<TaskProgress>): void {
    const task = this.longTermMemory.taskHistory.find(t => t.taskId === taskId);
    if (task) {
      Object.assign(task, update, { updatedAt: Date.now() });
      task.progress = this.calculateProgress(task);
      this.upsertPalaceMemory('ergasterion', `task:${taskId}`, {
        title: task.description,
        content: [
          `Status: ${task.status}`,
          task.currentStep ? `Current step: ${task.currentStep}` : undefined,
          task.result ? `Result: ${task.result}` : undefined,
          task.error ? `Error: ${task.error}` : undefined,
        ].filter(Boolean).join('\n'),
        zone: 'tasks',
        tags: ['task', task.status],
        metadata: {
          taskId,
          progress: task.progress,
          completedSteps: task.completedSteps,
          pendingSteps: task.pendingSteps,
          status: task.status,
        },
      });
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

  recordTaskResult(input: {
    description: string;
    status: 'completed' | 'failed' | 'partial';
    result?: string;
    error?: string;
    currentStep?: string;
    metadata?: Record<string, any>;
  }): TaskProgress {
    const now = Date.now();
    const task: TaskProgress = {
      taskId: `task_${now}_${Math.random().toString(36).slice(2, 8)}`,
      description: input.description,
      status: input.status,
      progress: input.status === 'failed' ? 0 : 100,
      currentStep: input.currentStep,
      completedSteps: input.status === 'failed' ? [] : ['completed'],
      pendingSteps: [],
      result: input.result,
      error: input.error,
      startedAt: now,
      updatedAt: now,
    };

    this.longTermMemory.taskHistory.push(task);
    this.upsertPalaceMemory('ergasterion', `task:${task.taskId}`, {
      title: input.description,
      content: [
        `Status: ${task.status}`,
        input.currentStep ? `Current step: ${input.currentStep}` : undefined,
        input.result ? `Result: ${input.result}` : undefined,
        input.error ? `Error: ${input.error}` : undefined,
      ].filter(Boolean).join('\n'),
      zone: 'tasks',
      tags: ['task', task.status],
      metadata: {
        taskId: task.taskId,
        progress: task.progress,
        ...input.metadata,
      },
    });
    this.saveLongTermMemory();
    return task;
  }

  getLongTermMemory(): LongTermMemory {
    return JSON.parse(JSON.stringify(this.longTermMemory)) as LongTermMemory;
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

    const palaceContext = this.getNavigablePalaceContext();
    if (palaceContext) {
      contextParts.push(`记忆宫殿: ${palaceContext}`);
    }
    
    return contextParts.join('\n');
  }

  getMemoryPalace(): MemoryPalace {
    return JSON.parse(JSON.stringify(this.longTermMemory.memoryPalace)) as MemoryPalace;
  }

  getMemoryPalaceOverview(): {
    name: string;
    currentRoomId: string;
    roomCount: number;
    totalMemoryCount: number;
    rooms: Array<{ id: string; name: string; zone: MemoryPalaceZone; memoryCount: number; exits: string[] }>;
  } {
    const palace = this.longTermMemory.memoryPalace;
    const rooms = Object.values(palace.rooms).map(room => ({
      id: room.id,
      name: room.name,
      zone: room.zone,
      memoryCount: room.memories.length,
      exits: room.exits,
    }));

    return {
      name: palace.name,
      currentRoomId: palace.currentRoomId,
      roomCount: rooms.length,
      totalMemoryCount: rooms.reduce((sum, room) => sum + room.memoryCount, 0),
      rooms,
    };
  }

  getMemoryPalaceRoom(roomId?: string): MemoryPalaceRoom | undefined {
    const palace = this.longTermMemory.memoryPalace;
    const id = roomId || palace.currentRoomId;
    const room = palace.rooms[id];
    if (!room) {
      return undefined;
    }

    room.lastVisited = Date.now();
    palace.updatedAt = Date.now();
    return JSON.parse(JSON.stringify(room)) as MemoryPalaceRoom;
  }

  setCurrentPalaceRoom(roomId: string): boolean {
    const palace = this.longTermMemory.memoryPalace;
    if (!palace.rooms[roomId]) {
      return false;
    }

    palace.currentRoomId = roomId;
    palace.rooms[roomId].lastVisited = Date.now();
    palace.updatedAt = Date.now();
    this.saveLongTermMemory();
    return true;
  }

  searchMemoryPalace(query: string): MemoryPalaceItem[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const results: MemoryPalaceItem[] = [];
    for (const room of Object.values(this.longTermMemory.memoryPalace.rooms)) {
      for (const item of room.memories) {
        const haystack = `${item.title}\n${item.content}\n${item.tags.join(' ')}`.toLowerCase();
        if (haystack.includes(normalized)) {
          results.push(JSON.parse(JSON.stringify(item)) as MemoryPalaceItem);
        }
      }
    }

    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getNavigablePalaceContext(maxItemsPerRoom = 2): string {
    const palace = this.longTermMemory.memoryPalace;
    const room = palace.rooms[palace.currentRoomId];
    if (!room) {
      return '';
    }

    const items = room.memories.slice(-maxItemsPerRoom).map(item => item.title).join(', ');
    const exits = room.exits.map(exitId => palace.rooms[exitId]?.name || exitId).join(', ');
    return `${room.name}，陈列: ${items || '暂无'}，可前往: ${exits || '无'}`;
  }

  private upsertPalaceMemory(
    roomId: string,
    anchor: string,
    input: {
      title: string;
      content: string;
      zone: MemoryPalaceZone;
      tags: string[];
      metadata?: Record<string, any>;
    },
  ): void {
    const palace = this.longTermMemory.memoryPalace;
    const room = palace.rooms[roomId];
    if (!room) {
      return;
    }

    const now = Date.now();
    const existing = room.memories.find(item => item.anchor === anchor);
    if (existing) {
      existing.title = input.title;
      existing.content = input.content;
      existing.tags = input.tags;
      existing.zone = input.zone;
      existing.metadata = input.metadata;
      existing.updatedAt = now;
    } else {
      room.memories.push({
        id: `palace_${now}_${Math.random().toString(36).slice(2, 8)}`,
        anchor,
        title: input.title,
        content: input.content,
        zone: input.zone,
        tags: input.tags,
        createdAt: now,
        updatedAt: now,
        metadata: input.metadata,
      });
    }

    room.lastVisited = now;
    palace.updatedAt = now;

    if (room.memories.length > 120) {
      room.memories = room.memories.slice(-120);
    }
  }
}

export function createEnhancedMemoryManager(baseDir?: string): EnhancedMemoryManager {
  return new EnhancedMemoryManager(baseDir);
}
