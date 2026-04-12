import test from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceMonitor } from '../src/core/monitoring/performance-monitor.js';

test('PerformanceMonitor tracks context size, response times, and permission hits', () => {
  const monitor = new PerformanceMonitor();
  monitor.trackContextSize([
    { content: 'hello' },
    { content: 'world world world world' },
  ]);
  monitor.trackResponseTime('chat', 120);
  monitor.trackResponseTime('chat', 240);
  monitor.trackPermissionHits('command_execute');
  monitor.trackPermissionHits('command_execute');

  const snapshot = monitor.getSnapshot();
  assert.equal(snapshot.contextSize.lastMessageCount, 2);
  assert.equal(snapshot.responseTimes[0]?.label, 'chat');
  assert.equal(snapshot.responseTimes[0]?.count, 2);
  assert.equal(snapshot.recentResponseTimes.length, 2);
  assert.equal(snapshot.permissionHits.byType.command_execute, 2);
});

test('PerformanceMonitor can reset accumulated metrics', () => {
  const monitor = new PerformanceMonitor();
  monitor.trackContextSize([{ content: 'hello' }]);
  monitor.trackResponseTime('chat', 120);
  monitor.trackPermissionHits('command_execute');

  monitor.reset();

  const snapshot = monitor.getSnapshot();
  assert.equal(snapshot.contextSize.sampleCount, 0);
  assert.equal(snapshot.responseTimes.length, 0);
  assert.equal(snapshot.recentResponseTimes.length, 0);
  assert.equal(snapshot.permissionHits.total, 0);
});