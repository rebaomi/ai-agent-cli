import type { MCPManager, ToolResult as MCPToolResult } from '../mcp/client.js';
import type { Message, MemoryConfig } from '../types/index.js';
import type { EnhancedMemoryManager } from './memory-enhanced.js';
import type { SkillManager } from './skills.js';

export type MemoryLayer = 'session' | 'facts' | 'procedural';

export interface MemoryRecallResult {
  source: 'local' | 'mempalace';
  kind: 'preference' | 'knowledge' | 'project' | 'task' | 'session' | 'external' | 'procedural';
  title: string;
  content: string;
  score: number;
  layer?: MemoryLayer;
  metadata?: Record<string, unknown>;
}

export interface MemoryLayerIndex {
  layer: MemoryLayer;
  title: string;
  items: MemoryRecallResult[];
}

export interface MemoryWriteEntry {
  kind: 'preference' | 'knowledge' | 'project' | 'task' | 'procedural';
  title: string;
  content: string;
  key?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryProvider {
  readonly backend: 'local' | 'mempalace' | 'hybrid';
  recall(query: string, limit?: number): Promise<MemoryRecallResult[]>;
  recallLayers(query: string, limit?: number): Promise<MemoryLayerIndex[]>;
  buildContext(query: string, limit?: number): Promise<string>;
  syncSession(messages: Message[]): Promise<void>;
  store(entry: MemoryWriteEntry): Promise<void>;
}

interface MemoryProviderOptions {
  enhancedMemory: EnhancedMemoryManager;
  mcpManager?: MCPManager;
  config?: MemoryConfig;
  skillManager?: SkillManager;
}

class LocalMemoryProvider implements MemoryProvider {
  readonly backend = 'local' as const;

  constructor(
    private readonly enhancedMemory: EnhancedMemoryManager,
    private readonly skillManager?: SkillManager,
  ) {}

  async recall(query: string, limit = 6): Promise<MemoryRecallResult[]> {
    const layers = await this.recallLayers(query, limit);
    return this.deduplicate(layers.flatMap(layer => layer.items)).slice(0, limit);
  }

  async recallLayers(query: string, limit = 6): Promise<MemoryLayerIndex[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const memory = this.enhancedMemory.getLongTermMemory();
    const sessionItems: MemoryRecallResult[] = [];
    const factItems: MemoryRecallResult[] = [];
    const proceduralItems: MemoryRecallResult[] = [];

    const sessionMessages = this.enhancedMemory.getMessages();
    for (const message of sessionMessages.slice(-20).reverse()) {
      if (!message.content.toLowerCase().includes(normalized)) {
        continue;
      }
      sessionItems.push({
        source: 'local',
        kind: 'session',
        title: `Recent ${message.role}`,
        content: message.content,
        score: 0.9,
        layer: 'session',
        metadata: { role: message.role },
      });
      if (sessionItems.length >= limit) {
        break;
      }
    }

    for (const [key, value] of Object.entries(memory.userPreferences)) {
      const content = typeof value === 'string' ? value : JSON.stringify(value);
      if (`${key} ${content}`.toLowerCase().includes(normalized)) {
        factItems.push({
          source: 'local',
          kind: 'preference',
          title: `Preference · ${key}`,
          content,
          score: 0.95,
          layer: 'facts',
          metadata: { key },
        });
      }
    }

    for (const knowledge of memory.knowledgeBase) {
      if (knowledge.toLowerCase().includes(normalized)) {
        factItems.push({
          source: 'local',
          kind: 'knowledge',
          title: 'Knowledge',
          content: knowledge,
          score: 0.9,
          layer: 'facts',
        });
      }
    }

    for (const [key, value] of Object.entries(memory.projectContext)) {
      const content = typeof value === 'string' ? value : JSON.stringify(value);
      if (`${key} ${content}`.toLowerCase().includes(normalized)) {
        factItems.push({
          source: 'local',
          kind: 'project',
          title: `Project · ${key}`,
          content,
          score: 0.88,
          layer: 'facts',
          metadata: { key },
        });
      }
    }

    for (const task of memory.taskHistory) {
      const taskText = [task.description, task.currentStep, task.result, task.error]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (taskText.includes(normalized)) {
        factItems.push({
          source: 'local',
          kind: 'task',
          title: task.description,
          content: [
            `status=${task.status}`,
            task.currentStep ? `currentStep=${task.currentStep}` : undefined,
            task.result ? `result=${task.result}` : undefined,
            task.error ? `error=${task.error}` : undefined,
          ].filter(Boolean).join('\n'),
          score: task.status === 'in_progress' ? 0.92 : 0.84,
          layer: 'facts',
          metadata: { taskId: task.taskId, progress: task.progress },
        });
      }
    }

    for (const item of this.enhancedMemory.searchMemoryPalace(query).slice(0, limit)) {
      const layer: MemoryLayer = item.zone === 'tasks' || item.zone === 'archive'
        ? 'facts'
        : item.zone === 'knowledge' || item.zone === 'project' || item.zone === 'identity'
          ? 'facts'
          : 'session';
      factItems.push({
        source: 'local',
        kind: item.zone === 'knowledge' ? 'knowledge' : item.zone === 'project' ? 'project' : item.zone === 'tasks' ? 'task' : 'session',
        title: item.title,
        content: item.content,
        score: 0.8,
        layer,
        metadata: { zone: item.zone, tags: item.tags },
      });
    }

    if (this.skillManager) {
      const candidates = await this.skillManager.searchSkillCandidates(query, limit);
      for (const candidate of candidates) {
        proceduralItems.push({
          source: 'local',
          kind: 'procedural',
          title: `Candidate Skill · ${candidate.name}`,
          content: [candidate.description, candidate.whenToUse, ...candidate.procedureSteps.slice(0, 3)].filter(Boolean).join('\n'),
          score: Math.min(0.99, candidate.score),
          layer: 'procedural',
          metadata: {
            path: candidate.path,
            confidence: candidate.confidence,
            tags: candidate.tags,
            procedureSteps: candidate.procedureSteps,
          },
        });
      }
    }

    const layers: MemoryLayerIndex[] = [
      { layer: 'session', title: '会话记忆', items: this.deduplicate(sessionItems).slice(0, Math.max(2, Math.ceil(limit / 3))) },
      { layer: 'facts', title: '长期事实', items: this.deduplicate(factItems).slice(0, Math.max(2, Math.ceil(limit / 2))) },
      { layer: 'procedural', title: 'Procedural Skill', items: this.deduplicate(proceduralItems).slice(0, Math.max(2, Math.ceil(limit / 3))) },
    ];

    return layers.filter(layer => layer.items.length > 0);
  }

  async buildContext(query: string, limit = 6): Promise<string> {
    const layers = await this.recallLayers(query, limit);
    if (layers.length === 0) {
      return this.buildBaselineContext();
    }

    const baseline = this.buildBaselineContext();
    const layerLines = layers.flatMap(layer => [
      `${layer.title}:`,
      ...layer.items.map((item, index) => `${index + 1}. [${item.source}/${item.kind}] ${item.title}: ${item.content}`),
    ]);
    return [baseline, '三层记忆索引:', ...layerLines].filter(Boolean).join('\n');
  }

  async syncSession(messages: Message[]): Promise<void> {
    this.enhancedMemory.setMessages(messages);
  }

  async store(entry: MemoryWriteEntry): Promise<void> {
    switch (entry.kind) {
      case 'preference':
        this.enhancedMemory.setUserPreference(entry.key || entry.title, entry.content);
        break;
      case 'project':
        this.enhancedMemory.setProjectContext(entry.key || entry.title, entry.content);
        break;
      case 'knowledge':
        this.enhancedMemory.addToKnowledgeBase(entry.content);
        break;
      case 'task':
        this.enhancedMemory.setProjectContext(`task:${entry.title}`, {
          summary: entry.content,
          ...entry.metadata,
        });
        break;
      case 'procedural':
        this.enhancedMemory.setProjectContext(`procedural:${entry.title}`, {
          summary: entry.content,
          ...entry.metadata,
        });
        break;
    }
  }

  private buildBaselineContext(): string {
    const memory = this.enhancedMemory.getLongTermMemory();
    const baselineParts: string[] = [];
    const shared = this.enhancedMemory.getSharedContext();
    if (shared) {
      baselineParts.push(`已知长期记忆:\n${shared}`);
    }

    const artifactOutputDir = memory.projectContext.artifact_output_dir;
    if (typeof artifactOutputDir === 'string' && artifactOutputDir.trim()) {
      baselineParts.push(`固定 artifact 输出目录: ${artifactOutputDir.trim()}`);
    }

    for (const [label, key] of [
      ['最近一次输出文件', 'last_output_file'],
      ['最近一次 Word 输出', 'last_docx_output_file'],
      ['最近一次 PDF 输出', 'last_pdf_output_file'],
      ['最近一次表格输出', 'last_xlsx_output_file'],
      ['最近一次 CSV 输出', 'last_csv_output_file'],
      ['最近一次 TSV 输出', 'last_tsv_output_file'],
      ['最近一次演示文稿输出', 'last_pptx_output_file'],
      ['最近一次文本输出', 'last_txt_output_file'],
      ['最近一次 Markdown 输出', 'last_md_output_file'],
    ] as const) {
      const value = memory.projectContext[key];
      if (typeof value === 'string' && value.trim()) {
        baselineParts.push(`${label}: ${value.trim()}`);
      }
    }

    const recentCompletedTasks = memory.taskHistory
      .filter(task => task.status === 'completed' || task.status === 'partial' || task.status === 'failed')
      .slice(-3)
      .reverse()
      .map(task => [
        `${task.description}`,
        `status=${task.status}`,
        task.result ? `result=${task.result}` : undefined,
        task.error ? `error=${task.error}` : undefined,
      ].filter(Boolean).join(' | '));

    if (recentCompletedTasks.length > 0) {
      baselineParts.push(`最近任务结果:\n${recentCompletedTasks.map((item, index) => `${index + 1}. ${item}`).join('\n')}`);
    }

    return baselineParts.join('\n');
  }

  private deduplicate(results: MemoryRecallResult[]): MemoryRecallResult[] {
    const seen = new Set<string>();
    return results
      .sort((left, right) => right.score - left.score)
      .filter(result => {
        const key = `${result.kind}:${result.title}:${result.content}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  }
}

class MemPalaceMemoryProvider implements MemoryProvider {
  readonly backend = 'mempalace' as const;

  constructor(
    private readonly mcpManager: MCPManager,
    private readonly localFallback: LocalMemoryProvider,
  ) {}

  async recall(query: string, limit = 6): Promise<MemoryRecallResult[]> {
    const client = this.mcpManager.getClient('mempalace');
    if (!client) {
      return [];
    }

    const available = new Set(client.getTools().map(tool => tool.name));
    const results: MemoryRecallResult[] = [];

    if (available.has('mempalace_search')) {
      const search = await this.tryToolCalls('mempalace_search', [
        { query, limit },
        { query, top_k: limit },
        { q: query, top_k: limit },
      ]);
      results.push(...this.parseToolResult('external', search, 0.86));
    }

    if (available.has('mempalace_kg_query')) {
      const kg = await this.tryToolCalls('mempalace_kg_query', [
        { query },
        { q: query },
        { text: query },
      ]);
      results.push(...this.parseToolResult('knowledge', kg, 0.89));
    }

    return results.slice(0, limit);
  }

  async recallLayers(query: string, limit = 6): Promise<MemoryLayerIndex[]> {
    const results = await this.recall(query, limit);
    return results.length > 0
      ? [{ layer: 'facts', title: '长期事实', items: results.map(item => ({ ...item, layer: 'facts' })) }]
      : [];
  }

  async buildContext(query: string, limit = 6): Promise<string> {
    const layers = await this.recallLayers(query, limit);
    if (layers.length === 0) {
      return '';
    }

    return layers.flatMap(layer => [
      `${layer.title}:`,
      ...layer.items.map((item, index) => `${index + 1}. [${item.kind}] ${item.title}: ${item.content}`),
    ]).join('\n');
  }

  async syncSession(_messages: Message[]): Promise<void> {
    return;
  }

  async store(entry: MemoryWriteEntry): Promise<void> {
    const client = this.mcpManager.getClient('mempalace');
    if (!client) {
      return;
    }

    const tools = new Set(client.getTools().map(tool => tool.name));
    if (entry.kind === 'task' && tools.has('mempalace_diary_write')) {
      await this.tryToolCalls('mempalace_diary_write', [{
        agent_name: 'ai-agent-cli',
        topic: entry.title,
        entry: entry.content,
      }]);
      return;
    }

    if (entry.kind === 'knowledge' && tools.has('mempalace_add_drawer')) {
      await this.tryToolCalls('mempalace_add_drawer', [
        { title: entry.title, content: entry.content },
        { name: entry.title, content: entry.content },
      ]);
    }
  }

  private async tryToolCalls(toolName: string, candidates: Array<Record<string, unknown>>): Promise<MCPToolResult | undefined> {
    for (const candidate of candidates) {
      try {
        return await this.mcpManager.callTool('mempalace', toolName, candidate);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private parseToolResult(kind: MemoryRecallResult['kind'], result: MCPToolResult | undefined, score: number): MemoryRecallResult[] {
    if (!result?.content) {
      return [];
    }

    const texts = result.content
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text || '')
      .map(text => text.trim())
      .filter(Boolean);

    return texts.slice(0, 6).map((text, index) => ({
      source: 'mempalace',
      kind,
      title: `MemPalace #${index + 1}`,
      content: text,
      score: score - index * 0.01,
    }));
  }
}

class HybridMemoryProvider implements MemoryProvider {
  readonly backend = 'hybrid' as const;

  constructor(
    private readonly localProvider: LocalMemoryProvider,
    private readonly mempalaceProvider?: MemPalaceMemoryProvider,
  ) {}

  async recall(query: string, limit = 6): Promise<MemoryRecallResult[]> {
    const [localResults, mempalaceResults] = await Promise.all([
      this.localProvider.recall(query, limit),
      this.mempalaceProvider?.recall(query, limit) ?? Promise.resolve([]),
    ]);

    const merged = [...localResults, ...mempalaceResults]
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);

    return merged;
  }

  async recallLayers(query: string, limit = 6): Promise<MemoryLayerIndex[]> {
    const [localLayers, mempalaceLayers] = await Promise.all([
      this.localProvider.recallLayers(query, limit),
      this.mempalaceProvider?.recallLayers(query, limit) ?? Promise.resolve([]),
    ]);

    const merged = new Map<MemoryLayer, MemoryLayerIndex>();
    for (const layer of [...localLayers, ...mempalaceLayers]) {
      const existing = merged.get(layer.layer);
      if (!existing) {
        merged.set(layer.layer, { ...layer, items: [...layer.items] });
        continue;
      }

      existing.items.push(...layer.items);
      existing.items = existing.items.sort((left, right) => right.score - left.score).slice(0, limit);
    }

    return Array.from(merged.values());
  }

  async buildContext(query: string, limit = 6): Promise<string> {
    const layers = await this.recallLayers(query, limit);
    if (layers.length === 0) {
      return '';
    }

    return ['三层记忆索引:', ...layers.flatMap(layer => [
      `${layer.title}:`,
      ...layer.items.map((item, index) => `${index + 1}. [${item.source}/${item.kind}] ${item.title}: ${item.content}`),
    ])].join('\n');
  }

  async syncSession(messages: Message[]): Promise<void> {
    await this.localProvider.syncSession(messages);
  }

  async store(entry: MemoryWriteEntry): Promise<void> {
    await this.localProvider.store(entry);
    if (this.mempalaceProvider) {
      await this.mempalaceProvider.store(entry);
    }
  }
}

export function createMemoryProvider(options: MemoryProviderOptions): MemoryProvider {
  const backend = options.config?.backend || 'hybrid';
  const localProvider = new LocalMemoryProvider(options.enhancedMemory, options.skillManager);

  if (backend === 'local' || !options.mcpManager) {
    return localProvider;
  }

  const mempalaceProvider = new MemPalaceMemoryProvider(options.mcpManager, localProvider);

  if (backend === 'mempalace') {
    return mempalaceProvider;
  }

  return new HybridMemoryProvider(localProvider, mempalaceProvider);
}
