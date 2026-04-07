import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseOnboardingInput } from '../src/core/onboarding.js';
import { CLI } from '../src/cli/index.js';
import { createAgent } from '../src/core/agent.js';
import { createDirectActionRouter } from '../src/core/direct-action-router.js';
import { createContextManager } from '../src/core/context-manager.js';
import { createEnhancedMemoryManager } from '../src/core/memory-enhanced.js';
import { createMemoryManager } from '../src/core/memory.js';
import { PermissionManager } from '../src/core/permission-manager.js';
import { createTaskManager } from '../src/core/task-manager.js';
import { createCronManager } from '../src/core/cron-manager.js';
import { LSPManager } from '../src/lsp/client.js';
import { MCPClient } from '../src/mcp/client.js';
import { Sandbox } from '../src/sandbox/executor.js';
import { createSkillManager } from '../src/core/skills.js';
import { createToolRegistry } from '../src/core/tool-registry.js';
import { BuiltInTools } from '../src/tools/builtin.js';
import { progressTracker } from '../src/utils/progress.js';
import type { LLMProviderInterface, LLMResponse, LLMStreamChunk } from '../src/llm/types.js';
import type { Message, Tool } from '../src/types/index.js';

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

function testOnboardingParser(): void {
  const parsed = parseOnboardingInput('我是程序员，主要用来写代码和调试，喜欢专业风格');
  assert.ok(parsed);
  assert.match(parsed?.job || '', /程序员/);
  assert.match(parsed?.purpose || '', /写代码/);
  assert.match(parsed?.preferredStyle || '', /专业/);
}

async function testDirectActionRouter(tempDir: string): Promise<void> {
  const filePath = path.join(tempDir, 'direct.txt');
  await fs.writeFile(filePath, 'direct router works', 'utf-8');

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir] });
  await sandbox.initialize();

  const builtInTools = new BuiltInTools(sandbox, new LSPManager());
  const skillManager = createSkillManager(path.join(tempDir, 'skills-home'));
  await skillManager.initialize();
  await skillManager.loadSkill('hello-skill', path.join(process.cwd(), 'examples', 'skill-hello'));

  const permissionManager = new PermissionManager(path.join(tempDir, 'direct-permissions'));
  await permissionManager.initialize();
  permissionManager.grantPermission('file_read');
  permissionManager.grantPermission('tool_execute');

  const router = createDirectActionRouter({
    builtInTools,
    skillManager,
    permissionManager,
    workspace: process.cwd(),
    config: {},
  });

  const fileReadResult = await router.tryHandle(`读取文件 ${filePath}`);
  assert.equal(fileReadResult?.handled, true);
  assert.equal(fileReadResult?.output, 'direct router works');

  const skillCommandResult = await router.tryHandle('hello Copilot');
  assert.equal(skillCommandResult?.handled, true);
  assert.match(skillCommandResult?.output || '', /Hello, Copilot!/);
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
  });

  await registry.refresh();
  const toolNames = registry.listTools().map(tool => tool.name);

  assert.equal(toolNames.includes('read_file'), true);
  assert.equal(toolNames.includes('hello_world'), true);

  const readResult = await registry.execute('read_file', { path: filePath });
  assert.equal(readResult.output, 'registry read');

  const skillResult = await registry.execute('hello_world', { name: 'Registry' });
  assert.match(skillResult.output || '', /Hello, Registry!/);
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

  await cronManager.runDueJobs(now);
  assert.deepEqual(executed, ['tencent_hot_news']);

  const listedJobs = await tools.executeTool('cron_list', {});
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

function testCliSlashCommandCompletion(): void {
  const cli = new CLI();
  const [matches] = (cli as any).completeInput('/m') as [string[], string];
  const [modelMatches] = (cli as any).completeInput('/model s') as [string[], string];
  const [cronMatches] = (cli as any).completeInput('/cron c') as [string[], string];
  const [mcpMatches] = (cli as any).completeInput('/mcp c') as [string[], string];

  assert.equal(matches.includes('/m'), true);
  assert.equal(matches.includes('/model'), true);
  assert.equal(matches.includes('/memory'), true);
  assert.equal(matches.includes('/mcp'), true);
  assert.equal(modelMatches.includes('/model switch'), true);
  assert.equal(cronMatches.includes('/cron create'), true);
  assert.equal(cronMatches.includes('/cron create-news'), true);
  assert.equal(mcpMatches.includes('/mcp check'), true);
  assert.equal(mcpMatches.includes('/mcp check mempalace'), true);
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

async function testMemPalaceTaskAutoArchive(): Promise<void> {
  const events: Array<{ type: string; content: string; memorySync?: { status: string; detail?: string } }> = [];
  let archivedCall: { serverName: string; toolName: string; args: Record<string, unknown> } | undefined;

  const fakeMcpManager = {
    async listAllTools() {
      return [{
        server: 'mempalace',
        tool: {
          name: 'mempalace_diary_write',
          description: 'Write diary',
          inputSchema: { type: 'object', properties: {} },
        },
      }];
    },
    getClient(name: string) {
      if (name !== 'mempalace') return undefined;
      return {
        getTools() {
          return [{ name: 'mempalace_diary_write' }];
        },
      };
    },
    async callTool(serverName: string, toolName: string, args: Record<string, unknown>) {
      archivedCall = { serverName, toolName, args };
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  };

  const agent = createAgent({
    llm: new StubLLM(),
    mcpManager: fakeMcpManager as any,
    agentRole: 'ai-agent-cli',
  });

  agent.setEventHandler((event) => {
    events.push({
      type: event.type,
      content: event.content,
      memorySync: event.memorySync ? { status: event.memorySync.status, detail: event.memorySync.detail } : undefined,
    });
  });

  const response = await (agent as any).synthesizeResults('实现登录功能', ['[步骤 1] 设计 API\n完成']);

  assert.match(response, /任务完成/);
  assert.equal(archivedCall?.serverName, 'mempalace');
  assert.equal(archivedCall?.toolName, 'mempalace_diary_write');
  assert.match(String(archivedCall?.args?.entry || ''), /TASK:实现登录功能/);
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
    await testToolOutputBackflow(tempDir);
    await testPermissionAskToggle(tempDir);
    testOnboardingParser();
    await testDirectActionRouter(tempDir);
    await testMemoryManagerResume(tempDir);
    await testUnifiedToolRegistry(tempDir);
    await testTaskAndCronTools(tempDir);
    await testMcpClientAcceptsStderrLogs(tempDir);
    testDeepSeekToolMessageSanitization();
    testContextManagerCompressionKeepsToolMessagesValid();
    testCliSlashCommandCompletion();
    testMemPalaceSystemPromptProtocol();
    await testMemPalaceTaskAutoArchive();
    await testCliHistoryPersistence(tempDir);
    await testMemoryPalace(tempDir);
    await testCliLiveProgressDisplay(tempDir);
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