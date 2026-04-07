import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { ToolResult } from '../types/index.js';

export interface CronJobDefinition {
  id: string;
  name: string;
  schedule: string;
  toolName: string;
  args: Record<string, unknown>;
  enabled: boolean;
  description?: string;
  timezone?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastRunKey?: string;
  nextRunAt?: number;
}

type CronExecutor = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
type CronNotifier = (payload: { job: CronJobDefinition; result: ToolResult }) => Promise<void> | void;

export class CronManager {
  private storeDir: string;
  private storeFile: string;
  private jobs: CronJobDefinition[] = [];
  private timer?: NodeJS.Timeout;
  private executor?: CronExecutor;
  private notifier?: CronNotifier;

  constructor(storeDir?: string) {
    this.storeDir = storeDir || path.join(os.homedir(), '.ai-agent-cli', 'cron');
    this.storeFile = path.join(this.storeDir, 'jobs.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
    await this.load();
  }

  setExecutor(executor: CronExecutor): void {
    this.executor = executor;
  }

  setNotifier(notifier: CronNotifier): void {
    this.notifier = notifier;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runDueJobs();
    }, 30_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async createJob(input: {
    name: string;
    schedule: string;
    toolName: string;
    args?: Record<string, unknown>;
    enabled?: boolean;
    description?: string;
    timezone?: string;
  }): Promise<CronJobDefinition> {
    this.validateSchedule(input.schedule);

    const now = Date.now();
    const job: CronJobDefinition = {
      id: randomUUID(),
      name: input.name,
      schedule: input.schedule,
      toolName: input.toolName,
      args: input.args || {},
      enabled: input.enabled ?? true,
      description: input.description,
      timezone: input.timezone,
      createdAt: now,
      updatedAt: now,
      nextRunAt: this.computeNextRunAt(input.schedule, new Date(now), input.timezone),
    };

    this.jobs.unshift(job);
    await this.save();
    return job;
  }

  listJobs(): CronJobDefinition[] {
    return [...this.jobs].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteJob(idOrName: string): Promise<CronJobDefinition | null> {
    const index = this.jobs.findIndex(job => job.id === idOrName || job.name === idOrName);
    if (index === -1) {
      return null;
    }

    const [job] = this.jobs.splice(index, 1);
    await this.save();
    return job || null;
  }

  async runDueJobs(now = new Date()): Promise<void> {
    if (!this.executor) {
      return;
    }

    for (const job of this.jobs) {
      if (!job.enabled) {
        continue;
      }

      if (!this.matchesSchedule(job.schedule, now, job.timezone)) {
        continue;
      }

      const runKey = this.toRunKey(now, job.timezone);
      if (job.lastRunKey === runKey) {
        continue;
      }

      const result = await this.executor(job.toolName, job.args);
      job.lastRunAt = now.getTime();
      job.lastRunKey = runKey;
      job.updatedAt = Date.now();
      job.nextRunAt = this.computeNextRunAt(job.schedule, now, job.timezone);
      await this.save();

      if (this.notifier) {
        await this.notifier({ job, result });
      }
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.storeFile, 'utf-8');
      const parsed = JSON.parse(raw);
      this.jobs = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.jobs = [];
      await this.save();
    }
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
    await fs.writeFile(this.storeFile, JSON.stringify(this.jobs, null, 2), 'utf-8');
  }

  private validateSchedule(schedule: string): void {
    const trimmed = schedule.trim();
    if (/^@(hourly|daily|weekly|monthly)$/i.test(trimmed)) {
      return;
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) {
      throw new Error('Cron schedule must contain 5 fields, e.g. "0 8 * * *"');
    }

    for (const field of fields) {
      if (!/^([*]|\*\/\d+|\d+|\d+-\d+|\d+(,\d+)*|\d+-\d+(,\d+-\d+)*|\*?(\/\d+)?)$/.test(field)) {
        throw new Error(`Unsupported cron field: ${field}`);
      }
    }
  }

  private matchesSchedule(schedule: string, now: Date, timezone?: string): boolean {
    const normalized = this.normalizeSchedule(schedule);
    const fields = normalized.split(/\s+/);
    if (fields.length !== 5) {
      return false;
    }

    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
    const parts = this.getDateParts(now, timezone);

    return this.matchesField(minute, parts.minute, 0, 59)
      && this.matchesField(hour, parts.hour, 0, 23)
      && this.matchesField(dayOfMonth, parts.dayOfMonth, 1, 31)
      && this.matchesField(month, parts.month, 1, 12)
      && this.matchesField(dayOfWeek, parts.dayOfWeek, 0, 6);
  }

  private normalizeSchedule(schedule: string): string {
    switch (schedule.trim().toLowerCase()) {
      case '@hourly':
        return '0 * * * *';
      case '@daily':
        return '0 8 * * *';
      case '@weekly':
        return '0 8 * * 1';
      case '@monthly':
        return '0 8 1 * *';
      default:
        return schedule.trim();
    }
  }

  private matchesField(field: string, value: number, min: number, max: number): boolean {
    if (field === '*') {
      return true;
    }

    if (field.includes(',')) {
      return field.split(',').some(part => this.matchesField(part, value, min, max));
    }

    if (field.startsWith('*/')) {
      const step = Number(field.slice(2));
      return Number.isFinite(step) && step > 0 && value % step === 0;
    }

    if (field.includes('-')) {
      const range = field.split('-').map(Number);
      if (range.length !== 2) {
        return false;
      }

      const [start, end] = range as [number, number];
      return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end;
    }

    const exact = Number(field);
    return Number.isFinite(exact) && exact >= min && exact <= max && exact === value;
  }

  private getDateParts(date: Date, timezone?: string): {
    minute: number;
    hour: number;
    dayOfMonth: number;
    month: number;
    dayOfWeek: number;
  } {
    if (!timezone) {
      return {
        minute: date.getMinutes(),
        hour: date.getHours(),
        dayOfMonth: date.getDate(),
        month: date.getMonth() + 1,
        dayOfWeek: date.getDay(),
      };
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      minute: '2-digit',
      hour: '2-digit',
      day: '2-digit',
      month: '2-digit',
      weekday: 'short',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find(part => part.type === type)?.value || '0';
    const weekdayToken = get('weekday').toLowerCase();
    const weekdayMap: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };

    return {
      minute: Number(get('minute')),
      hour: Number(get('hour')),
      dayOfMonth: Number(get('day')),
      month: Number(get('month')),
      dayOfWeek: weekdayMap[weekdayToken] ?? 0,
    };
  }

  private computeNextRunAt(schedule: string, from: Date, timezone?: string): number | undefined {
    const cursor = new Date(from.getTime());
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);

    for (let index = 0; index < 44_640; index++) {
      if (this.matchesSchedule(schedule, cursor, timezone)) {
        return cursor.getTime();
      }
      cursor.setMinutes(cursor.getMinutes() + 1);
    }

    return undefined;
  }

  private toRunKey(date: Date, timezone?: string): string {
    const parts = this.getDateParts(date, timezone);
    return [parts.month, parts.dayOfMonth, parts.hour, parts.minute].map(part => String(part).padStart(2, '0')).join('-');
  }
}

export function createCronManager(storeDir?: string): CronManager {
  return new CronManager(storeDir);
}