import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { z } from 'zod';
import type { Message } from '../types/index.js';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_calls: z.array(z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  })).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  timestamp: z.number().optional(),
});

const historySchema = z.object({
  version: z.string(),
  sessions: z.record(z.array(messageSchema)),
});

type HistoryData = z.infer<typeof historySchema>;

export class MemoryManager {
  private historyDir: string;
  private currentSessionId: string;
  private maxMessagesPerSession: number;
  private currentMessages: Message[] = [];
  private sessionStateFile: string;

  constructor(historyDir?: string, maxMessagesPerSession = 100) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.historyDir = historyDir || join(homeDir, '.ai-agent-cli', 'history');
    this.currentSessionId = this.generateSessionId();
    this.maxMessagesPerSession = maxMessagesPerSession;
    this.sessionStateFile = join(dirname(this.historyDir), 'runtime', 'current-session.json');
  }

  private generateSessionId(): string {
    const now = new Date();
    return `session_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${Date.now()}`;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.historyDir, { recursive: true });
    await fs.mkdir(dirname(this.sessionStateFile), { recursive: true });

    const pinnedSessionId = await this.loadPinnedSessionId();
    if (pinnedSessionId) {
      this.currentSessionId = pinnedSessionId;
      const loaded = await this.loadSessionById(pinnedSessionId);
      if (!loaded) {
        this.currentMessages = [];
        await this.saveSessionState();
      }
      return;
    }

    await this.loadCurrentSession();

    if (this.currentMessages.length === 0) {
      await this.loadLatestSession();
    }

    await this.saveSessionState();
  }

  private getHistoryFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return join(this.historyDir, `history_${date}.json`);
  }

  private async loadCurrentSession(): Promise<void> {
    try {
      const historyFile = this.getHistoryFilePath();
      const content = await fs.readFile(historyFile, 'utf-8');
      const data = JSON.parse(content) as HistoryData;
      
      const session = data.sessions[this.currentSessionId];
      if (session) {
        this.currentMessages = session.map(m => ({
          ...m,
          timestamp: m.timestamp,
        }));
      }
    } catch {
      this.currentMessages = [];
    }
  }

  private async loadLatestSession(): Promise<void> {
    try {
      const sessions = await this.listSessions();
      const latest = sessions[0];
      if (latest) {
        await this.loadSession(latest.id);
      }
    } catch {
      this.currentMessages = [];
    }
  }

  private async saveHistory(): Promise<void> {
    try {
      const historyFile = this.getHistoryFilePath();
      let data: HistoryData = {
        version: '1.0',
        sessions: {},
      };

      try {
        const content = await fs.readFile(historyFile, 'utf-8');
        data = JSON.parse(content) as HistoryData;
      } catch {
        // File doesn't exist, use default
      }

      data.sessions[this.currentSessionId] = this.currentMessages.map(m => ({
        ...m,
        timestamp: Date.now(),
      }));

      await fs.writeFile(historyFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save history:', error);
    }
  }

  addMessage(message: Message): void {
    this.currentMessages.push(message);
    
    if (this.currentMessages.length > this.maxMessagesPerSession) {
      this.currentMessages = this.currentMessages.slice(-this.maxMessagesPerSession);
    }
    
    this.saveHistory().catch(console.error);
    this.saveSessionState().catch(console.error);
  }

  getMessages(): Message[] {
    return [...this.currentMessages];
  }

  setMessages(messages: Message[]): void {
    this.currentMessages = messages;
    this.saveHistory().catch(console.error);
    this.saveSessionState().catch(console.error);
  }

  clearHistory(): void {
    this.currentMessages = [];
    this.saveHistory().catch(console.error);
    this.saveSessionState().catch(console.error);
  }

  async listSessions(): Promise<Array<{ id: string; messageCount: number; lastUpdated: number }>> {
    const sessions: Array<{ id: string; messageCount: number; lastUpdated: number }> = [];
    
    try {
      const files = await fs.readdir(this.historyDir);
      for (const file of files) {
        if (file.startsWith('history_') && file.endsWith('.json')) {
          const content = await fs.readFile(join(this.historyDir, file), 'utf-8');
          const data = JSON.parse(content) as HistoryData;
          
          for (const [sessionId, messages] of Object.entries(data.sessions)) {
            const lastMsg = messages[messages.length - 1];
            sessions.push({
              id: sessionId,
              messageCount: messages.length,
              lastUpdated: lastMsg?.timestamp || 0,
            });
          }
        }
      }
    } catch {
      // Ignore errors
    }

    return sessions.sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  async loadSession(sessionId: string): Promise<boolean> {
    const loaded = await this.loadSessionById(sessionId);
    if (loaded) {
      await this.saveSessionState();
    }
    return loaded;
  }

  newSession(): void {
    this.currentSessionId = this.generateSessionId();
    this.currentMessages = [];
    this.saveSessionState().catch(console.error);
  }

  getCurrentSessionId(): string {
    return this.currentSessionId;
  }

  getContextSummary(maxLength = 500): string {
    const recent = this.currentMessages.slice(-10);
    const summary = recent.map(m => `${m.role}: ${m.content.slice(0, 100)}`).join('\n');
    return summary.length > maxLength ? summary.slice(0, maxLength) + '...' : summary;
  }

  private async loadSessionById(sessionId: string): Promise<boolean> {
    try {
      const files = await fs.readdir(this.historyDir);
      for (const file of files) {
        if (file.startsWith('history_') && file.endsWith('.json')) {
          const content = await fs.readFile(join(this.historyDir, file), 'utf-8');
          const data = JSON.parse(content) as HistoryData;
          
          if (data.sessions[sessionId]) {
            this.currentSessionId = sessionId;
            this.currentMessages = data.sessions[sessionId];
            return true;
          }
        }
      }
    } catch {
      // Ignore errors
    }
    return false;
  }

  private async loadPinnedSessionId(): Promise<string | null> {
    try {
      const raw = await fs.readFile(this.sessionStateFile, 'utf-8');
      const parsed = JSON.parse(raw) as { currentSessionId?: string };
      return typeof parsed.currentSessionId === 'string' && parsed.currentSessionId.trim().length > 0
        ? parsed.currentSessionId.trim()
        : null;
    } catch {
      return null;
    }
  }

  private async saveSessionState(): Promise<void> {
    try {
      await fs.writeFile(this.sessionStateFile, JSON.stringify({
        currentSessionId: this.currentSessionId,
        updatedAt: Date.now(),
      }, null, 2), 'utf-8');
    } catch (error) {
      console.error('Failed to save current session state:', error);
    }
  }
}

export function createMemoryManager(historyDir?: string, maxMessages?: number): MemoryManager {
  return new MemoryManager(historyDir, maxMessages);
}
