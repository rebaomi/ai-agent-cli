import test from 'node:test';
import assert from 'node:assert/strict';
import { ContextBus } from '../src/core/context-bus.js';

test('ContextBus preserves parent context across agents', () => {
  const bus = new ContextBus();
  const parent = bus.pushAgentContext({
    agentId: 'agent1',
    scopeId: 'scope-1',
    state: { data: 'test' },
    title: 'agent1',
  });

  bus.pushAgentContext({
    agentId: 'agent2',
    scopeId: 'scope-1',
    state: { step: 'child' },
    parentSnapshotId: parent.id,
    title: 'agent2',
  });

  const context = bus.getContextForAgent('agent2', { scopeId: 'scope-1', includeParent: true, includeMemory: true });
  assert.equal(context.parent?.payload.metadata?.state?.data, 'test');
  assert.equal(context.chain.length, 2);
});