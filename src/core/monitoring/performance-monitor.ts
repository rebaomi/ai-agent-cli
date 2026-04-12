import type { Message } from '../../types/index.js';
import type { PermissionType } from '../permission-manager.js';

export interface ContextSizeSnapshot {
  sampleCount: number;
  lastMessageCount: number;
  maxMessageCount: number;
  lastApproxTokens: number;
  maxApproxTokens: number;
}

export interface ResponseTimeSnapshot {
  label: string;
  count: number;
  lastMs: number;
  avgMs: number;
  maxMs: number;
}

export interface ResponseTimeEvent {
  label: string;
  durationMs: number;
  recordedAt: string;
}

export interface PermissionHitSnapshot {
  total: number;
  byType: Record<string, number>;
}

export interface PerformanceMonitorSnapshot {
  contextSize: ContextSizeSnapshot;
  responseTimes: ResponseTimeSnapshot[];
  recentResponseTimes: ResponseTimeEvent[];
  permissionHits: PermissionHitSnapshot;
}

export class PerformanceMonitor {
  private contextSize: ContextSizeSnapshot = {
    sampleCount: 0,
    lastMessageCount: 0,
    maxMessageCount: 0,
    lastApproxTokens: 0,
    maxApproxTokens: 0,
  };

  private readonly responseTimes = new Map<string, { count: number; totalMs: number; lastMs: number; maxMs: number }>();
  private readonly recentResponseTimes: ResponseTimeEvent[] = [];
  private permissionHitsTotal = 0;
  private readonly permissionHitsByType = new Map<string, number>();

  trackContextSize(messages: Array<Pick<Message, 'content'>>): ContextSizeSnapshot {
    const lastMessageCount = messages.length;
    const lastApproxTokens = messages.reduce((sum, message) => sum + Math.ceil((message.content || '').length / 4), 0);

    this.contextSize = {
      sampleCount: this.contextSize.sampleCount + 1,
      lastMessageCount,
      maxMessageCount: Math.max(this.contextSize.maxMessageCount, lastMessageCount),
      lastApproxTokens,
      maxApproxTokens: Math.max(this.contextSize.maxApproxTokens, lastApproxTokens),
    };

    return { ...this.contextSize };
  }

  trackResponseTime(label: string, durationMs: number): ResponseTimeSnapshot {
    const current = this.responseTimes.get(label) || { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += durationMs;
    current.lastMs = durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    this.responseTimes.set(label, current);
    this.recentResponseTimes.push({
      label,
      durationMs,
      recordedAt: new Date().toISOString(),
    });
    if (this.recentResponseTimes.length > 20) {
      this.recentResponseTimes.splice(0, this.recentResponseTimes.length - 20);
    }

    return {
      label,
      count: current.count,
      lastMs: current.lastMs,
      avgMs: current.totalMs / current.count,
      maxMs: current.maxMs,
    };
  }

  trackPermissionHits(permissionType: PermissionType | string): PermissionHitSnapshot {
    this.permissionHitsTotal += 1;
    this.permissionHitsByType.set(permissionType, (this.permissionHitsByType.get(permissionType) || 0) + 1);
    return this.getPermissionHitSnapshot();
  }

  getSnapshot(): PerformanceMonitorSnapshot {
    return {
      contextSize: { ...this.contextSize },
      responseTimes: Array.from(this.responseTimes.entries()).map(([label, stats]) => ({
        label,
        count: stats.count,
        lastMs: stats.lastMs,
        avgMs: stats.totalMs / stats.count,
        maxMs: stats.maxMs,
      })),
      recentResponseTimes: [...this.recentResponseTimes],
      permissionHits: this.getPermissionHitSnapshot(),
    };
  }

  reset(): void {
    this.contextSize = {
      sampleCount: 0,
      lastMessageCount: 0,
      maxMessageCount: 0,
      lastApproxTokens: 0,
      maxApproxTokens: 0,
    };
    this.responseTimes.clear();
    this.recentResponseTimes.splice(0, this.recentResponseTimes.length);
    this.permissionHitsTotal = 0;
    this.permissionHitsByType.clear();
  }

  formatSummary(): string {
    const snapshot = this.getSnapshot();
    const responseSummary = snapshot.responseTimes
      .map(item => `${item.label}:last=${item.lastMs.toFixed(0)}ms avg=${item.avgMs.toFixed(0)}ms max=${item.maxMs.toFixed(0)}ms count=${item.count}`)
      .join(' | ');
    return [
      `context=${snapshot.contextSize.lastMessageCount}/${snapshot.contextSize.maxMessageCount}`,
      `tokens=${snapshot.contextSize.lastApproxTokens}/${snapshot.contextSize.maxApproxTokens}`,
      `permissionHits=${snapshot.permissionHits.total}`,
      responseSummary || 'response=n/a',
    ].join(' | ');
  }

  private getPermissionHitSnapshot(): PermissionHitSnapshot {
    return {
      total: this.permissionHitsTotal,
      byType: Object.fromEntries(Array.from(this.permissionHitsByType.entries()).sort((left, right) => left[0].localeCompare(right[0]))),
    };
  }
}