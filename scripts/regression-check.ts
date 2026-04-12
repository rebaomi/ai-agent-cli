import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { parseOnboardingInput } from '../src/core/onboarding.js';
import { CLI } from '../src/cli/index.js';
import { configManager } from '../src/core/config.js';
import { APP_VERSION, buildCliLogo, getFullHelpText, getQuickHelpText, isFullHelpShortcut, isQuickHelpShortcut } from '../src/cli/cli-shell-text.js';
import { createAgent } from '../src/core/agent.js';
import { createOllamaVisionService } from '../src/core/ollama-vision-service.js';
import { createDirectActionRouter } from '../src/core/direct-action-router.js';
import { buildDirectActionRiskSummary, buildPlanCheckpointRiskText, summarizePlanCheckpointRisks } from '../src/core/checkpoint-risk.js';
import { IntentResolver } from '../src/core/intent-resolver.js';
import { BrowserSession, buildChromiumExtensionArgs } from '../src/browser-agent/runtime/browser-session.js';
import { createContextManager } from '../src/core/context-manager.js';
import { createPlanner } from '../src/core/planner.js';
import { createEnhancedMemoryManager } from '../src/core/memory-enhanced.js';
import { createMemoryManager } from '../src/core/memory.js';
import { PermissionManager } from '../src/core/permission-manager.js';
import { createTaskManager } from '../src/core/task-manager.js';
import { createCronManager } from '../src/core/cron-manager.js';
import { LSPManager } from '../src/lsp/client.js';
import { MCPClient } from '../src/mcp/client.js';
import { TOOL_DEFINITIONS, buildLarkCliArgs, buildSpawnSpec, getBaseLarkCliCandidates } from '../src/mcp/lark-bridge.js';
import { Sandbox } from '../src/sandbox/executor.js';
import { createSkillManager } from '../src/core/skills.js';
import { createToolRegistry } from '../src/core/tool-registry.js';
import { createMemoryProvider } from '../src/core/memory-provider.js';
import { BuiltInTools } from '../src/tools/builtin.js';
import { progressTracker } from '../src/utils/progress.js';
import { createOutputCoordinator } from '../src/utils/output.js';
import { getArtifactOutputDir, getDesktopPath, resolveOutputPath, resolveUserPath } from '../src/utils/path-resolution.js';
import { detectRequestedExportFormat, selectPreferredExportTool } from '../src/core/export-intent.js';
import { buildFallbackIntentContract } from '../src/core/tool-intent-contract.js';
import { validateToolCallsAgainstContract } from '../src/core/tool-call-validator.js';
import { HybridClient } from '../src/llm/providers/hybrid.js';
import { DeepSeekRouterClient } from '../src/llm/providers/deepseek-router.js';
import { LarkRelayAgent, normalizeLarkRelayConfig, parseLarkRelayMessageLine } from '../src/lark/relay-agent.js';
import { ResponseStreamCollector } from '../src/core/response-stream-collector.js';
import { FinalResponseAssembler } from '../src/core/final-response-assembler.js';
import { ResponseTurnExecutor } from '../src/core/response-turn-executor.js';
import { ResponseTurnProcessor } from '../src/core/response-turn-processor.js';
import { KnownGapManager } from '../src/core/known-gap-manager.js';
import { SkillLearningService } from '../src/core/skill-learning-service.js';
import { createModerator } from '../src/core/content-moderator.js';
import { PlannedToolArgsResolver } from '../src/core/planned-tool-args-resolver.js';
import { AgentInteractionService } from '../src/core/agent-interaction-service.js';
import { buildTaskContextJsonPayload, createAgentCheckpoint } from '../src/core/agent-graph-state.js';
import { createAgentGraphRunner } from '../src/core/agent-graph-runner.js';
import { TaskSynthesisService } from '../src/core/task-synthesis-service.js';
import { AgentToolCallService } from '../src/core/agent-tool-call-service.js';
import { ToolExecutionGuard } from '../src/core/tool-execution-guard.js';
import { DirectActionDispatchService } from '../src/core/direct-action-dispatch-service.js';
import { ChatRouter } from '../src/core/chat-router.js';
import { TaskExecutorService } from '../src/core/task-executor-service.js';
import { SessionTaskStackManager } from '../src/core/session-task-stack-manager.js';
import { DirectActionArtifactSupport } from '../src/core/direct-actions/artifact-support.js';
import { DirectActionExportSupport } from '../src/core/direct-actions/export-support.js';
import { DirectActionKnownGapSupport } from '../src/core/direct-actions/known-gap-support.js';
import { DirectActionRoutingSupport } from '../src/core/direct-actions/routing-support.js';
import { DirectActionToolSupport } from '../src/core/direct-actions/tool-support.js';
import { BrowserActionHandler } from '../src/core/direct-actions/handlers/browser-action-handler.js';
import { BrowserWorkflowService } from '../src/browser-agent/workflows/browser-workflow-service.js';
import { buildBrowserWorkflowQuickFixDrafts } from '../src/browser-agent/workflows/browser-workflow-quick-fix.js';
import { BrowserActionPlanner } from '../src/browser-agent/planner/action-planner.js';
import { runBrowserAutomation } from '../src/utils/browser-automation.js';
import { extractDocxText, validateDocxContent } from '../src/utils/docx-validation.js';
import { extractPdfText } from '../src/utils/pdf-validation.js';
import { extractPptxText } from '../src/utils/pptx-validation.js';
import { extractXlsxText } from '../src/utils/xlsx-validation.js';
import { repairHighBitAsciiMojibake } from '../src/utils/text-repair.js';
import type { LLMProviderInterface, LLMResponse, LLMStreamChunk } from '../src/llm/types.js';
import { TASK_CONTEXT_SCHEMA_VERSION } from '../src/types/index.js';
import type { Message, Tool, ToolCall } from '../src/types/index.js';

process.env.AI_AGENT_CLI_QUIET_SKILL_LOGS = '1';

const regressionTraceEnabled = process.env.AI_AGENT_CLI_REGRESSION_TRACE === '1';

async function runRegressionStep(name: string, fn: () => void | Promise<void>): Promise<void> {
  if (regressionTraceEnabled) {
    console.log(`[REGRESSION] ${name}`);
  }
  await fn();
}

async function writeMinimalDocx(target: string, text: string, title?: string): Promise<void> {
  const fullText = [title?.trim(), text].filter(Boolean).join('\n\n');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${fullText.split(/\r?\n/).map(line => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`).join('')}
  </w:body>
</w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;
  const relsXml = `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml" Id="R1"/>
</Relationships>`;
  const docRelsXml = `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
  const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const zipBuffer = buildZip([
    ['word/document.xml', Buffer.from(documentXml, 'utf-8')],
    ['word/styles.xml', Buffer.from(stylesXml, 'utf-8')],
    ['_rels/.rels', Buffer.from(relsXml, 'utf-8')],
    ['word/_rels/document.xml.rels', Buffer.from(docRelsXml, 'utf-8')],
    ['[Content_Types].xml', Buffer.from(contentTypesXml, 'utf-8')],
  ]);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, zipBuffer);
}

function buildZip(entries: Array<[string, Buffer]>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf-8');
    const compressed = deflateRawSync(content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class StubLLM implements LLMProviderInterface {
  readonly provider = 'deepseek' as const;

  async chat(): Promise<LLMResponse> {
    return { content: 'ok' };
  }

  async generate(): Promise<string> {
    return 'ok';
  }

  async *chatStream(): AsyncGenerator<LLMStreamChunk> {
    yield { content: 'ok', done: true };
  }

  async *generateStream(): AsyncGenerator<LLMStreamChunk> {
    yield { content: 'ok', done: true };
  }

  setTools(_tools: Tool[]): void {}

  async checkConnection(): Promise<boolean> {
    return true;
  }

  getModel(): string {
    return 'stub';
  }

  setModel(): void {}
}

class StaticResponseLLM extends StubLLM {
  constructor(private readonly response: string) {
    super();
  }

  override async generate(): Promise<string> {
    return this.response;
  }
}

class CountingLLM extends StaticResponseLLM {
  calls = 0;

  override async generate(): Promise<string> {
    this.calls++;
    return super.generate();
  }
}

class SequenceGenerateLLM implements LLMProviderInterface {
  readonly provider = 'deepseek' as const;

  constructor(private readonly responses: string[]) {}

  async chat(): Promise<LLMResponse> {
    return { content: await this.generate([]) };
  }

  async generate(): Promise<string> {
    return this.responses.shift() || 'ok';
  }

  setTools(_tools: Tool[]): void {}

  async checkConnection(): Promise<boolean> {
    return true;
  }

  getModel(): string {
    return 'sequence';
  }

  setModel(): void {}
}

async function testToolOutputBackflow(tempDir: string): Promise<void> {
  const filePath = path.join(tempDir, 'sample.txt');
  await fs.writeFile(filePath, 'hello regression', 'utf-8');

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();
  const tools = new BuiltInTools(sandbox, new LSPManager());

  const result = await tools.executeTool('read_file', { path: filePath });

  assert.equal(result.is_error, undefined);
  assert.equal(result.output, 'hello regression');
  assert.equal(result.content?.[0]?.text, 'hello regression');
}

async function testPermissionAskToggle(tempDir: string): Promise<void> {
  const permissionDir = path.join(tempDir, 'permissions');
  const manager = new PermissionManager(permissionDir);
  await manager.initialize();
  manager.setAskForPermissions(false);

  const granted = await manager.requestPermission('command_execute', 'curl https://example.com');
  assert.equal(granted, false);
}

async function testPermissionManagerAllowsLarkCliLocatorProbe(tempDir: string): Promise<void> {
  const permissionDir = path.join(tempDir, 'permissions-safe-probe');
  const manager = new PermissionManager(permissionDir);
  await manager.initialize();
  manager.setAskForPermissions(false);

  const windowsGranted = await manager.requestPermission('command_execute', 'where lark-cli');
  assert.equal(windowsGranted, true);

  const unixGranted = await manager.requestPermission('command_execute', 'which lark-cli');
  assert.equal(unixGranted, true);
}

async function testPermissionManagerAllowsReadOnlyShellCommands(tempDir: string): Promise<void> {
  const permissionDir = path.join(tempDir, 'permissions-readonly-shell');
  const manager = new PermissionManager(permissionDir);
  await manager.initialize();
  manager.setAskForPermissions(false);

  assert.equal(await manager.requestPermission('command_execute', 'dir'), true);
  assert.equal(await manager.requestPermission('command_execute', 'pwd'), true);
  assert.equal(await manager.requestPermission('command_execute', 'where'), true);
  assert.equal(await manager.requestPermission('command_execute', 'Get-Location'), true);
  assert.equal(await manager.requestPermission('command_execute', 'Get-ChildItem'), true);
  assert.equal(await manager.requestPermission('command_execute', 'echo hello'), false);
}

async function testPermissionManagerAllowsLarkCliHelpCommands(tempDir: string): Promise<void> {
  const permissionDir = path.join(tempDir, 'permissions-lark-help');
  const manager = new PermissionManager(permissionDir);
  await manager.initialize();
  manager.setAskForPermissions(false);

  assert.equal(await manager.requestPermission('command_execute', 'lark-cli --help'), true);
  assert.equal(await manager.requestPermission('command_execute', 'lark-cli -h'), true);
  assert.equal(await manager.requestPermission('command_execute', 'lark-cli --version'), true);
  assert.equal(await manager.requestPermission('command_execute', 'lark-cli auth status'), true);
  assert.equal(await manager.requestPermission('command_execute', 'lark-cli im +messages-send --chat-id oc_xxx --text hi'), false);
}

function testPermissionManagerParsesTaskScopedBatchAnswer(): void {
  const manager = new PermissionManager(path.join(os.tmpdir(), 'permission-parse-only'));
  const taskResult = manager.parsePermissionAnswer('task');
  assert.equal(taskResult.granted, true);
  assert.equal(taskResult.batchCurrentTask, true);

  const batchResult = manager.parsePermissionAnswer('batch');
  assert.equal(batchResult.granted, true);
  assert.equal(batchResult.batchCurrentTask, true);
}

function testOutputCoordinatorPausesNonPermissionChannels(): void {
  const delivered: Array<{ channel: string; text: string }> = [];
  const coordinator = createOutputCoordinator({
    write: (entry) => {
      delivered.push({ channel: entry.channel, text: entry.text });
    },
  });

  coordinator.pause('permission:req_1');
  coordinator.write({ channel: 'process', level: 'info', text: 'process line' });
  coordinator.write({ channel: 'notification', level: 'warning', text: 'notify line' });
  coordinator.write({ channel: 'permission', level: 'info', text: 'permission line' });

  assert.deepEqual(delivered, [{ channel: 'permission', text: 'permission line' }]);

  coordinator.resume('permission:req_1');
  assert.deepEqual(delivered, [
    { channel: 'permission', text: 'permission line' },
    { channel: 'process', text: 'process line' },
    { channel: 'notification', text: 'notify line' },
  ]);
}

async function testSandboxAllowedPathNormalization(tempDir: string): Promise<void> {
  const allowedDir = path.join(tempDir, 'sandbox');
  const siblingDir = path.join(tempDir, 'sandbox-other');
  await fs.mkdir(allowedDir, { recursive: true });
  await fs.mkdir(siblingDir, { recursive: true });

  const allowedFile = path.join(allowedDir, 'ok.txt');
  const siblingFile = path.join(siblingDir, 'blocked.txt');
  await fs.writeFile(allowedFile, 'allowed', 'utf-8');
  await fs.writeFile(siblingFile, 'blocked', 'utf-8');

  const configuredAllowedPath = process.platform === 'win32' ? allowedDir.toUpperCase() : allowedDir;
  const requestedAllowedFilePath = process.platform === 'win32' ? allowedFile.toLowerCase() : allowedFile;
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [configuredAllowedPath] });
  await sandbox.initialize();

  const content = await sandbox.readFile(requestedAllowedFilePath);
  assert.equal(content, 'allowed');

  await assert.rejects(
    sandbox.readFile(siblingFile),
    /Path not allowed/,
  );
}

async function testSandboxDefaultsToWorkspaceWhitelist(tempDir: string): Promise<void> {
  const originalCwd = process.cwd();
  const workspaceDir = path.join(tempDir, 'workspace-default');
  const outsideDir = path.join(tempDir, 'outside-default');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, 'inside.txt'), 'inside', 'utf-8');
  await fs.writeFile(path.join(outsideDir, 'outside.txt'), 'outside', 'utf-8');

  process.chdir(workspaceDir);
  try {
    const sandbox = new Sandbox({ enabled: true });
    await sandbox.initialize();
    assert.equal(await sandbox.readFile(path.join(workspaceDir, 'inside.txt')), 'inside');
    await assert.rejects(
      sandbox.readFile(path.join(outsideDir, 'outside.txt')),
      /Path not allowed/,
    );
  } finally {
    process.chdir(originalCwd);
  }
}

async function testSandboxRejectsCommandCwdOutsideWhitelist(tempDir: string): Promise<void> {
  const workspaceDir = path.join(tempDir, 'workspace-cwd');
  const outsideDir = path.join(tempDir, 'outside-cwd');
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [workspaceDir] });
  await sandbox.initialize();

  await assert.rejects(
    sandbox.execute(process.execPath, ['-e', 'console.log("ok")'], { cwd: outsideDir }),
    /Command cwd not allowed/,
  );
}

async function testSandboxHonorsShellCapabilities(tempDir: string): Promise<void> {
  const workspaceDir = path.join(tempDir, 'workspace-shell-capabilities');
  await fs.mkdir(workspaceDir, { recursive: true });

  const sandbox = new Sandbox({
    enabled: true,
    allowedPaths: [workspaceDir],
    allowCommandExecution: false,
    allowBash: false,
    allowPowerShell: false,
  });
  await sandbox.initialize();

  await assert.rejects(
    sandbox.execute(process.execPath, ['-e', 'console.log("ok")'], { cwd: workspaceDir }),
    /Command execution is disabled/,
  );

  await assert.rejects(
    sandbox.executeBash('echo hi'),
    /Bash execution is disabled/,
  );

  await assert.rejects(
    sandbox.executePowerShell('Write-Output hi'),
    /PowerShell execution is disabled/,
  );
}

async function testPhaseAwareWorkflowLintAndQuickFixes(tempDir: string): Promise<void> {
  const workflowDir = path.join(tempDir, 'browser-workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const validWorkflowPath = path.join(workflowDir, 'phase-valid.md');
  const invalidWorkflowPath = path.join(workflowDir, 'phase-invalid.md');

  await fs.writeFile(validWorkflowPath, `---
name: phase-valid
description: Valid phase-aware workflow
match:
  - example.com
priority: 100
selectorSlots:
  searchBox:
    - input[name="q"]
scripts:
  userscriptPaths:
    - ./scripts/search-helper.user.js
  userscriptMode: on
  userscriptRunAt: document-end
scriptApis:
  - name: UserscriptBridge.collectResults
    description: Return structured search results
    args:
      - name: limit
        type: number
        required: false
        description: Maximum result count
      - name: includeAds
        type: boolean
    returns:
      type: array
      shape: '{ title: string; url: string; sponsored?: boolean }'
      description: Ordered search results
---

# phase-valid

## When to Use
Use this workflow for example.com searches.

## Steps
1. Open the search page.
2. Submit the requested query.

## Success
- At least one search result is available.

## Phase Steps
### search-input
1. Fill the search box with the user query.
2. Submit the form.

### search-results
1. Read the top result cards.

## Phase Preferred Selectors
### search-input
- fill: $searchBox

### search-results
- extract: main

## Phase Done Conditions
### search-results
- textIncludes:result
`, 'utf-8');

  await fs.writeFile(invalidWorkflowPath, `---
name: phase-invalid
description: Invalid phase-aware workflow
priority: 100
phases:
  search-reslts:
    steps:
      - typo phase in frontmatter
---

# phase-invalid

## When to Use
Broken sample for regression coverage.

## Phase Steps
### search-reslts
1. Mistyped phase heading.

### detail
1. Open a detail card.

## Phase Preferred Selectors
### detail
- click: $detailCard
`, 'utf-8');

  const service = new BrowserWorkflowService({ workflowDir });
  const inspected = await service.inspectWorkflow(validWorkflowPath);
  assert.equal(inspected.phaseConfigurations['search-input']?.steps.length, 2);
  assert.equal(inspected.phaseConfigurations['search-results']?.doneConditions[0], 'textIncludes:result');
  assert.equal(inspected.scriptBinding?.userscriptPaths[0], './scripts/search-helper.user.js');
  assert.equal(inspected.scriptBinding?.userscriptMode, 'on');
  assert.equal(inspected.scriptApis?.[0]?.name, 'UserscriptBridge.collectResults');
  assert.equal(inspected.scriptApis?.[0]?.args[0]?.name, 'limit');
  assert.equal(inspected.scriptApis?.[0]?.args[0]?.type, 'number');
  assert.equal(inspected.scriptApis?.[0]?.args[0]?.required, false);
  assert.equal(inspected.scriptApis?.[0]?.returns?.type, 'array');
  assert.equal(inspected.scriptApis?.[0]?.returns?.shape, '{ title: string; url: string; sponsored?: boolean }');
  assert.equal(inspected.scriptApis?.[0]?.returns?.description, 'Ordered search results');

  const validLint = await service.lintWorkflow(validWorkflowPath);
  assert.equal(validLint.valid, true);
  assert.equal(validLint.issueCounts.errors, 0);

  const invalidLint = await service.lintWorkflow(invalidWorkflowPath);
  assert.equal(invalidLint.valid, false);
  assert.equal(invalidLint.issues.some(issue => issue.code === 'invalid-phase-name'), true);
  assert.equal(invalidLint.issues.some(issue => issue.code === 'unknown-selector-slot'), true);
  assert.equal(invalidLint.issues.some(issue => issue.code === 'missing-phase-success'), true);

  const summary = await service.lintWorkflows();
  assert.equal(summary.counts.files, 2);
  assert.equal(summary.counts.valid, 1);
  assert.equal(summary.counts.invalid, 1);
  assert.equal(summary.codeCounts.some(item => item.code === 'invalid-phase-name'), true);

  const drafts = buildBrowserWorkflowQuickFixDrafts([invalidLint]);
  assert.equal(drafts.some(draft => draft.code === 'invalid-phase-name' && draft.count === 2), true);
  assert.equal(drafts.some(draft => draft.code === 'unknown-selector-slot' && /(selectorSlots|slot)/i.test(draft.summary)), true);
}

function testSessionTaskStackContextSnapshot(): void {
  const manager = new SessionTaskStackManager();
  const baseTask = manager.recordTask({
    channel: 'direct_action',
    title: '百度搜索 AI agent',
    input: '百度搜索 AI agent',
    effectiveInput: '百度搜索 AI agent',
    category: 'browser-action',
    status: 'completed',
    metadata: { engine: 'baidu', query: 'AI agent' },
  });

  const followTask = manager.recordTask({
    channel: 'agent',
    title: '按刚才那个方式再来',
    input: '按刚才那个方式再来',
    effectiveInput: '延续上一任务：百度搜索 AI agent',
    category: 'agent',
    status: 'completed',
    metadata: {
      boundTaskId: baseTask.id,
      boundTaskTitle: baseTask.title,
    },
  });

  const snapshot = manager.getContextSnapshot(5);
  assert.equal(snapshot.activeTask?.id, followTask.id);
  assert.equal(snapshot.recentBindings.length, 1);
  assert.equal(snapshot.recentBindings[0]?.sourceTask.id, followTask.id);
  assert.equal(snapshot.recentBindings[0]?.targetTask?.id, baseTask.id);
}

function testSessionTaskStackBindsShortAdjustmentFollowUp(): void {
  const manager = new SessionTaskStackManager();
  manager.recordTask({
    channel: 'agent',
    title: '分析数据库应用并发我飞书',
    input: '帮我分析大模型在数据库领域的应用，整理成 pdf 发我飞书',
    effectiveInput: '帮我分析大模型在数据库领域的应用，整理成 pdf 发我飞书',
    category: 'agent',
    status: 'completed',
  });

  const binding = manager.resolveInput('改成word发我飞书');
  assert.equal(binding.isFollowUp, true);
  assert.match(binding.effectiveInput, /上一任务内容：.*发我飞书/);
  assert.match(binding.effectiveInput, /保持上一任务的核心目标、交付动作和目标渠道/);
  assert.match(binding.effectiveInput, /用户跟进：改成word发我飞书/);
}

function testSessionTaskStackKeepsStandaloneNewTaskUnbound(): void {
  const manager = new SessionTaskStackManager();
  manager.recordTask({
    channel: 'agent',
    title: '前一个任务',
    input: '前一个任务',
    effectiveInput: '前一个任务',
    category: 'agent',
    status: 'completed',
  });

  const binding = manager.resolveInput('帮我分析一下今天 AI 新闻');
  assert.equal(binding.isFollowUp, false);
  assert.equal(binding.effectiveInput, '帮我分析一下今天 AI 新闻');
}

async function testDirectActionConversationPreambleTemplates(): Promise<void> {
  const createService = (handlerName: string, messages: string[]) => new DirectActionDispatchService({
    handlers: () => [{
      name: handlerName,
      canHandle: async () => true,
      handle: async () => ({ handled: true }),
    }],
    tryLegacyFallbacks: async () => null,
    conversationMode: {
      enabled: true,
      preambleThreshold: 0,
    },
    onConversationPreamble: (message) => {
      messages.push(message);
    },
  });

  const browserSearchMessages: string[] = [];
  await createService('browser-action', browserSearchMessages).tryHandle({
    originalInput: '请帮我百度搜索 AI agent',
    effectiveInput: '请帮我百度搜索 AI agent',
  });
  assert.equal(browserSearchMessages[0], '我先查一下，做完告诉你结果。');

  const browserOpenMessages: string[] = [];
  await createService('browser-action', browserOpenMessages).tryHandle({
    originalInput: '帮我打开 GitHub 看一下',
    effectiveInput: '帮我打开 GitHub 看一下',
  });
  assert.equal(browserOpenMessages[0], '我先打开看看，做完告诉你结果。');

  const documentMessages: string[] = [];
  await createService('document-action', documentMessages).tryHandle({
    originalInput: '把刚刚的内容整理成 word 文档',
    effectiveInput: '把刚刚的内容整理成 word 文档',
  });
  assert.equal(documentMessages[0], '我先整理成文档，做完告诉你结果。');

  const followUpMessages: string[] = [];
  await createService('browser-action', followUpMessages).tryHandle({
    originalInput: '按刚才那个方式继续',
    effectiveInput: '延续上一任务：百度搜索 AI agent',
    isFollowUp: true,
    boundTask: {
      id: 'task_prev',
      channel: 'direct_action',
      title: '百度搜索 AI agent',
      input: '百度搜索 AI agent',
      effectiveInput: '百度搜索 AI agent',
      category: 'browser-action',
      status: 'completed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(followUpMessages[0], '我先按刚才那个任务继续处理，做完告诉你结果。');
}

async function testIntentResolverRejectsGenericKnowledgeQueryAsBrowserSearch(): Promise<void> {
  const resolver = new IntentResolver({
    async generate() {
      return JSON.stringify({
        name: 'browser.search',
        confidence: 0.96,
        slots: {
          engine: 'baidu',
          query: '最近烟台有什么活动',
        },
      });
    },
  });

  const resolved = await resolver.resolve('最近烟台有什么活动');
  assert.equal(resolved.name, 'unknown');
}

function testBrowserActionHandlerRejectsGenericKnowledgeQueryIntent(): void {
  const handler = new BrowserActionHandler({
    executeBuiltInTool: async () => ({ handled: true, output: 'ok' }),
    getConversationMessages: () => [],
  });

  assert.equal(handler.canHandle('最近烟台有什么活动', {
    name: 'browser.search',
    confidence: 0.98,
    slots: {
      engine: 'baidu',
      query: '最近烟台有什么活动',
    },
    source: 'llm',
  }), false);

  assert.equal(handler.canHandle('帮我百度搜索 烟台最近有什么活动', {
    name: 'browser.search',
    confidence: 0.98,
    slots: {
      engine: 'baidu',
      query: '烟台最近有什么活动',
    },
    source: 'llm',
  }), true);
}

async function testBrowserActionHandlerRoutesCompositeWebsiteTaskToBrowserAgent(): Promise<void> {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const handler = new BrowserActionHandler({
    executeBuiltInTool: async (toolName, args) => {
      calls.push({ toolName, args: args as Record<string, unknown> });
      return { handled: true, output: 'ok' };
    },
    getConversationMessages: () => [],
  });

  const input = '帮我打开网易buff，点击顶部的饰品市场页面，然后滚动下拉';

  assert.equal(handler.canHandle(input), true);
  await handler.handle(input);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toolName, 'browser_agent_run');
  assert.equal(calls[0]?.args.goal, input);
  assert.equal(calls[0]?.args.startUrl, 'https://buff.163.com');
}

async function testBrowserActionHandlerRoutesOpenThenSingleOperationToBrowserAgent(): Promise<void> {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  const handler = new BrowserActionHandler({
    executeBuiltInTool: async (toolName, args) => {
      calls.push({ toolName, args: args as Record<string, unknown> });
      return { handled: true, output: 'ok' };
    },
    getConversationMessages: () => [],
  });

  const input = '打开网易buff点击顶部的饰品市场页面';

  assert.equal(handler.canHandle(input), true);
  await handler.handle(input);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.toolName, 'browser_agent_run');
  assert.equal(calls[0]?.args.startUrl, 'https://buff.163.com');
}

async function testSessionTaskStackPersistence(tempDir: string): Promise<void> {
  const filePath = path.join(tempDir, 'task-stack.json');
  const manager = new SessionTaskStackManager();
  const baseTask = manager.recordTask({
    channel: 'direct_action',
    title: 'base search',
    input: 'base search',
    effectiveInput: 'base search',
    category: 'browser-action',
    status: 'completed',
  });
  manager.recordTask({
    channel: 'agent',
    title: 'follow up',
    input: 'follow up',
    effectiveInput: 'continue base search',
    category: 'agent',
    status: 'completed',
    metadata: { boundTaskId: baseTask.id, boundTaskTitle: baseTask.title },
  });
  manager.setCheckpoint(createAgentCheckpoint('execute_step', 'running', 'follow up', '执行节点中'));

  await manager.saveToFile(filePath);

  const restored = new SessionTaskStackManager();
  await restored.loadFromFile(filePath);
  const snapshot = restored.getContextSnapshot(5);
  assert.equal(snapshot.recentTasks.length, 2);
  assert.equal(snapshot.recentBindings[0]?.targetTask?.title, 'base search');
  assert.equal(snapshot.checkpoint?.node, 'execute_step');
}

function testTaskContextJsonPayload(): void {
  const manager = new SessionTaskStackManager();
  const baseTask = manager.recordTask({
    channel: 'direct_action',
    title: 'base search',
    input: 'base search',
    effectiveInput: 'base search',
    category: 'browser-action',
    status: 'completed',
  });
  manager.recordTask({
    channel: 'agent',
    title: 'follow up',
    input: 'follow up',
    effectiveInput: 'continue base search',
    category: 'agent',
    status: 'completed',
    metadata: { boundTaskId: baseTask.id, boundTaskTitle: baseTask.title },
  });
  manager.setCheckpoint(createAgentCheckpoint('finalize', 'completed', 'follow up', '当前回合已完成'));

  const payload = buildTaskContextJsonPayload(manager.getContextSnapshot(10));
  assert.equal(payload.schemaVersion, TASK_CONTEXT_SCHEMA_VERSION);
  assert.equal(payload.mode, 'json');
  assert.equal(payload.taskContext.recentTasks.length, 2);
  assert.equal(payload.taskContext.checkpoint?.node, 'finalize');
}

async function testAgentGraphRunnerDirectAction(): Promise<void> {
  const agent = createAgent({ llm: new StubLLM() });
  const runner = createAgentGraphRunner({
    agent,
    directActionRouter: {
      async tryHandle() {
        return {
          handled: true,
          title: 'open page',
          output: 'opened',
          category: 'browser-action',
          handlerName: 'BrowserActionHandler',
        };
      },
    } as any,
  });

  const result = await runner.runTurn({
    input: '打开百度',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '打开百度',
    },
  });

  assert.equal(result.route, 'direct_action');
  assert.equal(result.graphState.currentNode, 'finalize');
  assert.equal(result.graphState.status, 'completed');
  assert.equal(result.taskRecord?.channel, 'direct_action');
}

function testPlanCheckpointRiskSummary(): void {
  const plan = {
    originalTask: '执行部署并发到飞书',
    steps: [
      {
        id: 'step_1',
        description: '执行命令并通知飞书',
        status: 'pending',
        toolCalls: [
          { name: 'execute_command', args: { command: 'npm publish' } },
          { name: 'send_lark_message', args: { chatId: 'oc_xxx', text: 'done' } },
        ],
      },
    ],
  } as any;

  const summary = summarizePlanCheckpointRisks(plan);
  const text = buildPlanCheckpointRiskText(plan) || '';
  assert.equal(summary.hasRiskyActions, true);
  assert.equal(summary.hasOutboundDelivery, true);
  assert.match(text, /执行命令/);
  assert.match(text, /对外发送内容/);
}

async function testAgentGraphRunnerDirectActionApprovalCheckpoint(): Promise<void> {
  const agent = createAgent({ llm: new StubLLM() });
  let executed = 0;
  const runner = createAgentGraphRunner({
    agent,
    checkpoints: {
      enabled: true,
      outboundApproval: true,
      riskyDirectActionApproval: true,
    },
    directActionRouter: {
      async preview() {
        return {
          handlerName: 'lark-workflow',
          category: 'lark-workflow',
          riskSummary: buildDirectActionRiskSummary('lark-workflow', '把内容发到飞书'),
        };
      },
      async tryHandle() {
        executed += 1;
        return {
          handled: true,
          title: 'send lark',
          output: 'sent',
          category: 'lark-workflow',
          handlerName: 'lark-workflow',
        };
      },
    } as any,
  });

  const first = await runner.runTurn({
    input: '把上面的内容发到飞书',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '把上面的内容发到飞书',
    },
  });

  assert.equal(first.graphState.currentNode, 'direct_action');
  assert.equal(first.graphState.status, 'waiting');
  assert.equal(agent.getPendingInteractionDetails()?.type, 'direct_action_execution');
  assert.match(first.output || '', /待确认的 direct action/);

  const second = await runner.runTurn({
    input: '是',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '是',
    },
    checkpoint: first.checkpoint,
  });

  assert.equal(second.graphState.currentNode, 'finalize');
  assert.equal(second.graphState.status, 'completed');
  assert.equal(second.route, 'direct_action');
  assert.equal(executed, 1);
}

async function testAgentGraphRunnerMainChain(): Promise<void> {
  const plan = {
    originalTask: '帮我先生成短视频脚本，然后保存成文档',
    steps: [
      {
        id: 'step_1',
        description: '生成短视频脚本并整理成文档输出',
      },
    ],
  };
  const fakePlanner = {
    async createPlan() {
      return plan;
    },
    completeStep() {},
    failStep() {},
  };
  const agent = createAgent({
    llm: new StubLLM(),
    planner: fakePlanner as any,
    maxIterations: 7,
    maxToolCallsPerTurn: 3,
  });
  const transitions: string[] = [];
  const runner = createAgentGraphRunner({
    agent,
    onStateChange: (state) => {
      transitions.push(`${state.currentNode}:${state.status}`);
    },
  });

  const first = await runner.runTurn({
    input: '帮我先生成短视频脚本，然后保存成文档',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '帮我先生成短视频脚本，然后保存成文档',
    },
  });
  assert.equal(first.route, 'agent');
  assert.equal(first.graphState.currentNode, 'clarify');
  assert.equal(first.graphState.pendingInteraction?.type, 'task_clarification');

  const second = await runner.runTurn({
    input: '输出成 word 文档，放到 artifacts 目录',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '输出成 word 文档，放到 artifacts 目录',
    },
    checkpoint: first.checkpoint,
  });
  assert.equal(second.graphState.currentNode, 'plan');
  assert.equal(second.graphState.pendingInteraction?.type, 'plan_execution');

  const third = await runner.runTurn({
    input: '是',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '是',
    },
    checkpoint: second.checkpoint,
  });
  assert.equal(transitions.includes('execute_step:running'), true);
  assert.equal(third.graphState.currentNode, 'finalize');
  assert.equal(third.graphState.status, 'completed');
}

async function testAgentGraphRunnerAutoConfirmPlanExecutionOption(): Promise<void> {
  const plan = {
    originalTask: '生成周报并导出文档',
    steps: [
      {
        id: 'step_1',
        description: '生成周报并整理输出',
      },
    ],
  };
  const fakePlanner = {
    async createPlan() {
      return plan;
    },
    completeStep() {},
    failStep() {},
  };
  const agent = createAgent({
    llm: new StubLLM(),
    planner: fakePlanner as any,
    maxIterations: 7,
    maxToolCallsPerTurn: 3,
  });
  const runner = createAgentGraphRunner({
    agent,
    autoConfirmPlanExecution: true,
  });

  const first = await runner.runTurn({
    input: '帮我处理一下',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '帮我处理一下',
    },
  });
  assert.equal(first.graphState.currentNode, 'clarify');

  const second = await runner.runTurn({
    input: '生成周报并导出成 word 文档，放到 artifacts 目录',
    taskBinding: {
      isFollowUp: false,
      effectiveInput: '生成周报并导出成 word 文档，放到 artifacts 目录',
    },
    checkpoint: first.checkpoint,
  });

  assert.equal(second.graphState.currentNode, 'finalize');
  assert.equal(second.graphState.status, 'completed');
  assert.equal(second.graphState.pendingInteraction?.type, undefined);
  assert.match(second.output || '', /任务完成/);
  assert.equal(second.notices.some(notice => notice.message.includes('自动确认计划')), true);
}

async function testAgentGraphRunnerCheckpointRestorePlan(): Promise<void> {
  const plan = {
    originalTask: '帮我先生成短视频脚本，然后保存成文档',
    steps: [
      { id: 'step_1', description: '生成短视频脚本并整理成文档输出' },
    ],
  };
  const fakePlanner = {
    async createPlan() {
      return plan;
    },
    completeStep() {},
    failStep() {},
  };

  const firstAgent = createAgent({ llm: new StubLLM(), planner: fakePlanner as any });
  const firstRunner = createAgentGraphRunner({ agent: firstAgent });

  const first = await firstRunner.runTurn({
    input: '帮我先生成短视频脚本，然后保存成文档',
    taskBinding: { isFollowUp: false, effectiveInput: '帮我先生成短视频脚本，然后保存成文档' },
  });
  const second = await firstRunner.runTurn({
    input: '输出成 word 文档，放到 artifacts 目录',
    taskBinding: { isFollowUp: false, effectiveInput: '输出成 word 文档，放到 artifacts 目录' },
    checkpoint: first.checkpoint,
  });

  const restoredAgent = createAgent({ llm: new StubLLM(), planner: fakePlanner as any });
  restoredAgent.setMessages(firstAgent.getMessages());
  const restoredRunner = createAgentGraphRunner({ agent: restoredAgent });
  const restored = await restoredRunner.runTurn({
    input: '是',
    taskBinding: { isFollowUp: false, effectiveInput: '是' },
    checkpoint: second.checkpoint,
  });

  assert.equal(restored.graphState.currentNode, 'finalize');
  assert.equal(restored.graphState.status, 'completed');
  assert.equal(restored.output?.includes('任务完成'), true);
}

async function testAgentGraphRunnerCheckpointRestorePlanResume(): Promise<void> {
  const plan = {
    originalTask: '修复部署问题',
    steps: [
      { id: 'step_1', description: '执行修复脚本', toolCalls: [{ name: 'mock_resume_tool', args: { command: 'fix.cmd' } }] },
    ],
  };
  const agent = createAgent({ llm: new StubLLM() }) as any;
  let executeCount = 0;
  agent.toolRegistry = {
    execute: async () => {
      executeCount += 1;
      if (executeCount === 1) {
        return { tool_call_id: '', output: 'permission denied: missing approval', is_error: true };
      }
      return { tool_call_id: '', output: 'fixed', is_error: false };
    },
    getTool: () => undefined,
    listTools: () => [],
  };

  const pausedMessage = await agent.executePlan('修复部署问题', plan as any);
  assert.match(pausedMessage, /任务已暂停/);
  const checkpoint = createAgentCheckpoint('pause_for_input', 'waiting', '修复部署问题', '等待恢复', {
    route: 'agent',
    pendingType: 'plan_resume',
    resumeState: agent.getPendingInteractionDetails()?.resumeState,
  });

  const restoredAgent = createAgent({ llm: new StubLLM() }) as any;
  restoredAgent.toolRegistry = agent.toolRegistry;
  restoredAgent.setMessages(agent.getMessages());
  const restoredRunner = createAgentGraphRunner({ agent: restoredAgent });
  const restored = await restoredRunner.runTurn({
    input: '继续',
    taskBinding: { isFollowUp: false, effectiveInput: '继续' },
    checkpoint,
  });

  assert.equal(restored.graphState.currentNode, 'finalize');
  assert.equal(restored.graphState.status, 'completed');
  assert.equal(executeCount >= 2, true);
}

async function testUnifiedAgentStateSnapshot(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
    maxIterations: 7,
    maxToolCallsPerTurn: 3,
  });

  agent.setMessages([
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '旧回答' },
  ]);
  agent.setRuntimeMemoryContext('recent memory');
  agent.setSystemPrompt('system');

  const clarification = await agent.chat('帮我先生成短视频脚本，然后保存成文档');
  assert.match(clarification, /关键信息/);

  const snapshot = agent.getUnifiedStateSnapshot({
    isFollowUp: false,
    effectiveInput: '帮我先生成短视频脚本，然后保存成文档',
  }, createAgentCheckpoint('clarify', 'waiting', '帮我先生成短视频脚本，然后保存成文档', '等待补充'));

  assert.equal(snapshot.state, 'WAITING_CONFIRMATION');
  assert.equal(snapshot.pendingInteraction?.type, 'task_clarification');
  assert.equal(snapshot.toolBudget.maxIterations, 7);
  assert.equal(snapshot.toolBudget.maxToolCallsPerTurn >= 3, true);
  assert.equal(snapshot.toolBudget.maxToolCallsPerTurn > 3, true);
  assert.equal(snapshot.runtimeMemoryContext, 'recent memory');
  assert.equal(snapshot.checkpoint?.node, 'clarify');
  assert.equal(snapshot.messages.length >= 3, true);
}

function testOnboardingParser(): void {
  const parsed = parseOnboardingInput('我是程序员，主要用来写代码和调试，喜欢专业风格');
  assert.ok(parsed);
  assert.match(parsed?.job || '', /程序员/);
  assert.match(parsed?.purpose || '', /写代码/);
  assert.match(parsed?.preferredStyle || '', /专业/);
}

async function testDirectActionRouter(tempDir: string): Promise<void> {
  const traceDirectAction = (label: string) => {
    if (regressionTraceEnabled) {
      console.log(`[DIRECT_ACTION] ${label}`);
    }
  };

  const filePath = path.join(tempDir, 'direct.txt');
  const mdFilePath = path.join(tempDir, 'notes.md');
  const docxFilePath = path.join(tempDir, 'legacy.docx');
  const csvFilePath = path.join(tempDir, '财务报表_利润表模板.csv');
  const firstFilePath = path.join(tempDir, 'first.ts');
  const secondFilePath = path.join(tempDir, 'second.ts');
  const searchFilePath = path.join(tempDir, 'search-target.ts');
  const artifactDir = path.join(tempDir, 'artifacts');
  await fs.writeFile(filePath, 'direct router works', 'utf-8');
  await fs.writeFile(mdFilePath, '# Notes\n\n这是 markdown 源文件。', 'utf-8');
  await fs.writeFile(docxFilePath, 'legacy docx placeholder', 'utf-8');
  await fs.writeFile(csvFilePath, '科目,金额\n主营业务收入,1000\n净利润,300', 'utf-8');
  await fs.writeFile(firstFilePath, 'export const first = 1;', 'utf-8');
  await fs.writeFile(secondFilePath, 'export const second = 2;', 'utf-8');
  await fs.writeFile(searchFilePath, 'const createDirectActionRouter = true;', 'utf-8');

  const larkCalls: Array<{ serverName: string; toolName: string; args: Record<string, unknown> }> = [];
  const executedCommands: string[] = [];
  const fakeMcpManager = {
    getServerNames: () => ['lark'],
    callTool: async (serverName: string, toolName: string, args: Record<string, unknown>) => {
      larkCalls.push({ serverName, toolName, args });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  };

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, artifactDir] });
  await sandbox.initialize();

  const builtInTools = new BuiltInTools(sandbox, new LSPManager(), {
    mcpManager: fakeMcpManager as any,
    workspace: tempDir,
    config: {
      artifactOutputDir: artifactDir,
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_defaultlark',
          },
        },
      },
    },
  });
  const originalExecuteTool = builtInTools.executeTool.bind(builtInTools);
  (builtInTools as any).executeTool = async (name: string, args: unknown) => {
    if (name === 'execute_command') {
      const command = String((args as { command?: string }).command || '');
      executedCommands.push(command);
      if (/xiaohongshu-extract\.mjs/i.test(command)) {
        return {
          tool_call_id: '',
          output: `Exit code: 0\n\nStdout:\nREPORT_PATH=${xiaohongshuReportPath}\n\nStderr:\n`,
        };
      }
      return {
        tool_call_id: '',
        output: '{"results":[{"title":"测试结果","url":"https://example.com","snippet":"百度搜索命中"}]}',
      };
    }
    return originalExecuteTool(name, args);
  };
  (builtInTools as any).getTencentHotNews = async () => '今日热点新闻\n1. 测试新闻 A\n2. 测试新闻 B';
  const skillManager = createSkillManager(path.join(tempDir, 'skills-home'));
  await skillManager.initialize();
  for (const skill of await skillManager.listSkills()) {
    skillManager.disableSkill(skill.name);
  }
  await skillManager.loadSkill('hello-skill', path.join(process.cwd(), 'examples', 'skill-hello'));
  const desktopDir = getDesktopPath();
  const isolatedExportSkill = {
    name: 'doc-export-skill',
    version: '1.0.0',
    description: 'Export text content to office documents',
    main: 'index.js',
    tools: [
      {
        name: 'txt_to_docx',
        description: 'Export plain text to DOCX',
        inputSchema: { type: 'object', properties: { output: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' } }, required: ['output', 'text'] },
        handler: async (args: Record<string, unknown>) => {
          const requestedPath = String(args.output || 'exported-document.docx');
          const target = /^(Desktop|桌面)(\\|\/|$)/i.test(requestedPath)
            ? path.join(desktopDir, requestedPath.replace(/^(Desktop|桌面)[\\/]?/i, ''))
            : (path.isAbsolute(requestedPath) ? requestedPath : path.join(artifactDir, requestedPath));
          await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
          await writeMinimalDocx(target, String(args.text || ''), typeof args.title === 'string' ? args.title : undefined);
          return { content: [{ type: 'text' as const, text: 'DOCX:' + requestedPath + ':' + String(args.text || '') }] };
        },
      },
      {
        name: 'txt_to_pdf',
        description: 'Export plain text to PDF',
        inputSchema: { type: 'object', properties: { out: { type: 'string' }, text: { type: 'string' }, title: { type: 'string' } }, required: ['out', 'text'] },
        handler: async (args: Record<string, unknown>) => {
          const requestedPath = String(args.out || 'exported-document.pdf');
          const target = /^(Desktop|桌面)(\\|\/|$)/i.test(requestedPath)
            ? path.join(desktopDir, requestedPath.replace(/^(Desktop|桌面)[\\/]?/i, ''))
            : (path.isAbsolute(requestedPath) ? requestedPath : path.join(artifactDir, requestedPath));
          await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
          await fs.writeFile(target, 'PDF FILE\n' + String(args.text || ''), 'utf-8');
          return { content: [{ type: 'text' as const, text: 'PDF:' + requestedPath + ':' + String(args.text || '') }] };
        },
      },
    ],
    hooks: {},
  };
  (skillManager as any).skills.set('doc-export-skill', isolatedExportSkill);
  skillManager.enableSkill('doc-export-skill');
  await skillManager.addLearningTodo({
    sourceTask: '把 docx 文件转成 pdf',
    issueSummary: '缺少 docx 转 pdf 的稳定工作流。',
    suggestedSkill: 'docx-to-pdf-workflow',
    blockers: ['没有 docx 内容提取或转换工具'],
    nextActions: ['补齐 docx 读取能力', '补齐 docx 到 pdf 转换流程'],
    tags: ['document', 'learning'],
    confidence: 0.86,
  });

  const permissionManager = new PermissionManager(path.join(tempDir, 'direct-permissions'));
  await permissionManager.initialize();
  permissionManager.grantPermission('file_read');
  permissionManager.grantPermission('command_execute');
  permissionManager.grantPermission('tool_execute');

  const storedEntries: Array<{ key?: string; content: string }> = [];
  const conversationMessages: Message[] = [
    { role: 'user', content: '帮我写个短视频脚本' },
    { role: 'assistant', content: '这是刚生成的短视频脚本正文。' },
  ];

  const router = createDirectActionRouter({
    builtInTools,
    skillManager,
    permissionManager,
    workspace: process.cwd(),
    config: {
      artifactOutputDir: artifactDir,
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_defaultlark',
          },
        },
      },
    },
    getConversationMessages: () => conversationMessages,
    memoryProvider: {
      backend: 'local',
      async recall() {
        return [];
      },
      async recallLayers() {
        return [];
      },
      async buildContext() {
        return '';
      },
      async syncSession() {
        return;
      },
      async store(entry) {
        storedEntries.push({ key: entry.key, content: entry.content });
      },
    },
  });

  const externalSkillsRoot = path.join(tempDir, 'external-agent-skills');
  const baiduScriptsDir = path.join(externalSkillsRoot, 'baidu-search', 'scripts');
  const xiaohongshuScriptsDir = path.join(externalSkillsRoot, 'xiaohongshu-search-summarizer', 'scripts');
  const xiaohongshuArtifactDir = path.join(artifactDir, 'xiaohongshu', 'AI-智能体-方案');
  await fs.mkdir(baiduScriptsDir, { recursive: true });
  await fs.mkdir(xiaohongshuScriptsDir, { recursive: true });
  await fs.mkdir(xiaohongshuArtifactDir, { recursive: true });
  await fs.writeFile(path.join(baiduScriptsDir, 'search.py'), '# mock', 'utf-8');
  await fs.writeFile(path.join(baiduScriptsDir, 'config.json'), JSON.stringify({ api_key: 'bce-v3/test-key' }), 'utf-8');
  await fs.writeFile(path.join(xiaohongshuScriptsDir, 'run.sh'), '#!/bin/bash\necho ok\n', 'utf-8');
  const repoXiaohongshuScript = path.join(process.cwd(), 'scripts', 'xiaohongshu-extract.mjs');
  let createdRepoXiaohongshuScript = false;
  try {
    await fs.access(repoXiaohongshuScript);
  } catch {
    await fs.mkdir(path.dirname(repoXiaohongshuScript), { recursive: true });
    await fs.writeFile(repoXiaohongshuScript, 'console.log("mock xiaohongshu extract");\n', 'utf-8');
    createdRepoXiaohongshuScript = true;
  }
  const xiaohongshuReportPath = path.join(xiaohongshuArtifactDir, 'AI_智能体_方案_raw_data.md');
  await fs.writeFile(xiaohongshuReportPath, [
    '# 小红书「AI 智能体 方案」搜索原始数据提取',
    '',
    '## 1. AI 智能体落地框架',
    '',
    '> 强调从工作流、工具调用、记忆三层一起设计。',
    '',
    '**💬 Top 评论：**',
    '- **用户A**: 企业场景里先把高频流程固化更重要。',
    '',
    '---',
    '',
    '## 2. Agent 编排避坑',
    '',
    '> 很多团队卡在模型自由发挥，缺少确定性闭环。',
    '',
    '**💬 Top 评论：**',
    '- **用户B**: 飞书闭环要先打通，不然很难验证业务价值。',
  ].join('\n'), 'utf-8');

  const previousExternalSkillsDir = process.env.AI_AGENT_CLI_EXTERNAL_SKILLS_DIR;
  process.env.AI_AGENT_CLI_EXTERNAL_SKILLS_DIR = externalSkillsRoot;

  try {
    traceDirectAction('read-single-file');
    const fileReadResult = await router.tryHandle(`读取文件 ${filePath}`);
    assert.equal(fileReadResult?.handled, true);
    assert.equal(fileReadResult?.output, 'direct router works');

    traceDirectAction('read-multiple-files');
    const multiReadResult = await router.tryHandle(`读取 ${firstFilePath} 和 ${secondFilePath}`);
    assert.equal(multiReadResult?.handled, true);
    assert.match(multiReadResult?.output || '', /first\.ts/);
    assert.match(multiReadResult?.output || '', /second\.ts/);

    traceDirectAction('search-in-directory');
    const searchResult = await router.tryHandle(`在 ${tempDir} 中搜索 createDirectActionRouter`);
    assert.equal(searchResult?.handled, true);
    assert.match(searchResult?.output || '', /search-target\.ts/);

    traceDirectAction('baidu-search');
    const baiduSearchResult = await router.tryHandle('请用百度搜索 AI 智能体 最近一周 前 5 条');
    assert.equal(baiduSearchResult?.handled, true);
    assert.equal(baiduSearchResult?.isError, undefined);
    assert.match(baiduSearchResult?.output || '', /测试结果/);
    assert.equal(executedCommands.length > 0, true);
    assert.match(executedCommands[0] || '', /search\.py/);
    assert.match(executedCommands[0] || '', /--api-type web_search/);
    assert.match(executedCommands[0] || '', /--recency week/);
    assert.match(executedCommands[0] || '', /--limit 5/);

    traceDirectAction('xiaohongshu-search');
    const xiaohongshuSearchResult = await router.tryHandle('请帮我搜索小红书 AI 智能体 方案并总结');
    assert.equal(xiaohongshuSearchResult?.handled, true);
    assert.equal(xiaohongshuSearchResult?.isError, undefined);
    assert.match(xiaohongshuSearchResult?.output || '', /REPORT_PATH=/);
    assert.equal(executedCommands.some(command => /xiaohongshu-extract\.mjs/i.test(command)), true);
    assert.match(executedCommands.find(command => /xiaohongshu-extract\.mjs/i.test(command)) || '', new RegExp(repoXiaohongshuScript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    traceDirectAction('xiaohongshu-to-lark');
    const xiaohongshuToLarkResult = await router.tryHandle('请把小红书 AI 智能体 方案 搜索后总结发送到飞书，chatId 是 oc_xhs123');
    assert.equal(xiaohongshuToLarkResult?.handled, true);
    assert.equal(xiaohongshuToLarkResult?.isError, undefined);
    assert.match(xiaohongshuToLarkResult?.output || '', /原始报告已生成/);
    assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && call.args.flags?.['chat-id'] === 'oc_xhs123' && String(call.args.flags?.markdown || '').includes('小红书搜索总结：AI 智能体 方案')), true);
    assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && String(call.args.flags?.markdown || '').includes('AI 智能体落地框架')), true);

    traceDirectAction('vision-action');
    const visionDir = path.join(tempDir, 'vision-router-images');
    await fs.mkdir(visionDir, { recursive: true });
    await fs.writeFile(path.join(visionDir, 'screen-a.png'), Buffer.from('png-data'));
    await fs.writeFile(path.join(visionDir, 'screen-b.jpg'), Buffer.from('jpg-data'));

    const originalFetch = globalThis.fetch;
    let capturedVisionBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedVisionBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return {
        ok: true,
        json: async () => ({ response: 'vision-router-ok', done: true }),
      } as Response;
    }) as typeof fetch;

    try {
      const visionResult = await router.tryHandle(`分析 ${visionDir} 目录下的图片，检查是否有报错`);
      assert.equal(visionResult?.handled, true);
      assert.equal(visionResult?.isError, undefined);
      assert.equal(visionResult?.category, 'vision-action');
      assert.match(visionResult?.output || '', /vision-router-ok/);
      assert.equal(capturedVisionBody?.model, 'minicpm-v');
      assert.equal(Array.isArray(capturedVisionBody?.images), true);
      assert.equal((capturedVisionBody?.images as unknown[]).length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    if (previousExternalSkillsDir === undefined) {
      delete process.env.AI_AGENT_CLI_EXTERNAL_SKILLS_DIR;
    } else {
      process.env.AI_AGENT_CLI_EXTERNAL_SKILLS_DIR = previousExternalSkillsDir;
    }

    if (createdRepoXiaohongshuScript) {
      await fs.rm(repoXiaohongshuScript, { force: true });
    }
  }

  traceDirectAction('glob-ts-files');
  const globResult = await router.tryHandle(`查找所有 ts 文件 在 ${tempDir}`);
  assert.equal(globResult?.handled, true);
  assert.match(globResult?.output || '', /first\.ts/);
  assert.match(globResult?.output || '', /second\.ts/);

  traceDirectAction('save-markdown');
  const markdownSaveResult = await router.tryHandle('把内容保存成markdown文件，文件名叫 notes，内容是 今日完成接口联调');
  assert.equal(markdownSaveResult?.handled, true);
  assert.match(markdownSaveResult?.output || '', /notes\.md/);
  assert.equal(await fs.readFile(path.join(artifactDir, 'notes.md'), 'utf-8'), '今日完成接口联调');

  traceDirectAction('save-txt');
  const txtSaveResult = await router.tryHandle('把内容保存成txt文件，文件名叫 news_summary_temp，内容是 今日热点新闻摘要');
  assert.equal(txtSaveResult?.handled, true);
  assert.match(txtSaveResult?.output || '', /news_summary_temp\.txt/);
  assert.equal(await fs.readFile(path.join(artifactDir, 'news_summary_temp.txt'), 'utf-8'), '今日热点新闻摘要');

  traceDirectAction('skill-command');
  const skillCommandResult = await router.tryHandle('hello Copilot');
  assert.equal(skillCommandResult?.handled, true);
  assert.match(skillCommandResult?.output || '', /Hello, Copilot!/);

  traceDirectAction('save-word-desktop');
  const saveWordResult = await router.tryHandle('把刚刚的内容保存成word文档，放到桌面');
  assert.equal(saveWordResult?.handled, true);
  assert.equal(saveWordResult?.isError, undefined);
  assert.match(saveWordResult?.output || '', /Created report document:/);
  assert.equal(await extractDocxText(path.join(desktopDir, 'exported-document.docx')), 'exported document\n这是刚生成的短视频脚本正文。');

  traceDirectAction('save-pdf');
  const savePdfResult = await router.tryHandle('把刚刚的内容保存成pdf');
  assert.equal(savePdfResult?.handled, true);
  assert.equal(savePdfResult?.isError, undefined);
  assert.match(savePdfResult?.output || '', /Created PDF document:/);
  assert.match(await extractPdfText(path.join(artifactDir, 'exported-document.pdf')), /这是刚生成的短视频脚本正文。/);

  traceDirectAction('configured-dir-docx');
  const configuredDirDocxResult = await router.tryHandle('把刚刚的内容保存成word文档，放到配置文件指定目录，不要在当前目录');
  assert.equal(configuredDirDocxResult?.handled, true);
  assert.equal(configuredDirDocxResult?.isError, undefined);
  assert.match(configuredDirDocxResult?.output || '', /Created report document:/);
  assert.equal(await extractDocxText(path.join(artifactDir, 'exported-document.docx')), 'exported document\n这是刚生成的短视频脚本正文。');

  traceDirectAction('inline-docx');
  const inlineDocxResult = await router.tryHandle('生成word文档，文件名叫 brief，内容是 这是一段内联正文');
  assert.equal(inlineDocxResult?.handled, true);
  assert.match(inlineDocxResult?.output || '', /Created report document:/);
  assert.equal(await extractDocxText(path.join(artifactDir, 'brief.docx')), 'brief\n这是一段内联正文');

  const generationFirstDocxResult = await router.tryHandle('根据今日热点新闻生成一个word文档，文件标题是你好新闻');
  assert.equal(generationFirstDocxResult, null);

  traceDirectAction('recent-text-to-lark');
  const recentTextToLarkResult = await router.tryHandle('把刚刚的内容发送到飞书，chatId 是 oc_recenttext');
  assert.equal(recentTextToLarkResult?.handled, true);
  assert.equal(recentTextToLarkResult?.isError, undefined);
  assert.match(recentTextToLarkResult?.output || '', /消息已发送到飞书群/);
  assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && call.args.flags?.text === '这是刚生成的短视频脚本正文。'), true);

  traceDirectAction('news-text-to-lark');
  const newsTextToLarkResult = await router.tryHandle('把今日热点新闻发送到飞书，chatId 是 oc_newstext');
  assert.equal(newsTextToLarkResult?.handled, true);
  assert.equal(newsTextToLarkResult?.isError, undefined);
  assert.match(newsTextToLarkResult?.output || '', /发送到飞书群/);
  assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && String(call.args.flags?.text || '').includes('今日热点新闻')), true);

  traceDirectAction('docx-to-lark');
  const docxToLarkResult = await router.tryHandle('把内容保存成word文档并发送到飞书，文件名叫 brief，内容是 这是一段内联正文，chatId 是 oc_testchat');
  assert.equal(docxToLarkResult?.handled, true);
  assert.equal(docxToLarkResult?.isError, undefined);
  assert.match(docxToLarkResult?.output || '', /文档已创建:/);
  assert.equal(await extractDocxText(path.join(artifactDir, 'brief.docx')), 'brief\n这是一段内联正文');
  assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && String(call.args.flags?.file || '').includes('brief.docx')), true);

  traceDirectAction('news-docx-to-lark');
  const newsDocxToLarkResult = await router.tryHandle('把今日热点新闻生成一个word文档并发送到飞书，文件标题是 你好新闻，chatId 是 oc_newstest');
  assert.equal(newsDocxToLarkResult?.handled, true);
  assert.equal(newsDocxToLarkResult?.isError, undefined);
  assert.match(newsDocxToLarkResult?.output || '', /文档已创建:/);
  assert.equal(await extractDocxText(path.join(artifactDir, '你好新闻.docx')), '你好新闻\n今日热点新闻\n1. 测试新闻 A\n2. 测试新闻 B');
  assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && String(call.args.flags?.file || '').includes('你好新闻.docx')), true);

  traceDirectAction('natural-docx-to-lark');
  const naturalDocxToLarkResult = await router.tryHandle('把上面的ai新闻整理成word文档发我飞书');
  assert.equal(naturalDocxToLarkResult?.handled, true);
  assert.equal(naturalDocxToLarkResult?.isError, undefined);
  assert.match(naturalDocxToLarkResult?.output || '', /文档已创建:/);
  const naturalDocxPathMatch = String(naturalDocxToLarkResult?.output || '').match(/文档已创建:\s*(.+\.docx)/);
  assert.ok(naturalDocxPathMatch);
  assert.equal(await extractDocxText(naturalDocxPathMatch?.[1]?.trim() || ''), 'exported document\n这是刚生成的短视频脚本正文。');
  assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && /\.docx$/i.test(String(call.args.flags?.file || ''))), true);

  traceDirectAction('query-then-lark-should-fall-through');
  const queryThenLarkResult = await router.tryHandle('杜甫的茅屋为秋风所破歌这首诗内容是什么，发我飞书');
  assert.equal(queryThenLarkResult, null);

  traceDirectAction('semantic-then-lark-should-fall-through');
  const semanticThenLarkResult = await router.tryHandle('解释一下杜甫的茅屋为秋风所破歌，再发我飞书');
  assert.equal(semanticThenLarkResult, null);

  traceDirectAction('markdown-to-docx');
  const markdownFileDocxResult = await router.tryHandle(`把 ${mdFilePath} 转成word文档`);
  assert.equal(markdownFileDocxResult?.handled, true);
  assert.match(markdownFileDocxResult?.output || '', /Created report document:/);
  assert.match(await extractDocxText(path.join(artifactDir, 'notes.docx')), /# Notes/);

  traceDirectAction('invalid-docx');
  const invalidDocxResult = await router.tryHandle('把刚刚的内容保存成word文档，内容是 [repl] Error: Invalid or unexpected token');
  assert.equal(invalidDocxResult?.handled, true);
  assert.equal(invalidDocxResult?.isError, true);
  assert.match(invalidDocxResult?.output || '', /已停止导出|错误文本/);

  const wrongDocxPath = path.join(artifactDir, 'wrong-content.docx');
  await writeMinimalDocx(wrongDocxPath, '[repl] Error: Invalid or unexpected token', '正常标题');
  const wrongDocxValidation = await validateDocxContent(wrongDocxPath, '正常正文', '正常标题');
  assert.equal(wrongDocxValidation.ok, false);
  assert.match(wrongDocxValidation.problems.join('\n'), /repl 报错/);

  traceDirectAction('markdown-to-pdf');
  const markdownFilePdfResult = await router.tryHandle(`把 ${mdFilePath} 转成pdf`);
  assert.equal(markdownFilePdfResult?.handled, true);
  assert.match(markdownFilePdfResult?.output || '', /Created PDF document:/);
  assert.match(await extractPdfText(path.join(artifactDir, 'notes.pdf')), /# Notes/);

  traceDirectAction('markdown-to-txt');
  const markdownFileTxtResult = await router.tryHandle(`把 ${mdFilePath} 转成txt`);
  assert.equal(markdownFileTxtResult?.handled, true);
  assert.match(markdownFileTxtResult?.output || '', /notes\.txt/);
  assert.match(await fs.readFile(path.join(artifactDir, 'notes.txt'), 'utf-8'), /# Notes/);

  traceDirectAction('explicit-dir-pdf');
  const explicitDirPdfResult = await router.tryHandle(`把 ${mdFilePath} 转成pdf，存进 ${artifactDir} 文件夹内`);
  assert.equal(explicitDirPdfResult?.handled, true);
  assert.match(explicitDirPdfResult?.output || '', /Created PDF document:/);
  assert.match(await extractPdfText(path.join(artifactDir, 'notes.pdf')), /# Notes/);

  traceDirectAction('save-xlsx');
  const xlsxResult = await router.tryHandle('把刚刚的内容保存成xlsx');
  assert.equal(xlsxResult?.handled, true);
  assert.equal(xlsxResult?.isError, undefined);
  assert.match(xlsxResult?.output || '', /Created spreadsheet document:/);
  assert.equal(await extractXlsxText(path.join(artifactDir, 'exported-document.xlsx')), '这是刚生成的短视频脚本正文。');

  conversationMessages.push({ role: 'tool', content: `Created file: ${csvFilePath}`, name: 'write_file', tool_call_id: 'csv_artifact' });
  traceDirectAction('remembered-csv-to-xlsx');
  const rememberedCsvResult = await router.tryHandle('把这个csv转换成xlsx文件');
  assert.equal(rememberedCsvResult?.handled, true);
  assert.equal(rememberedCsvResult?.isError, undefined);
  assert.match(rememberedCsvResult?.output || '', /财务报表_利润表模板\.xlsx/);
  assert.equal(await extractXlsxText(path.join(artifactDir, '财务报表_利润表模板.xlsx')), '科目\t金额\n主营业务收入\t1000\n净利润\t300');
  assert.equal(storedEntries.some(entry => entry.key === 'last_xlsx_output_file' && /财务报表_利润表模板\.xlsx/.test(entry.content)), true);

  traceDirectAction('save-pptx');
  const pptxResult = await router.tryHandle('把刚刚的内容保存成ppt');
  assert.equal(pptxResult?.handled, true);
  assert.equal(pptxResult?.isError, undefined);
  assert.match(pptxResult?.output || '', /Created presentation document:/);
  assert.match(await extractPptxText(path.join(artifactDir, 'exported-document.pptx')), /这是刚生成的短视频脚本正文。/);

  traceDirectAction('pptx-to-lark');
  const pptxToLarkResult = await router.tryHandle('把刚刚的内容保存成ppt并发送到飞书，chatId 是 oc_ppttest');
  assert.equal(pptxToLarkResult?.handled, true);
  assert.equal(pptxToLarkResult?.isError, undefined);
  assert.match(pptxToLarkResult?.output || '', /演示文稿已创建:/);
  assert.equal(larkCalls.some(call => call.toolName === 'shortcut' && call.args.flags?.['chat-id'] === 'oc_ppttest' && String(call.args.flags?.file || '').includes('exported-document.pptx')), true);

  traceDirectAction('unsupported-docx-to-pdf');
  const unsupportedDocxResult = await router.tryHandle(`把 ${docxFilePath} 转成pdf`);
  assert.equal(unsupportedDocxResult?.handled, true);
  assert.equal(unsupportedDocxResult?.isError, true);
  assert.match(unsupportedDocxResult?.output || '', /这是已知能力缺口/);
  assert.match(unsupportedDocxResult?.output || '', /docx/i);

  skillManager.disableSkill('doc-export-skill');
  (skillManager as any).skills.set('broken-docx-skill', {
    name: 'broken-docx-skill',
    version: '1.0.0',
    description: 'Broken docx exporter',
    main: 'index.js',
    tools: [
      {
        name: 'txt_to_docx',
        description: 'Broken DOCX export tool',
        inputSchema: { type: 'object', properties: { output: { type: 'string' }, text: { type: 'string' } } },
        handler: async () => {
          throw new Error('minimax-docx 当前不可用：本机缺少 .NET SDK，而该 skill 依赖 dotnet run 启动 OpenXML CLI。');
        },
      },
    ],
    hooks: {},
  });
  skillManager.enableSkill('broken-docx-skill');

  traceDirectAction('fallback-docx-after-broken-skill');
  const unavailableDocxResult = await router.tryHandle('把刚刚的内容保存成word文档');
  assert.equal(unavailableDocxResult?.handled, true);
  assert.equal(unavailableDocxResult?.isError, undefined);
  assert.match(unavailableDocxResult?.output || '', /Created report document:/);
  assert.equal(await extractDocxText(path.join(artifactDir, 'exported-document.docx')), 'exported document\n这是刚生成的短视频脚本正文。');
}

async function testNestedSkillDirectoryDiscovery(tempDir: string): Promise<void> {
  const homeDir = path.join(tempDir, 'home');
  const nestedSkillDir = path.join(homeDir, '.agents', 'skills', 'minimax-skills', 'minimax-docx');
  const officialSkillDir = path.join(homeDir, '.agents', 'skills', 'docx');
  await fs.mkdir(nestedSkillDir, { recursive: true });
  await fs.mkdir(officialSkillDir, { recursive: true });
  await fs.writeFile(
    path.join(nestedSkillDir, 'SKILL.md'),
    `---
name: minimax-docx
description: Create and edit docx files
version: 1.0.0
---

DOCX workflow instructions.
`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(officialSkillDir, 'SKILL.md'),
    `---
name: docx
description: Official Anthropic DOCX skill
version: 1.0.0
---

Official DOCX workflow instructions.
`,
    'utf-8',
  );

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    const manager = createSkillManager(path.join(tempDir, 'skills-home'));
    await manager.initialize();

    const officialSkill = manager.getSkill('docx');
    const legacySkill = manager.getSkill('minimax-docx');
    const skills = await manager.listSkills();

    assert.ok(officialSkill);
    assert.equal(officialSkill?.description, 'Official Anthropic DOCX skill');
    assert.match(manager.getSkillContent('docx') || '', /Official DOCX workflow instructions/);
    assert.equal(legacySkill, undefined);
    assert.equal(skills.some(item => item.name === 'docx' && item.enabled), true);
    assert.equal(skills.some(item => item.name === 'minimax-docx' && item.enabled), false);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }

    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  }
}

async function testCrLfMarkdownOnlySkillLoads(tempDir: string): Promise<void> {
  const skillDir = path.join(tempDir, 'crlf-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    '---\r\nname: crlf-skill\r\ndescription: Skill loaded from CRLF markdown\r\n---\r\n\r\nThis skill should still load.\r\n',
    'utf-8',
  );

  const manager = createSkillManager(path.join(tempDir, 'skills-home'));
  await manager.initialize();
  await manager.loadSkill('crlf-skill', skillDir);

  const skill = manager.getSkill('crlf-skill');
  const skills = await manager.listSkills();

  assert.ok(skill);
  assert.equal(skill?.description, 'Skill loaded from CRLF markdown');
  assert.equal(skills.some(item => item.name === 'crlf-skill'), true);
}

async function testMarkdownOnlySkillDescriptionCleanup(tempDir: string): Promise<void> {
  const skillDir = path.join(tempDir, 'markdown-cleanup-skill');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---
name: markdown-cleanup-skill
version: 1.0.0
---

# Markdown Cleanup Skill

- 支持读取原始日志
- 支持整理为日报

**适用场景：** 当用户需要把原始日志整理成简洁日报时使用。
输出应聚焦关键异常与处理建议。
`,
    'utf-8',
  );

  const manager = createSkillManager(path.join(tempDir, 'skills-home'));
  await manager.initialize();
  await manager.loadSkill('markdown-cleanup-skill', skillDir);

  const skill = manager.getSkill('markdown-cleanup-skill');
  const listed = (await manager.listSkills()).find(item => item.name === 'markdown-cleanup-skill');

  assert.match(skill?.description || '', /^适用场景：\s*当用户需要把原始日志整理成简洁日报时使用。$/);
  assert.match(listed?.description || '', /^适用场景：\s*当用户需要把原始日志整理成简洁日报时使用。$/);
}

async function testLearnedSkillCandidateLifecycle(tempDir: string): Promise<void> {
  const manager = createSkillManager(path.join(tempDir, 'skills-home'));
  await manager.initialize();

  const candidate = await manager.maybeCreateCandidateFromExecution({
    originalTask: '整理日志并输出日报模板',
    stepDescriptions: ['读取日志文件', '提取关键错误', '生成日报草稿'],
    stepResults: ['读取完成，共 12 条记录', '发现 2 个关键错误，已归类', '日报草稿已生成到 outputs'],
    completedSteps: 3,
    totalSteps: 3,
    refinement: {
      shouldCreate: true,
      confidence: 0.91,
      refinedDescription: '整理日志并生成日报模板的可复用流程。',
      whenToUse: '当用户需要把原始日志汇总成日报模板时使用。',
      procedure: ['读取日志文件', '提取关键错误并归类', '输出日报模板到 outputs'],
      verification: ['确认日报模板包含关键异常与处理建议。'],
      tags: ['logs', 'report'],
      qualitySummary: '自检通过，步骤稳定且可复用。',
      suggestedName: 'log-report-workflow',
    },
  });

  assert.ok(candidate);
  assert.equal(candidate?.confidence, 0.91);
  assert.deepEqual(candidate?.tags, ['logs', 'report']);

  const candidates = await manager.listSkillCandidates();
  assert.equal(candidates.some(item => item.name === candidate?.name), true);
  const matches = await manager.searchSkillCandidates('整理日志生成日报', 3);
  assert.equal(matches[0]?.name, candidate?.name);
  assert.match(matches[0]?.whenToUse || '', /日报模板/);
  assert.equal(matches[0]?.procedureSteps[0], '读取日志文件');

  if (candidate) {
    await manager.adoptCandidate(candidate.name);
    const skill = manager.getSkill(candidate.name);
    assert.ok(skill);
    assert.equal(skill?.description, '整理日志并生成日报模板的可复用流程。');
  }
}

async function testMemoryManagerResume(tempDir: string): Promise<void> {
  const historyDir = path.join(tempDir, 'history');

  const managerA = createMemoryManager(historyDir);
  await managerA.initialize();
  managerA.addMessage({ role: 'user', content: 'first message' });
  managerA.addMessage({ role: 'assistant', content: 'first reply' });

  await new Promise(resolve => setTimeout(resolve, 10));

  const managerB = createMemoryManager(historyDir);
  await managerB.initialize();

  const resumed = managerB.getMessages();
  assert.equal(resumed.length >= 2, true);
  assert.equal(resumed[0]?.content, 'first message');
  assert.equal(resumed[1]?.content, 'first reply');
}

async function testUnifiedToolRegistry(tempDir: string): Promise<void> {
  const filePath = path.join(tempDir, 'registry.txt');
  await fs.writeFile(filePath, 'registry read', 'utf-8');
  const auditRecords: Array<{
    toolName: string;
    toolSource: string;
    argsPreview: string;
    outputPreview: string;
    isError: boolean;
    durationMs: number;
    status: string;
  }> = [];

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();
  const builtInTools = new BuiltInTools(sandbox, new LSPManager());

  const skillManager = createSkillManager(path.join(tempDir, 'registry-skills'));
  await skillManager.initialize();
  await skillManager.loadSkill('hello-skill', path.join(process.cwd(), 'examples', 'skill-hello'));

  const registry = createToolRegistry({
    builtInTools,
    skillManager,
    skillContextFactory: () => ({
      workspace: process.cwd(),
      config: {},
      skillsDir: skillManager.getSkillsDir(),
    }),
    onAuditRecord: (record) => {
      auditRecords.push(record);
    },
  });

  await registry.refresh();
  const toolNames = registry.listTools().map(tool => tool.name);

  assert.equal(toolNames.includes('read_file'), true);
  assert.equal(toolNames.includes('hello_world'), true);

  const readResult = await registry.execute('read_file', { path: filePath });
  assert.equal(readResult.output, 'registry read');

  const invalidArgsResult = await registry.execute('read_file', {
    path: 123 as unknown as string,
    unexpected: true,
  } as Record<string, unknown>);
  assert.equal(invalidArgsResult.is_error, true);
  assert.match(invalidArgsResult.output || '', /Invalid arguments for tool read_file/);
  assert.match(invalidArgsResult.output || '', /\$\.path expected string, got number/);
  assert.match(invalidArgsResult.output || '', /\$\.unexpected is not allowed/);

  const skillResult = await registry.execute('hello_world', { name: 'Registry' });
  assert.match(skillResult.output || '', /Hello, Registry!/);
  assert.equal(auditRecords.length >= 3, true);
  assert.equal(auditRecords[0]?.toolName, 'read_file');
  assert.equal(auditRecords[0]?.toolSource, 'builtin');
  assert.equal(auditRecords[0]?.isError, false);
  assert.match(auditRecords[0]?.argsPreview || '', /registry\.txt/);
  assert.match(auditRecords[0]?.outputPreview || '', /registry read/);
  assert.equal(auditRecords[1]?.toolName, 'read_file');
  assert.equal(auditRecords[1]?.toolSource, 'builtin');
  assert.equal(auditRecords[1]?.isError, true);
  assert.equal(auditRecords[1]?.status, 'completed');
  assert.match(auditRecords[1]?.outputPreview || '', /Invalid arguments for tool read_file/);
  assert.equal(auditRecords[2]?.toolName, 'hello_world');
  assert.equal(auditRecords[2]?.toolSource, 'skill');
  assert.equal(auditRecords[2]?.status, 'completed');

  const originalExecuteTool = builtInTools.executeTool.bind(builtInTools);
  (builtInTools as any).executeTool = async (name: string, args: Record<string, unknown>) => {
    if (name === 'read_file' && args.path === '__boom__') {
      throw new Error('simulated builtin failure');
    }
    return originalExecuteTool(name, args);
  };

  const builtinFailureResult = await registry.execute('read_file', { path: '__boom__' });
  assert.equal(builtinFailureResult.is_error, true);
  assert.match(builtinFailureResult.output || '', /Built-in tool error: simulated builtin failure/);
  assert.equal(auditRecords[3]?.toolName, 'read_file');
  assert.equal(auditRecords[3]?.status, 'threw');
  assert.equal(auditRecords[3]?.isError, true);

  const permissionAwareRegistry = createToolRegistry({
    builtInTools,
    skillManager,
    skillContextFactory: () => ({
      workspace: process.cwd(),
      config: {},
      skillsDir: skillManager.getSkillsDir(),
    }),
    onPermissionCheck: async (request) => ({
      allowed: request.permissionType !== 'file_read',
    }),
  });
  await permissionAwareRegistry.refresh();

  const deniedReadResult = await permissionAwareRegistry.execute('read_file', { path: filePath });
  assert.equal(deniedReadResult.is_error, true);
  assert.match(deniedReadResult.output || '', /Permission denied: file_read/);

  const allowedSkillResult = await permissionAwareRegistry.execute('hello_world', { name: 'Permission' });
  assert.equal(allowedSkillResult.is_error, undefined);
  assert.match(allowedSkillResult.output || '', /Hello, Permission!/);

  (skillManager as any).skills.set('broken-docx-skill', {
    name: 'broken-docx-skill',
    version: '1.0.0',
    description: 'Broken docx exporter',
    main: 'index.js',
    tools: [
      {
        name: 'txt_to_docx',
        description: 'Broken DOCX export tool',
        inputSchema: { type: 'object', properties: { output: { type: 'string' }, text: { type: 'string' } } },
        handler: async () => {
          throw new Error('minimax-docx 当前不可用：本机缺少 .NET SDK，而该 skill 依赖 dotnet run 启动 OpenXML CLI。');
        },
      },
    ],
    hooks: {},
  });
  skillManager.enableSkill('broken-docx-skill');

  await registry.refresh();
  const registryDocxPath = path.join(tempDir, 'demo.docx');
  const docxResult = await registry.execute('txt_to_docx', { output: registryDocxPath, text: 'demo' });
  assert.equal(docxResult.is_error, undefined);
  assert.match(docxResult.output || '', /Created report document:/);
  assert.equal(await extractDocxText(registryDocxPath), 'exported document\ndemo');

  const registryXlsxPath = path.join(tempDir, 'demo.xlsx');
  const xlsxResult = await registry.execute('txt_to_xlsx', { output: registryXlsxPath, text: '列A\t列B\n中文\t123' });
  assert.equal(xlsxResult.is_error, undefined);
  assert.match(xlsxResult.output || '', /Created spreadsheet document:/);
  assert.equal(await extractXlsxText(registryXlsxPath), '列A\t列B\n中文\t123');
}

async function testBuiltInToolsAllowlistCommandMode(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();
  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: {
      sandbox: {
        commandExecutionMode: 'allowlist',
        commandAllowlist: ['node'],
      },
    },
  });

  const allowed = await tools.executeTool('execute_command', {
    command: `"${process.execPath}" -e "console.log('ok')"`,
    timeout: 10000,
  });
  assert.equal(allowed.is_error, undefined);
  assert.match(allowed.output || '', /ok/);

  const blocked = await tools.executeTool('execute_command', {
    command: 'powershell -NoProfile -Command Get-Date',
    timeout: 1000,
  });
  assert.equal(blocked.is_error, true);
  assert.match(blocked.output || '', /allowlist/);
}

async function testBuiltInToolsBrowserNetworkCapabilities(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();
  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: {
      sandbox: {
        allowNetworkRequests: false,
        allowBrowserOpen: false,
        allowBrowserAutomation: false,
      },
    },
  });

  const network = await tools.executeTool('fetch_url', { url: 'https://example.com' });
  assert.equal(network.is_error, true);
  assert.match(network.output || '', /Network requests are disabled by sandbox policy/);

  const browserOpen = await tools.executeTool('open_browser', { url: 'https://example.com' });
  assert.equal(browserOpen.is_error, true);
  assert.match(browserOpen.output || '', /Browser open is disabled by sandbox policy/);

  const browserAutomation = await tools.executeTool('browser_automate', { url: 'https://example.com', actions: [] });
  assert.equal(browserAutomation.is_error, true);
  assert.match(browserAutomation.output || '', /Browser automation is disabled by sandbox policy/);
}

async function testConfigDefaultsFavorConservativeExecution(tempDir: string): Promise<void> {
  const originalConfig = configManager.getAll();
  const configPath = path.join(tempDir, 'default-config.yaml');

  await fs.writeFile(configPath, '{}\n', 'utf-8');
  await configManager.loadFromFile(configPath);

  try {
    assert.equal(configManager.get('maxIterations'), 40);
    assert.equal(configManager.get('maxToolCallsPerTurn'), 8);
    assert.equal(configManager.get('autoContinueOnToolLimit'), false);
    assert.equal(configManager.get('maxContinuationTurns'), 1);
    assert.equal(configManager.get('checkpoints').continuationApproval, true);
  } finally {
    configManager.setAll(originalConfig);
  }
}

async function testTaskAndCronTools(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const taskManager = createTaskManager(path.join(tempDir, 'tasks'));
  await taskManager.initialize();

  const cronManager = createCronManager(path.join(tempDir, 'cron'));
  await cronManager.initialize();

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    taskManager,
    cronManager,
  });

  const categories = new Set(tools.getTools().map(tool => tool.category));
  assert.equal(categories.has('agents_tasks'), true);
  assert.equal(categories.has('mcp'), true);

  const createdTask = await tools.executeTool('task_create', { title: 'Regression task', description: 'from test' });
  const task = JSON.parse(createdTask.output || '{}') as { id?: string };
  assert.ok(task.id);

  const listedTasks = await tools.executeTool('task_get_list', {});
  assert.match(listedTasks.output || '', /Regression task/);

  const now = new Date();
  const schedule = `${now.getMinutes()} ${now.getHours()} * * *`;
  const executed: string[] = [];
  cronManager.setExecutor(async (toolName) => {
    executed.push(toolName);
    return { tool_call_id: '', output: 'cron fired', content: [{ type: 'text', text: 'cron fired' }] };
  });

  const createdJob = await tools.executeTool('cron_create', {
    name: 'regression-news',
    schedule,
    tool: 'tencent_hot_news',
  });
  assert.match(createdJob.output || '', /regression-news/);

  const stoppedJob = await tools.executeTool('cron_stop', { idOrName: 'regression-news' });
  assert.match(stoppedJob.output || '', /"enabled": false/);

  const forcedRun = await tools.executeTool('cron_run', { idOrName: 'regression-news' });
  assert.match(forcedRun.output || '', /"workDir"/);
  assert.match(forcedRun.output || '', /cron fired/);

  const startedJob = await tools.executeTool('cron_start', { idOrName: 'regression-news' });
  assert.match(startedJob.output || '', /"enabled": true/);

  const stopScheduler = await tools.executeTool('cron_stop', {});
  assert.match(stopScheduler.output || '', /Cron scheduler stopped/);

  const startScheduler = await tools.executeTool('cron_start', {});
  assert.match(startScheduler.output || '', /Cron scheduler started/);

  const cronScopedWrite = await tools.executeToolForCronJob('write_file', {
    path: 'daily.md',
    content: '# cron output',
  }, 'regression-news');
  assert.match(cronScopedWrite.output || '', /daily\.md/);
  assert.equal(await fs.readFile(path.join(tempDir, 'cron', 'regression-news', 'daily.md'), 'utf-8'), '# cron output');

  const cronScopedCommand = await tools.executeToolForCronJob('execute_command', {
    command: "New-Item -ItemType Directory -Path scripts -Force | Out-Null; Set-Content -Path scripts\\job.ps1 -Value 'Write-Host cron'",
  }, 'regression-news');
  assert.match(cronScopedCommand.output || '', /Exit code: 0/);
  assert.equal(await fs.readFile(path.join(tempDir, 'cron', 'regression-news', 'scripts', 'job.ps1'), 'utf-8').then(content => content.trim()), 'Write-Host cron');

  await cronManager.runDueJobs(now);
  assert.deepEqual(executed, ['tencent_hot_news', 'tencent_hot_news']);

  const listedJobs = await tools.executeTool('cron_list', {});
  assert.match(listedJobs.output || '', /"schedulerRunning": true/);
  assert.match(listedJobs.output || '', /regression-news/);
}

async function testMcpClientAcceptsStderrLogs(tempDir: string): Promise<void> {
  const serverPath = path.join(tempDir, 'mock-mcp-server.js');
  await fs.writeFile(serverPath, `
process.stderr.write('Mock MCP starting...\\n');
process.stdin.setEncoding('utf8');

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);

    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock', version: '1.0.0' },
        },
      }) + '\\n');
      continue;
    }

    if (request.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [{
            name: 'mock_tool',
            description: 'Mock tool',
            inputSchema: { type: 'object', properties: {} },
          }],
        },
      }) + '\\n');
      continue;
    }

    if (request.method === 'notifications/initialized') {
      continue;
    }
  }
});
`, 'utf-8');

  const client = new MCPClient({
    name: 'mock',
    command: process.execPath,
    args: [serverPath],
  });

  await client.connect();
  const initialized = await client.initialize();
  const tools = await client.listTools();

  assert.equal(initialized.serverInfo.name, 'mock');
  assert.equal(tools[0]?.name, 'mock_tool');

  await client.disconnect();
}

async function testPlanConfirmationPersistsConversationContext(): Promise<void> {
  const plan = {
    id: 'plan_script',
    originalTask: '生成一个短视频脚本并保存为文档',
    currentStepIndex: 0,
    status: 'planning' as const,
    steps: [
      { id: 'step_1', description: '生成短视频脚本', status: 'pending' as const },
    ],
  };

  const fakePlanner = {
    async createPlan() {
      return plan;
    },
    completeStep() {},
    failStep() {},
  };

  const agent = createAgent({
    llm: new StubLLM(),
    planner: fakePlanner as any,
  });

  const summary = await agent.chat('帮我先生成短视频脚本，然后保存成文档');
  assert.match(summary, /缺少一些关键信息/);
  assert.match(summary, /输出格式或输出位置/);

  const replannedSummary = await (agent as any).respondToPendingInput('输出成 word 文档，放到 artifacts 目录');
  assert.match(replannedSummary || '', /任务规划已创建/);
  assert.equal(agent.getMessages().some(message => message.role === 'assistant' && message.content.includes('任务规划已创建')), true);

  const executionResult = await agent.confirmAction(true);
  assert.match(executionResult || '', /任务完成/);

  const messages = agent.getMessages();
  assert.equal(messages.some(message => message.role === 'user' && message.content === '是'), true);
  assert.equal(messages.some(message => message.role === 'assistant' && message.content.includes('## ✅ 任务完成')), true);
}

async function testAgentInteractionService(): Promise<void> {
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  let state = 'IDLE';
  let lastUserInput = '';

  const service = new AgentInteractionService({
    addUserMessage: (content) => {
      userMessages.push(content);
    },
    addAssistantMessage: (content) => {
      assistantMessages.push(content);
    },
    executePlan: async (originalTask) => `EXEC:${originalTask}`,
    resumePlanExecution: async (_resumeState, note) => `RESUME:${note || 'none'}`,
    chatWithPlanning: async (input) => `PLAN:${input}`,
    setState: (next) => {
      state = next;
    },
    setLastUserInput: (input) => {
      lastUserInput = input;
    },
    getLastUserInput: () => lastUserInput,
  });

  assert.match(service.buildTaskClarificationPrompt('帮我处理一下') || '', /缺少一些关键信息/);
  assert.equal(service.buildTaskClarificationPrompt('看下招远明天天气，然后发我飞书'), null);

  service.setPendingInteraction({
    type: 'plan_execution',
    originalTask: '生成脚本',
    plan: { id: 'plan_1', originalTask: '生成脚本', currentStepIndex: 0, status: 'planning', steps: [] } as any,
    prompt: 'confirm',
  });

  const replanned = await service.respondToPendingInput('输出成 word 文档');
  assert.match(replanned || '', /PLAN:/);
  assert.equal(state, 'THINKING');
  assert.match(lastUserInput, /用户对执行计划的补充要求/);

  service.setPendingInteraction({
    type: 'plan_resume',
    originalTask: '恢复任务',
    resumeState: {
      originalTask: '恢复任务',
      plan: { id: 'plan_resume', originalTask: '恢复任务', currentStepIndex: 0, status: 'planning', steps: [] } as any,
      nextStepIndex: 0,
      results: [],
      blockedStepDescription: 'step',
      blockedReason: 'need auth',
    },
    prompt: 'resume',
  });

  const resumed = await service.respondToPendingInput('继续');
  assert.equal(resumed, 'RESUME:none');
  assert.equal(userMessages.includes('继续'), true);
  assert.equal(assistantMessages.length >= 0, true);
}

async function testWeatherToLarkRequestSkipsClarification(): Promise<void> {
  const plan = {
    originalTask: '看下招远明天天气，然后发我飞书',
    steps: [
      { id: 'step_1', description: '查询招远明天天气并整理为可发送内容' },
      { id: 'step_2', description: '将整理好的天气内容发送到飞书' },
    ],
  };
  const fakePlanner = {
    async createPlan() {
      return plan;
    },
    completeStep() {},
    failStep() {},
  };

  const agent = createAgent({
    llm: new StubLLM(),
    planner: fakePlanner as any,
    config: { agentInteractionMode: 'auto' } as any,
  });

  const summary = await agent.chat('看下招远明天天气，然后发我飞书');
  assert.doesNotMatch(summary, /缺少一些关键信息/);
  assert.match(summary, /任务规划已创建/);
}

function testLarkBridgeToolDefinitions(): void {
  const toolNames = TOOL_DEFINITIONS.map(tool => tool.name);

  assert.equal(toolNames.includes('help'), true);
  assert.equal(toolNames.includes('doctor'), true);
  assert.equal(toolNames.includes('auth_status'), true);
  assert.equal(toolNames.includes('shortcut'), true);
  assert.equal(toolNames.includes('service'), true);
  assert.equal(toolNames.includes('api'), true);
}

function testLarkBridgeArgumentBuilding(): void {
  assert.deepEqual(buildLarkCliArgs('auth_status', { verify: true }), ['auth', 'status', '--verify']);
  assert.deepEqual(buildLarkCliArgs('schema', { target: 'calendar.events.instance_view' }), ['schema', 'calendar.events.instance_view']);
  assert.deepEqual(
    buildLarkCliArgs('shortcut', {
      service: 'calendar',
      command: '+agenda',
      flags: { timezone: 'Asia/Shanghai', compact: true },
      as: 'user',
    }),
    ['calendar', '+agenda', '--timezone', 'Asia/Shanghai', '--compact', '--as', 'user', '--format', 'json'],
  );
  assert.deepEqual(
    buildLarkCliArgs('shortcut', {
      service: 'im',
      command: '+messages-send',
      flags: { 'chat-id': 'oc_9680feeacaabb3dcae9f406ffbaf18e2', text: '测试成功！' },
      as: 'bot',
    }),
    ['im', '+messages-send', '--chat-id', 'oc_9680feeacaabb3dcae9f406ffbaf18e2', '--text', '测试成功！', '--as', 'bot'],
  );
  assert.deepEqual(
    buildLarkCliArgs('shortcut', {
      service: 'im',
      command: '+messages-send',
      flags: { 'chat-id': 'oc_9680feeacaabb3dcae9f406ffbaf18e2', text: '第一行\n第二行\n第三行' },
      as: 'bot',
    }),
    ['im', '+messages-send', '--chat-id', 'oc_9680feeacaabb3dcae9f406ffbaf18e2', '--text', '第一行\n第二行\n第三行', '--as', 'bot'],
  );
  assert.deepEqual(
    buildLarkCliArgs('shortcut', {
      service: 'im',
      command: '+messages-send',
      flags: { 'chat-id': 'oc_9680feeacaabb3dcae9f406ffbaf18e2', text: '身份修正测试' },
      as: 'user',
    }),
    ['im', '+messages-send', '--chat-id', 'oc_9680feeacaabb3dcae9f406ffbaf18e2', '--text', '身份修正测试', '--as', 'bot'],
  );
  assert.deepEqual(
    getBaseLarkCliCandidates('lark-cli', 'win32'),
    ['lark-cli', 'lark-cli.exe', 'lark-cli.cmd', 'lark-cli.bat'],
  );
  assert.deepEqual(
    getBaseLarkCliCandidates('lark-cli.cmd', 'win32'),
    ['lark-cli.exe', 'lark-cli', 'lark-cli.cmd'],
  );
  assert.deepEqual(
    buildLarkCliArgs('shortcut', {
      service: 'calendar',
      command: '+create',
      flags: {
        title: '吃午饭',
        startTime: '2026-04-09T12:00:00+08:00',
        endTime: '2026-04-09T13:00:00+08:00',
      },
      as: 'user',
    }),
    ['calendar', '+create', '--summary', '吃午饭', '--start', '2026-04-09T12:00:00+08:00', '--end', '2026-04-09T13:00:00+08:00', '--as', 'user', '--format', 'json'],
  );
  assert.deepEqual(
    buildLarkCliArgs('service', {
      service: 'calendar',
      resource: 'calendars',
      method: 'list',
      params: { page_size: 20 },
      as: 'bot',
      dryRun: true,
    }),
    ['calendar', 'calendars', 'list', '--params', '{"page_size":20}', '--as', 'bot', '--format', 'json', '--dry-run'],
  );
  assert.deepEqual(
    buildLarkCliArgs('api', {
      httpMethod: 'get',
      path: '/open-apis/calendar/v4/calendars',
      params: { page_size: 10 },
    }),
    ['api', 'GET', '/open-apis/calendar/v4/calendars', '--params', '{"page_size":10}', '--format', 'json'],
  );
}

async function testLarkBridgeSpawnSpecBypassesCmdWrapper(tempDir: string): Promise<void> {
  const nodeBinDir = path.join(tempDir, 'node-bin');
  const wrapperPath = path.join(nodeBinDir, 'lark-cli.cmd');
  const runJsPath = path.join(nodeBinDir, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  const nodeExePath = path.join(nodeBinDir, 'node.exe');

  await fs.mkdir(path.dirname(runJsPath), { recursive: true });
  await fs.writeFile(wrapperPath, '@echo off\r\n', 'utf-8');
  await fs.writeFile(runJsPath, 'console.log("ok");\n', 'utf-8');
  await fs.writeFile(nodeExePath, '', 'utf-8');

  assert.deepEqual(
    buildSpawnSpec(
      'lark-cli.cmd',
      ['im', '+messages-send', '--text', '第一行\n第二行', '--as', 'bot'],
      'win32',
      nodeBinDir,
    ),
    {
      command: nodeExePath,
      args: [runJsPath, 'im', '+messages-send', '--text', '第一行\n第二行', '--as', 'bot'],
    },
  );
}

function testDeepSeekToolMessageSanitization(): void {
  const agent = createAgent({
    llm: new StubLLM(),
  });

  agent.setMessages([
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [{
        id: 'call_valid',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      }],
    },
    { role: 'tool', content: 'tool result', tool_call_id: 'call_valid', name: 'read_file' },
    { role: 'tool', content: 'orphan tool result', tool_call_id: 'call_orphan', name: 'read_file' },
    { role: 'user', content: 'next turn' },
  ]);

  const messages = (agent as any).getMessagesForLLM() as Message[];
  const orphan = messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_orphan');
  const valid = messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_valid');

  assert.equal(orphan, undefined);
  assert.ok(valid);
}

function testDeepSeekDropsDanglingAssistantToolCalls(): void {
  const agent = createAgent({
    llm: new StubLLM(),
  });

  agent.setMessages([
    { role: 'user', content: '生成 PDF 并发到飞书' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [{
        id: 'call_missing',
        type: 'function',
        function: { name: 'txt_to_pdf', arguments: '{"out":"a.pdf"}' },
      }],
    },
    { role: 'user', content: '你这个文档打不开' },
  ]);

  const messages = (agent as any).getMessagesForLLM() as Message[];
  const danglingAssistant = messages.find(
    message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'call_missing'),
  );

  assert.equal(danglingAssistant, undefined);
  assert.equal(messages.some(message => message.role === 'user' && message.content === '你这个文档打不开'), true);
}

function testContextManagerCompressionKeepsToolMessagesValid(): void {
  const contextManager = createContextManager({
    maxWorkingTokens: 10,
    maxSummaryTokens: 0,
    enableSummary: false,
  });

  contextManager.initialize([
    { role: 'user', content: 'alpha' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [{
        id: 'call_ctx',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"x.txt"}' },
      }],
    },
    { role: 'tool', content: 'tool output', tool_call_id: 'call_ctx', name: 'read_file' },
  ]);

  contextManager.addMessage({ role: 'user', content: 'this message is long enough to trigger compression hard' });

  const messages = contextManager.getMessages();
  const orphan = messages.find(message => message.role === 'tool' && message.tool_call_id === 'call_ctx');
  const assistant = messages.find(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'call_ctx'));

  if (!assistant) {
    assert.equal(orphan, undefined);
  }
}

function testContextManagerDropsDanglingAssistantToolCalls(): void {
  const contextManager = createContextManager({
    maxWorkingTokens: 10,
    maxSummaryTokens: 0,
    enableSummary: false,
  });

  contextManager.initialize([
    { role: 'user', content: 'alpha' },
    {
      role: 'assistant',
      content: 'calling tool',
      tool_calls: [{
        id: 'call_ctx_missing',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"x.txt"}' },
      }],
    },
  ]);

  contextManager.addMessage({ role: 'user', content: 'this message is long enough to trigger compression hard' });

  const messages = contextManager.getMessages();
  const danglingAssistant = messages.find(
    message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'call_ctx_missing'),
  );

  assert.equal(danglingAssistant, undefined);
}

function testCliSlashCommandCompletion(): void {
  const cli = new CLI();
  const [matches] = (cli as any).completeInput('/m') as [string[], string];
  const [modelMatches] = (cli as any).completeInput('/model s') as [string[], string];
  const [configMatches] = (cli as any).completeInput('/config u') as [string[], string];
  const [relayMatches] = (cli as any).completeInput('/relay ') as [string[], string];
  const [cronMatches] = (cli as any).completeInput('/cron c') as [string[], string];
  const [mcpMatches] = (cli as any).completeInput('/mcp c') as [string[], string];
  const [newsMatches] = (cli as any).completeInput('/news ') as [string[], string];
  const [newsSaveMatches] = (cli as any).completeInput('/news s') as [string[], string];
  const [newsOutputMatches] = (cli as any).completeInput('/news o') as [string[], string];
  const [visionMatches] = (cli as any).completeInput('/vision ') as [string[], string];

  assert.equal(matches.includes('/m'), true);
  assert.equal(matches.includes('/model'), true);
  assert.equal(matches.includes('/memory'), true);
  assert.equal(matches.includes('/mcp'), true);
  assert.equal(modelMatches.includes('/model switch'), true);
  assert.equal(modelMatches.includes('/model switch hybrid'), true);
  assert.equal(configMatches.includes('/config update'), true);
  assert.equal(relayMatches.includes('/relay status'), true);
  assert.equal(relayMatches.includes('/relay start'), true);
  assert.equal(relayMatches.includes('/relay stop'), true);
  assert.equal(relayMatches.includes('/relay reconnect'), true);
  assert.equal(cronMatches.includes('/cron create'), true);
  assert.equal(cronMatches.includes('/cron create-news'), true);
  assert.equal(mcpMatches.includes('/mcp check'), true);
  assert.equal(mcpMatches.includes('/mcp check mempalace'), true);
  assert.equal(newsMatches.includes('/news hot'), true);
  assert.equal(newsMatches.includes('/news search'), true);
  assert.equal(newsMatches.includes('/news morning'), true);
  assert.equal(newsMatches.includes('/news evening'), true);
  assert.equal(newsSaveMatches.includes('/news save hot'), true);
  assert.equal(newsSaveMatches.includes('/news save search'), true);
  assert.equal(newsOutputMatches.includes('/news output-dir'), true);
  assert.equal(visionMatches.includes('/vision analyze ./images'), true);
}

function testCliVisionAnalyzeArgParsing(): void {
  const cli = new CLI() as any;
  const parsed = cli.parseVisionAnalyzeArgs([
    './images',
    './captures/error.png',
    '--model',
    'minicpm-v',
    '--limit',
    '3',
    '请总结异常状态',
  ]);

  assert.deepEqual(parsed?.targets, ['./images', './captures/error.png']);
  assert.equal(parsed?.model, 'minicpm-v');
  assert.equal(parsed?.limit, 3);
  assert.equal(parsed?.prompt, '请总结异常状态');
  assert.throws(() => cli.parseVisionAnalyzeArgs(['./images', '--limit', '0']), /Invalid --limit value/);
}

async function testCliParseBrowserScriptActions(tempDir: string): Promise<void> {
  const cli = new CLI() as any;
  cli.workspace = tempDir;

  const inline = await cli.parseBrowserActions(JSON.stringify([
    { type: 'evaluate_script', script: 'window.__x = 1' },
    { type: 'call_userscript_api', api: 'UserscriptBridge.collect', args: ['orders'] },
    { type: 'toggle_userscript_mode', enabled: false },
  ]));

  assert.equal(inline[0]?.type, 'evaluate_script');
  assert.equal(inline[1]?.api, 'UserscriptBridge.collect');
  assert.equal(inline[2]?.enabled, false);

  const filePath = path.join(tempDir, 'browser-actions.json');
  await fs.writeFile(filePath, JSON.stringify([{ type: 'evaluate_script', script: '1 + 1' }]), 'utf-8');
  const fromFile = await cli.parseBrowserActions('@browser-actions.json');
  assert.equal(fromFile[0]?.type, 'evaluate_script');
}

async function testCliConfigReloadCommand(): Promise<void> {
  const cli = new CLI() as any;
  let reloadCount = 0;
  cli.reloadRuntimeConfig = async () => {
    reloadCount += 1;
  };

  await cli.handleCommand('/config update');
  await cli.handleCommand('/config reload');

  assert.equal(reloadCount, 2);
}

async function testCliRelayCommands(): Promise<void> {
  const cli = new CLI() as any;
  let statusCount = 0;
  let startCount = 0;
  let stopCount = 0;
  let reconnectCount = 0;

  cli.showRelayStatus = async () => {
    statusCount += 1;
  };
  cli.startLarkRelayFromCommand = async () => {
    startCount += 1;
  };
  cli.stopLarkRelayFromCommand = async () => {
    stopCount += 1;
  };
  cli.reconnectLarkRelay = async () => {
    reconnectCount += 1;
  };

  await cli.handleCommand('/relay status');
  await cli.handleCommand('/relay start');
  await cli.handleCommand('/relay stop');
  await cli.handleCommand('/relay reconnect');

  assert.equal(statusCount, 1);
  assert.equal(startCount, 1);
  assert.equal(stopCount, 1);
  assert.equal(reconnectCount, 1);
}

async function testCliSendsFinalAssistantReplyToLarkChat(): Promise<void> {
  const cli = new CLI() as any;
  const sentCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  cli.activeLarkReplyTarget = {
    type: 'im.message.receive_v1',
    content: '测试消息',
    chatId: 'oc_reply_target',
    raw: {},
  };
  cli.builtInTools = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      sentCalls.push({ name, args });
      return { output: 'ok' };
    },
  };

  await cli.sendAssistantReplyToActiveLarkTarget('最终结果正文');

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0]?.name, 'send_lark_message');
  assert.deepEqual(sentCalls[0]?.args, {
    chatId: 'oc_reply_target',
    text: '最终结果正文',
  });
}

async function testCliSendsPendingInteractionPromptToLarkChat(): Promise<void> {
  const cli = new CLI() as any;
  const sentCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  cli.activeLarkReplyTarget = {
    type: 'im.message.receive_v1',
    content: '测试消息',
    chatId: 'oc_reply_target',
    raw: {},
  };
  cli.builtInTools = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      sentCalls.push({ name, args });
      return { output: 'ok' };
    },
  };
  cli.agent = {
    getPendingInteractionDetails: () => ({
      type: 'plan_execution',
      prompt: '请确认是否执行上述计划（回复“是”或“否”）',
    }),
  };

  await cli.sendPendingInteractionPromptToActiveLarkTarget('别的正文');

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0]?.name, 'send_lark_message');
  assert.deepEqual(sentCalls[0]?.args, {
    chatId: 'oc_reply_target',
    text: '请确认是否执行上述计划（回复“是”或“否”）',
  });

  sentCalls.length = 0;
  await cli.sendPendingInteractionPromptToActiveLarkTarget('请确认是否执行上述计划（回复“是”或“否”）');
  assert.equal(sentCalls.length, 0);
}

async function testCliForwardsPermissionPromptToLarkAndConsumesLarkReply(tempDir: string): Promise<void> {
  const cli = new CLI() as any;
  const sentCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const permissionManager = new PermissionManager(path.join(tempDir, 'permission-forwarding'));
  await permissionManager.initialize();

  cli.permissionMgr = permissionManager;
  cli.currentInputMode = 'feishu';
  cli.activeLarkReplyTarget = {
    type: 'im.message.receive_v1',
    content: '执行一下目录命令',
    chatId: 'oc_permission_chat',
    senderId: 'ou_sender_1',
    raw: {},
  };
  cli.builtInTools = {
    executeTool: async (name: string, args: Record<string, unknown>) => {
      sentCalls.push({ name, args });
      return { output: 'ok' };
    },
  };
  cli.promptInline = async () => {
    throw new Error('promptInline should not be used for feishu permission approval');
  };

  cli.setupPermissionHandler();

  const requestPromise = permissionManager.requestPermission('command_execute', 'dir /b');
  await Promise.resolve();

  assert.equal(sentCalls.length, 1);
  assert.equal(sentCalls[0]?.name, 'send_lark_message');
  assert.equal(sentCalls[0]?.args.chatId, 'oc_permission_chat');
  assert.match(String(sentCalls[0]?.args.text || ''), /危险操作/);
  assert.match(String(sentCalls[0]?.args.text || ''), /yes\s+-\s+授权本次/);
  assert.equal(/\u001B\[[0-9;]*m/.test(String(sentCalls[0]?.args.text || '')), false);

  const consumed = cli.consumePendingLarkInlineReply('yes', {
    type: 'im.message.receive_v1',
    content: 'yes',
    chatId: 'oc_permission_chat',
    senderId: 'ou_sender_1',
    raw: {},
  });
  assert.equal(consumed, true);

  const granted = await requestPromise;
  assert.equal(granted, true);
}

async function testLarkRelayStatusClassification(): Promise<void> {
  const relay = new LarkRelayAgent({ enabled: true, autoSubscribe: true }) as any;
  relay.readManagedState = async () => ({ pid: 101, cliBin: 'lark-cli.cmd', args: ['event', '+subscribe'], createdAt: Date.now() });
  relay.listSubscribeProcesses = async () => ([
    { pid: 101, commandLine: 'lark-cli.cmd event +subscribe --as bot' },
    { pid: 202, commandLine: 'lark-cli.cmd event +subscribe --as bot --compact' },
  ]);
  relay.process = { pid: 101 };
  relay.lastStartupError = 'boom';
  relay.lastStopDetail = 'code=1 signal=null';

  const status = await relay.getStatus();

  assert.equal(status.running, true);
  assert.equal(status.currentPid, 101);
  assert.equal(status.managedPid, 101);
  assert.equal(status.externalOccupancy, true);
  assert.equal(status.subscribeProcesses[0]?.owner, 'current');
  assert.equal(status.subscribeProcesses[1]?.owner, 'external');
  assert.equal(status.lastStartupError, 'boom');
  assert.equal(status.lastStopDetail, 'code=1 signal=null');
}

async function testResponseStreamCollector(): Promise<void> {
  const seenChunks: string[] = [];
  const collector = new ResponseStreamCollector({
    onChunk: (chunk) => {
      seenChunks.push(chunk.content);
    },
  });

  async function* stream(): AsyncGenerator<LLMStreamChunk> {
    yield { content: 'hello ', done: false };
    yield {
      content: 'world',
      done: false,
      toolCalls: [{ id: 'native_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    };
    yield { content: '!', done: true };
  }

  const collected = await collector.collect(stream());

  assert.deepEqual(seenChunks, ['hello ', 'world', '!']);
  assert.equal(collected.content, 'hello world!');
  assert.equal(collected.nativeToolCalls.length, 1);
  assert.equal(collected.nativeToolCalls[0]?.id, 'native_1');
}

function testFinalResponseAssembler(): void {
  const messages: Message[] = [];
  const assembler = new FinalResponseAssembler({
    applyKnownGapNotice: (response) => response ? `NOTICE\n\n${response}` : 'NOTICE',
    addMessage: (message) => {
      messages.push(message);
    },
  });

  const finalized = assembler.finalizeResponse('正文', true);
  assert.equal(finalized, 'NOTICE\n\n正文');
  assert.equal(messages[0]?.content, 'NOTICE\n\n正文');

  const errorResult = assembler.finalizeError('boom', 'partial');
  assert.equal(errorResult.assistantMessage, 'Error: boom');
  assert.equal(errorResult.returnValue, 'NOTICE\n\npartial');
}

async function testResponseTurnExecutor(): Promise<void> {
  const iterations: number[] = [];
  let turnCount = 0;
  const executor = new ResponseTurnExecutor({
    maxIterations: 3,
    isToolOverLimit: () => false,
    onToolLimit: () => {
      throw new Error('should not hit tool limit');
    },
    onIterationStart: (iteration) => {
      iterations.push(iteration);
    },
    getMessagesForLLM: () => [{ role: 'user', content: 'hello' }],
    runTurn: async () => {
      turnCount += 1;
      if (turnCount === 1) {
        return { response: 'tool turn', continueLoop: true };
      }
      return { response: 'final turn', continueLoop: false };
    },
    finalizeError: () => 'error',
    finalizeMaxIterations: () => 'maxed',
    finalizeCompletion: (response) => `done:${response}`,
  });

  const result = await executor.execute();

  assert.deepEqual(iterations, [1, 2]);
  assert.equal(result, 'done:final turn');
}

async function testResponseTurnProcessor(): Promise<void> {
  const persistedMessages: Message[] = [];
  const collector = new ResponseStreamCollector();
  const assembler = new FinalResponseAssembler({
    applyKnownGapNotice: (response) => response ? `NOTICE\n\n${response}` : 'NOTICE',
    addMessage: (message) => {
      persistedMessages.push(message);
    },
  });

  let coordinatedCalls = 0;
  const nonStreamingProcessor = new ResponseTurnProcessor({
    llm: {
      generate: async () => 'plain response',
      chatStream: undefined,
    } as unknown as LLMProviderInterface,
    responseStreamCollector: collector,
    toolCallResponseCoordinator: {
      coordinate: async () => {
        coordinatedCalls += 1;
        return { handled: false, cleanResponse: 'plain response', toolCallSource: 'none' as const };
      },
    },
    finalResponseAssembler: assembler,
  });

  const nonStreamingResult = await nonStreamingProcessor.execute([{ role: 'user', content: 'hello' }], 'hello');
  assert.equal(nonStreamingResult.continueLoop, false);
  assert.equal(nonStreamingResult.response, 'NOTICE\n\nplain response');
  assert.equal(coordinatedCalls, 1);
  assert.equal(persistedMessages[0]?.content, 'NOTICE\n\nplain response');

  const streamingProcessor = new ResponseTurnProcessor({
    llm: {
      generate: async () => 'unused',
      async *chatStream(): AsyncGenerator<LLMStreamChunk> {
        yield {
          content: 'tool response',
          done: false,
          toolCalls: [{ id: 'native_2', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        };
        yield { content: '', done: true };
      },
    } as unknown as LLMProviderInterface,
    responseStreamCollector: collector,
    toolCallResponseCoordinator: {
      coordinate: async (params) => {
        assert.equal(params.userInput, 'use tool');
        assert.equal(params.nativeToolCalls?.[0]?.id, 'native_2');
        return { handled: true, cleanResponse: 'tool response', toolCallSource: 'native' as const };
      },
    },
    finalResponseAssembler: assembler,
  });

  const streamingResult = await streamingProcessor.execute([{ role: 'user', content: 'use tool' }], 'use tool');
  assert.equal(streamingResult.continueLoop, true);
  assert.equal(streamingResult.response, 'tool response');
  assert.equal(persistedMessages.length, 1);
}

async function testResponseTurnProcessorDefersFinalizationOnHandledNonStreamingToolCall(): Promise<void> {
  const persistedMessages: Message[] = [];
  const processor = new ResponseTurnProcessor({
    llm: {
      generate: async () => 'call tool now',
      chatStream: undefined,
    } as unknown as LLMProviderInterface,
    responseStreamCollector: new ResponseStreamCollector(),
    toolCallResponseCoordinator: {
      coordinate: async (params) => {
        assert.equal(params.responseContent, 'call tool now');
        assert.equal(params.prepareFallbackContent, 'Using tool...');
        return { handled: true, cleanResponse: 'call tool now', toolCallSource: 'fallback' as const };
      },
    },
    finalResponseAssembler: new FinalResponseAssembler({
      applyKnownGapNotice: (response) => `NOTICE\n\n${response}`,
      addMessage: (message) => {
        persistedMessages.push(message);
      },
    }),
  });

  const result = await processor.execute([{ role: 'user', content: 'run tool' }], 'run tool');

  assert.equal(result.continueLoop, true);
  assert.equal(result.response, 'call tool now');
  assert.equal(persistedMessages.length, 0);
}

async function testDirectActionSupportComponents(tempDir: string): Promise<void> {
  const artifactDir = path.join(tempDir, 'artifacts');
  const rememberedCsvPath = path.join(artifactDir, 'recent.csv');
  const rememberedMarkdownPath = path.join(artifactDir, 'notes.md');
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(rememberedCsvPath, 'name,value\nfoo,1', 'utf-8');
  await fs.writeFile(rememberedMarkdownPath, '# recent note', 'utf-8');

  const storedEntries: Array<{ key?: string; content: string; metadata?: Record<string, unknown> }> = [];
  const artifactSupport = new DirectActionArtifactSupport({
    workspace: tempDir,
    config: { artifactOutputDir: artifactDir },
    getConversationMessages: () => [
      { role: 'assistant', content: '这是上一段可复用正文。' },
      { role: 'tool', content: `Created file: ${rememberedCsvPath}`, name: 'write_file', tool_call_id: 'tool_recent_csv' },
    ],
    memoryProvider: {
      backend: 'local',
      async recall(query: string) {
        if (/last_output_file|csv/i.test(query)) {
          return [{ content: `latest artifact: ${rememberedCsvPath}`, metadata: { path: rememberedCsvPath } } as any];
        }
        return [];
      },
      async recallLayers() { return []; },
      async buildContext() { return ''; },
      async syncSession() { return; },
      async store(entry) {
        storedEntries.push({ key: entry.key, content: entry.content, metadata: entry.metadata as Record<string, unknown> | undefined });
      },
    },
  });
  const exportSupport = new DirectActionExportSupport();
  const routingSupport = new DirectActionRoutingSupport();

  assert.equal(artifactSupport.resolveDirectSourceText('把刚刚的内容保存成 word'), '这是上一段可复用正文。');
  assert.equal(artifactSupport.extractRequestedFileName('生成word文档，文件名叫 brief，内容是 hi'), 'brief');
  assert.match(artifactSupport.inferConversionOutputPath('把刚刚的内容保存成ppt，放到桌面', 'weekly-report', 'pptx'), /^桌面[\\/]weekly-report\.pptx$/);
  assert.equal(await artifactSupport.findConvertibleSourceFilePath('把刚刚的内容保存成ppt', 'pptx'), '');
  assert.equal(await artifactSupport.findConvertibleSourceFilePath('把这个csv转换成xlsx文件', 'xlsx'), rememberedCsvPath);

  assert.deepEqual(routingSupport.splitExplicitPaths(`${rememberedCsvPath} 和 ${rememberedMarkdownPath}`), [rememberedCsvPath, rememberedMarkdownPath]);
  assert.deepEqual(routingSupport.extractPathCandidates('分析 ./captures 和 D:/screenshots/error.png 里的图片').slice(0, 2), ['./captures', 'D:/screenshots/error.png']);
  assert.equal(routingSupport.normalizeSearchQuery('关键词： createDirectActionRouter '), 'createDirectActionRouter');
  assert.equal(routingSupport.normalizeGlobPattern('ts'), '**/*.ts');

  await artifactSupport.rememberSuccessfulToolResult('txt_to_xlsx', { output: 'finance-summary.xlsx', title: '财务汇总' });
  assert.equal(storedEntries.some(entry => entry.key === 'last_output_file' && String(entry.metadata?.path || '').endsWith('finance-summary.xlsx')), true);
  assert.equal(storedEntries.some(entry => entry.key === 'last_xlsx_output_file' && /财务汇总/.test(entry.content)), true);

  assert.equal(exportSupport.detectConvertibleFormat('把刚刚的内容保存成ppt'), 'pptx');
  assert.equal(exportSupport.detectTextFormat('把内容保存成markdown文件'), 'markdown');
  assert.equal(exportSupport.detectFormatFromPath(rememberedMarkdownPath), 'md');
  assert.equal(exportSupport.resolveDocumentExportTool('pptx', ['txt_to_pptx', 'txt_to_docx']), 'txt_to_pptx');

  const skillManager = createSkillManager(path.join(tempDir, 'support-skills-home'));
  await skillManager.initialize();
  await skillManager.addLearningTodo({
    sourceTask: '把 docx 文件转成 pdf',
    issueSummary: '缺少 docx 转 pdf 的稳定工作流。',
    suggestedSkill: 'docx-to-pdf-workflow',
    blockers: ['没有稳定的转换链路'],
    nextActions: ['补齐 docx 读取', '补齐 pdf 导出'],
    tags: ['document'],
    confidence: 0.88,
  });

  const knownGapSupport = new DirectActionKnownGapSupport(skillManager);
  const knownGapResult = await knownGapSupport.buildKnownGapResult(
    '把 docx 文件转成 pdf',
    '当前无法直接完成 docx 到 pdf 的转换。',
    ['可以先转成 txt 再导出 pdf。'],
  );

  assert.equal(knownGapResult.handled, true);
  assert.equal(knownGapResult.isError, true);
  assert.match(knownGapResult.output || '', /这是已知能力缺口/);
  assert.match(knownGapResult.output || '', /docx-to-pdf-workflow/);

  const permissionManager = new PermissionManager(path.join(tempDir, 'tool-support-permissions'));
  await permissionManager.initialize();
  permissionManager.grantPermission('tool_execute');
  permissionManager.grantPermission('file_read');

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, artifactDir] });
  await sandbox.initialize();
  const builtInTools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: { artifactOutputDir: artifactDir },
  });
  const toolSupport = new DirectActionToolSupport({
    builtInTools,
    skillManager,
    permissionManager,
    workspace: tempDir,
    config: { artifactOutputDir: artifactDir },
    artifactSupport,
    exportSupport,
  });

  const escapedMarkdownPath = rememberedMarkdownPath.replace(/\\/g, '\\\\');
  const explicitToolResult = await toolSupport.tryLegacyFallbacks(`@tool read_file {"path":"${escapedMarkdownPath}"}`);
  assert.equal(explicitToolResult?.handled, true);
  assert.match(explicitToolResult?.output || '', /recent note/);

  const unknownToolResult = await toolSupport.tryLegacyFallbacks('@tool missing_tool {}');
  assert.equal(unknownToolResult?.isError, true);
  assert.match(unknownToolResult?.output || '', /Unknown tool/);
}

async function testHybridClientRouting(): Promise<void> {
  class NamedLLM extends StubLLM {
    available = true;
    failChat = false;
    connectionChecks = 0;

    constructor(private readonly label: string) {
      super();
    }

    override async chat(): Promise<LLMResponse> {
      if (this.failChat) {
        throw new Error(`${this.label} unavailable`);
      }
      return { content: this.label };
    }

    override async generate(): Promise<string> {
      return this.label;
    }

    override async checkConnection(): Promise<boolean> {
      this.connectionChecks += 1;
      return this.available;
    }

    override getModel(): string {
      return this.label;
    }
  }

  const local = new NamedLLM('local');
  const remote = new NamedLLM('remote');
  const hybrid = new HybridClient({
    localProvider: local,
    remoteProvider: remote,
    localProviderName: 'ollama',
    remoteProviderName: 'deepseek',
    simpleTaskMaxChars: 80,
    simpleConversationMaxChars: 6000,
    preferRemoteForToolMessages: true,
    localAvailabilityCacheMs: 60_000,
  });

  const simpleChat = await hybrid.chat([
    { role: 'user', content: '你好' },
  ]);
  assert.equal(simpleChat.content, 'local');
  assert.equal(hybrid.getLastRouteSnapshot()?.target, 'local');
  assert.equal(hybrid.getLastRouteSnapshot()?.cacheStatus, 'miss');

  const secondSimpleChat = await hybrid.chat([
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(secondSimpleChat.content, 'local');
  assert.equal(local.connectionChecks, 1);
  assert.equal(hybrid.getLastRouteSnapshot()?.cacheStatus, 'hit');

  const complexChat = await hybrid.chat([
    { role: 'user', content: '先搜索今天的 AI 新闻，然后分析重点，再生成一份周报并发送到飞书' },
  ]);
  assert.equal(complexChat.content, 'remote');
  assert.equal(hybrid.getLastRouteSnapshot()?.target, 'remote');

  const toolHeavyChat = await hybrid.chat([
    { role: 'user', content: '继续处理' },
    { role: 'tool', content: 'tool output', name: 'read_file', tool_call_id: 'tool_1' },
  ]);
  assert.equal(toolHeavyChat.content, 'remote');
  assert.equal(hybrid.getLastRouteSnapshot()?.reason, 'tool_messages');

  const offlineHybrid = new HybridClient({
    localProvider: local,
    remoteProvider: remote,
    localProviderName: 'ollama',
    remoteProviderName: 'deepseek',
    simpleTaskMaxChars: 80,
    simpleConversationMaxChars: 6000,
    preferRemoteForToolMessages: true,
    localAvailabilityCacheMs: 0,
  });

  local.available = false;
  const localOfflineChat = await offlineHybrid.chat([
    { role: 'user', content: 'hello' },
  ]);
  assert.equal(localOfflineChat.content, 'remote');
  assert.equal(offlineHybrid.getLastRouteSnapshot()?.fallbackReason, 'local_unavailable');

  local.available = true;
  local.failChat = true;
  const localFailureChat = await offlineHybrid.chat([
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(localFailureChat.content, 'remote');
  assert.equal(offlineHybrid.getLastRouteSnapshot()?.fallbackReason, 'local_runtime_error');
}

async function testDeepSeekRouterBehavior(): Promise<void> {
  class NamedLLM extends StubLLM {
    constructor(private readonly label: string) {
      super();
    }

    override async chat(): Promise<LLMResponse> {
      return { content: this.label };
    }

    override async generate(): Promise<string> {
      return this.label;
    }

    override getModel(): string {
      return this.label;
    }
  }

  const primary = new NamedLLM('deepseek-chat');
  const reasoning = new NamedLLM('deepseek-reasoner');
  const router = new DeepSeekRouterClient({
    apiKey: 'test',
    baseUrl: 'https://api.deepseek.com',
    primaryModel: 'deepseek-chat',
    reasoningModel: 'deepseek-reasoner',
    primaryProvider: primary,
    reasoningProvider: reasoning,
    autoReasoning: {
      enabled: true,
      simpleTaskMaxChars: 80,
      simpleConversationMaxChars: 6000,
      preferReasonerForToolMessages: true,
      preferReasonerForPlanning: true,
      preferReasonerForLongContext: true,
    },
  });

  const simpleChat = await router.chat([
    { role: 'user', content: '你好' },
  ]);
  assert.equal(simpleChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.target, 'primary');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'simple_task');

  const complexChat = await router.chat([
    { role: 'user', content: '请分析当前 AI 行业格局，并比较主要模型厂商的策略差异和风险' },
  ]);
  assert.equal(complexChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.target, 'primary');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'simple_task');

  const architectureChat = await router.chat([
    { role: 'user', content: '请给我一个支付系统的架构设计和模块拆分方案' },
  ]);
  assert.equal(architectureChat.content, 'deepseek-reasoner');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'architecture_design');

  const troubleshootingChat = await router.chat([
    { role: 'user', content: '帮我排查线上接口偶发超时的根因，并给出调试步骤' },
  ]);
  assert.equal(troubleshootingChat.content, 'deepseek-reasoner');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'troubleshooting');

  const stockAnalysisChat = await router.chat([
    { role: 'user', content: '分析热点新闻中提到的公司或行业，识别相关股票并给出投资逻辑' },
  ]);
  assert.equal(stockAnalysisChat.content, 'deepseek-reasoner');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'stock_analysis');

  const longSummaryChat = await router.chat([
    { role: 'user', content: '请把这篇长报告做一个长文总结，提炼核心观点、风险和结论' },
  ]);
  assert.equal(longSummaryChat.content, 'deepseek-reasoner');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'long_form_summary');

  const toolHeavyChat = await router.chat([
    { role: 'user', content: '继续处理' },
    { role: 'tool', content: 'tool output', name: 'read_file', tool_call_id: 'tool_1' },
  ]);
  assert.equal(toolHeavyChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.target, 'primary');

  const toolAnalysisChat = await router.chat([
    { role: 'user', content: '基于上面的工具结果，分析根因并给出修复建议' },
    { role: 'tool', content: 'tool output', name: 'read_file', tool_call_id: 'tool_1' },
  ]);
  assert.equal(toolAnalysisChat.content, 'deepseek-reasoner');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'troubleshooting');

  const fileDeliveryChat = await router.chat([
    { role: 'user', content: '把 C:/Users/521ka/.ai-agent-cli/outputs/today-news.pptx 发到飞书' },
  ]);
  assert.equal(fileDeliveryChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.target, 'primary');

  const longContextFileDeliveryChat = await router.chat([
    { role: 'user', content: '历史上下文'.repeat(4000) },
    { role: 'assistant', content: '之前处理了很多步骤' },
    { role: 'user', content: '把 C:/Users/521ka/.ai-agent-cli/outputs/today-news.docx 发到飞书' },
  ]);
  assert.equal(longContextFileDeliveryChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.target, 'primary');

  router.setModel('primary');
  const forcedPrimaryChat = await router.chat([
    { role: 'user', content: '请分析一个复杂任务' },
  ]);
  assert.equal(forcedPrimaryChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'manual_primary');

  router.setModel('auto:on');
  const autoOnChat = await router.chat([
    { role: 'user', content: '请分析一个复杂任务' },
  ]);
  assert.equal(autoOnChat.content, 'deepseek-reasoner');
  assert.equal(router.getLastRouteSnapshot()?.target, 'reasoning');

  router.setModel('auto:off');
  const autoOffChat = await router.chat([
    { role: 'user', content: '请分析一个复杂任务' },
  ]);
  assert.equal(autoOffChat.content, 'deepseek-chat');
  assert.equal(router.getLastRouteSnapshot()?.reason, 'manual_primary');
}

function testMemPalaceSystemPromptProtocol(): void {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  agent.tools = [
    {
      name: 'mempalace_search',
      description: 'Search memories',
      input_schema: {},
      category: 'mcp',
    },
    {
      name: 'mempalace_kg_query',
      description: 'Query facts',
      input_schema: {},
      category: 'mcp',
    },
  ];

  const prompt = agent.getDefaultSystemPrompt() as string;
  assert.match(prompt, /Memory Protocol/);
  assert.match(prompt, /mempalace_search/);
  assert.match(prompt, /mempalace_diary_write/);
}

async function testHybridMemoryProviderRecall(tempDir: string): Promise<void> {
  const enhanced = createEnhancedMemoryManager(path.join(tempDir, 'hybrid-memory'));
  await enhanced.initialize();
  enhanced.setUserPreference('job', 'programmer');
  enhanced.addToKnowledgeBase('TypeScript project with MemPalace hybrid recall');
  enhanced.setMessages([
    { role: 'user', content: '我们之前讨论了 TypeScript 记忆架构' },
    { role: 'assistant', content: '是的，已经有本地记忆和 MemPalace 两层。' },
  ]);

  const fakeMcpManager = {
    getClient(name: string) {
      if (name !== 'mempalace') return undefined;
      return {
        getTools() {
          return [{ name: 'mempalace_search' }, { name: 'mempalace_kg_query' }];
        },
      };
    },
    async callTool(_serverName: string, toolName: string) {
      if (toolName === 'mempalace_search') {
        return { content: [{ type: 'text', text: 'MemPalace search hit: TypeScript memory design' }] };
      }
      return { content: [{ type: 'text', text: 'MemPalace fact: hybrid mode enabled' }] };
    },
  };

  const provider = createMemoryProvider({
    enhancedMemory: enhanced,
    mcpManager: fakeMcpManager as any,
    config: { backend: 'hybrid', recallLimit: 4, enableSessionSync: true, enableAutoArchive: true },
  });

  const context = await provider.buildContext('TypeScript', 4);
  assert.match(context, /MemPalace/);
  assert.match(context, /TypeScript project with MemPalace hybrid recall/);
}

async function testMemoryProviderBuildsThreeLayerContext(tempDir: string): Promise<void> {
  const enhanced = createEnhancedMemoryManager(path.join(tempDir, 'layered-memory'));
  await enhanced.initialize();
  enhanced.setUserPreference('job', 'programmer');
  enhanced.addToKnowledgeBase('日报模板需要突出关键异常。');
  enhanced.setMessages([
    { role: 'user', content: '整理日志生成日报' },
    { role: 'assistant', content: '我会先读取日志，再汇总关键异常。' },
  ]);

  const skillManager = createSkillManager(path.join(tempDir, 'layered-skills'));
  await skillManager.initialize();
  await skillManager.maybeCreateCandidateFromExecution({
    originalTask: '整理日志并输出日报模板',
    stepDescriptions: ['读取日志', '归纳异常', '输出日报模板'],
    stepResults: ['读取完成', '归纳完成', '已输出到 outputs'],
    completedSteps: 3,
    totalSteps: 3,
    refinement: {
      shouldCreate: true,
      confidence: 0.88,
      refinedDescription: '日志到日报模板的 procedural workflow。',
      whenToUse: '当任务是整理日志并输出日报模板时使用。',
      procedure: ['读取日志', '归纳异常', '输出日报模板'],
      tags: ['logs', 'report'],
    },
  });

  const provider = createMemoryProvider({
    enhancedMemory: enhanced,
    config: { backend: 'local', recallLimit: 6, enableSessionSync: true, enableAutoArchive: true },
    skillManager,
  });

  const context = await provider.buildContext('整理日志日报', 6);
  const layers = await provider.recallLayers('整理日志日报', 6);

  assert.match(context, /三层记忆索引/);
  assert.match(context, /已知长期记忆/);
  assert.match(context, /Procedural Skill/);
  assert.equal(layers.length > 0, true);
  assert.equal(layers.some(layer => layer.layer === 'procedural'), true);
}

async function testMemoryProviderBaselineIncludesArtifactHints(tempDir: string): Promise<void> {
  const enhanced = createEnhancedMemoryManager(path.join(tempDir, 'artifact-memory'));
  await enhanced.initialize();
  enhanced.setProjectContext('artifact_output_dir', 'C:/Users/521ka/.ai-agent-cli/outputs');
  enhanced.setProjectContext('last_docx_output_file', '今日热点新闻报告: C:/Users/521ka/.ai-agent-cli/outputs/today-news.docx');
  enhanced.setProjectContext('last_csv_output_file', '利润表模板: C:/Users/521ka/.ai-agent-cli/outputs/财务报表_利润表模板.csv');
  enhanced.setProjectContext('last_xlsx_output_file', '利润表模板: C:/Users/521ka/.ai-agent-cli/outputs/财务报表_利润表模板.xlsx');
  enhanced.createTaskProgress('生成今日热点新闻 Word 文档', ['抓取新闻', '导出 Word']);
  const latestTask = enhanced.getActiveTasks()[0];
  if (latestTask) {
    enhanced.completeTask(latestTask.taskId, '输出到 C:/Users/521ka/.ai-agent-cli/outputs/today-news.docx');
  }

  const provider = createMemoryProvider({
    enhancedMemory: enhanced,
    config: { backend: 'local', recallLimit: 6, enableSessionSync: true, enableAutoArchive: true },
  });

  const context = await provider.buildContext('你还记得我让你生成的word文档在哪儿吗', 6);
  assert.match(context, /固定 artifact 输出目录/);
  assert.match(context, /today-news\.docx/);
  assert.match(context, /财务报表_利润表模板\.csv/);
  assert.match(context, /财务报表_利润表模板\.xlsx/);
  assert.match(context, /最近任务结果/);
}

function testAgentRuntimeMemoryContextInjection(): void {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  agent.setRuntimeMemoryContext('最近相关记忆: 用户偏好 TypeScript');
  const messages = agent.getMessagesForLLM() as Message[];

  assert.equal(messages[1]?.role, 'system');
  assert.match(messages[1]?.content || '', /最近相关记忆/);
}

async function testArtifactPathResolution(tempDir: string): Promise<void> {
  const artifactDir = path.join(tempDir, 'artifacts');
  const homeDir = path.join(tempDir, 'home');
  const desktopDir = path.join(homeDir, 'OneDrive', '桌面');
  await fs.mkdir(desktopDir, { recursive: true });

  const artifactPath = resolveOutputPath('report.docx', {
    workspace: tempDir,
    artifactOutputDir: artifactDir,
    homeDir,
  });
  const dotRelativeArtifactPath = resolveOutputPath('./report.docx', {
    workspace: tempDir,
    artifactOutputDir: artifactDir,
    homeDir,
  });
  const desktopAliasPath = resolveUserPath('桌面/summary.txt', {
    workspace: tempDir,
    homeDir,
  });

  assert.equal(artifactPath, path.join(artifactDir, 'report.docx'));
  assert.equal(dotRelativeArtifactPath, path.join(artifactDir, 'report.docx'));
  assert.equal(desktopAliasPath, path.join(desktopDir, 'summary.txt'));
  assert.equal(getArtifactOutputDir({ artifactOutputDir: artifactDir, workspace: tempDir, homeDir }), artifactDir);
  assert.equal(getDesktopPath({ homeDir }), desktopDir);
}

async function testBuiltInToolsArtifactOutput(tempDir: string): Promise<void> {
  const artifactDir = path.join(tempDir, 'artifacts');
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, artifactDir] });
  await sandbox.initialize();

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: { artifactOutputDir: artifactDir },
  });

  const writeResult = await tools.executeTool('write_file', { path: 'story.txt', content: 'artifact output test' });
  const content = await fs.readFile(path.join(artifactDir, 'story.txt'), 'utf-8');

  assert.match(writeResult.output || '', /artifacts/);
  assert.equal(content, 'artifact output test');

  const fakeDocxResult = await tools.executeTool('write_file', { path: 'story.docx', content: 'not a real docx' });
  assert.equal(fakeDocxResult.is_error, true);
  assert.match(fakeDocxResult.output || '', /write_file 不能直接写入/i);

  const docxResult = await tools.executeTool('txt_to_docx', { output: 'artifact-report.docx', text: 'artifact doc body' });
  assert.equal(docxResult.is_error, undefined);
  const infoResult = await tools.executeTool('file_info', { path: 'artifact-report.docx' });
  assert.equal(infoResult.is_error, undefined);
  assert.match(infoResult.output || '', /artifact-report\.docx/);
  assert.match(infoResult.output || '', /artifacts/);
}

function testLarkRelayParsesCompactMessage(): void {
  const line = JSON.stringify({
    type: 'im.message.receive_v1',
    id: 'om_test_message',
    message_id: 'om_test_message',
    chat_id: 'oc_test_chat',
    chat_type: 'p2p',
    message_type: 'text',
    content: '帮我整理今天的热点新闻',
    sender_id: 'ou_test_sender',
    create_time: '1773491924409',
  });

  const parsed = parseLarkRelayMessageLine(line, {
    enabled: true,
    allowedChatIds: ['oc_test_chat'],
    allowedSenderIds: ['ou_test_sender'],
  });

  assert.equal(parsed?.type, 'im.message.receive_v1');
  assert.equal(parsed?.chatId, 'oc_test_chat');
  assert.equal(parsed?.senderId, 'ou_test_sender');
  assert.equal(parsed?.content, '帮我整理今天的热点新闻');
}

function testLarkRelayFiltersUnexpectedSender(): void {
  const line = JSON.stringify({
    type: 'im.message.receive_v1',
    message_id: 'om_test_message',
    chat_id: 'oc_test_chat',
    message_type: 'text',
    content: '这条消息不该被转发',
    sender_id: 'ou_other_sender',
  });

  const parsed = parseLarkRelayMessageLine(line, {
    enabled: true,
    allowedSenderIds: ['ou_expected_sender'],
  });

  assert.equal(parsed, null);
}

function testLarkRelayParsesAttachmentMessage(): void {
  const line = JSON.stringify({
    type: 'im.message.receive_v1',
    event: {
      message: {
        message_id: 'om_attachment_message',
        chat_id: 'oc_test_chat',
        chat_type: 'p2p',
        message_type: 'file',
        content: JSON.stringify({
          file_key: 'file_test_key',
          file_name: '日报.docx',
        }),
      },
      sender: {
        sender_id: {
          open_id: 'ou_test_sender',
        },
      },
    },
  });

  const parsed = parseLarkRelayMessageLine(line, {
    enabled: true,
    allowedChatIds: ['oc_test_chat'],
    allowedSenderIds: ['ou_test_sender'],
  });

  assert.equal(parsed?.messageId, 'om_attachment_message');
  assert.equal(parsed?.messageType, 'file');
  assert.equal(parsed?.attachments?.length, 1);
  assert.equal(parsed?.attachments?.[0]?.type, 'file');
  assert.equal(parsed?.attachments?.[0]?.fileName, '日报.docx');
  assert.match(parsed?.content || '', /飞书文件/);
}

function testLarkRelayDefaultReceiveDir(): void {
  const normalized = normalizeLarkRelayConfig({ enabled: true });
  assert.equal(normalized.downloadAttachments, true);
  assert.equal(normalized.receiveDir, path.join(os.homedir(), '.ai-agent-cli', 'feishuReceive'));
}

async function testLarkRelayMaterializesAttachmentContent(): Promise<void> {
  const relay = new LarkRelayAgent({
    enabled: true,
    receiveDir: path.join(os.tmpdir(), 'ai-agent-cli-feishu-test'),
  }) as any;

  relay.downloadAttachment = async (_message: unknown, attachment: { fileName?: string; type: string }) => {
    return path.join('C:/Users/521ka/.ai-agent-cli/feishuReceive/2026-04-11', attachment.fileName || `${attachment.type}.bin`);
  };

  const message = {
    type: 'im.message.receive_v1',
    content: '[飞书文件] 日报.docx',
    messageId: 'om_attachment_message',
    chatId: 'oc_test_chat',
    senderId: 'ou_test_sender',
    messageType: 'file',
    attachments: [
      {
        key: 'file_test_key',
        type: 'file',
        fileName: '日报.docx',
      },
    ],
    raw: {},
  };

  const materialized = await relay.materializeMessageResources(message);

  assert.equal(materialized.attachments?.[0]?.localPath, 'C:/Users/521ka/.ai-agent-cli/feishuReceive/2026-04-11/日报.docx');
  assert.match(materialized.content, /本地路径: C:\/Users\/521ka\/.ai-agent-cli\/feishuReceive\/2026-04-11\/日报\.docx/);
}

async function testWebSearchUnwrapsDuckDuckGoRedirectLinks(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const html = `
      <html>
        <body>
          <div class="result results_links results_links_deep web-result">
            <div class="links_main links_deep result__body">
              <h2 class="result__title">
                <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenai.com%2Findex%2Fintroducing%2Dgpt%2D5%2D4%2F&amp;rut=test">Introducing GPT-5.4 - OpenAI</a>
              </h2>
              <a class="result__snippet">Latest OpenAI release notes and overview.</a>
            </div>
          </div>
        </body>
      </html>`;

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    });
  }) as typeof globalThis.fetch;

  try {
    const result = await tools.executeTool('web_search', { query: 'OpenAI GPT-5.4', numResults: 3 });
    assert.equal(result.is_error, undefined);
    assert.match(result.output || '', /Introducing GPT-5.4 - OpenAI/);
    assert.match(result.output || '', /https:\/\/openai\.com\/index\/introducing-gpt-5-4\//);
    assert.doesNotMatch(result.output || '', /duckduckgo\.com\/l\//);
    assert.match(result.output || '', /Latest OpenAI release notes and overview\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testWebSearchFallsBackToBaidu(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url.includes('duckduckgo.com')) {
      throw new Error('fetch failed');
    }

    if (url.includes('baidu.com')) {
      const html = `
        <html>
          <body>
            <div class="result c-container">
              <h3 class="c-title">
                <a href="https://finance.example.com/ev-news">新能源汽车板块走强</a>
              </h3>
              <div class="c-abstract">锂电和整车产业链相关上市公司受到市场关注。</div>
            </div>
          </body>
        </html>`;

      return new Response(html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      });
    }

    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;

  try {
    const result = await tools.executeTool('web_search', { query: '新能源汽车 产业链 上市公司', numResults: 3 });
    assert.equal(result.is_error, undefined);
    assert.match(result.output || '', /新能源汽车板块走强/);
    assert.match(result.output || '', /https:\/\/finance\.example\.com\/ev-news/);
    assert.match(result.output || '', /锂电和整车产业链相关上市公司受到市场关注/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPushNewsToLarkRequiresChatId(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    config: {
      notifications: {
        lark: {
          morningNews: {
            userId: 'ou_23aba51dc5e2d7eaf65bdae8ec3ccf43',
          },
        },
      },
    },
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async () => ({ content: [{ type: 'text' as const, text: 'unexpected' }] }),
    } as any,
  });

  const result = await tools.executeTool('push_news_to_lark', { newsType: 'hot', limit: 1 });
  assert.equal(result.is_error, true);
  assert.match(result.output || '', /requires chatId/i);

  const explicitUserResult = await tools.executeTool('push_news_to_lark', {
    newsType: 'hot',
    limit: 1,
    userId: 'ou_23aba51dc5e2d7eaf65bdae8ec3ccf43',
  });
  assert.equal(explicitUserResult.is_error, true);
  assert.match(explicitUserResult.output || '', /only supports chatId/i);
}

async function testPushWeatherToLark(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      current_condition: [{
        temp_C: '19',
        FeelsLikeC: '18',
        humidity: '56',
        windspeedKmph: '8',
        winddir16Point: 'NE',
        uvIndex: '4',
        weatherDesc: [{ value: '晴' }],
      }],
      weather: [{
        maxtempC: '24',
        mintempC: '13',
        astronomy: [{ sunrise: '05:52 AM', sunset: '06:31 PM' }],
        hourly: [{ chanceofrain: '10' }, { chanceofrain: '35' }],
      }],
    }),
  })) as typeof globalThis.fetch;

  let capturedArgs: Record<string, unknown> | undefined;
  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    config: {
      notifications: {
        lark: {
          weather: {
            chatId: 'oc_weather',
            city: '北京',
            timezone: 'Asia/Shanghai',
          },
        },
      },
    },
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as any,
  });

  try {
    const weatherResult = await tools.executeTool('get_weather', { city: '北京' });
    assert.equal(weatherResult.is_error, undefined);
    assert.match(weatherResult.output || '', /今日天气 北京/);
    assert.match(weatherResult.output || '', /天气: 晴/);

    const pushResult = await tools.executeTool('push_weather_to_lark', {});
    assert.equal(pushResult.is_error, undefined);
    assert.match(pushResult.output || '', /天气已发送到飞书群 oc_weather/);
    assert.equal((capturedArgs?.flags as Record<string, unknown>)?.['chat-id'], 'oc_weather');
    assert.match(String((capturedArgs?.flags as Record<string, unknown>)?.text || ''), /今日天气 北京/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testSendLarkMessageUsesBotShortcut(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  let capturedServer = '';
  let capturedTool = '';
  let capturedArgs: Record<string, unknown> | undefined;

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    config: {
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
          },
        },
      },
    },
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
        capturedServer = server;
        capturedTool = tool;
        capturedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as any,
  });

  const result = await tools.executeTool('send_lark_message', { text: '你好，飞书' });
  assert.equal(result.is_error, undefined);
  assert.match(result.output || '', /消息已发送到飞书群/);
  assert.equal(capturedServer, 'lark');
  assert.equal(capturedTool, 'shortcut');
  assert.deepEqual(capturedArgs, {
    service: 'im',
    command: '+messages-send',
    as: 'bot',
    flags: {
      'chat-id': 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
      text: '你好，飞书',
    },
  });
}

async function testSendLarkMessagePrefersMarkdown(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  let capturedArgs: Record<string, unknown> | undefined;

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    config: {
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
          },
        },
      },
    },
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as any,
  });

  const result = await tools.executeTool('send_lark_message', {
    text: '纯文本版本',
    markdown: '**Markdown 版本**',
  });

  assert.equal(result.is_error, undefined);
  assert.deepEqual(capturedArgs, {
    service: 'im',
    command: '+messages-send',
    as: 'bot',
    flags: {
      'chat-id': 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
      markdown: '**Markdown 版本**',
    },
  });
}

async function testSendLarkMessageStagesAbsoluteAttachment(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, process.cwd()] });
  await sandbox.initialize();

  const attachmentPath = path.join(tempDir, 'attachment.docx');
  await fs.writeFile(attachmentPath, 'docx-binary-placeholder', 'utf-8');

  let capturedArgs: Record<string, unknown> | undefined;
  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as any,
    config: {
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
          },
        },
      },
    },
  });

  const result = await tools.executeTool('send_lark_message', { file: attachmentPath });
  assert.equal(result.is_error, undefined);
  assert.equal(capturedArgs?.service, 'im');
  assert.equal(capturedArgs?.command, '+messages-send');
  assert.equal((capturedArgs?.flags as Record<string, unknown>)['chat-id'], 'oc_9680feeacaabb3dcae9f406ffbaf18e2');
  assert.match(String((capturedArgs?.flags as Record<string, unknown>).file || ''), /^\.\/ai-agent-cli-lark-attachments\//);
  assert.equal(await fs.stat(path.join(process.cwd(), 'ai-agent-cli-lark-attachments')).then(() => true).catch(() => false), false);
}

async function testSendLarkMessageResolvesRelativeArtifactAttachment(tempDir: string): Promise<void> {
  const artifactDir = path.join(tempDir, 'artifacts');
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, artifactDir, process.cwd()] });
  await sandbox.initialize();

  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'relative-attachment.docx'), 'docx-binary-placeholder', 'utf-8');

  let capturedArgs: Record<string, unknown> | undefined;
  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: {
      artifactOutputDir: artifactDir,
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
          },
        },
      },
    },
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as any,
  });

  const result = await tools.executeTool('send_lark_message', { file: 'relative-attachment.docx' });
  assert.equal(result.is_error, undefined);
  assert.match(String((capturedArgs?.flags as Record<string, unknown>).file || ''), /^\.\/ai-agent-cli-lark-attachments\//);
}

async function testSendLarkMessagePrefersFileOverText(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, process.cwd()] });
  await sandbox.initialize();

  const attachmentPath = path.join(tempDir, 'attachment.pptx');
  await fs.writeFile(attachmentPath, 'pptx-binary-placeholder', 'utf-8');

  let capturedArgs: Record<string, unknown> | undefined;
  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    mcpManager: {
      getServerNames: () => ['lark'],
      callTool: async (_server: string, _tool: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as any,
    config: {
      notifications: {
        lark: {
          morningNews: {
            chatId: 'oc_9680feeacaabb3dcae9f406ffbaf18e2',
          },
        },
      },
    },
  });

  const result = await tools.executeTool('send_lark_message', {
    file: attachmentPath,
    text: '这段文字不应覆盖附件发送',
  });

  assert.equal(result.is_error, undefined);
  assert.match(String((capturedArgs?.flags as Record<string, unknown>).file || ''), /^\.\/ai-agent-cli-lark-attachments\//);
  assert.equal((capturedArgs?.flags as Record<string, unknown>).text, undefined);
}

function testCliNewsPushRejectsUserIdAndIgnoresLegacyUserDefault(): void {
  const cli = new CLI() as any;

  const parsedWithUserId = cli.parseNewsPushArgs(['morning', '--user-id', 'ou_legacy']);
  assert.equal(parsedWithUserId, null);

  const originalGetDefaultTarget = cli.getDefaultLarkNewsTarget;
  cli.getDefaultLarkNewsTarget = () => ({ chatId: undefined });
  const parsedWithNoChatTarget = cli.parseNewsPushArgs(['morning']);
  assert.equal(parsedWithNoChatTarget, null);

  cli.getDefaultLarkNewsTarget = originalGetDefaultTarget;
}

async function testGreetingDoesNotTriggerPlanning(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  const simpleGreeting = await agent.detectComplexTask('你好');
  const negativeResponse = await agent.detectComplexTask('hello');
  const compositeLarkDelivery = await agent.detectComplexTask('杜甫的茅屋为秋风所破歌这首诗内容是什么，发我飞书');

  assert.equal(simpleGreeting, false);
  assert.equal(negativeResponse, false);
  assert.equal(compositeLarkDelivery, true);
}

async function testAmbiguousShortInputRequestsClarification(): Promise<void> {
  const agent = createAgent({
    llm: new StaticResponseLLM('不该走到这里'),
  }) as any;

  const response = await agent.chat('cli');
  const pending = agent.getConfirmationStatus();

  assert.match(response, /输入有点短|不能准确判断/i);
  assert.equal(pending.pending, true);
  assert.equal(pending.type, 'task_clarification');
}

async function testAmbiguousShortInputClarificationReturnsDirectResponse(): Promise<void> {
  const agent = createAgent({
    llm: new StaticResponseLLM('CLI 是命令行界面，用来通过文本命令操作程序。'),
  }) as any;

  await agent.chat('cli');
  const response = await agent.respondToPendingInput('我是想问 CLI 是什么');

  assert.match(response || '', /命令行界面/);
}

function testDefaultPromptEncouragesDirectPaths(): void {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  const prompt = agent.getDefaultSystemPrompt() as string;

  assert.match(prompt, /Before planning, classify the request into one of three paths/i);
  assert.match(prompt, /Direct action means one clear operation/i);
  assert.match(prompt, /Prefer read_multiple_files over repeated read_file calls/i);
  assert.match(prompt, /save generated content as Word or PDF/i);
  assert.match(prompt, /prefer the configured outputs directory/i);
  assert.match(prompt, /including \.\/file\.docx and \.\/file\.pdf/i);
}

function testCliShellTextUtilities(): void {
  assert.equal(APP_VERSION, '1.3.0');
  assert.match(buildCliLogo(), /AI Agent CLI v1\.3\.0/);
  assert.match(getQuickHelpText(), /\/vision/);
  assert.match(getFullHelpText(), /\/vision/);
  assert.match(getQuickHelpText(), /Override routing mode for debug/);
  assert.match(getFullHelpText(), /Show current routing override/);
  assert.equal(isQuickHelpShortcut('/?'), true);
  assert.equal(isQuickHelpShortcut('/？'), true);
  assert.equal(isQuickHelpShortcut('/help'), false);
  assert.equal(isFullHelpShortcut('/help'), true);
  assert.equal(isFullHelpShortcut('/h'), true);
  assert.equal(isFullHelpShortcut('/?'), false);
}

async function testOllamaVisionService(tempDir: string): Promise<void> {
  const imageDir = path.join(tempDir, 'vision-images');
  await fs.mkdir(imageDir, { recursive: true });
  await fs.writeFile(path.join(imageDir, 'b.jpg'), Buffer.from('jpg-data'));
  await fs.writeFile(path.join(imageDir, 'a.png'), Buffer.from('png-data'));
  await fs.writeFile(path.join(imageDir, 'notes.txt'), 'ignore me', 'utf-8');

  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    return {
      ok: true,
      json: async () => ({ response: 'vision-ok', done: true }),
    } as Response;
  }) as typeof fetch;

  try {
    const service = createOllamaVisionService({
      workspace: tempDir,
      ollamaConfig: {
        baseUrl: 'http://localhost:11434',
        model: 'qwen3.5:9b',
        visionModel: 'minicpm-v',
        visionMaxImages: 4,
      },
    });

    const result = await service.analyzeDirectory({
      directory: './vision-images',
      prompt: '请总结这些图片里的异常点',
      maxImages: 2,
    });

    assert.equal(result.response, 'vision-ok');
    assert.equal(result.model, 'minicpm-v');
    assert.equal(result.imageCount, 2);
    assert.equal(result.imageFiles.map(file => path.basename(file)).join(','), 'a.png,b.jpg');
    assert.equal(capturedBody?.model, 'minicpm-v');
    assert.equal(Array.isArray(capturedBody?.images), true);
    assert.equal((capturedBody?.images as unknown[]).length, 2);
    assert.match(String(capturedBody?.prompt || ''), /a\.png, b\.jpg/);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testBrowserSessionExtensionBootstrap(tempDir: string): Promise<void> {
  const extensionDir = path.join(tempDir, 'tampermonkey-extension');
  const profileDir = path.join(tempDir, 'browser-profile');
  const initScriptPath = path.join(tempDir, 'inject-init.js');
  const pageScriptPath = path.join(tempDir, 'inject-page.js');
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(initScriptPath, 'window.__initScriptLoaded = true;', 'utf-8');
  await fs.writeFile(pageScriptPath, 'window.__pageScriptLoaded = true;', 'utf-8');

  const initScripts: string[] = [];
  const evaluatedScripts: string[] = [];
  const evaluatedObjects: unknown[] = [];
  const evaluatedBooleans: boolean[] = [];
  const gotoUrls: string[] = [];
  let launchUserDataDir = '';
  let launchOptions: Record<string, unknown> | undefined;

  const page = {
    addInitScript: async (script: string) => {
      initScripts.push(script);
    },
    goto: async (url: string) => {
      gotoUrls.push(url);
    },
    title: async () => 'Example',
    url: () => gotoUrls[gotoUrls.length - 1] || 'about:blank',
    setDefaultTimeout: () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      first: () => ({
        click: async () => {},
        fill: async (_value: string) => {},
        press: async (_key: string) => {},
        innerText: async () => '',
      }),
    }),
    evaluate: async (_pageFunction: unknown, arg: unknown) => {
      if (typeof arg === 'string') {
        evaluatedScripts.push(arg);
        if (arg.includes('window.__scriptResult = 1')) {
          return { ok: true };
        }
        return undefined;
      }

      if (typeof arg === 'boolean') {
        evaluatedBooleans.push(arg);
        return arg;
      }

      evaluatedObjects.push(arg);
      return 'api-ok';
    },
  };

  const context = {
    addInitScript: async (script: string) => {
      initScripts.push(script);
    },
    newPage: async () => page,
    close: async () => {},
    pages: () => [],
  };

  const session = new BrowserSession({
    browser: 'chrome',
    headless: true,
    timeoutMs: 4321,
    workspace: tempDir,
    userDataDir: './browser-profile',
    extensionPaths: ['./tampermonkey-extension'],
    initScriptPaths: ['./inject-init.js'],
    initScripts: ['window.__inlineInitLoaded = true;'],
    pageScriptPaths: ['./inject-page.js'],
    pageScripts: ['window.__inlinePageLoaded = true;'],
    userscripts: {
      inline: ['window.__userscriptLoaded = true;'],
      runAt: 'document-end',
    },
  }) as any;

  session.loadPlaywright = async () => ({
    chromium: {
      launch: async () => {
        throw new Error('launch should not be used when extension paths are configured');
      },
      launchPersistentContext: async (userDataDir: string, options: Record<string, unknown>) => {
        launchUserDataDir = userDataDir;
        launchOptions = options;
        return context;
      },
    },
  });

  await session.start('https://example.com/dashboard');
  const scriptResult = await session.executeWithOptions({
    type: 'evaluate_script',
    script: 'window.__scriptResult = 1',
    expectResult: {
      type: 'object',
      shape: '{ ok: boolean }',
      description: 'script execution payload',
    },
    reason: 'execute explicit script',
    confidence: 0.9,
  }, {});
  const apiResult = await session.executeWithOptions({
    type: 'call_userscript_api',
    api: 'UserscriptBridge.collect',
    args: ['foo', 2],
    expectResult: {
      type: 'array',
      shape: '{ id: string }[]',
      description: 'order list',
    },
    reason: 'call userscript api',
    confidence: 0.9,
  }, {});
  const toggleResult = await session.executeWithOptions({
    type: 'toggle_userscript_mode',
    enabled: false,
    reason: 'disable userscript mode',
    confidence: 0.9,
  }, {});
  await session.close();

  assert.equal(launchUserDataDir, profileDir);
  assert.equal(launchOptions?.channel, 'chromium');
  assert.equal(launchOptions?.headless, false);
  assert.deepEqual(launchOptions?.ignoreDefaultArgs, ['--disable-extensions']);
  assert.deepEqual(launchOptions?.args, buildChromiumExtensionArgs([extensionDir]));
  assert.equal(initScripts.length, 3);
  assert.equal(initScripts[0]?.includes('__AI_AGENT_USERSCRIPT_STATE__'), true);
  assert.equal(evaluatedScripts.length, 3);
  assert.match(scriptResult.summary, /返回值匹配预期 object <\{ ok: boolean \}> script execution payload/);
  assert.deepEqual(JSON.parse(scriptResult.extractedText || '{}'), {
    matched: true,
    expected: 'object <{ ok: boolean }> script execution payload',
    actual: 'object',
    value: { ok: true },
  });
  assert.match(apiResult.summary, /返回值与预期不匹配/);
  assert.deepEqual(JSON.parse(apiResult.extractedText || '{}'), {
    matched: false,
    expected: 'array <{ id: string }[]> order list',
    actual: 'string',
    value: 'api-ok',
  });
  assert.equal(toggleResult.summary, '已关闭用户脚本模式');
  assert.equal(evaluatedObjects.length, 1);
  assert.deepEqual(evaluatedObjects[0], { apiPath: 'UserscriptBridge.collect', args: ['foo', 2] });
  assert.deepEqual(evaluatedBooleans, [false]);
  assert.deepEqual(gotoUrls, ['https://example.com/dashboard']);
}

async function testBrowserAutomationScriptEnvironment(tempDir: string): Promise<void> {
  const extensionDir = path.join(tempDir, 'tm-extension');
  const profileDir = path.join(tempDir, 'browser-profile');
  const initScriptPath = path.join(tempDir, 'init.js');
  const pageScriptPath = path.join(tempDir, 'page.js');
  const userscriptPath = path.join(tempDir, 'userscript.js');
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(initScriptPath, 'window.__initScriptLoaded = true;', 'utf-8');
  await fs.writeFile(pageScriptPath, 'window.__pageScriptLoaded = (window.__pageScriptLoaded || 0) + 1;', 'utf-8');
  await fs.writeFile(userscriptPath, 'window.__userscriptLoaded = (window.__userscriptLoaded || 0) + 1;', 'utf-8');

  const initScripts: string[] = [];
  const gotoUrls: string[] = [];
  const evaluatedStrings: string[] = [];
  const evaluatedObjects: unknown[] = [];
  const evaluatedBooleans: boolean[] = [];
  let launchUserDataDir = '';
  let launchOptions: Record<string, unknown> | undefined;

  const page = {
    addInitScript: async (script: string) => {
      initScripts.push(script);
    },
    goto: async (url: string) => {
      gotoUrls.push(url);
    },
    title: async () => 'Example',
    url: () => gotoUrls[gotoUrls.length - 1] || 'about:blank',
    setDefaultTimeout: () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    locator: () => ({
      first: () => ({
        click: async () => {},
        fill: async (_value: string) => {},
        press: async (_key: string) => {},
        innerText: async () => 'body text',
      }),
    }),
    evaluate: async (_pageFunction: unknown, arg: unknown) => {
      if (typeof arg === 'string') {
        evaluatedStrings.push(arg);
        if (arg.includes('window.__manualScript = true;')) {
          return { ok: true };
        }
        return undefined;
      }

      if (typeof arg === 'boolean') {
        evaluatedBooleans.push(arg);
        return arg;
      }

      evaluatedObjects.push(arg);
      return 'api-ok';
    },
    screenshot: async () => {},
  };

  const context = {
    addInitScript: async (script: string) => {
      initScripts.push(script);
    },
    newPage: async () => page,
    close: async () => {},
    pages: () => [],
  };

  const result = await runBrowserAutomation({
    url: 'https://example.com/home',
    actions: [
      { type: 'goto', url: 'https://example.com/dashboard' },
      {
        type: 'evaluate_script',
        script: 'window.__manualScript = true;',
        expectResult: {
          type: 'object',
          shape: '{ ok: boolean }',
          description: 'manual script payload',
        },
      },
      {
        type: 'call_userscript_api',
        api: 'UserscriptBridge.collect',
        args: ['orders'],
        expectResult: {
          type: 'array',
          shape: '{ id: string }[]',
          description: 'orders result',
        },
      },
      { type: 'toggle_userscript_mode', enabled: false },
    ],
    browser: 'chrome',
    headless: true,
    timeoutMs: 4321,
    workspace: tempDir,
    userDataDir: './browser-profile',
    extensionPaths: ['./tm-extension'],
    initScriptPaths: ['./init.js'],
    initScripts: ['window.__inlineInitLoaded = true;'],
    pageScriptPaths: ['./page.js'],
    pageScripts: ['window.__inlinePageLoaded = true;'],
    userscripts: {
      paths: ['./userscript.js'],
      inline: ['window.__inlineUserscriptLoaded = true;'],
      runAt: 'document-end',
      enabled: true,
    },
    resolveOutputPath: requestedPath => requestedPath || path.join(tempDir, 'artifacts', 'browser.png'),
    loadPlaywright: async () => ({
      chromium: {
        launch: async () => {
          throw new Error('launch should not be used when extension paths are configured');
        },
        launchPersistentContext: async (userDataDir: string, options: Record<string, unknown>) => {
          launchUserDataDir = userDataDir;
          launchOptions = options;
          return context;
        },
      },
    }),
  });

  const parsed = JSON.parse(result);
  assert.equal(launchUserDataDir, profileDir);
  assert.equal(launchOptions?.channel, 'chromium');
  assert.equal(launchOptions?.headless, false);
  assert.deepEqual(launchOptions?.ignoreDefaultArgs, ['--disable-extensions']);
  assert.equal(initScripts.length, 3);
  assert.deepEqual(gotoUrls, ['https://example.com/home', 'https://example.com/dashboard']);
  assert.equal(initScripts[0]?.includes('__AI_AGENT_USERSCRIPT_STATE__'), true);
  assert.equal(evaluatedStrings.filter(script => script.includes('__inlinePageLoaded')).length, 2);
  assert.equal(evaluatedStrings.filter(script => script.includes('__pageScriptLoaded')).length, 2);
  assert.equal(evaluatedStrings.filter(script => script.includes('__inlineUserscriptLoaded')).length, 2);
  assert.equal(evaluatedStrings.filter(script => script.includes('__userscriptLoaded')).length, 2);
  assert.equal(evaluatedStrings.some(script => script.includes('window.__manualScript = true;')), true);
  assert.deepEqual(evaluatedObjects, [{ apiPath: 'UserscriptBridge.collect', args: ['orders'] }]);
  assert.deepEqual(evaluatedBooleans, [false]);
  assert.equal(parsed.actions[1].type, 'evaluate_script');
  assert.equal(parsed.actions[1].validation, '返回值匹配预期 object <{ ok: boolean }> manual script payload');
  assert.deepEqual(JSON.parse(parsed.actions[1].text), {
    matched: true,
    expected: 'object <{ ok: boolean }> manual script payload',
    actual: 'object',
    value: { ok: true },
  });
  assert.equal(parsed.actions[2].type, 'call_userscript_api');
  assert.equal(parsed.actions[2].validation, '返回值与预期不匹配，预期 array <{ id: string }[]> orders result，实际 string');
  assert.deepEqual(JSON.parse(parsed.actions[2].text), {
    matched: false,
    expected: 'array <{ id: string }[]> orders result',
    actual: 'string',
    value: 'api-ok',
  });
  assert.equal(parsed.actions[3].type, 'toggle_userscript_mode');
}

async function testBuiltInBrowserAutomationEnvironmentDefaults(tempDir: string): Promise<void> {
  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const tools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: {
      appBaseDir: path.join(tempDir, 'app-base'),
      artifactOutputDir: path.join(tempDir, 'artifacts'),
      documentOutputDir: path.join(tempDir, 'documents'),
      browserAgent: {
        browser: 'edge',
        executablePath: 'C:/Browsers/msedge.exe',
        expectResultMismatchStrategy: 'hard-fail',
        userDataDir: './profile',
        extensionPaths: ['./ext-a'],
        initScriptPaths: ['./init-a.js'],
        initScripts: ['window.__init = true;'],
        pageScriptPaths: ['./page-a.js'],
        pageScripts: ['window.__page = true;'],
        userscripts: {
          paths: ['./userscript-a.js'],
          inline: ['window.__userscript = true;'],
          runAt: 'document-end',
          enabled: true,
        },
      },
    },
  });

  const environment = (tools as any).getBrowserAutomationEnvironment();
  assert.equal(environment.workspace, tempDir);
  assert.equal(environment.appBaseDir, path.join(tempDir, 'app-base'));
  assert.equal(environment.artifactOutputDir, path.join(tempDir, 'artifacts'));
  assert.equal(environment.documentOutputDir, path.join(tempDir, 'documents'));
  assert.equal(environment.executablePath, 'C:/Browsers/msedge.exe');
  assert.equal(environment.userDataDir, './profile');
  assert.deepEqual(environment.extensionPaths, ['./ext-a']);
  assert.deepEqual(environment.initScriptPaths, ['./init-a.js']);
  assert.deepEqual(environment.pageScriptPaths, ['./page-a.js']);
  assert.deepEqual(environment.userscripts.paths, ['./userscript-a.js']);
  assert.equal(environment.expectResultMismatchStrategy, 'hard-fail');
}

async function testBrowserSessionExpectResultMismatchStrategies(tempDir: string): Promise<void> {
  const page = {
    addInitScript: async () => {},
    goto: async () => {},
    title: async () => 'Example',
    url: () => 'https://example.com',
    setDefaultTimeout: () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    waitForLoadState: async () => {},
    locator: () => ({
      first: () => ({
        click: async () => {},
        fill: async () => {},
        press: async () => {},
        innerText: async () => '',
      }),
    }),
    evaluate: async (_pageFunction: unknown, arg: unknown) => {
      if (typeof arg === 'object' && arg !== null) {
        return 'api-ok';
      }
      return undefined;
    },
  };

  const browser = {
    newPage: async () => page,
    close: async () => {},
  };

  const recordOnlySession = new BrowserSession({
    workspace: tempDir,
    expectResultMismatchStrategy: 'record-only',
  }) as any;
  recordOnlySession.loadPlaywright = async () => ({
    chromium: {
      launch: async () => browser,
      launchPersistentContext: async () => { throw new Error('should not use persistent context'); },
    },
  });

  await recordOnlySession.start('https://example.com');
  const recordOnlyResult = await recordOnlySession.executeWithOptions({
    type: 'call_userscript_api',
    api: 'UserscriptBridge.collect',
    args: [],
    expectResult: {
      type: 'array',
      shape: '{ id: string }[]',
      description: 'order list',
    },
    reason: 'test mismatch strategy',
    confidence: 0.9,
  }, {});
  await recordOnlySession.close();

  assert.equal(recordOnlyResult.summary, '已调用用户脚本 API: UserscriptBridge.collect');
  assert.deepEqual(JSON.parse(recordOnlyResult.extractedText || '{}'), {
    matched: false,
    expected: 'array <{ id: string }[]> order list',
    actual: 'string',
    value: 'api-ok',
  });

  const hardFailSession = new BrowserSession({
    workspace: tempDir,
    expectResultMismatchStrategy: 'hard-fail',
  }) as any;
  hardFailSession.loadPlaywright = async () => ({
    chromium: {
      launch: async () => browser,
      launchPersistentContext: async () => { throw new Error('should not use persistent context'); },
    },
  });

  await hardFailSession.start('https://example.com');
  await assert.rejects(() => hardFailSession.executeWithOptions({
    type: 'call_userscript_api',
    api: 'UserscriptBridge.collect',
    args: [],
    expectResult: {
      type: 'array',
      shape: '{ id: string }[]',
      description: 'order list',
    },
    reason: 'test hard fail strategy',
    confidence: 0.9,
  }, {}), /call_userscript_api\(UserscriptBridge\.collect\) 返回值校验失败/);
  await hardFailSession.close();
}

async function testBrowserAutomationExpectResultMismatchStrategies(tempDir: string): Promise<void> {
  const page = {
    addInitScript: async () => {},
    goto: async () => {},
    title: async () => 'Example',
    url: () => 'https://example.com',
    setDefaultTimeout: () => {},
    waitForTimeout: async () => {},
    waitForSelector: async () => {},
    locator: () => ({
      first: () => ({
        click: async () => {},
        fill: async () => {},
        press: async () => {},
        innerText: async () => 'body text',
      }),
    }),
    evaluate: async (_pageFunction: unknown, arg: unknown) => {
      if (typeof arg === 'object' && arg !== null) {
        return 'api-ok';
      }
      return undefined;
    },
    screenshot: async () => {},
  };

  const browser = {
    newPage: async () => page,
    close: async () => {},
  };

  const recordOnlyOutput = await runBrowserAutomation({
    url: 'https://example.com',
    actions: [{
      type: 'call_userscript_api',
      api: 'UserscriptBridge.collect',
      args: [],
      expectResult: {
        type: 'array',
        shape: '{ id: string }[]',
        description: 'order list',
      },
    }],
    expectResultMismatchStrategy: 'record-only',
    resolveOutputPath: requestedPath => requestedPath || path.join(tempDir, 'artifacts', 'browser.png'),
    loadPlaywright: async () => ({
      chromium: {
        launch: async () => browser,
        launchPersistentContext: async () => { throw new Error('should not use persistent context'); },
      },
    }),
  });
  const parsedRecordOnly = JSON.parse(recordOnlyOutput);
  assert.equal(parsedRecordOnly.actions[0].validation, '返回值与预期不匹配，预期 array <{ id: string }[]> order list，实际 string');

  await assert.rejects(() => runBrowserAutomation({
    url: 'https://example.com',
    actions: [{
      type: 'call_userscript_api',
      api: 'UserscriptBridge.collect',
      args: [],
      expectResult: {
        type: 'array',
        shape: '{ id: string }[]',
        description: 'order list',
      },
    }],
    expectResultMismatchStrategy: 'hard-fail',
    resolveOutputPath: requestedPath => requestedPath || path.join(tempDir, 'artifacts', 'browser.png'),
    loadPlaywright: async () => ({
      chromium: {
        launch: async () => browser,
        launchPersistentContext: async () => { throw new Error('should not use persistent context'); },
      },
    }),
  }), /call_userscript_api\(UserscriptBridge\.collect\) 返回值校验失败/);
}

async function testBrowserActionPlannerScriptActions(): Promise<void> {
  const workflows = [{
    name: 'orders-script-workflow',
    description: 'Collect order data via userscript API',
    sourcePath: 'browser-workflows/orders-script.md',
    startUrl: 'https://example.com/orders',
    matchPatterns: ['example.com/orders'],
    whenToUse: 'Need structured order data',
    steps: ['open order list', 'collect data'],
    hints: ['prefer userscript api'],
    successCriteria: ['orders collected'],
    selectorSlots: {},
    preferredSelectors: {},
    fallbackActions: {},
    doneConditions: [],
    phaseConfigurations: {},
    scriptApis: [{
      name: 'UserscriptBridge.collect',
      description: 'Collect order summaries',
      args: [{ name: 'scope', type: 'string', required: false }],
      returns: {
        type: 'array',
        shape: '{ id: string; status: string }',
        description: 'visible orders',
      },
    }],
    maxRetries: 2,
    priority: 100,
  }];

  const planner = new BrowserActionPlanner({
    plannerClient: new StaticResponseLLM(JSON.stringify({
      finalMessage: 'use script actions',
      actions: [
        {
          type: 'toggle_userscript_mode',
          enabled: true,
          reason: 'ensure userscript is enabled',
          confidence: 0.91,
        },
        {
          type: 'call_userscript_api',
          api: 'UserscriptBridge.collect',
          args: ['orders'],
          reason: 'collect data through userscript api',
          confidence: 0.88,
        },
      ],
    })),
    maxActionsPerPlan: 3,
  });

  const plan = await planner.createPlan(
    { goal: '调用用户脚本 API 抓取订单列表' },
    {
      url: 'https://example.com/orders',
      title: 'Orders',
      visibleText: '订单列表 页面',
      interactiveElements: [],
      interactiveSummary: [],
    },
    [],
    { allowFastPath: false, workflows },
  );

  assert.equal(plan.source, 'llm');
  assert.equal(plan.actions[0]?.type, 'toggle_userscript_mode');
  assert.equal(plan.actions[0]?.enabled, true);
  assert.equal(plan.actions[1]?.type, 'call_userscript_api');
  assert.equal(plan.actions[1]?.api, 'UserscriptBridge.collect');
  assert.deepEqual(plan.actions[1]?.args, ['orders']);
  assert.deepEqual(plan.actions[1]?.expectResult, {
    type: 'array',
    shape: '{ id: string; status: string }',
    description: 'visible orders',
  });
}

async function testBrowserWorkflowTemplateIncludesScriptScaffolding(tempDir: string): Promise<void> {
  const service = new BrowserWorkflowService({ workflowDir: path.join(tempDir, 'workflow-template') });
  const created = await service.createWorkflowTemplate('script-ready-workflow', {
    description: 'workflow with script helpers',
    match: ['example.com'],
  });

  const content = await fs.readFile(created.filePath, 'utf-8');
  assert.match(content, /scripts:/);
  assert.match(content, /scriptApis:/);
  assert.match(content, /UserscriptBridge\.collectResults/);
  assert.match(content, /type: array/);
  assert.match(content, /shape: \{ title: string; url: string \}/);
}

function testSharedExportIntentRules(): void {
  assert.equal(detectRequestedExportFormat('把 notes.md 转成 pdf', ['docx', 'pdf', 'md', 'txt']), 'pdf');
  assert.equal(detectRequestedExportFormat('把 summary.txt 保存成 word 文档', ['docx', 'pdf', 'md', 'txt']), 'docx');
  assert.equal(buildFallbackIntentContract('把讲义改成ppt文件', []).targetFormat, 'pptx');
  assert.equal(detectRequestedExportFormat('创建说明文档，指导如何将PDF转换为PPT格式', ['docx', 'pdf', 'md', 'txt', 'pptx']), null);
  assert.equal(selectPreferredExportTool('pdf', ['txt_to_docx', 'txt_to_pdf']), 'txt_to_pdf');
  assert.equal(selectPreferredExportTool('docx', ['txt_to_docx', 'txt_to_pdf']), 'txt_to_docx');
  assert.equal(selectPreferredExportTool('pptx', ['txt_to_pptx']), 'txt_to_pptx');
  assert.equal(selectPreferredExportTool('xlsx', ['txt_to_xlsx']), 'txt_to_xlsx');
  assert.equal(selectPreferredExportTool('docx', ['docx_create_from_text', 'txt_to_docx']), 'docx_create_from_text');
  assert.equal(selectPreferredExportTool('pdf', ['pdf_create_from_text', 'txt_to_pdf']), 'pdf_create_from_text');
  assert.equal(selectPreferredExportTool('xlsx', ['xlsx_create_from_text', 'txt_to_xlsx']), 'xlsx_create_from_text');
  assert.equal(selectPreferredExportTool('pptx', ['pptx_create_from_text', 'txt_to_pptx']), 'pptx_create_from_text');
  assert.equal(buildFallbackIntentContract('分析搜索结果，确定《将进酒》中最有名的诗句', []).action, 'file_write');
}

function testCliAgentInteractionMode(): void {
  const originalFunctionMode = configManager.get('functionMode');
  const originalMode = configManager.get('agentInteractionMode');

  try {
    configManager.set('functionMode', 'workflow');
    const workflowCli = new CLI();
    assert.equal((workflowCli as any).getFunctionMode(), 'workflow');
    assert.equal((workflowCli as any).getPromptLabel(), '[cli|workflow] > ');

    configManager.set('functionMode', 'chat');
    const chatCli = new CLI();
    assert.equal((chatCli as any).getFunctionMode(), 'chat');
    assert.equal((chatCli as any).getPromptLabel(), '[cli|chat] > ');

    const functionCandidates = (chatCli as any).getCompletionCandidates('/function sw');
    const candidates = (chatCli as any).getCompletionCandidates('/agent-mode sw');
    assert.equal(functionCandidates.includes('/function switch workflow'), true);
    assert.equal(functionCandidates.includes('/function switch chat'), true);
    assert.equal(candidates.includes('/agent-mode switch workflow'), true);
    assert.equal(candidates.includes('/agent-mode switch chat'), true);
  } finally {
    configManager.set('functionMode', originalFunctionMode ?? 'workflow');
    configManager.set('agentInteractionMode', originalMode ?? 'auto');
  }
}

async function testCliSuppressesDirectActionPreambleInTaskMode(): Promise<void> {
  const originalFunctionMode = configManager.get('functionMode');

  try {
    configManager.set('functionMode', 'workflow');
    const taskCli = new CLI() as any;
    let streamed = '';
    taskCli.streamResponse = async (text: string) => {
      streamed += text;
    };

    await taskCli.showDirectActionPreamble('我先打开看看，做完告诉你结果。');
    assert.equal(taskCli.pendingDirectActionPreamble, undefined);
    assert.equal(streamed, '');

    configManager.set('functionMode', 'chat');
    const chatCli = new CLI() as any;
    let chatStreamed = '';
    chatCli.streamResponse = async (text: string) => {
      chatStreamed += text;
    };

    await chatCli.showDirectActionPreamble('我先打开看看，做完告诉你结果。');
    assert.equal(chatCli.pendingDirectActionPreamble, '我先打开看看，做完告诉你结果。');
    assert.equal(chatStreamed, '我先打开看看，做完告诉你结果。');
  } finally {
    configManager.set('functionMode', originalFunctionMode ?? 'workflow');
  }
}

async function testCliAutoModeUsesWorkflowHandlerForComplexTask(): Promise<void> {
  const cli = new CLI() as any;
  let handledInTaskMode = false;

  cli.chatRouter = {
    route: async () => ({ target: 'task', reason: 'complex_task', intent: 'workflow_task' }),
  };
  cli.reportAutoRouteDecision = () => {};
  cli.agent = {};
  cli.handleTaskModeMessage = async (input: string, taskBinding: { effectiveInput: string }) => {
    handledInTaskMode = input === '帮我先整理需求，再生成周报并导出文档'
      && taskBinding.effectiveInput === '帮我先整理需求，再生成周报并导出文档';
  };

  await cli.handleAutoModeMessage('帮我先整理需求，再生成周报并导出文档', {
    isFollowUp: false,
    effectiveInput: '帮我先整理需求，再生成周报并导出文档',
  });

  assert.equal(handledInTaskMode, true);
}

async function testCliAutoModeUsesChatRouterForConversation(): Promise<void> {
  const cli = new CLI() as any;
  let handledInChatMode = false;
  let handledInTaskMode = false;
  const infoMessages: string[] = [];

  cli.chatRouter = {
    route: async () => ({ target: 'chat', reason: 'knowledge_chat', intent: 'knowledge_chat' }),
  };
  cli.agent = {};
  cli.reportAutoRouteDecision = (decision: { reason: string; target: string }) => {
    infoMessages.push(`${decision.target}:${decision.reason}`);
  };
  cli.handleChatModeMessage = async (input: string, taskBinding: { effectiveInput: string }) => {
    handledInChatMode = input === '你是谁'
      && taskBinding.effectiveInput === '你是谁';
  };
  cli.handleTaskModeMessage = async () => {
    handledInTaskMode = true;
  };

  await cli.handleAutoModeMessage('你是谁', {
    isFollowUp: false,
    effectiveInput: '你是谁',
  });

  assert.equal(handledInChatMode, true);
  assert.equal(handledInTaskMode, false);
  assert.deepEqual(infoMessages, ['chat:knowledge_chat']);
}

async function testChatRouterSeparatesConversationAndTask(): Promise<void> {
  const router = new ChatRouter();
  const agent = {
    getConfirmationStatus: () => ({ pending: false }),
    detectComplexTask: async (input: string) => /先整理需求/.test(input),
  };

  const chatDecision = await router.route({
    input: '你是谁',
    taskBinding: { isFollowUp: false, effectiveInput: '你是谁' },
    agent,
    policy: { preferWorkflow: false },
  });
  assert.equal(chatDecision.target, 'chat');
  assert.equal(chatDecision.reason, 'knowledge_chat');
  assert.equal(chatDecision.intent, 'knowledge_chat');

  const socialDecision = await router.route({
    input: '你好',
    taskBinding: { isFollowUp: false, effectiveInput: '你好' },
    agent,
    policy: { preferWorkflow: false },
  });
  assert.equal(socialDecision.target, 'chat');
  assert.equal(socialDecision.reason, 'social_chat');

  const taskDecision = await router.route({
    input: '帮我读取这个目录并导出报告',
    taskBinding: { isFollowUp: false, effectiveInput: '帮我读取这个目录并导出报告' },
    agent,
    policy: { preferWorkflow: true },
  });
  assert.equal(taskDecision.target, 'task');
  assert.equal(taskDecision.reason, 'direct_action_request');
  assert.equal(taskDecision.intent, 'direct_action');

  const complexDecision = await router.route({
    input: '帮我先整理需求，再生成周报',
    taskBinding: { isFollowUp: false, effectiveInput: '帮我先整理需求，再生成周报' },
    agent,
    policy: { preferWorkflow: true },
  });
  assert.equal(complexDecision.target, 'task');
  assert.equal(complexDecision.reason, 'workflow_request');
}

async function testTaskExecutorServiceDelegatesToGraphRunner(): Promise<void> {
  const agent = createAgent({ llm: new StubLLM() });
  const executor = new TaskExecutorService({
    agent,
    recallLimit: 4,
    autoContinueOnToolLimit: true,
    maxContinuationTurns: 2,
    permissionManager: {
      getConfig: () => ({ autoGrantDangerous: false, askForPermissions: true }),
    } as any,
    memoryProvider: {
      buildContext: async () => 'memory-context',
      syncSession: async () => {},
      archiveSession: async () => undefined,
    } as any,
  });

  const result = await executor.executeTurn('你好', {
    isFollowUp: false,
    effectiveInput: '你好',
  });

  assert.equal(result.route, 'agent');
  assert.equal(typeof result.graphState.currentNode, 'string');
  assert.equal(result.executionContext.mode, 'fresh_task');
  assert.equal(result.executionPolicy.permissionStrategy, 'ask_dangerous');
}

function testTaskExecutorServiceDescribesResumeContexts(): void {
  const agent = {
    getConfirmationStatus: () => ({ pending: true }),
  } as unknown as Agent;
  const executor = new TaskExecutorService({
    agent,
    recallLimit: 4,
    autoContinueOnToolLimit: true,
    maxContinuationTurns: 2,
  });

  const pendingContext = executor.describeExecutionContext({
    isFollowUp: false,
    effectiveInput: '继续',
  });
  assert.equal(pendingContext.mode, 'pending_interaction');
  assert.equal(pendingContext.isResuming, true);

  const checkpointExecutor = new TaskExecutorService({
    agent: {
      getConfirmationStatus: () => ({ pending: false }),
    } as unknown as Agent,
    recallLimit: 4,
    autoContinueOnToolLimit: true,
    maxContinuationTurns: 2,
  });

  const checkpointContext = checkpointExecutor.describeExecutionContext({
    isFollowUp: true,
    effectiveInput: '按刚才那个继续',
  }, {
    node: 'resume',
    status: 'waiting',
    updatedAt: new Date().toISOString(),
  });
  assert.equal(checkpointContext.mode, 'checkpoint_resume');
  assert.equal(checkpointContext.isResuming, true);
}

async function testCliChatModeAutoSwitchesToWorkflow(): Promise<void> {
  const originalFunctionMode = configManager.get('functionMode');
  const originalRouting = configManager.get('functionRouting');
  const cli = new CLI() as any;
  let switchedTo: string | undefined;
  let handledTaskInput: string | undefined;

  try {
    configManager.set('functionMode', 'chat');
    configManager.set('functionRouting', {
      ...originalRouting,
      allowAutoSwitchFromChatToWorkflow: true,
      workflowSwitchKeywords: ['切换workflow'],
    });

    cli.agent = {
      getConfirmationStatus: () => ({ pending: false }),
    };
    cli.switchFunctionMode = async (target: string) => {
      switchedTo = target;
    };
    cli.handleTaskModeMessage = async (input: string) => {
      handledTaskInput = input;
    };

    await cli.handleChatModeMessage('切换workflow，帮我整理周报', {
      isFollowUp: false,
      effectiveInput: '切换workflow，帮我整理周报',
    });

    assert.equal(switchedTo, 'workflow');
    assert.equal(handledTaskInput, '帮我整理周报');
  } finally {
    configManager.set('functionMode', originalFunctionMode ?? 'workflow');
    configManager.set('functionRouting', originalRouting);
  }
}

async function testAutoModeWorkflowProgressUsesConversationalCopy(): Promise<void> {
  const plan = {
    originalTask: '整理需求并输出结论',
    steps: [
      { id: 'step_1', description: '整理需求要点并输出结论' },
    ],
  };
  const fakePlanner = {
    async createPlan() {
      return plan;
    },
    completeStep() {},
    failStep() {},
  };
  const thinkingMessages: string[] = [];
  const progressMessages: string[] = [];
  const originalLog = console.log;
  const consoleMessages: string[] = [];
  console.log = (...args: unknown[]) => {
    consoleMessages.push(args.map(String).join(' '));
  };

  try {
    const agent = createAgent({
      llm: new StubLLM(),
      planner: fakePlanner as any,
      config: { agentInteractionMode: 'auto' } as any,
    });
    agent.setEventHandler((event) => {
      if (event.type === 'thinking') {
        thinkingMessages.push(event.content);
      }
      if (event.type === 'plan_progress') {
        progressMessages.push(event.content);
      }
    });

    const clarification = await agent.chat('帮我处理一下');
    assert.match(clarification, /缺少一些关键信息/);

    const replanned = await agent.respondToPendingInput('整理需求并输出成 markdown');
    assert.match(replanned || '', /任务规划已创建/);

    const execution = await agent.confirmAction(true);
    assert.match(execution || '', /任务完成/);
    assert.equal(thinkingMessages.some(message => message.includes('我先处理第 1/1 步')), true);
    assert.equal(progressMessages.some(message => message.includes('这一步已经处理完了')), true);
    assert.equal(consoleMessages.some(message => message.includes('我先处理第 1/1 步')), true);
  } finally {
    console.log = originalLog;
  }
}

async function testCliChatModeDoesNotAutoSwitchToWorkflow(): Promise<void> {
  const cli = new CLI() as any;
  let handledInTaskMode = false;
  let chatted = false;

  cli.agent = {
    getConfirmationStatus: () => ({ pending: false }),
    getMessages: () => [],
    setRuntimeMemoryContext: () => {},
    chat: async () => {
      chatted = true;
      return 'chat-response';
    },
    needsContinuation: () => false,
  };
  cli.memoryManager = { setMessages: () => {} };
  cli.memoryProvider = { buildContext: async () => '', syncSession: async () => {} };
  cli.streamingOutput = { clear: () => {} };
  cli.printHybridRouteSummary = () => {};
  cli.streamResponse = async () => {};
  cli.handleTaskModeMessage = async () => {
    handledInTaskMode = true;
  };

  await cli.handleChatModeMessage('帮我先整理需求，再生成周报并导出文档', {
    isFollowUp: false,
    effectiveInput: '帮我先整理需求，再生成周报并导出文档',
  });

  assert.equal(chatted, true);
  assert.equal(handledInTaskMode, false);
}

async function testOfficialDocumentSkillBridges(tempDir: string): Promise<void> {
  const homeDir = path.join(tempDir, 'bridge-home');
  const skillsRoot = path.join(homeDir, '.agents', 'skills');
  const skillFixtures = [
    ['docx', 'Official Anthropic DOCX skill'],
    ['pdf', 'Official Anthropic PDF skill'],
    ['xlsx', 'Official Anthropic XLSX skill'],
    ['pptx', 'Official Anthropic PPTX skill'],
  ] as const;

  for (const [name, description] of skillFixtures) {
    const dir = path.join(skillsRoot, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'SKILL.md'),
      `---
name: ${name}
description: ${description}
version: 1.0.0
---

Official ${name.toUpperCase()} workflow instructions.
`,
      'utf-8',
    );
  }

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    const manager = createSkillManager(path.join(tempDir, 'bridge-skills-home'));
    await manager.initialize();

    const bridgeTools = manager.getTools().filter(tool => /_create_from_text$/i.test(tool.name));
    assert.deepEqual(
      bridgeTools
        .map(tool => `${tool.skill}:${tool.name}`)
        .sort(),
      [
        'docx:docx_create_from_text',
        'pdf:pdf_create_from_text',
        'pptx:pptx_create_from_text',
        'xlsx:xlsx_create_from_text',
      ],
    );

    const available = [
      ...bridgeTools.map(tool => tool.name),
      'txt_to_docx',
      'txt_to_pdf',
      'txt_to_xlsx',
      'txt_to_pptx',
    ];

    assert.equal(selectPreferredExportTool('docx', available), 'docx_create_from_text');
    assert.equal(selectPreferredExportTool('pdf', available), 'pdf_create_from_text');
    assert.equal(selectPreferredExportTool('xlsx', available), 'xlsx_create_from_text');
    assert.equal(selectPreferredExportTool('pptx', available), 'pptx_create_from_text');
  } finally {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
  }
}

function testGenericToolCallValidator(): void {
  const exportFallback = buildFallbackIntentContract('把 notes.md 转成 pdf', []);
  assert.equal(exportFallback.action, 'document_export');
  assert.equal(exportFallback.targetFormat, 'pdf');

  const exportContract = {
    action: 'document_export' as const,
    summary: 'Export content to PDF',
    targetFormat: 'pdf' as const,
  };
  const exportToolCall: ToolCall = {
    id: 'call_export',
    type: 'function',
    function: {
      name: 'txt_to_docx',
      arguments: JSON.stringify({ output: '$ARTIFACT_OUTPUT_DIR/notes.docx', text: '$LAST_ASSISTANT_TEXT', title: 'notes' }),
    },
  };

  const exportValidation = validateToolCallsAgainstContract(exportContract, [exportToolCall], ['txt_to_docx', 'txt_to_pdf']);
  assert.equal(exportValidation.toolCalls[0]?.function.name, 'txt_to_pdf');
  assert.match(exportValidation.toolCalls[0]?.function.arguments || '', /notes\.pdf/);
  assert.equal(exportValidation.rejections.length, 0);

  const mistakenWriteToolCall: ToolCall = {
    id: 'call_write_docx',
    type: 'function',
    function: {
      name: 'write_file',
      arguments: JSON.stringify({ path: '$ARTIFACT_OUTPUT_DIR/notes.docx', content: '$LAST_ASSISTANT_TEXT' }),
    },
  };

  const mistakenWriteValidation = validateToolCallsAgainstContract(
    {
      action: 'document_export' as const,
      summary: 'Export content to DOCX',
      targetFormat: 'docx' as const,
    },
    [mistakenWriteToolCall],
    ['docx_create_from_text', 'write_file'],
  );
  assert.equal(mistakenWriteValidation.toolCalls[0]?.function.name, 'docx_create_from_text');
  assert.match(mistakenWriteValidation.toolCalls[0]?.function.arguments || '', /notes\.docx/);
  assert.match(mistakenWriteValidation.toolCalls[0]?.function.arguments || '', /LAST_ASSISTANT_TEXT/);
  assert.equal(mistakenWriteValidation.rejections.length, 0);

  const readContract = buildFallbackIntentContract('读取 package.json', []);
  const commandToolCall: ToolCall = {
    id: 'call_read',
    type: 'function',
    function: {
      name: 'execute_command',
      arguments: JSON.stringify({ command: 'npm install' }),
    },
  };

  const readValidation = validateToolCallsAgainstContract(readContract, [commandToolCall], ['execute_command']);
  assert.equal(readValidation.toolCalls.length, 0);
  assert.equal(readValidation.rejections.length, 1);
  assert.match(readValidation.rejections[0]?.reason || '', /读取内容/);

  const pptFallback = buildFallbackIntentContract('把 notes.md 改成ppt文件', []);
  assert.equal(pptFallback.targetFormat, 'pptx');
  const pptContract = {
    action: 'document_export' as const,
    summary: 'Export content to PPTX',
    targetFormat: 'pptx' as const,
  };
  const pdfToolCall: ToolCall = {
    id: 'call_ppt',
    type: 'function',
    function: {
      name: 'txt_to_pdf',
      arguments: JSON.stringify({ out: '$ARTIFACT_OUTPUT_DIR/notes.pdf', text: '$LAST_ASSISTANT_TEXT' }),
    },
  };

  const pptValidation = validateToolCallsAgainstContract(pptContract, [pdfToolCall], ['txt_to_pdf', 'txt_to_pptx']);
  assert.equal(pptValidation.toolCalls[0]?.function.name, 'txt_to_pptx');
  assert.match(pptValidation.toolCalls[0]?.function.arguments || '', /notes\.pptx/);
  assert.equal(pptValidation.rejections.length, 0);

  const messageContract = buildFallbackIntentContract('给我的飞书群发送一条自定义消息', []);
  assert.equal(messageContract.action, 'message_send');

  const compositeMessageContract = buildFallbackIntentContract('杜甫的茅屋为秋风所破歌这首诗内容是什么，发我飞书', []);
  assert.equal(compositeMessageContract.action, 'generic');
  assert.match(compositeMessageContract.summary, /Resolve requested content first/i);

  const pushNewsToolCall: ToolCall = {
    id: 'call_lark_news',
    type: 'function',
    function: {
      name: 'push_news_to_lark',
      arguments: JSON.stringify({ chatId: 'oc_xxx', title: '你好', newsType: 'hot' }),
    },
  };

  const messageValidation = validateToolCallsAgainstContract(messageContract, [pushNewsToolCall], ['push_news_to_lark', 'send_lark_message', 'lark_shortcut']);
  assert.equal(messageValidation.toolCalls.length, 0);
  assert.equal(messageValidation.rejections.length, 1);
  assert.match(messageValidation.rejections[0]?.reason || '', /push_news_to_lark 只用于抓取腾讯新闻/i);

  const pushWeatherToolCall: ToolCall = {
    id: 'call_lark_weather',
    type: 'function',
    function: {
      name: 'push_weather_to_lark',
      arguments: JSON.stringify({ chatId: 'oc_xxx', city: '北京' }),
    },
  };

  const weatherMessageValidation = validateToolCallsAgainstContract(messageContract, [pushWeatherToolCall], ['push_weather_to_lark', 'send_lark_message', 'lark_shortcut']);
  assert.equal(weatherMessageValidation.toolCalls.length, 0);
  assert.equal(weatherMessageValidation.rejections.length, 1);
  assert.match(weatherMessageValidation.rejections[0]?.reason || '', /push_weather_to_lark 只用于抓取天气/i);

  const unresolvedMessageToolCall: ToolCall = {
    id: 'call_lark_unresolved_payload',
    type: 'function',
    function: {
      name: 'send_lark_message',
      arguments: JSON.stringify({ chatId: 'oc_xxx', text: '什么' }),
    },
  };

  const unresolvedMessageValidation = validateToolCallsAgainstContract(messageContract, [unresolvedMessageToolCall], ['send_lark_message', 'lark_shortcut']);
  assert.equal(unresolvedMessageValidation.toolCalls.length, 0);
  assert.equal(unresolvedMessageValidation.rejections.length, 1);
  assert.match(unresolvedMessageValidation.rejections[0]?.reason || '', /先获取内容再发送|未解析的占位文本/i);

  const commandWorkflowContract = buildFallbackIntentContract('运行一个简单的Playwright测试来验证安装是否成功', [
    {
      id: 'call_prepare_script',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: '$WORKSPACE/tmp-test.js', content: 'console.log(1);' }),
      },
    },
    {
      id: 'call_run_test',
      type: 'function',
      function: {
        name: 'execute_command',
        arguments: JSON.stringify({ command: 'node tmp-test.js' }),
      },
    },
  ]);
  assert.equal(commandWorkflowContract.action, 'generic');

  const searchAnalysisContract = buildFallbackIntentContract('分析搜索结果，确定《将进酒》中最有名的诗句', []);
  assert.equal(searchAnalysisContract.action, 'file_write');
}

async function testPlannerProducesConcreteToolCalls(): Promise<void> {
  const planner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "搜索代码并导出文档",
      "steps": [
        {
          "id": "step_1",
          "description": "读取入口文件并搜索 direct action",
          "toolCalls": [
            { "name": "read_file", "args": { "path": "src/cli/index.ts" } },
            { "name": "search_files", "args": { "path": "$WORKSPACE", "content": "createDirectActionRouter" } }
          ]
        },
        {
          "id": "step_2",
          "description": "把结果保存成 Word 文档，文件名叫 summary"
        }
      ]
    }`),
  });

  const plan = await planner.createPlan('搜索 createDirectActionRouter 并导出为 Word 文档');

  assert.equal(plan.steps[0]?.toolCalls?.length, 2);
  assert.equal(plan.steps[0]?.toolCalls?.[0]?.name, 'read_file');
  assert.equal(plan.steps[0]?.toolCalls?.[1]?.name, 'search_files');
  assert.equal(plan.steps[1]?.toolCalls?.[0]?.name, 'docx_create_from_text');
  assert.equal(plan.steps[1]?.toolCalls?.[0]?.args.output, '$ARTIFACT_OUTPUT_DIR/summary.docx');
  assert.equal(plan.steps[1]?.toolCalls?.[0]?.args.text, '$LAST_ASSISTANT_TEXT');

  const pdfPlanner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "把 notes.docx 转成 pdf",
      "steps": [
        {
          "id": "step_1",
          "description": "把 notes.docx 转成 pdf"
        }
      ]
    }`),
  });

  const pdfPlan = await pdfPlanner.createPlan('把 notes.docx 转成 pdf');
  assert.equal(pdfPlan.steps[0]?.toolCalls?.[0]?.name, 'pdf_create_from_text');
  assert.equal(pdfPlan.steps[0]?.toolCalls?.[0]?.args.out, '$ARTIFACT_OUTPUT_DIR/exported-document.pdf');

  const correctedPdfPlanner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "把 notes.md 转成 pdf",
      "steps": [
        {
          "id": "step_1",
          "description": "把 notes.md 转成 pdf",
          "toolCalls": [
            {
              "name": "docx_create_from_text",
              "args": {
                "output": "$ARTIFACT_OUTPUT_DIR/notes.docx",
                "text": "$LAST_ASSISTANT_TEXT",
                "title": "notes"
              }
            }
          ]
        }
      ]
    }`),
  });

  const correctedPdfPlan = await correctedPdfPlanner.createPlan('把 notes.md 转成 pdf');
  assert.equal(correctedPdfPlan.steps[0]?.toolCalls?.[0]?.name, 'pdf_create_from_text');
  assert.equal(correctedPdfPlan.steps[0]?.toolCalls?.[0]?.args.out, '$ARTIFACT_OUTPUT_DIR/notes.pdf');

  const correctedTxtPdfPlan = await correctedPdfPlanner.createPlan('把 summary.txt 转成 pdf');
  assert.equal(correctedTxtPdfPlan.steps[0]?.toolCalls?.[0]?.name, 'pdf_create_from_text');

  const newsStockPlanner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "把今天热点新闻整理一下，附带分析相关的股票，然后整理成word文档发我飞书",
      "steps": [
        {
          "id": "step_1",
          "description": "分析热点新闻中提到的公司或行业，识别相关股票",
          "toolCalls": [
            {
              "name": "web_search",
              "args": {
                "query": "热点新闻相关股票分析",
                "numResults": 5
              }
            }
          ]
        }
      ]
    }`),
  });

  const newsStockPlan = await newsStockPlanner.createPlan('把今天热点新闻整理一下，附带分析相关的股票，然后整理成word文档发我飞书');
  assert.equal(newsStockPlan.steps[0]?.toolCalls?.length || 0, 0);

  const recencyYearPlanner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "最近烟台有什么活动",
      "steps": [
        {
          "id": "step_1",
          "description": "搜索近期活动信息",
          "toolCalls": [
            {
              "name": "web_search",
              "args": {
                "query": "烟台 近期 活动 2024",
                "numResults": 10
              }
            }
          ]
        }
      ]
    }`),
  });

  const recencyYearPlan = await recencyYearPlanner.createPlan('最近烟台有什么活动');
  assert.equal(recencyYearPlan.steps[0]?.toolCalls?.[0]?.name, 'web_search');
  const correctedRecencyQuery = String(recencyYearPlan.steps[0]?.toolCalls?.[0]?.args.query || '');
  assert.equal(/2024/.test(correctedRecencyQuery), false);
  assert.equal(new RegExp(String(new Date().getFullYear())).test(correctedRecencyQuery), true);

  const historicalYearPlanner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "查 2024 年烟台有哪些活动",
      "steps": [
        {
          "id": "step_1",
          "description": "搜索 2024 年活动",
          "toolCalls": [
            {
              "name": "web_search",
              "args": {
                "query": "烟台 2024 活动",
                "numResults": 10
              }
            }
          ]
        }
      ]
    }`),
  });

  const historicalYearPlan = await historicalYearPlanner.createPlan('查 2024 年烟台有哪些活动');
  assert.equal(historicalYearPlan.steps[0]?.toolCalls?.[0]?.args.query, '烟台 2024 活动');
}

async function testPlannerSuppressesRedundantSearchForFollowUpAdjustmentTask(): Promise<void> {
  const planner = createPlanner({
    llm: new StaticResponseLLM(`{
      "task": "follow up export",
      "steps": [
        {
          "id": "step_1",
          "description": "重新搜索资料",
          "toolCalls": [
            { "name": "web_search", "args": { "query": "大模型 数据库 应用" } },
            { "name": "search_files", "args": { "path": "$WORKSPACE", "content": "数据库" } }
          ]
        },
        {
          "id": "step_2",
          "description": "改成 word 文档"
        }
      ]
    }`),
  });

  const plan = await planner.createPlan([
    '延续上一任务：分析数据库应用并发我飞书',
    '上一任务内容：帮我分析大模型在数据库领域的应用，整理成 pdf 发我飞书',
    '要求：默认保持上一任务的核心目标、交付动作和目标渠道；如果这次跟进只修改格式、路径、标题、发送方式或局部步骤，应在不丢失原目标的前提下调整。',
    '用户跟进：改成word发我飞书',
  ].join('\n'));

  assert.equal(plan.steps[0]?.toolCalls, undefined);
  assert.equal(plan.steps[1]?.toolCalls?.[0]?.name, 'docx_create_from_text');
}

async function testPlannerPrefersProceduralCandidate(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'planner-skills'));
  await skillManager.initialize();
  await skillManager.maybeCreateCandidateFromExecution({
    originalTask: '整理日志并输出日报模板',
    stepDescriptions: ['读取日志文件', '提取关键错误', '输出日报模板'],
    stepResults: ['读取完成', '提取完成', '日报模板已输出到 outputs'],
    completedSteps: 3,
    totalSteps: 3,
    refinement: {
      shouldCreate: true,
      confidence: 0.94,
      refinedDescription: '日志日报 workflow。',
      whenToUse: '当用户要求整理日志并输出日报模板时使用。',
      procedure: ['读取日志文件', '提取关键错误', '输出日报模板到 outputs'],
      tags: ['logs', 'report'],
    },
  });

  const llm = new CountingLLM('{"task":"fallback","steps":[]}');
  const planner = createPlanner({ llm, skillManager });
  const plan = await planner.createPlan('整理日志并输出日报模板');

  assert.equal(llm.calls, 0);
  assert.equal(plan.steps.length, 3);
  assert.equal((plan.neededSkills?.length || 0) > 0, true);
}

async function testSkillLearningServiceCandidateAssessment(): Promise<void> {
  let capturedRefinement: Record<string, unknown> | undefined;
  const service = new SkillLearningService({
    llm: new StaticResponseLLM(`{
      "shouldCreate": true,
      "confidence": 0.87,
      "refinedDescription": "用于把执行经验沉淀成候选 skill 的自检流程。",
      "whenToUse": "当一个多步骤任务稳定完成并值得复用时使用。",
      "procedure": ["审查任务结果", "抽象稳定步骤", "生成候选草稿"],
      "verification": ["确认步骤不依赖一次性环境"],
      "tags": ["procedural", "learning"],
      "qualitySummary": "自检通过。",
      "suggestedName": "procedural-learning-review"
    }`),
    skillManager: {
      maybeCreateCandidateFromExecution: async (input) => {
        capturedRefinement = input.refinement as Record<string, unknown> | undefined;
        return {
          name: 'procedural-learning-review',
          path: 'skill-candidates/procedural-learning-review',
          sourceTask: input.originalTask,
        };
      },
    },
  });

  await service.processExecution(
    '整理稳定工作流',
    {
      id: 'plan_1',
      originalTask: '整理稳定工作流',
      currentStepIndex: 0,
      status: 'planning',
      steps: [
        { id: 'step_1', description: '读取上下文', status: 'pending' },
        { id: 'step_2', description: '沉淀流程', status: 'pending' },
      ],
    },
    ['读取完成', '沉淀完成'],
  );

  assert.equal(capturedRefinement?.shouldCreate, true);
  assert.equal(capturedRefinement?.confidence, 0.87);
  assert.equal((capturedRefinement?.procedure as string[] | undefined)?.[1], '抽象稳定步骤');
}

async function testSkillLearningServiceCreatesTodo(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'todo-skills'));
  await skillManager.initialize();

  const service = new SkillLearningService({
    llm: new StaticResponseLLM(`{
      "shouldTrack": true,
      "issueSummary": "缺少 markdown 转 docx 的稳定工作流。",
      "suggestedSkill": "markdown-to-docx-workflow",
      "blockers": ["没有现成的 md 文件转 docx skill"],
      "nextActions": ["评估是否封装 markdown 导出 skill"],
      "tags": ["document", "learning"],
      "confidence": 0.82
    }`),
    skillManager,
  });

  await service.processExecution(
    '把 markdown 文件转成 word',
    {
      id: 'plan_fail',
      originalTask: '把 markdown 文件转成 word',
      currentStepIndex: 0,
      status: 'failed',
      steps: [
        { id: 'step_1', description: '读取 markdown 文件', status: 'completed' },
        { id: 'step_2', description: '导出为 word', status: 'failed' },
      ],
    },
    ['[步骤 1] 读取成功', '[步骤 2] 失败: 缺少 markdown 转 word 能力'],
  );

  const todos = await skillManager.listLearningTodos();
  assert.equal(todos[0]?.suggestedSkill, 'markdown-to-docx-workflow');
  assert.match(todos[0]?.issueSummary || '', /markdown/);
}

async function testSkillLearningServiceSkipsPlaceholderExportTodo(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'placeholder-todo-skills'));
  await skillManager.initialize();

  const service = new SkillLearningService({
    llm: new StaticResponseLLM(`{
      "shouldTrack": true,
      "issueSummary": "这条不该被写入。",
      "suggestedSkill": "should-not-exist"
    }`),
    skillManager,
  });

  await service.processExecution(
    '生成详细报告并导出 PDF',
    {
      id: 'plan_placeholder_fail',
      originalTask: '生成详细报告并导出 PDF',
      currentStepIndex: 0,
      status: 'failed',
      steps: [
        { id: 'step_1', description: '撰写详细报告', status: 'completed' },
        { id: 'step_2', description: '导出 PDF', status: 'failed' },
      ],
    },
    [
      '[步骤 1] 已生成文本',
      '[步骤 2] 失败: PDF 文件已创建，但正文校验失败: C:/tmp/report.pdf 缺少预期内容: （此处为报告详细内容，基于搜索结果和分析整理，包含具体的技术细节、应用案例、数据支持和专业分析）',
    ],
  );

  const todos = await skillManager.listLearningTodos();
  assert.equal(todos.length, 0);
}

async function testToolExecutionGuardRejectsPlaceholderExportInput(): Promise<void> {
  const guard = new ToolExecutionGuard({
    getTool: () => undefined,
  } as any);

  const result = await guard.authorize('pdf_create_from_text', {
    out: 'report.pdf',
    text: '# 报告\n\n## 摘要\n本报告系统分析了当前情况...\n\n（此处为报告详细内容，基于搜索结果和分析整理，包含具体的技术细节、应用案例、数据支持和专业分析）',
    title: '报告',
  });

  assert.equal(result?.is_error, true);
  assert.match(result?.output || '', /占位稿或模板骨架/);
}

async function testToolExecutionGuardRejectsIncompleteStructuredTextWrite(): Promise<void> {
  const guard = new ToolExecutionGuard({
    getTool: () => undefined,
  } as any);

  const result = await guard.authorize('write_file', {
    path: '大模型在数据库领域的应用详细报告.txt',
    content: '# 大模型在当今数据库领域的应用分析报告\n\n## 摘要\n本报告系统分析了大模型在数据库领域的最新应用现状...\n\n（此处为报告详细内容，基于搜索结果和分析整理，包含具体的技术细节、应用案例、数据支持和专业分析）\n\n## 1. 引言\n\n## 2. 主要应用场景\n\n## 3. 技术实现架构\n\n## 4. 典型案例分析\n\n## 5. 挑战与限制\n\n## 6. 未来发展趋势\n\n## 7. 结论与建议',
  });

  assert.equal(result?.is_error, true);
  assert.match(result?.output || '', /未完成报告骨架|占位稿/);
}

async function testAgentUsesExpandedBudgetForResearchExportDeliveryTask(): Promise<void> {
  const agent = createAgent({
    llm: new StaticResponseLLM('处理完成'),
  });

  await agent.chat('先搜索资料，整理成 pdf 报告，再发我飞书');
  const snapshot = agent.getUnifiedStateSnapshot();
  assert.equal(snapshot.toolBudget.maxToolCallsPerTurn, 36);
}

async function testAgentUsesLeanBudgetForPlainConversation(): Promise<void> {
  const agent = createAgent({
    llm: new StaticResponseLLM('你好，我在。'),
  });

  await agent.chat('你好，介绍一下你自己');
  const snapshot = agent.getUnifiedStateSnapshot();
  assert.equal(snapshot.toolBudget.maxToolCallsPerTurn, 12);
}

async function testToolExecutionGuardAllowsTemplateTextWrite(): Promise<void> {
  const guard = new ToolExecutionGuard({
    getTool: () => undefined,
  } as any);

  const result = await guard.authorize('write_file', {
    path: '数据库应用报告模板.txt',
    content: '# 数据库应用报告模板\n\n（此处为报告详细内容，后续补充）',
  });

  assert.equal(result, null);
}

function testContentModeratorDoesNotCountBenignConfirmation(): void {
  const moderator = createModerator();
  moderator.recordWarning('是', true);
  moderator.recordWarning('是', true);
  moderator.recordWarning('是', true);

  assert.equal(moderator.getWarningCount(), 0);
}

function testContentModeratorCountsRepeatedViolations(): void {
  const moderator = createModerator();
  moderator.recordWarning('你他妈的真烦', true);
  moderator.recordWarning('你他妈的真烦', true);
  moderator.recordWarning('你他妈的真烦', true);

  assert.equal(moderator.getWarningCount(), 1);
}

function testRepairHighBitAsciiMojibake(): void {
  const garbled = 'ÛÔÏÏÌÝ Message: Óõããåóóæõììù ÷òïôå ôï C:\\Users\\test\\文档\\note.md';
  const repaired = repairHighBitAsciiMojibake(garbled);

  assert.equal(repaired, '[TOOL] Message: Successfully wrote to C:\\Users\\test\\文档\\note.md');
}

async function testKnownGapManagerBuildsNotice(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'known-gap-manager-skills'));
  await skillManager.initialize();
  await skillManager.addLearningTodo({
    sourceTask: '把 docx 转成 pdf',
    issueSummary: '缺少 docx 转 pdf 的稳定工作流。',
    suggestedSkill: 'docx-to-pdf-workflow',
    blockers: ['没有 docx 转换器'],
    nextActions: ['实现 docx 提取', '接入 pdf 导出'],
    tags: ['document'],
    confidence: 0.9,
  });

  const manager = new KnownGapManager(skillManager);
  await manager.prepare('把 docx 转成 pdf');

  assert.match(manager.getNotice(), /^这是已知能力缺口：/);
  assert.match(manager.getContext(), /Known skill gap detected/);
  assert.match(manager.applyNotice('可以先降级处理。'), /^这是已知能力缺口：/);
}

async function testLearningTodoCanSeedCandidate(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'todo-seed-skills'));
  await skillManager.initialize();

  const todo = await skillManager.addLearningTodo({
    sourceTask: '把 markdown 文件转成 xlsx',
    issueSummary: '缺少 markdown 到 xlsx 的结构化导出流程。',
    suggestedSkill: 'markdown-to-xlsx-workflow',
    blockers: ['没有 markdown 到 xlsx 的转换 skill'],
    nextActions: ['确认表格列结构', '封装 xlsx 导出 skill'],
    tags: ['document', 'spreadsheet'],
    confidence: 0.79,
  });

  const candidate = await skillManager.createCandidateFromTodo(todo.id);
  assert.equal(candidate.name.startsWith('markdown-to-xlsx-workflow'), true);

  const candidates = await skillManager.listSkillCandidates();
  assert.equal(candidates.some(item => item.name === candidate.name), true);

  const todos = await skillManager.listLearningTodos();
  assert.equal(todos[0]?.draftedCandidateName, candidate.name);
}

async function testAgentKnownGapNotice(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'known-gap-skills'));
  await skillManager.initialize();
  await skillManager.addLearningTodo({
    sourceTask: '把 docx 转成 pdf',
    issueSummary: '缺少 docx 转 pdf 的稳定工作流。',
    suggestedSkill: 'docx-to-pdf-workflow',
    blockers: ['没有 docx 转换器'],
    nextActions: ['实现 docx 提取', '接入 pdf 导出'],
    tags: ['document'],
    confidence: 0.9,
  });

  const agent = createAgent({
    llm: new StaticResponseLLM('可以先降级为请你提供提取后的文本，我再导出为 PDF。'),
    skillManager,
  });

  const response = await agent.chat('把 docx 转成 pdf');
  assert.match(response, /^这是已知能力缺口：/);
  assert.match(response, /降级|ok/);
}

async function testAgentIntentContractRejectsMismatchedTool(): Promise<void> {
  const llm = new SequenceGenerateLLM([
    '<tool_call>{"name":"execute_command","arguments":{"command":"npm install"}}</tool_call>',
    '{"action":"file_read","summary":"Read package.json","confidence":0.93}',
    '已拒绝错误工具调用，并等待与读取意图一致的后续动作。',
  ]);

  const agent = createAgent({ llm });
  const response = await agent.chat('读取 package.json');

  assert.match(response, /已拒绝错误工具调用/);
  const toolMessage = agent.getMessages().find(message => message.role === 'tool');
  assert.match(toolMessage?.content || '', /Tool call rejected by intent contract/);
}

function testPlannedToolArgPlaceholderResolution(): void {
  const agent = createAgent({
    llm: new StubLLM(),
    config: { artifactOutputDir: 'C:/artifacts' },
  }) as any;

  agent.setMessages([
    { role: 'user', content: '先生成摘要' },
    { role: 'assistant', content: '这是最近生成的摘要。' },
  ]);

  const resolved = agent.resolvePlannedToolArgs({
    path: '$ARTIFACT_OUTPUT_DIR/summary.md',
    content: '$LAST_ASSISTANT_TEXT',
    cwd: '$WORKSPACE',
    paths: ['$WORKSPACE/src/index.ts', '$ARTIFACT_OUTPUT_DIR/report.txt'],
  });

  assert.equal(String(resolved.path).replace(/\\/g, '/'), 'C:/artifacts/summary.md');
  assert.equal(resolved.content, '这是最近生成的摘要。');
  assert.match(resolved.cwd, /ai-agent-cli$/);
  assert.equal(String(resolved.paths[1]).replace(/\\/g, '/'), 'C:/artifacts/report.txt');
}

function testPlannedToolArgsResolver(): void {
  const resolver = new PlannedToolArgsResolver({
    workspace: 'D:/workspace/ai-agent-cli',
    artifactOutputDir: 'C:/artifacts',
    getMessages: () => [
      { role: 'assistant', content: '这是第一段结果' },
      { role: 'assistant', content: 'Using tool...' },
      { role: 'tool', content: '头条A\n头条B' },
      { role: 'assistant', content: '## ✅ 任务完成\n\n**原始任务**: 示例' },
    ],
    getLastReusableContent: () => '',
  });

  const resolved = resolver.resolve({
    output: '$ARTIFACT_OUTPUT_DIR/news.docx',
    text: '$LAST_ASSISTANT_TEXT',
    cwd: '$WORKSPACE',
  });

  assert.equal(String(resolved.output).replace(/\\/g, '/'), 'C:/artifacts/news.docx');
  assert.equal(resolved.text, '头条A\n头条B');
  assert.equal(String(resolved.cwd).replace(/\\/g, '/'), 'D:/workspace/ai-agent-cli');
}

async function testDirectToolCallPlaceholderResolution(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
    config: { artifactOutputDir: 'C:/artifacts' },
  }) as any;

  agent.setMessages([
    { role: 'user', content: '先生成今日热点新闻' },
    { role: 'assistant', content: '1. 新闻A\n2. 新闻B\n3. 新闻C' },
  ]);

  let capturedArgs: Record<string, unknown> | undefined;
  agent.toolRegistry = {
    execute: async (_name: string, args: Record<string, unknown>) => {
      capturedArgs = args;
      await writeMinimalDocx(
        String(args.output),
        String(args.text || ''),
        typeof args.title === 'string' ? args.title : undefined,
      );
      return { tool_call_id: '', output: 'ok', is_error: false };
    },
    getTool: () => undefined,
    listTools: () => [],
  };

  const result = await agent.executeToolCall({
    id: 'call_direct_docx',
    type: 'function',
    function: {
      name: 'txt_to_docx',
      arguments: JSON.stringify({
        output: '$ARTIFACT_OUTPUT_DIR/news.docx',
        text: '$LAST_ASSISTANT_TEXT',
        title: '今日热点新闻报告',
      }),
    },
  });

  assert.equal(result.is_error, false);
  assert.equal(String(capturedArgs?.output).replace(/\\/g, '/'), 'C:/artifacts/news.docx');
  assert.equal(capturedArgs?.text, '1. 新闻A\n2. 新闻B\n3. 新闻C');
}

async function testPlaceholderResolutionSkipsStatusMessages(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
    config: { artifactOutputDir: 'C:/artifacts' },
  }) as any;

  agent.setMessages([
    { role: 'user', content: '根据今日热点新闻生成一个word文档' },
    { role: 'assistant', content: '新闻一：AI 芯片发布\n新闻二：机器人融资\n新闻三：大模型开源' },
    { role: 'assistant', content: 'Using tool...' },
    { role: 'assistant', content: '## ✅ 任务完成\n\n**原始任务**: 根据今日热点新闻生成一个word文档\n\n[write_file]\nFile written successfully: D:/workspace/ai-agent-cli/news_summary.txt' },
  ]);

  let capturedArgs: Record<string, unknown> | undefined;
  agent.toolRegistry = {
    execute: async (_name: string, args: Record<string, unknown>) => {
      capturedArgs = args;
      await writeMinimalDocx(
        String(args.output),
        String(args.text || ''),
        typeof args.title === 'string' ? args.title : undefined,
      );
      return { tool_call_id: '', output: 'ok', is_error: false };
    },
    getTool: () => undefined,
    listTools: () => [],
  };

  const result = await agent.executeToolCall({
    id: 'call_skip_status_docx',
    type: 'function',
    function: {
      name: 'docx_create_from_text',
      arguments: JSON.stringify({
        output: '$ARTIFACT_OUTPUT_DIR/hot-news.docx',
        text: '$LAST_ASSISTANT_TEXT',
        title: '今日热点新闻',
      }),
    },
  });

  assert.equal(result.is_error, false);
  assert.equal(capturedArgs?.text, '新闻一：AI 芯片发布\n新闻二：机器人融资\n新闻三：大模型开源');
}

async function testPlaceholderResolutionFallsBackToToolContent(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
    config: { artifactOutputDir: 'C:/artifacts' },
  }) as any;

  agent.setMessages([
    { role: 'user', content: '先抓取今日热点新闻' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'news_1',
        type: 'function',
        function: {
          name: 'tencent_hot_news',
          arguments: '{}',
        },
      }],
    },
    { role: 'tool', name: 'tencent_hot_news', tool_call_id: 'news_1', content: '头条A\n头条B\n头条C' },
    { role: 'assistant', content: '## ✅ 任务完成\n\n**原始任务**: 先抓取今日热点新闻' },
  ]);

  let capturedArgs: Record<string, unknown> | undefined;
  agent.toolRegistry = {
    execute: async (_name: string, args: Record<string, unknown>) => {
      capturedArgs = args;
      await writeMinimalDocx(
        String(args.output),
        String(args.text || ''),
        typeof args.title === 'string' ? args.title : undefined,
      );
      return { tool_call_id: '', output: 'ok', is_error: false };
    },
    getTool: () => undefined,
    listTools: () => [],
  };

  const result = await agent.executeToolCall({
    id: 'call_tool_content_docx',
    type: 'function',
    function: {
      name: 'docx_create_from_text',
      arguments: JSON.stringify({
        output: '$ARTIFACT_OUTPUT_DIR/tool-news.docx',
        text: '$LAST_ASSISTANT_TEXT',
        title: '工具新闻正文',
      }),
    },
  });

  assert.equal(result.is_error, false);
  assert.equal(capturedArgs?.text, '头条A\n头条B\n头条C');
}

async function testPlaceholderResolutionPrefersWrittenTextContent(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
    config: { artifactOutputDir: 'C:/artifacts' },
  }) as any;

  agent.toolRegistry = {
    execute: async (name: string, args: Record<string, unknown>) => {
      if (name === 'write_file') {
        return {
          tool_call_id: '',
          output: 'File written successfully: D:/workspace/ai-agent-cli/news_summary.txt',
          is_error: false,
        };
      }

      return { tool_call_id: '', output: 'ok', is_error: false };
    },
    getTool: () => undefined,
    listTools: () => [],
  };

  const writeResult = await agent.executeToolCall({
    id: 'call_write_news_txt',
    type: 'function',
    function: {
      name: 'write_file',
      arguments: JSON.stringify({
        path: '$ARTIFACT_OUTPUT_DIR/news_summary.txt',
        content: '头条一：芯片\n头条二：机器人\n头条三：开源模型',
      }),
    },
  });

  assert.equal(writeResult.is_error, false);

  const resolved = agent.resolvePlannedToolArgs({
    output: '$ARTIFACT_OUTPUT_DIR/今日热点新闻.docx',
    text: '$LAST_ASSISTANT_TEXT',
    title: '今日热点新闻',
  });

  assert.equal(resolved.text, '头条一：芯片\n头条二：机器人\n头条三：开源模型');
}

async function testExecutePlanStopsAfterFailedStep(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  let executeCount = 0;
  agent.toolRegistry = {
    execute: async () => {
      executeCount++;
      return { tool_call_id: '', output: 'step failed', is_error: true };
    },
    getTool: () => undefined,
    listTools: () => [],
  };

  const plan = {
    id: 'plan_stop_on_failure',
    originalTask: '搜索《将进酒》并发送到飞书',
    currentStepIndex: 0,
    status: 'planning',
    steps: [
      {
        id: 'step_1',
        description: '分析搜索结果，确定《将进酒》中最有名的诗句',
        status: 'pending',
        toolCalls: [
          {
            name: 'write_file',
            args: { path: '$WORKSPACE/analysis_result.txt', content: '$LAST_ASSISTANT_TEXT' },
          },
        ],
      },
      {
        id: 'step_2',
        description: '读取分析结果文件',
        status: 'pending',
        toolCalls: [
          {
            name: 'read_file',
            args: { path: '$WORKSPACE/analysis_result.txt' },
          },
        ],
      },
    ],
  };

  const summary = await agent.executePlan('搜索《将进酒》并发送到飞书', plan);
  assert.match(summary, /步骤 1/);
  assert.doesNotMatch(summary, /步骤 2/);
  assert.equal(executeCount, 1);
}

async function testAgentStoresArtifactOutputInMemory(): Promise<void> {
  const storedEntries: Array<{ key?: string; content: string }> = [];
  const agent = createAgent({
    llm: new StubLLM(),
    config: { artifactOutputDir: 'C:/artifacts' },
    memoryProvider: {
      backend: 'local',
      async recall() { return []; },
      async recallLayers() { return []; },
      async buildContext() { return ''; },
      async syncSession() {},
      async store(entry) { storedEntries.push({ key: entry.key, content: entry.content }); },
    },
  }) as any;

  agent.toolRegistry = {
    execute: async () => ({ tool_call_id: '', output: 'ok', is_error: false }),
    getTool: () => undefined,
    listTools: () => [],
  };

  await agent.executeToolCall({
    id: 'call_memory_docx',
    type: 'function',
    function: {
      name: 'txt_to_docx',
      arguments: JSON.stringify({
        output: '$ARTIFACT_OUTPUT_DIR/news.docx',
        text: '新闻正文',
        title: '今日热点新闻报告',
      }),
    },
  });

  assert.equal(storedEntries.some(entry => entry.key === 'last_output_file' && /news\.docx/.test(entry.content)), true);
  assert.equal(storedEntries.some(entry => entry.key === 'last_docx_output_file' && /news\.docx/.test(entry.content)), true);
}

function testGenericPlanDetection(): void {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  const genericPlan = {
    id: 'plan_generic',
    originalTask: '你好',
    currentStepIndex: 0,
    status: 'planning',
    steps: [
      { id: 'step_1', description: '分析任务需求', status: 'pending' },
      { id: 'step_2', description: '将任务拆分成清晰的步骤', status: 'pending' },
      { id: 'step_3', description: '开发一个网站应用', status: 'pending' },
    ],
  };

  assert.equal(agent.isGenericPlan(genericPlan, '你好'), true);
}

async function testFailedPlanReturnsFailureSummary(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  const summary = await agent.synthesizeResults('导出 PDF', ['[步骤 1] 失败: 未找到 PDF skill']);
  assert.match(summary, /任务失败/);
  assert.doesNotMatch(summary, /## ✅ 任务完成/);
}

async function testTaskSynthesisServiceArchivesSummary(): Promise<void> {
  const events: Array<{ type: string; status?: string; content: string }> = [];
  let archivedEntry: { kind: string; title: string; content: string } | undefined;

  const service = new TaskSynthesisService({
    agentRole: 'ai-agent-cli',
    memoryProvider: {
      backend: 'hybrid',
      async recall() { return []; },
      async recallLayers() { return []; },
      async buildContext() { return ''; },
      async syncSession() { return; },
      async store(entry) {
        archivedEntry = {
          kind: entry.kind,
          title: entry.title,
          content: entry.content,
        };
      },
    } as any,
    onResponse: (content) => {
      events.push({ type: 'response', content });
    },
    onMemorySync: (event) => {
      events.push({ type: 'memory_sync', status: event.status, content: event.content });
    },
  });

  const response = await service.synthesizeResults('实现登录功能', ['[步骤 1] 设计 API\n完成']);
  assert.match(response, /任务完成/);
  assert.equal(archivedEntry?.kind, 'task');
  assert.equal(archivedEntry?.title, '实现登录功能');
  assert.match(String(archivedEntry?.content || ''), /TASK:实现登录功能/);
  assert.equal(events.some(event => event.type === 'response' && /任务完成/.test(event.content)), true);
  assert.equal(events.some(event => event.type === 'memory_sync' && event.status === 'archived'), true);
}

async function testAgentToolCallServiceExecutesAndCapturesReusableContent(): Promise<void> {
  let rememberedReusableContent = '';
  let capturedArgs: Record<string, unknown> | undefined;

  const service = new AgentToolCallService({
    resolvePlannedToolArgs: (args) => ({
      ...args,
      output: String(args.output || '').replace('$ARTIFACT_OUTPUT_DIR', 'C:/artifacts'),
      text: String(args.text || '').replace('$LAST_ASSISTANT_TEXT', '头条一\n头条二'),
    }),
    toolExecutionGuard: {
      authorize: async () => null,
    },
    toolRegistry: {
      execute: async (_name, args) => {
        capturedArgs = args;
        return { tool_call_id: '', output: 'ok', is_error: false };
      },
    },
    toolResultPostProcessor: {
      process: async (_name, _args, result) => ({
        result,
        reusableContent: '头条一\n头条二',
      }),
    },
    toolCallPreparationPolicy: {
      prepare: async (_userInput, _assistantContent, toolCalls) => ({
        contract: buildFallbackIntentContract('test', toolCalls),
        toolCalls,
        rejections: [],
      }),
    },
    setLastReusableContent: (content) => {
      rememberedReusableContent = content;
    },
  });

  const result = await service.executeToolCall({
    id: 'call_service_docx',
    type: 'function',
    function: {
      name: 'docx_create_from_text',
      arguments: JSON.stringify({
        output: '$ARTIFACT_OUTPUT_DIR/news.docx',
        text: '$LAST_ASSISTANT_TEXT',
        title: '新闻',
      }),
    },
  });

  assert.equal(result.is_error, false);
  assert.equal(result.tool_call_id, 'call_service_docx');
  assert.equal(String(capturedArgs?.output).replace(/\\/g, '/'), 'C:/artifacts/news.docx');
  assert.equal(capturedArgs?.text, '头条一\n头条二');
  assert.equal(rememberedReusableContent, '头条一\n头条二');
}

async function testMemPalaceTaskAutoArchive(): Promise<void> {
  const events: Array<{ type: string; content: string; memorySync?: { status: string; detail?: string } }> = [];
  let archivedEntry: { kind: string; title: string; content: string } | undefined;

  const fakeMemoryProvider = {
    backend: 'hybrid' as const,
    async recall() {
      return [];
    },
    async buildContext() {
      return '';
    },
    async syncSession() {
      return;
    },
    async store(entry: { kind: string; title: string; content: string }) {
      archivedEntry = entry;
    },
  };

  const agent = createAgent({
    llm: new StubLLM(),
    agentRole: 'ai-agent-cli',
    memoryProvider: fakeMemoryProvider as any,
  });

  agent.setEventHandler((event) => {
    events.push({
      type: event.type,
      content: event.content,
      memorySync: event.memorySync ? { status: event.memorySync.status, detail: event.memorySync.detail } : undefined,
    });
  });

  const response = await agent.synthesizeResults('实现登录功能', ['[步骤 1] 设计 API\n完成']);

  assert.match(response, /任务完成/);
  assert.equal(archivedEntry?.kind, 'task');
  assert.equal(archivedEntry?.title, '实现登录功能');
  assert.match(String(archivedEntry?.content || ''), /TASK:实现登录功能/);
  const memoryEvent = events.find(event => event.type === 'memory_sync');
  assert.equal(memoryEvent?.memorySync?.status, 'archived');
}

async function testCliHistoryPersistence(tempDir: string): Promise<void> {
  const cli = new CLI() as any;
  cli.inputHistoryPath = path.join(tempDir, 'input-history.json');

  cli.recordHistory('/model switch deepseek');
  cli.recordHistory('帮我读文件');
  await cli.saveInputHistory();

  const reloaded = new CLI() as any;
  reloaded.inputHistoryPath = path.join(tempDir, 'input-history.json');
  await reloaded.loadInputHistory();

  assert.equal(reloaded.cmdHistory.includes('/model switch deepseek'), true);
  assert.equal(reloaded.cmdHistory.includes('帮我读文件'), true);
  const history = reloaded.getReadlineHistory() as string[];
  assert.equal(history[0], '帮我读文件');
}

async function testMemoryPalace(tempDir: string): Promise<void> {
  const enhanced = createEnhancedMemoryManager(path.join(tempDir, 'enhanced-memory'));
  await enhanced.initialize();

  enhanced.setUserPreference('job', 'programmer');
  enhanced.addToKnowledgeBase('TypeScript project with unified tool registry');
  const task = enhanced.createTaskProgress('Ship memory palace', ['design', 'implement']);
  enhanced.updateTaskProgress(task.taskId, {
    status: 'in_progress',
    currentStep: 'implement',
    completedSteps: ['design'],
    pendingSteps: ['implement'],
  });

  const palace = enhanced.getMemoryPalace();
  assert.equal(palace.entranceRoomId, 'propylaea');
  assert.ok(palace.rooms.oikos);
  assert.ok(palace.rooms.bibliotheke);
  assert.ok(palace.rooms.ergasterion);

  const jobMemory = palace.rooms.oikos?.memories.find(item => item.anchor === 'preference:job');
  const knowledgeMemory = palace.rooms.bibliotheke?.memories.find(item => item.content.includes('unified tool registry'));
  const taskMemory = palace.rooms.ergasterion?.memories.find(item => item.anchor === `task:${task.taskId}`);

  assert.ok(jobMemory);
  assert.ok(knowledgeMemory);
  assert.ok(taskMemory);

  const searchResults = enhanced.searchMemoryPalace('tool registry');
  assert.equal(searchResults.length > 0, true);

  const moved = enhanced.setCurrentPalaceRoom('bibliotheke');
  assert.equal(moved, true);
  const currentRoom = enhanced.getMemoryPalaceRoom();
  assert.equal(currentRoom?.id, 'bibliotheke');
  assert.match(enhanced.getNavigablePalaceContext(), /Bibliotheke|图书馆/);
}

async function testCliLiveProgressDisplay(tempDir: string): Promise<void> {
  progressTracker.clear();

  const cli = new CLI() as any;
  cli.enhancedMemory = createEnhancedMemoryManager(path.join(tempDir, 'enhanced-progress'));
  await cli.enhancedMemory.initialize();

  const originalPrintProgress = progressTracker.printProgress;
  progressTracker.printProgress = (() => {}) as typeof progressTracker.printProgress;

  try {
    const planEvent = {
      type: 'plan_summary',
      content: 'plan ready',
      plan: {
        originalTask: '用户登录功能开发',
        steps: [
          { id: 'step_requirements', description: '需求分析', status: 'pending' },
          { id: 'step_api', description: '编写后端 API', status: 'pending' },
        ],
      },
    };

    cli.trackPlannedTask(planEvent);

    const displayTaskId = cli.activeProgressDisplayTaskId as string;
    const displayTask = progressTracker.getTask(displayTaskId);
    assert.ok(displayTask);
    assert.equal(displayTask?.title, '用户登录功能开发');
    assert.equal(displayTask?.steps.length, 2);

    cli.updateTrackedTaskFromPlanEvent({
      type: 'plan_progress',
      content: '步骤开始: 需求分析',
      planProgress: {
        stepId: 'step_requirements',
        stepDescription: '需求分析',
        stepIndex: 0,
        totalSteps: 2,
        status: 'started',
      },
    });

    assert.equal(progressTracker.getTask(displayTaskId)?.steps[0]?.status, 'running');

    cli.updateTrackedTaskFromPlanEvent({
      type: 'plan_progress',
      content: '步骤完成: 需求分析',
      planProgress: {
        stepId: 'step_requirements',
        stepDescription: '需求分析',
        stepIndex: 0,
        totalSteps: 2,
        status: 'completed',
        result: 'done',
      },
    });

    assert.equal(progressTracker.getTask(displayTaskId)?.steps[0]?.status, 'completed');

    cli.completeTrackedTaskIfNeeded('## ✅ 任务完成\n\n完成');

    const completedTask = progressTracker.getTask(displayTaskId);
    assert.equal(completedTask?.status, 'completed');
    assert.equal(completedTask?.steps.every((step: { status: string }) => step.status === 'completed'), true);
  } finally {
    progressTracker.printProgress = originalPrintProgress;
    progressTracker.clear();
  }
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-agent-cli-regression-'));

  try {
    await runRegressionStep('testToolOutputBackflow', () => testToolOutputBackflow(tempDir));
    await runRegressionStep('testPermissionAskToggle', () => testPermissionAskToggle(tempDir));
    await runRegressionStep('testPermissionManagerAllowsLarkCliLocatorProbe', () => testPermissionManagerAllowsLarkCliLocatorProbe(tempDir));
    await runRegressionStep('testPermissionManagerAllowsReadOnlyShellCommands', () => testPermissionManagerAllowsReadOnlyShellCommands(tempDir));
    await runRegressionStep('testPermissionManagerAllowsLarkCliHelpCommands', () => testPermissionManagerAllowsLarkCliHelpCommands(tempDir));
    await runRegressionStep('testPermissionManagerParsesTaskScopedBatchAnswer', () => testPermissionManagerParsesTaskScopedBatchAnswer());
    await runRegressionStep('testOutputCoordinatorPausesNonPermissionChannels', () => testOutputCoordinatorPausesNonPermissionChannels());
    await runRegressionStep('testSandboxAllowedPathNormalization', () => testSandboxAllowedPathNormalization(tempDir));
    await runRegressionStep('testSandboxDefaultsToWorkspaceWhitelist', () => testSandboxDefaultsToWorkspaceWhitelist(tempDir));
    await runRegressionStep('testSandboxRejectsCommandCwdOutsideWhitelist', () => testSandboxRejectsCommandCwdOutsideWhitelist(tempDir));
    await runRegressionStep('testSandboxHonorsShellCapabilities', () => testSandboxHonorsShellCapabilities(tempDir));
    await runRegressionStep('testPhaseAwareWorkflowLintAndQuickFixes', () => testPhaseAwareWorkflowLintAndQuickFixes(tempDir));
    await runRegressionStep('testSessionTaskStackContextSnapshot', () => testSessionTaskStackContextSnapshot());
    await runRegressionStep('testSessionTaskStackPersistence', () => testSessionTaskStackPersistence(tempDir));
    await runRegressionStep('testTaskContextJsonPayload', () => testTaskContextJsonPayload());
    await runRegressionStep('testAgentGraphRunnerDirectAction', () => testAgentGraphRunnerDirectAction());
    await runRegressionStep('testPlanCheckpointRiskSummary', () => testPlanCheckpointRiskSummary());
    await runRegressionStep('testAgentGraphRunnerDirectActionApprovalCheckpoint', () => testAgentGraphRunnerDirectActionApprovalCheckpoint());
    await runRegressionStep('testAgentGraphRunnerMainChain', () => testAgentGraphRunnerMainChain());
    await runRegressionStep('testAgentGraphRunnerAutoConfirmPlanExecutionOption', () => testAgentGraphRunnerAutoConfirmPlanExecutionOption());
    await runRegressionStep('testAgentGraphRunnerCheckpointRestorePlan', () => testAgentGraphRunnerCheckpointRestorePlan());
    await runRegressionStep('testAgentGraphRunnerCheckpointRestorePlanResume', () => testAgentGraphRunnerCheckpointRestorePlanResume());
    await runRegressionStep('testUnifiedAgentStateSnapshot', () => testUnifiedAgentStateSnapshot());
    await runRegressionStep('testDirectActionConversationPreambleTemplates', () => testDirectActionConversationPreambleTemplates());
    await runRegressionStep('testIntentResolverRejectsGenericKnowledgeQueryAsBrowserSearch', () => testIntentResolverRejectsGenericKnowledgeQueryAsBrowserSearch());
    await runRegressionStep('testBrowserActionHandlerRejectsGenericKnowledgeQueryIntent', () => testBrowserActionHandlerRejectsGenericKnowledgeQueryIntent());
    await runRegressionStep('testBrowserActionHandlerRoutesCompositeWebsiteTaskToBrowserAgent', () => testBrowserActionHandlerRoutesCompositeWebsiteTaskToBrowserAgent());
    await runRegressionStep('testBrowserActionHandlerRoutesOpenThenSingleOperationToBrowserAgent', () => testBrowserActionHandlerRoutesOpenThenSingleOperationToBrowserAgent());
    await runRegressionStep('testOnboardingParser', () => testOnboardingParser());
    await runRegressionStep('testDirectActionRouter', () => testDirectActionRouter(tempDir));
    await runRegressionStep('testNestedSkillDirectoryDiscovery', () => testNestedSkillDirectoryDiscovery(tempDir));
    await runRegressionStep('testOfficialDocumentSkillBridges', () => testOfficialDocumentSkillBridges(tempDir));
    await runRegressionStep('testCrLfMarkdownOnlySkillLoads', () => testCrLfMarkdownOnlySkillLoads(tempDir));
    await runRegressionStep('testMarkdownOnlySkillDescriptionCleanup', () => testMarkdownOnlySkillDescriptionCleanup(tempDir));
    await runRegressionStep('testPlannerProducesConcreteToolCalls', () => testPlannerProducesConcreteToolCalls());
    await runRegressionStep('testPlannerSuppressesRedundantSearchForFollowUpAdjustmentTask', () => testPlannerSuppressesRedundantSearchForFollowUpAdjustmentTask());
    await runRegressionStep('testLearnedSkillCandidateLifecycle', () => testLearnedSkillCandidateLifecycle(tempDir));
    await runRegressionStep('testMemoryManagerResume', () => testMemoryManagerResume(tempDir));
    await runRegressionStep('testUnifiedToolRegistry', () => testUnifiedToolRegistry(tempDir));
    await runRegressionStep('testBuiltInToolsAllowlistCommandMode', () => testBuiltInToolsAllowlistCommandMode(tempDir));
    await runRegressionStep('testBuiltInToolsBrowserNetworkCapabilities', () => testBuiltInToolsBrowserNetworkCapabilities(tempDir));
    await runRegressionStep('testConfigDefaultsFavorConservativeExecution', () => testConfigDefaultsFavorConservativeExecution(tempDir));
    await runRegressionStep('testHybridMemoryProviderRecall', () => testHybridMemoryProviderRecall(tempDir));
    await runRegressionStep('testMemoryProviderBuildsThreeLayerContext', () => testMemoryProviderBuildsThreeLayerContext(tempDir));
    await runRegressionStep('testAgentRuntimeMemoryContextInjection', () => testAgentRuntimeMemoryContextInjection());
    await runRegressionStep('testArtifactPathResolution', () => testArtifactPathResolution(tempDir));
    await runRegressionStep('testBuiltInToolsArtifactOutput', () => testBuiltInToolsArtifactOutput(tempDir));
    await runRegressionStep('testWebSearchUnwrapsDuckDuckGoRedirectLinks', () => testWebSearchUnwrapsDuckDuckGoRedirectLinks(tempDir));
    await runRegressionStep('testWebSearchFallsBackToBaidu', () => testWebSearchFallsBackToBaidu(tempDir));
    await runRegressionStep('testPushNewsToLarkRequiresChatId', () => testPushNewsToLarkRequiresChatId(tempDir));
    await runRegressionStep('testPushWeatherToLark', () => testPushWeatherToLark(tempDir));
    await runRegressionStep('testSendLarkMessageUsesBotShortcut', () => testSendLarkMessageUsesBotShortcut(tempDir));
    await runRegressionStep('testSendLarkMessagePrefersMarkdown', () => testSendLarkMessagePrefersMarkdown(tempDir));
    await runRegressionStep('testSendLarkMessageStagesAbsoluteAttachment', () => testSendLarkMessageStagesAbsoluteAttachment(tempDir));
    await runRegressionStep('testSendLarkMessageResolvesRelativeArtifactAttachment', () => testSendLarkMessageResolvesRelativeArtifactAttachment(tempDir));
    await runRegressionStep('testSendLarkMessagePrefersFileOverText', () => testSendLarkMessagePrefersFileOverText(tempDir));
    await runRegressionStep('testLarkRelayParsesCompactMessage', () => testLarkRelayParsesCompactMessage());
    await runRegressionStep('testLarkRelayFiltersUnexpectedSender', () => testLarkRelayFiltersUnexpectedSender());
    await runRegressionStep('testLarkRelayParsesAttachmentMessage', () => testLarkRelayParsesAttachmentMessage());
    await runRegressionStep('testLarkRelayDefaultReceiveDir', () => testLarkRelayDefaultReceiveDir());
    await runRegressionStep('testLarkRelayMaterializesAttachmentContent', () => testLarkRelayMaterializesAttachmentContent());
    await runRegressionStep('testLarkBridgeSpawnSpecBypassesCmdWrapper', () => testLarkBridgeSpawnSpecBypassesCmdWrapper(tempDir));
    await runRegressionStep('testCliNewsPushRejectsUserIdAndIgnoresLegacyUserDefault', () => testCliNewsPushRejectsUserIdAndIgnoresLegacyUserDefault());
    await runRegressionStep('testMemoryProviderBaselineIncludesArtifactHints', () => testMemoryProviderBaselineIncludesArtifactHints(tempDir));
    await runRegressionStep('testTaskAndCronTools', () => testTaskAndCronTools(tempDir));
    await runRegressionStep('testMcpClientAcceptsStderrLogs', () => testMcpClientAcceptsStderrLogs(tempDir));
    await runRegressionStep('testPlanConfirmationPersistsConversationContext', () => testPlanConfirmationPersistsConversationContext());
    await runRegressionStep('testLarkBridgeToolDefinitions', () => testLarkBridgeToolDefinitions());
    await runRegressionStep('testLarkBridgeArgumentBuilding', () => testLarkBridgeArgumentBuilding());
    await runRegressionStep('testDeepSeekToolMessageSanitization', () => testDeepSeekToolMessageSanitization());
    await runRegressionStep('testDeepSeekDropsDanglingAssistantToolCalls', () => testDeepSeekDropsDanglingAssistantToolCalls());
    await runRegressionStep('testContextManagerDropsDanglingAssistantToolCalls', () => testContextManagerDropsDanglingAssistantToolCalls());
    await runRegressionStep('testContextManagerCompressionKeepsToolMessagesValid', () => testContextManagerCompressionKeepsToolMessagesValid());
    await runRegressionStep('testCliSlashCommandCompletion', () => testCliSlashCommandCompletion());
    await runRegressionStep('testCliAgentInteractionMode', () => testCliAgentInteractionMode());
    await runRegressionStep('testCliSuppressesDirectActionPreambleInTaskMode', () => testCliSuppressesDirectActionPreambleInTaskMode());
    await runRegressionStep('testCliAutoModeUsesWorkflowHandlerForComplexTask', () => testCliAutoModeUsesWorkflowHandlerForComplexTask());
    await runRegressionStep('testCliAutoModeUsesChatRouterForConversation', () => testCliAutoModeUsesChatRouterForConversation());
    await runRegressionStep('testCliChatModeDoesNotAutoSwitchToWorkflow', () => testCliChatModeDoesNotAutoSwitchToWorkflow());
    await runRegressionStep('testCliChatModeAutoSwitchesToWorkflow', () => testCliChatModeAutoSwitchesToWorkflow());
    await runRegressionStep('testChatRouterSeparatesConversationAndTask', () => testChatRouterSeparatesConversationAndTask());
    await runRegressionStep('testTaskExecutorServiceDelegatesToGraphRunner', () => testTaskExecutorServiceDelegatesToGraphRunner());
    await runRegressionStep('testTaskExecutorServiceDescribesResumeContexts', () => testTaskExecutorServiceDescribesResumeContexts());
    await runRegressionStep('testAutoModeWorkflowProgressUsesConversationalCopy', () => testAutoModeWorkflowProgressUsesConversationalCopy());
    await runRegressionStep('testCliVisionAnalyzeArgParsing', () => testCliVisionAnalyzeArgParsing());
    await runRegressionStep('testCliParseBrowserScriptActions', () => testCliParseBrowserScriptActions(tempDir));
    await runRegressionStep('testCliConfigReloadCommand', () => testCliConfigReloadCommand());
    await runRegressionStep('testCliRelayCommands', () => testCliRelayCommands());
    await runRegressionStep('testCliSendsFinalAssistantReplyToLarkChat', () => testCliSendsFinalAssistantReplyToLarkChat());
    await runRegressionStep('testCliSendsPendingInteractionPromptToLarkChat', () => testCliSendsPendingInteractionPromptToLarkChat());
    await runRegressionStep('testCliForwardsPermissionPromptToLarkAndConsumesLarkReply', () => testCliForwardsPermissionPromptToLarkAndConsumesLarkReply(tempDir));
    await runRegressionStep('testAgentInteractionService', () => testAgentInteractionService());
    await runRegressionStep('testWeatherToLarkRequestSkipsClarification', () => testWeatherToLarkRequestSkipsClarification());
    await runRegressionStep('testHybridClientRouting', () => testHybridClientRouting());
    await runRegressionStep('testOllamaVisionService', () => testOllamaVisionService(tempDir));
    await runRegressionStep('testBrowserSessionExtensionBootstrap', () => testBrowserSessionExtensionBootstrap(tempDir));
    await runRegressionStep('testBrowserAutomationScriptEnvironment', () => testBrowserAutomationScriptEnvironment(tempDir));
    await runRegressionStep('testBuiltInBrowserAutomationEnvironmentDefaults', () => testBuiltInBrowserAutomationEnvironmentDefaults(tempDir));
    await runRegressionStep('testBrowserSessionExpectResultMismatchStrategies', () => testBrowserSessionExpectResultMismatchStrategies(tempDir));
    await runRegressionStep('testBrowserAutomationExpectResultMismatchStrategies', () => testBrowserAutomationExpectResultMismatchStrategies(tempDir));
    await runRegressionStep('testBrowserActionPlannerScriptActions', () => testBrowserActionPlannerScriptActions());
    await runRegressionStep('testBrowserWorkflowTemplateIncludesScriptScaffolding', () => testBrowserWorkflowTemplateIncludesScriptScaffolding(tempDir));
    await runRegressionStep('testDeepSeekRouterBehavior', () => testDeepSeekRouterBehavior());
    await runRegressionStep('testMemPalaceSystemPromptProtocol', () => testMemPalaceSystemPromptProtocol());
    await runRegressionStep('testGreetingDoesNotTriggerPlanning', () => testGreetingDoesNotTriggerPlanning());
    await runRegressionStep('testAmbiguousShortInputRequestsClarification', () => testAmbiguousShortInputRequestsClarification());
    await runRegressionStep('testAmbiguousShortInputClarificationReturnsDirectResponse', () => testAmbiguousShortInputClarificationReturnsDirectResponse());
    await runRegressionStep('testDefaultPromptEncouragesDirectPaths', () => testDefaultPromptEncouragesDirectPaths());
    await runRegressionStep('testCliShellTextUtilities', () => testCliShellTextUtilities());
    await runRegressionStep('testSharedExportIntentRules', () => testSharedExportIntentRules());
    await runRegressionStep('testGenericToolCallValidator', () => testGenericToolCallValidator());
    await runRegressionStep('testPlannerPrefersProceduralCandidate', () => testPlannerPrefersProceduralCandidate(tempDir));
    await runRegressionStep('testPlannedToolArgPlaceholderResolution', () => testPlannedToolArgPlaceholderResolution());
    await runRegressionStep('testDirectToolCallPlaceholderResolution', () => testDirectToolCallPlaceholderResolution());
    await runRegressionStep('testPlaceholderResolutionSkipsStatusMessages', () => testPlaceholderResolutionSkipsStatusMessages());
    await runRegressionStep('testPlaceholderResolutionFallsBackToToolContent', () => testPlaceholderResolutionFallsBackToToolContent());
    await runRegressionStep('testPlaceholderResolutionPrefersWrittenTextContent', () => testPlaceholderResolutionPrefersWrittenTextContent());
    await runRegressionStep('testExecutePlanStopsAfterFailedStep', () => testExecutePlanStopsAfterFailedStep());
    await runRegressionStep('testAgentStoresArtifactOutputInMemory', () => testAgentStoresArtifactOutputInMemory());
    await runRegressionStep('testSkillLearningServiceCandidateAssessment', () => testSkillLearningServiceCandidateAssessment());
    await runRegressionStep('testSkillLearningServiceCreatesTodo', () => testSkillLearningServiceCreatesTodo(tempDir));
    await runRegressionStep('testSkillLearningServiceSkipsPlaceholderExportTodo', () => testSkillLearningServiceSkipsPlaceholderExportTodo(tempDir));
    await runRegressionStep('testLearningTodoCanSeedCandidate', () => testLearningTodoCanSeedCandidate(tempDir));
    await runRegressionStep('testToolExecutionGuardRejectsPlaceholderExportInput', () => testToolExecutionGuardRejectsPlaceholderExportInput());
    await runRegressionStep('testToolExecutionGuardRejectsIncompleteStructuredTextWrite', () => testToolExecutionGuardRejectsIncompleteStructuredTextWrite());
    await runRegressionStep('testAgentUsesExpandedBudgetForResearchExportDeliveryTask', () => testAgentUsesExpandedBudgetForResearchExportDeliveryTask());
    await runRegressionStep('testAgentUsesLeanBudgetForPlainConversation', () => testAgentUsesLeanBudgetForPlainConversation());
    await runRegressionStep('testToolExecutionGuardAllowsTemplateTextWrite', () => testToolExecutionGuardAllowsTemplateTextWrite());
    await runRegressionStep('testContentModeratorDoesNotCountBenignConfirmation', () => testContentModeratorDoesNotCountBenignConfirmation());
    await runRegressionStep('testContentModeratorCountsRepeatedViolations', () => testContentModeratorCountsRepeatedViolations());
    await runRegressionStep('testRepairHighBitAsciiMojibake', () => testRepairHighBitAsciiMojibake());
    await runRegressionStep('testSessionTaskStackBindsShortAdjustmentFollowUp', () => testSessionTaskStackBindsShortAdjustmentFollowUp());
    await runRegressionStep('testSessionTaskStackKeepsStandaloneNewTaskUnbound', () => testSessionTaskStackKeepsStandaloneNewTaskUnbound());
    await runRegressionStep('testKnownGapManagerBuildsNotice', () => testKnownGapManagerBuildsNotice(tempDir));
    await runRegressionStep('testAgentKnownGapNotice', () => testAgentKnownGapNotice(tempDir));
    await runRegressionStep('testAgentIntentContractRejectsMismatchedTool', () => testAgentIntentContractRejectsMismatchedTool());
    await runRegressionStep('testLarkRelayStatusClassification', () => testLarkRelayStatusClassification());
    await runRegressionStep('testDirectActionSupportComponents', () => testDirectActionSupportComponents(tempDir));
    await runRegressionStep('testPlannedToolArgsResolver', () => testPlannedToolArgsResolver());
    await runRegressionStep('testResponseStreamCollector', () => testResponseStreamCollector());
    await runRegressionStep('testFinalResponseAssembler', () => testFinalResponseAssembler());
    await runRegressionStep('testResponseTurnExecutor', () => testResponseTurnExecutor());
    await runRegressionStep('testResponseTurnProcessor', () => testResponseTurnProcessor());
    await runRegressionStep('testResponseTurnProcessorDefersFinalizationOnHandledNonStreamingToolCall', () => testResponseTurnProcessorDefersFinalizationOnHandledNonStreamingToolCall());
    await runRegressionStep('testFailedPlanReturnsFailureSummary', () => testFailedPlanReturnsFailureSummary());
    await runRegressionStep('testTaskSynthesisServiceArchivesSummary', () => testTaskSynthesisServiceArchivesSummary());
    await runRegressionStep('testAgentToolCallServiceExecutesAndCapturesReusableContent', () => testAgentToolCallServiceExecutesAndCapturesReusableContent());
    await runRegressionStep('testGenericPlanDetection', () => testGenericPlanDetection());
    await runRegressionStep('testMemPalaceTaskAutoArchive', () => testMemPalaceTaskAutoArchive());
    await runRegressionStep('testCliHistoryPersistence', () => testCliHistoryPersistence(tempDir));
    await runRegressionStep('testMemoryPalace', () => testMemoryPalace(tempDir));
    await runRegressionStep('testCliLiveProgressDisplay', () => testCliLiveProgressDisplay(tempDir));
    console.log('Regression checks passed');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('Regression checks failed');
  console.error(error);
  process.exitCode = 1;
});