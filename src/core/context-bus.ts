import type {
  ContextBusCurrentPointer,
  ContextBusLayer,
  ContextBusQuery,
  ContextBusSnapshot,
  ContextBusSnapshotPayload,
  ContextBusState,
} from '../types/index.js';
import { CONTEXT_BUS_SCHEMA_VERSION } from '../types/index.js';

export interface CaptureContextSnapshotInput {
  layer: ContextBusLayer;
  scopeId: string;
  payload: ContextBusSnapshotPayload;
  parentId?: string;
  taskId?: string;
  externalKey?: string;
  title?: string;
}

export class ContextBus {
  private readonly snapshots = new Map<string, ContextBusSnapshot>();
  private readonly currentPointers = new Map<string, ContextBusCurrentPointer>();

  constructor(initialState?: ContextBusState) {
    if (initialState) {
      this.replaceState(initialState);
    }
  }

  replaceState(state?: ContextBusState): void {
    this.snapshots.clear();
    this.currentPointers.clear();

    if (!state || state.schemaVersion !== CONTEXT_BUS_SCHEMA_VERSION) {
      return;
    }

    for (const snapshot of state.snapshots || []) {
      this.snapshots.set(snapshot.id, snapshot);
    }

    for (const pointer of state.currentPointers || []) {
      this.currentPointers.set(this.getPointerKey(pointer.layer, pointer.scopeId), pointer);
    }
  }

  exportState(): ContextBusState {
    return {
      schemaVersion: CONTEXT_BUS_SCHEMA_VERSION,
      snapshots: Array.from(this.snapshots.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      currentPointers: Array.from(this.currentPointers.values()).sort((left, right) => {
        const byScope = left.scopeId.localeCompare(right.scopeId);
        return byScope !== 0 ? byScope : left.layer.localeCompare(right.layer);
      }),
    };
  }

  captureSnapshot(input: CaptureContextSnapshotInput): ContextBusSnapshot {
    const existing = this.findByExternalKey(input.layer, input.scopeId, input.externalKey);
    const parent = input.parentId ? this.snapshots.get(input.parentId) : undefined;
    const timestamp = new Date().toISOString();

    const snapshot: ContextBusSnapshot = existing
      ? {
          ...existing,
          parentId: input.parentId ?? existing.parentId,
          rootId: parent?.rootId ?? existing.rootId,
          taskId: input.taskId ?? existing.taskId,
          externalKey: input.externalKey ?? existing.externalKey,
          title: input.title ?? existing.title,
          payload: input.payload,
          updatedAt: timestamp,
        }
      : {
          id: createContextSnapshotId(),
          layer: input.layer,
          scopeId: input.scopeId,
          rootId: parent?.rootId || '',
          parentId: input.parentId,
          taskId: input.taskId,
          externalKey: input.externalKey,
          title: input.title,
          payload: input.payload,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    if (!snapshot.rootId) {
      snapshot.rootId = parent?.rootId ?? snapshot.id;
    }

    this.snapshots.set(snapshot.id, snapshot);
    this.currentPointers.set(this.getPointerKey(input.layer, input.scopeId), {
      layer: input.layer,
      scopeId: input.scopeId,
      snapshotId: snapshot.id,
    });
    return snapshot;
  }

  getSnapshot(id: string): ContextBusSnapshot | undefined {
    return this.snapshots.get(id);
  }

  getCurrentSnapshot(layer: ContextBusLayer, scopeId: string): ContextBusSnapshot | undefined {
    const pointer = this.currentPointers.get(this.getPointerKey(layer, scopeId));
    return pointer ? this.snapshots.get(pointer.snapshotId) : undefined;
  }

  getCurrentSnapshotId(layer: ContextBusLayer, scopeId: string): string | undefined {
    return this.currentPointers.get(this.getPointerKey(layer, scopeId))?.snapshotId;
  }

  findSnapshots(query: ContextBusQuery = {}): ContextBusSnapshot[] {
    const layers = Array.isArray(query.layer) ? query.layer : query.layer ? [query.layer] : undefined;
    const normalizedText = query.text?.trim().toLowerCase();
    const snapshots = Array.from(this.snapshots.values())
      .filter((snapshot) => {
        if (layers && !layers.includes(snapshot.layer)) {
          return false;
        }
        if (query.scopeId && snapshot.scopeId !== query.scopeId) {
          return false;
        }
        if (query.rootId && snapshot.rootId !== query.rootId) {
          return false;
        }
        if (query.parentId && snapshot.parentId !== query.parentId) {
          return false;
        }
        if (query.taskId && snapshot.taskId !== query.taskId) {
          return false;
        }
        if (normalizedText) {
          const haystack = JSON.stringify(snapshot).toLowerCase();
          if (!haystack.includes(normalizedText)) {
            return false;
          }
        }
        return true;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    if (query.limit && query.limit > 0) {
      return snapshots.slice(0, query.limit);
    }

    return snapshots;
  }

  getLineage(snapshotId: string): ContextBusSnapshot[] {
    const lineage: ContextBusSnapshot[] = [];
    const visited = new Set<string>();
    let current = this.snapshots.get(snapshotId);

    while (current && !visited.has(current.id)) {
      lineage.push(current);
      visited.add(current.id);
      current = current.parentId ? this.snapshots.get(current.parentId) : undefined;
    }

    return lineage.reverse();
  }

  getChildren(parentId: string): ContextBusSnapshot[] {
    return Array.from(this.snapshots.values())
      .filter((snapshot) => snapshot.parentId === parentId)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  }

  serialize(): string {
    return JSON.stringify(this.exportState(), null, 2);
  }

  private findByExternalKey(layer: ContextBusLayer, scopeId: string, externalKey?: string): ContextBusSnapshot | undefined {
    if (!externalKey) {
      return undefined;
    }

    return Array.from(this.snapshots.values()).find((snapshot) => (
      snapshot.layer === layer
      && snapshot.scopeId === scopeId
      && snapshot.externalKey === externalKey
    ));
  }

  private getPointerKey(layer: ContextBusLayer, scopeId: string): string {
    return `${scopeId}::${layer}`;
  }
}

function createContextSnapshotId(): string {
  return `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}