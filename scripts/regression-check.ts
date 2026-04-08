import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseOnboardingInput } from '../src/core/onboarding.js';
import { CLI } from '../src/cli/index.js';
import { createAgent } from '../src/core/agent.js';
import { createDirectActionRouter } from '../src/core/direct-action-router.js';
import { createContextManager } from '../src/core/context-manager.js';
import { createPlanner } from '../src/core/planner.js';
import { createEnhancedMemoryManager } from '../src/core/memory-enhanced.js';
import { createMemoryManager } from '../src/core/memory.js';
import { PermissionManager } from '../src/core/permission-manager.js';
import { createTaskManager } from '../src/core/task-manager.js';
import { createCronManager } from '../src/core/cron-manager.js';
import { LSPManager } from '../src/lsp/client.js';
import { MCPClient } from '../src/mcp/client.js';
import { TOOL_DEFINITIONS, buildLarkCliArgs } from '../src/mcp/lark-bridge.js';
import { Sandbox } from '../src/sandbox/executor.js';
import { createSkillManager } from '../src/core/skills.js';
import { createToolRegistry } from '../src/core/tool-registry.js';
import { createMemoryProvider } from '../src/core/memory-provider.js';
import { BuiltInTools } from '../src/tools/builtin.js';
import { progressTracker } from '../src/utils/progress.js';
import { getArtifactOutputDir, getDesktopPath, resolveOutputPath, resolveUserPath } from '../src/utils/path-resolution.js';
import { detectRequestedExportFormat, selectPreferredExportTool } from '../src/core/export-intent.js';
import { buildFallbackIntentContract } from '../src/core/tool-intent-contract.js';
import { validateToolCallsAgainstContract } from '../src/core/tool-call-validator.js';
import type { LLMProviderInterface, LLMResponse, LLMStreamChunk } from '../src/llm/types.js';
import type { Message, Tool, ToolCall } from '../src/types/index.js';

process.env.AI_AGENT_CLI_QUIET_SKILL_LOGS = '1';

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

function testOnboardingParser(): void {
  const parsed = parseOnboardingInput('我是程序员，主要用来写代码和调试，喜欢专业风格');
  assert.ok(parsed);
  assert.match(parsed?.job || '', /程序员/);
  assert.match(parsed?.purpose || '', /写代码/);
  assert.match(parsed?.preferredStyle || '', /专业/);
}

async function testDirectActionRouter(tempDir: string): Promise<void> {
  const filePath = path.join(tempDir, 'direct.txt');
  const mdFilePath = path.join(tempDir, 'notes.md');
  const docxFilePath = path.join(tempDir, 'legacy.docx');
  const firstFilePath = path.join(tempDir, 'first.ts');
  const secondFilePath = path.join(tempDir, 'second.ts');
  const searchFilePath = path.join(tempDir, 'search-target.ts');
  const artifactDir = path.join(tempDir, 'artifacts');
  await fs.writeFile(filePath, 'direct router works', 'utf-8');
  await fs.writeFile(mdFilePath, '# Notes\n\n这是 markdown 源文件。', 'utf-8');
  await fs.writeFile(docxFilePath, 'legacy docx placeholder', 'utf-8');
  await fs.writeFile(firstFilePath, 'export const first = 1;', 'utf-8');
  await fs.writeFile(secondFilePath, 'export const second = 2;', 'utf-8');
  await fs.writeFile(searchFilePath, 'const createDirectActionRouter = true;', 'utf-8');

  const sandbox = new Sandbox({ enabled: true, allowedPaths: [tempDir, artifactDir] });
  await sandbox.initialize();

  const builtInTools = new BuiltInTools(sandbox, new LSPManager(), {
    workspace: tempDir,
    config: { artifactOutputDir: artifactDir },
  });
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
          await fs.writeFile(target, 'DOCX FILE\n' + String(args.text || ''), 'utf-8');
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
  permissionManager.grantPermission('tool_execute');

  const router = createDirectActionRouter({
    builtInTools,
    skillManager,
    permissionManager,
    workspace: process.cwd(),
    config: { artifactOutputDir: artifactDir },
    getConversationMessages: () => [
      { role: 'user', content: '帮我写个短视频脚本' },
      { role: 'assistant', content: '这是刚生成的短视频脚本正文。' },
    ],
  });

  const fileReadResult = await router.tryHandle(`读取文件 ${filePath}`);
  assert.equal(fileReadResult?.handled, true);
  assert.equal(fileReadResult?.output, 'direct router works');

  const multiReadResult = await router.tryHandle(`读取 ${firstFilePath} 和 ${secondFilePath}`);
  assert.equal(multiReadResult?.handled, true);
  assert.match(multiReadResult?.output || '', /first\.ts/);
  assert.match(multiReadResult?.output || '', /second\.ts/);

  const searchResult = await router.tryHandle(`在 ${tempDir} 中搜索 createDirectActionRouter`);
  assert.equal(searchResult?.handled, true);
  assert.match(searchResult?.output || '', /search-target\.ts/);

  const globResult = await router.tryHandle(`查找所有 ts 文件 在 ${tempDir}`);
  assert.equal(globResult?.handled, true);
  assert.match(globResult?.output || '', /first\.ts/);
  assert.match(globResult?.output || '', /second\.ts/);

  const markdownSaveResult = await router.tryHandle('把内容保存成markdown文件，文件名叫 notes，内容是 今日完成接口联调');
  assert.equal(markdownSaveResult?.handled, true);
  assert.match(markdownSaveResult?.output || '', /notes\.md/);
  assert.equal(await fs.readFile(path.join(artifactDir, 'notes.md'), 'utf-8'), '今日完成接口联调');

  const skillCommandResult = await router.tryHandle('hello Copilot');
  assert.equal(skillCommandResult?.handled, true);
  assert.match(skillCommandResult?.output || '', /Hello, Copilot!/);

  const saveWordResult = await router.tryHandle('把刚刚的内容保存成word文档，放到桌面');
  assert.equal(saveWordResult?.handled, true);
  assert.equal(saveWordResult?.isError, undefined);
  assert.match(saveWordResult?.output || '', /DOCX:桌面[\\/]exported-document\.docx:这是刚生成的短视频脚本正文。/);

  const savePdfResult = await router.tryHandle('把刚刚的内容保存成pdf');
  assert.equal(savePdfResult?.handled, true);
  assert.equal(savePdfResult?.isError, undefined);
  assert.match(savePdfResult?.output || '', /PDF:exported-document\.pdf:这是刚生成的短视频脚本正文。/);

  const inlineDocxResult = await router.tryHandle('生成word文档，文件名叫 brief，内容是 这是一段内联正文');
  assert.equal(inlineDocxResult?.handled, true);
  assert.match(inlineDocxResult?.output || '', /DOCX:brief\.docx:这是一段内联正文/);
  assert.equal(await fs.readFile(path.join(artifactDir, 'brief.docx'), 'utf-8'), 'DOCX FILE\n这是一段内联正文');

  const markdownFileDocxResult = await router.tryHandle(`把 ${mdFilePath} 转成word文档`);
  assert.equal(markdownFileDocxResult?.handled, true);
  assert.match(markdownFileDocxResult?.output || '', /DOCX:notes\.docx:# Notes/);
  assert.match(await fs.readFile(path.join(artifactDir, 'notes.docx'), 'utf-8'), /PDF FILE|DOCX FILE/);

  const markdownFilePdfResult = await router.tryHandle(`把 ${mdFilePath} 转成pdf`);
  assert.equal(markdownFilePdfResult?.handled, true);
  assert.match(markdownFilePdfResult?.output || '', /PDF:notes\.pdf:# Notes/);
  assert.match(await fs.readFile(path.join(artifactDir, 'notes.pdf'), 'utf-8'), /PDF FILE/);

  const markdownFileTxtResult = await router.tryHandle(`把 ${mdFilePath} 转成txt`);
  assert.equal(markdownFileTxtResult?.handled, true);
  assert.match(markdownFileTxtResult?.output || '', /notes\.txt/);
  assert.match(await fs.readFile(path.join(artifactDir, 'notes.txt'), 'utf-8'), /# Notes/);

  const explicitDirPdfResult = await router.tryHandle(`把 ${mdFilePath} 转成pdf，存进 ${artifactDir} 文件夹内`);
  assert.equal(explicitDirPdfResult?.handled, true);
  assert.match(explicitDirPdfResult?.output || '', /PDF:/);
  assert.match(await fs.readFile(path.join(artifactDir, 'notes.pdf'), 'utf-8'), /PDF FILE/);

  const xlsxResult = await router.tryHandle('把刚刚的内容保存成xlsx');
  assert.equal(xlsxResult?.handled, true);
  assert.equal(xlsxResult?.isError, true);
  assert.match(xlsxResult?.output || '', /XLSX/);
  assert.match(xlsxResult?.output || '', /降级方案/);

  const pptxResult = await router.tryHandle('把刚刚的内容保存成ppt');
  assert.equal(pptxResult?.handled, true);
  assert.equal(pptxResult?.isError, true);
  assert.match(pptxResult?.output || '', /PPT/);
  assert.match(pptxResult?.output || '', /降级方案/);

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

  const unavailableDocxResult = await router.tryHandle('把刚刚的内容保存成word文档');
  assert.equal(unavailableDocxResult?.handled, true);
  assert.equal(unavailableDocxResult?.isError, true);
  assert.match(unavailableDocxResult?.output || '', /这是(?:已知|当前)能力缺口/);
  assert.match(unavailableDocxResult?.output || '', /无可用 docx skill/i);
  assert.doesNotMatch(unavailableDocxResult?.output || '', /Skill tool error:/);
}

async function testNestedSkillDirectoryDiscovery(tempDir: string): Promise<void> {
  const homeDir = path.join(tempDir, 'home');
  const nestedSkillDir = path.join(homeDir, '.agents', 'skills', 'minimax-skills', 'minimax-docx');
  await fs.mkdir(nestedSkillDir, { recursive: true });
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

  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;

  try {
    const manager = createSkillManager(path.join(tempDir, 'skills-home'));
    await manager.initialize();

    const skill = manager.getSkill('minimax-docx');
    const skills = await manager.listSkills();

    assert.ok(skill);
    assert.equal(skill?.description, 'Create and edit docx files');
    assert.match(manager.getSkillContent('minimax-docx') || '', /DOCX workflow instructions/);
    assert.equal(skills.some(item => item.name === 'minimax-docx' && item.enabled), true);
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
  const docxResult = await registry.execute('txt_to_docx', { output: 'demo.docx', text: 'demo' });
  assert.equal(docxResult.is_error, true);
  assert.match(docxResult.output || '', /无可用 docx skill/i);
  assert.doesNotMatch(docxResult.output || '', /Skill tool error:/);
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
  assert.match(summary, /任务规划已创建/);
  assert.equal(agent.getMessages().some(message => message.role === 'assistant' && message.content.includes('任务规划已创建')), true);

  const executionResult = await agent.confirmAction(true);
  assert.match(executionResult || '', /任务完成/);

  const messages = agent.getMessages();
  assert.equal(messages.some(message => message.role === 'user' && message.content === '是'), true);
  assert.equal(messages.some(message => message.role === 'assistant' && message.content.includes('## ✅ 任务完成')), true);
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
  const [newsMatches] = (cli as any).completeInput('/news ') as [string[], string];
  const [newsSaveMatches] = (cli as any).completeInput('/news s') as [string[], string];
  const [newsOutputMatches] = (cli as any).completeInput('/news o') as [string[], string];

  assert.equal(matches.includes('/m'), true);
  assert.equal(matches.includes('/model'), true);
  assert.equal(matches.includes('/memory'), true);
  assert.equal(matches.includes('/mcp'), true);
  assert.equal(modelMatches.includes('/model switch'), true);
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
}

async function testGreetingDoesNotTriggerPlanning(): Promise<void> {
  const agent = createAgent({
    llm: new StubLLM(),
  }) as any;

  const simpleGreeting = await agent.detectComplexTask('你好');
  const negativeResponse = await agent.detectComplexTask('hello');

  assert.equal(simpleGreeting, false);
  assert.equal(negativeResponse, false);
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

function testSharedExportIntentRules(): void {
  assert.equal(detectRequestedExportFormat('把 notes.md 转成 pdf', ['docx', 'pdf', 'md', 'txt']), 'pdf');
  assert.equal(detectRequestedExportFormat('把 summary.txt 保存成 word 文档', ['docx', 'pdf', 'md', 'txt']), 'docx');
  assert.equal(buildFallbackIntentContract('把讲义改成ppt文件', []).targetFormat, 'pptx');
  assert.equal(detectRequestedExportFormat('创建说明文档，指导如何将PDF转换为PPT格式', ['docx', 'pdf', 'md', 'txt', 'pptx']), null);
  assert.equal(selectPreferredExportTool('pdf', ['txt_to_docx', 'txt_to_pdf']), 'txt_to_pdf');
  assert.equal(selectPreferredExportTool('docx', ['txt_to_docx', 'txt_to_pdf']), 'txt_to_docx');
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

  const pptValidation = validateToolCallsAgainstContract(pptContract, [pdfToolCall], ['txt_to_pdf']);
  assert.equal(pptValidation.toolCalls.length, 0);
  assert.equal(pptValidation.rejections.length, 1);
  assert.match(pptValidation.rejections[0]?.reason || '', /PPT/);

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
  assert.equal(plan.steps[1]?.toolCalls?.[0]?.name, 'txt_to_docx');
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
  assert.equal(pdfPlan.steps[0]?.toolCalls?.[0]?.name, 'txt_to_pdf');
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
              "name": "txt_to_docx",
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
  assert.equal(correctedPdfPlan.steps[0]?.toolCalls?.[0]?.name, 'txt_to_pdf');
  assert.equal(correctedPdfPlan.steps[0]?.toolCalls?.[0]?.args.out, '$ARTIFACT_OUTPUT_DIR/notes.pdf');

  const correctedTxtPdfPlan = await correctedPdfPlanner.createPlan('把 summary.txt 转成 pdf');
  assert.equal(correctedTxtPdfPlan.steps[0]?.toolCalls?.[0]?.name, 'txt_to_pdf');
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

async function testAgentSkillCandidateSelfReview(): Promise<void> {
  const agent = createAgent({
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
  }) as any;

  const refinement = await agent.assessSkillCandidateDraft(
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
    2,
  );

  assert.equal(refinement?.shouldCreate, true);
  assert.equal(refinement?.confidence, 0.87);
  assert.equal(refinement?.procedure?.[1], '抽象稳定步骤');
}

async function testLearningTodoCreatedFromFailedPlan(tempDir: string): Promise<void> {
  const skillManager = createSkillManager(path.join(tempDir, 'todo-skills'));
  await skillManager.initialize();

  const agent = createAgent({
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
  }) as any;

  await agent.maybeCaptureLearningTodo(
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

  const response = await (agent as any).synthesizeResults('实现登录功能', ['[步骤 1] 设计 API\n完成']);

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
    await testToolOutputBackflow(tempDir);
    await testPermissionAskToggle(tempDir);
    await testSandboxAllowedPathNormalization(tempDir);
    testOnboardingParser();
    await testDirectActionRouter(tempDir);
    await testNestedSkillDirectoryDiscovery(tempDir);
    await testCrLfMarkdownOnlySkillLoads(tempDir);
    await testMarkdownOnlySkillDescriptionCleanup(tempDir);
    await testPlannerProducesConcreteToolCalls();
    await testLearnedSkillCandidateLifecycle(tempDir);
    await testMemoryManagerResume(tempDir);
    await testUnifiedToolRegistry(tempDir);
    await testHybridMemoryProviderRecall(tempDir);
    await testMemoryProviderBuildsThreeLayerContext(tempDir);
    testAgentRuntimeMemoryContextInjection();
    await testArtifactPathResolution(tempDir);
    await testBuiltInToolsArtifactOutput(tempDir);
    await testMemoryProviderBaselineIncludesArtifactHints(tempDir);
    await testTaskAndCronTools(tempDir);
    await testMcpClientAcceptsStderrLogs(tempDir);
    await testPlanConfirmationPersistsConversationContext();
    testLarkBridgeToolDefinitions();
    testLarkBridgeArgumentBuilding();
    testDeepSeekToolMessageSanitization();
    testContextManagerCompressionKeepsToolMessagesValid();
    testCliSlashCommandCompletion();
    testMemPalaceSystemPromptProtocol();
    await testGreetingDoesNotTriggerPlanning();
    testDefaultPromptEncouragesDirectPaths();
    testSharedExportIntentRules();
    testGenericToolCallValidator();
    await testPlannerPrefersProceduralCandidate(tempDir);
    testPlannedToolArgPlaceholderResolution();
    await testDirectToolCallPlaceholderResolution();
    await testAgentStoresArtifactOutputInMemory();
    await testAgentSkillCandidateSelfReview();
    await testLearningTodoCreatedFromFailedPlan(tempDir);
    await testLearningTodoCanSeedCandidate(tempDir);
    await testAgentKnownGapNotice(tempDir);
    await testAgentIntentContractRejectsMismatchedTool();
    await testFailedPlanReturnsFailureSummary();
    testGenericPlanDetection();
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