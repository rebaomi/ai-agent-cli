import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

export type ManagedTaskStatus = 'pending' | 'in_progress' | 'completed' | 'stopped' | 'failed';

export interface ManagedTask {
  id: string;
  title: string;
  description?: string;
  status: ManagedTaskStatus;
  output?: string;
  assignee?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ManagedTeam {
  id: string;
  name: string;
  description?: string;
  members: string[];
  createdAt: number;
  updatedAt: number;
}

export interface AgentMessage {
  id: string;
  target: string;
  message: string;
  createdAt: number;
}

interface TaskStore {
  tasks: ManagedTask[];
  teams: ManagedTeam[];
  inbox: Record<string, AgentMessage[]>;
}

const EMPTY_STORE: TaskStore = {
  tasks: [],
  teams: [],
  inbox: {},
};

export class TaskManager {
  private storeDir: string;
  private storeFile: string;
  private store: TaskStore = { tasks: [], teams: [], inbox: {} };

  constructor(storeDir?: string) {
    this.storeDir = storeDir || path.join(os.homedir(), '.ai-agent-cli', 'tasks');
    this.storeFile = path.join(this.storeDir, 'store.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
    await this.load();
  }

  async createTask(input: {
    title: string;
    description?: string;
    status?: ManagedTaskStatus;
    output?: string;
    assignee?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ManagedTask> {
    const now = Date.now();
    const task: ManagedTask = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      status: input.status || 'pending',
      output: input.output,
      assignee: input.assignee,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.store.tasks.unshift(task);
    await this.save();
    return task;
  }

  listTasks(status?: ManagedTaskStatus): ManagedTask[] {
    if (!status) {
      return [...this.store.tasks].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    return this.store.tasks
      .filter(task => task.status === status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getTask(id: string): ManagedTask | undefined {
    return this.store.tasks.find(task => task.id === id);
  }

  async updateTask(id: string, updates: Partial<Pick<ManagedTask, 'title' | 'description' | 'status' | 'output' | 'assignee' | 'metadata'>>): Promise<ManagedTask | null> {
    const task = this.getTask(id);
    if (!task) {
      return null;
    }

    Object.assign(task, updates, { updatedAt: Date.now() });
    await this.save();
    return task;
  }

  async stopTask(id: string, reason?: string): Promise<ManagedTask | null> {
    const task = this.getTask(id);
    if (!task) {
      return null;
    }

    task.status = 'stopped';
    task.output = reason ? [task.output, `Stopped: ${reason}`].filter(Boolean).join('\n') : task.output;
    task.updatedAt = Date.now();
    await this.save();
    return task;
  }

  async createTeam(input: { name: string; description?: string; members?: string[] }): Promise<ManagedTeam> {
    const now = Date.now();
    const team: ManagedTeam = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      members: input.members || [],
      createdAt: now,
      updatedAt: now,
    };

    this.store.teams.unshift(team);
    await this.save();
    return team;
  }

  async deleteTeam(idOrName: string): Promise<ManagedTeam | null> {
    const index = this.store.teams.findIndex(team => team.id === idOrName || team.name === idOrName);
    if (index === -1) {
      return null;
    }

    const [team] = this.store.teams.splice(index, 1);
    await this.save();
    return team || null;
  }

  listTeams(): ManagedTeam[] {
    return [...this.store.teams].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async sendMessage(target: string, message: string): Promise<AgentMessage> {
    const item: AgentMessage = {
      id: randomUUID(),
      target,
      message,
      createdAt: Date.now(),
    };

    if (!this.store.inbox[target]) {
      this.store.inbox[target] = [];
    }

    this.store.inbox[target].push(item);
    await this.createTask({
      title: `Message for ${target}`,
      description: message,
      status: 'completed',
      assignee: target,
      output: 'Message queued locally',
      metadata: { kind: 'agent_message', messageId: item.id },
    });
    await this.save();
    return item;
  }

  listPeers(): Array<{ id: string; type: 'agent' | 'team'; description?: string }> {
    const peers: Array<{ id: string; type: 'agent' | 'team'; description?: string }> = [
      { id: 'default', type: 'agent', description: 'Default assistant agent' },
    ];

    for (const team of this.store.teams) {
      peers.push({
        id: team.name,
        type: 'team',
        description: team.description,
      });
    }

    for (const agentId of Object.keys(this.store.inbox)) {
      if (!peers.some(peer => peer.id === agentId)) {
        peers.push({ id: agentId, type: 'agent', description: 'Local peer inbox' });
      }
    }

    return peers;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storeFile, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<TaskStore>;
      this.store = {
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        teams: Array.isArray(parsed.teams) ? parsed.teams : [],
        inbox: parsed.inbox && typeof parsed.inbox === 'object' ? parsed.inbox : {},
      };
    } catch {
      this.store = { tasks: [], teams: [], inbox: {} };
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
    await fs.writeFile(this.storeFile, JSON.stringify(this.store, null, 2), 'utf-8');
  }
}

export function createTaskManager(storeDir?: string): TaskManager {
  return new TaskManager(storeDir);
}