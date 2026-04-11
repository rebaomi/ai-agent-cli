import { promises as fs } from 'fs';
import * as path from 'path';
import type { AgentGraphCheckpoint, SessionTaskChannel, SessionTaskRecord, SessionTaskStatus } from '../types/index.js';

export interface SessionTaskBinding {
  isFollowUp: boolean;
  boundTask?: SessionTaskRecord;
  effectiveInput: string;
}

export interface SessionTaskRecordInput {
  channel: SessionTaskChannel;
  title: string;
  input: string;
  effectiveInput?: string;
  category?: string;
  handlerName?: string;
  status: SessionTaskStatus;
  metadata?: Record<string, unknown>;
}

export interface SessionTaskBindingRelation {
  sourceTask: SessionTaskRecord;
  targetTask?: SessionTaskRecord;
  targetTaskId: string;
  targetTaskTitle?: string;
}

export interface SessionTaskContextSnapshot {
  activeTask?: SessionTaskRecord;
  bindableTask?: SessionTaskRecord;
  recentTasks: SessionTaskRecord[];
  recentBindings: SessionTaskBindingRelation[];
  checkpoint?: AgentGraphCheckpoint;
}

interface PersistedSessionTaskStack {
  version: '1.1';
  records: SessionTaskRecord[];
  checkpoint?: AgentGraphCheckpoint;
}

export class SessionTaskStackManager {
  private readonly records: SessionTaskRecord[] = [];
  private checkpoint?: AgentGraphCheckpoint;

  constructor(private readonly maxRecords = 12) {}

  resolveInput(input: string): SessionTaskBinding {
    const trimmed = input.trim();
    if (!trimmed) {
      return { isFollowUp: false, effectiveInput: input };
    }

    const boundTask = this.findBindableTask(trimmed);
    if (!boundTask) {
      return { isFollowUp: false, effectiveInput: input };
    }

    return {
      isFollowUp: true,
      boundTask,
      effectiveInput: [
        `延续上一任务：${boundTask.title}`,
        `上一任务内容：${boundTask.effectiveInput || boundTask.input}`,
        '要求：默认保持上一任务的核心目标、交付动作和目标渠道；如果这次跟进只修改格式、路径、标题、发送方式或局部步骤，应在不丢失原目标的前提下调整。',
        `用户跟进：${trimmed}`,
      ].join('\n'),
    };
  }

  recordTask(input: SessionTaskRecordInput): SessionTaskRecord {
    const timestamp = new Date().toISOString();
    const record: SessionTaskRecord = {
      id: createTaskId(),
      channel: input.channel,
      title: input.title,
      input: input.input,
      effectiveInput: input.effectiveInput,
      category: input.category,
      handlerName: input.handlerName,
      status: input.status,
      metadata: input.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.records.unshift(record);
    if (this.records.length > this.maxRecords) {
      this.records.length = this.maxRecords;
    }

    return record;
  }

  getLatestTask(): SessionTaskRecord | undefined {
    return this.records[0];
  }

  getBindableTask(): SessionTaskRecord | undefined {
    return this.records.find(record => record.status === 'completed' || record.status === 'failed');
  }

  listTasks(): SessionTaskRecord[] {
    return [...this.records];
  }

  getContextSnapshot(limit = 5): SessionTaskContextSnapshot {
    const recentTasks = this.records.slice(0, Math.max(1, limit));
    const recordMap = new Map(this.records.map(record => [record.id, record]));
    const recentBindings = recentTasks
      .map(task => this.extractBindingRelation(task, recordMap))
      .filter((relation): relation is SessionTaskBindingRelation => Boolean(relation));

    return {
      activeTask: recentTasks[0],
      bindableTask: this.getBindableTask(),
      recentTasks,
      recentBindings,
      checkpoint: this.checkpoint,
    };
  }

  getCheckpoint(): AgentGraphCheckpoint | undefined {
    return this.checkpoint;
  }

  setCheckpoint(checkpoint?: AgentGraphCheckpoint): void {
    this.checkpoint = checkpoint;
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedSessionTaskStack;
      if (!parsed || !Array.isArray(parsed.records)) {
        this.clear();
        return;
      }

      this.records.length = 0;
      this.records.push(...parsed.records.filter(isSessionTaskRecord).slice(0, this.maxRecords));
      this.checkpoint = isAgentGraphCheckpoint(parsed.checkpoint) ? parsed.checkpoint : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.clear();
        return;
      }
      throw error;
    }
  }

  async saveToFile(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload: PersistedSessionTaskStack = {
      version: '1.1',
      records: this.listTasks(),
      checkpoint: this.checkpoint,
    };
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  clear(): void {
    this.records.length = 0;
    this.checkpoint = undefined;
  }

  private findBindableTask(input: string): SessionTaskRecord | undefined {
    if (!this.isFollowUpLikeInput(input)) {
      return undefined;
    }

    return this.getBindableTask();
  }

  private extractBindingRelation(task: SessionTaskRecord, recordMap: Map<string, SessionTaskRecord>): SessionTaskBindingRelation | undefined {
    const boundTaskId = typeof task.metadata?.boundTaskId === 'string' ? task.metadata.boundTaskId : undefined;
    const boundTaskTitle = typeof task.metadata?.boundTaskTitle === 'string' ? task.metadata.boundTaskTitle : undefined;
    if (!boundTaskId) {
      return undefined;
    }

    return {
      sourceTask: task,
      targetTaskId: boundTaskId,
      targetTask: recordMap.get(boundTaskId),
      targetTaskTitle: boundTaskTitle,
    };
  }

  private isFollowUpLikeInput(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) {
      return false;
    }

    if (/^(继续|继续一下|继续执行|接着来|恢复|再来|再做一次|重来|重新来|按刚才那个方式|按刚才|照刚才|像刚才那样|同样方式|同样的方法|还是按刚才|基于刚才|沿用刚才)$/i.test(trimmed)) {
      return true;
    }

    if (trimmed.length <= 24 && /(?:继续|再来|按刚才|照刚才|刚才那个|刚刚那个|同样方式|同样的方法|像刚才那样|还是那个|再做一遍)/i.test(trimmed)) {
      return true;
    }

    if (trimmed.length <= 40 && this.isShortAdjustmentLikeInput(trimmed)) {
      return true;
    }

    return false;
  }

  private isShortAdjustmentLikeInput(input: string): boolean {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return false;
    }

    const adjustmentLead = /^(?:改成|改为|换成|换为|转成|转为|转换成|转换为|另存为|保存成|保存为|导出成|导出为|整理成|生成|做成|那就改成|那就换成|直接改成|直接换成|或者|要不|那就|直接|顺便)/i;
    const targetHint = /(?:word|docx|pdf|pptx?|xlsx|markdown|md|txt|文档|报告|附件|飞书|lark|发我|发给我|发到飞书|发给飞书|发我飞书|发送到飞书|发送给飞书)/i;
    const deliveryOnly = /^(?:发我飞书|发到飞书|发给飞书|直接发飞书|顺便发我飞书|再发我飞书|发我|发给我)$/i;

    return deliveryOnly.test(normalized) || (adjustmentLead.test(normalized) && targetHint.test(normalized));
  }
}

function createTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isSessionTaskRecord(value: unknown): value is SessionTaskRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.channel === 'string'
    && typeof record.title === 'string'
    && typeof record.input === 'string'
    && typeof record.status === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string';
}

function isAgentGraphCheckpoint(value: unknown): value is AgentGraphCheckpoint {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const checkpoint = value as Record<string, unknown>;
  return typeof checkpoint.node === 'string'
    && typeof checkpoint.status === 'string'
    && typeof checkpoint.updatedAt === 'string';
}
