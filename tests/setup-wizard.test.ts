import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSetupWizardConfigPatch } from '../src/core/setup-wizard.js';

test('setup wizard maps selections into runtime config', () => {
  const patch = buildSetupWizardConfigPatch({
    outputMode: 'quiet',
    agentcatMode: 'desktop',
    checkpointLevel: 'minimal',
  }, {
    ollama: { baseUrl: 'http://localhost:11434', model: 'stub' },
  } as any);

  assert.equal(patch.output.verbosity, 'quiet');
  assert.equal(patch.output.agentcat?.mode, 'desktop');
  assert.equal(patch.output.agentcat?.useDesktopNotification, true);
  assert.equal(patch.checkpoints.level, 'minimal');
  assert.equal(patch.checkpoints.planApproval, false);
  assert.equal(patch.setupWizard.completed, true);
});