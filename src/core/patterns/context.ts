import { EventEmitter } from 'events';
import type { Agent } from '../agent.js';

export interface PatternContext {
  agentId: string;
  patternName: string;
  state: Map<string, any>;
}

export class PatternContextManager {
  private contexts: Map<string, PatternContext> = new Map();
  private emitter = new EventEmitter();

  createContext(agentId: string, patternName: string): PatternContext {
    const context: PatternContext = {
      agentId,
      patternName,
      state: new Map(),
    };
    this.contexts.set(agentId, context);
    return context;
  }

  getContext(agentId: string): PatternContext | undefined {
    return this.contexts.get(agentId);
  }

  setState(agentId: string, key: string, value: any): void {
    const context = this.contexts.get(agentId);
    if (context) {
      context.state.set(key, value);
      this.emitter.emit('stateChanged', { agentId, key, value });
    }
  }

  getState(agentId: string, key: string): any {
    return this.contexts.get(agentId)?.state.get(key);
  }

  removeContext(agentId: string): void {
    this.contexts.delete(agentId);
  }

  onStateChanged(callback: (data: { agentId: string; key: string; value: any }) => void): void {
    this.emitter.on('stateChanged', callback);
  }
}

export const patternContextManager = new PatternContextManager();
