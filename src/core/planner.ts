import type { Message } from '../types/index.js';
import type { LLMProviderInterface } from '../llm/types.js';
import type { MemoryProvider } from './memory-provider.js';
import { detectRequestedExportFormat, isDocxExportTool, isPdfExportTool, retargetExportPath } from './export-intent.js';

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface Plan {
  id: string;
  originalTask: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  neededSkills?: string[];
}

export interface PlannerOptions {
  llm: LLMProviderInterface;
  maxSteps?: number;
  memoryProvider?: MemoryProvider;
  skillManager?: {
    searchSkillCandidates?: (query: string, limit?: number) => Promise<Array<{
      name: string;
      description: string;
      score: number;
      confidence?: number;
      whenToUse: string;
      procedureSteps: string[];
      verification: string[];
      tags?: string[];
    }>>;
  };
}

interface RawPlanToolCall {
  name?: string;
  args?: Record<string, unknown>;
}

interface RawPlanStep {
  id?: string;
  description?: string;
  tool?: string | null;
  args?: Record<string, unknown>;
  toolCalls?: RawPlanToolCall[];
}

interface RawPlanResponse {
  task?: string;
  steps: RawPlanStep[];
  neededSkills?: string[];
}

const PLANNER_PROMPT = `你是一个任务规划专家。当用户提出复杂任务时，你需要：

1. 分析任务需求
2. 将任务拆分成清晰的步骤
3. 确定每个步骤需要的工具或操作

请用 JSON 格式返回任务规划：
{
  "task": "原任务描述",
  "steps": [
    {
      "id": "step_1",
      "description": "步骤1描述",
      "toolCalls": [
        {
          "name": "需要的工具名",
          "args": { "工具参数": "具体值" }
        }
      ]
    }
  ],
  "neededSkills": ["需要的skill名称，如lark-sheets、pdf、docx、xlsx、pptx等"]
}

规则：
- 步骤数量控制在 3-8 个之间
- 每个步骤描述要清晰具体
- 能确定工具时，优先为每一步填 toolCalls，尽量不要留空
- toolCalls 允许一个步骤包含多个顺序执行的工具
- 对常见任务优先产出具体工具和参数：搜索文本用 search_files，查找某类文件用 glob，读取多个明确文件用 read_multiple_files，保存 txt/md 用 write_file，目标是 Word/docx 时优先用 docx_create_from_text，目标是 PDF 时优先用 pdf_create_from_text，XLSX/PPTX 同理优先用 xlsx_create_from_text、pptx_create_from_text
- 选择导出工具时只看目标格式，不要因为源文件是 .md、.txt 或 .docx 就选错工具
- 如果需要引用运行时内容，可使用占位符：$WORKSPACE、$ARTIFACT_OUTPUT_DIR、$LAST_ASSISTANT_TEXT
- 如果任务是“根据新闻内容分析公司/行业并识别相关股票”，必须先从新闻正文或 $LAST_ASSISTANT_TEXT 中提取明确的公司名、品牌名、机构名、行业词，再围绕这些实体生成具体搜索步骤；不要直接生成“热点新闻相关股票分析”这类泛化 web_search 查询
- 只返回 JSON，不要其他内容
- 如果任务需要操作飞书表格、生成PDF、处理Excel、分析图片等，需要在neededSkills中列出相应的skill名称`;

export class Planner {
  private llm: LLMProviderInterface;
  private maxSteps: number;
  private currentPlan?: Plan;
  private memoryProvider?: MemoryProvider;
  private skillManager?: PlannerOptions['skillManager'];

  constructor(options: PlannerOptions) {
    this.llm = options.llm;
    this.maxSteps = options.maxSteps ?? 10;
    this.memoryProvider = options.memoryProvider;
    this.skillManager = options.skillManager;
  }

  async createPlan(task: string): Promise<Plan> {
    const planId = `plan_${Date.now()}`;
    
    this.currentPlan = {
      id: planId,
      originalTask: task,
      steps: [],
      currentStepIndex: 0,
      status: 'planning',
    };

    try {
      const proceduralCandidates = await this.lookupProceduralCandidates(task);
      const candidatePlan = this.buildPlanFromCandidate(task, proceduralCandidates[0]);
      if (candidatePlan) {
        this.currentPlan.steps = candidatePlan.steps;
        this.currentPlan.neededSkills = proceduralCandidates[0]?.score ? [proceduralCandidates[0].name] : undefined;
        return this.currentPlan;
      }

      const proceduralContext = this.buildProceduralContext(proceduralCandidates);
      const memoryContext = await this.buildMemoryPlanningContext(task);
      const response = await this.llm.generate([
        { role: 'system', content: [PLANNER_PROMPT, proceduralContext, memoryContext].filter(Boolean).join('\n\n') },
        { role: 'user', content: `请规划这个任务：${task}` }
      ]);

      const planData = this.parsePlanResponse(response);
      
      if (planData && planData.steps) {
        this.currentPlan.steps = planData.steps.map((step: RawPlanStep, index: number) => {
          const toolCalls = this.normalizeStepToolCalls(task, step);
          return {
            id: step.id || `step_${index + 1}`,
            description: step.description || '',
            status: 'pending' as const,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          };
        });
        
        if (planData.neededSkills) {
          this.currentPlan.neededSkills = planData.neededSkills;
        }
      }

      return this.currentPlan;
    } catch (error) {
      this.currentPlan.status = 'failed';
      throw error;
    }
  }

  private parsePlanResponse(response: string): RawPlanResponse | null {
    const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```|(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1] ?? jsonMatch[2] ?? '';
        if (!jsonStr) return this.parseSimplePlan(response);
        return JSON.parse(jsonStr);
      } catch {
        return this.parseSimplePlan(response);
      }
    }
    return this.parseSimplePlan(response);
  }

  private parseSimplePlan(response: string): RawPlanResponse {
    const lines = response.split('\n').filter((line: string) => line.trim());
    const steps: RawPlanStep[] = [];
    
    let stepCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-') || trimmed.match(/^\d+[\.\)]/)) {
        stepCount++;
        const desc = trimmed.replace(/^-\s*|^\d+[\.\)]\s*/, '');
        steps.push({
          id: `step_${stepCount}`,
          description: desc,
        });
      }
    }

    if (steps.length === 0) {
      steps.push({
        id: 'step_1',
        description: response.slice(0, 200),
      });
    }

    return { steps };
  }

  private normalizeStepToolCalls(task: string, step: RawPlanStep): Array<{ name: string; args: Record<string, unknown> }> {
    const explicit = Array.isArray(step.toolCalls)
      ? step.toolCalls
          .filter((toolCall): toolCall is RawPlanToolCall => !!toolCall?.name)
          .map(toolCall => this.normalizePlannedToolCall(task, step.description || '', {
            name: toolCall.name as string,
            args: this.normalizeArgs(toolCall.args),
          }))
          .filter((toolCall): toolCall is { name: string; args: Record<string, unknown> } => !!toolCall)
      : [];

    if (explicit.length > 0) {
      return explicit;
    }

    if (step.tool) {
      const normalized = this.normalizePlannedToolCall(task, step.description || '', { name: step.tool, args: this.normalizeArgs(step.args) });
      return normalized ? [normalized] : [];
    }

    return this.inferToolCallsFromText(task, step.description || '');
  }

  private normalizeArgs(args: Record<string, unknown> | undefined): Record<string, unknown> {
    return args && typeof args === 'object' ? args : {};
  }

  private normalizePlannedToolCall(
    task: string,
    description: string,
    toolCall: { name: string; args: Record<string, unknown> },
  ): { name: string; args: Record<string, unknown> } | null {
    if (/^repl$/i.test(toolCall.name) && !this.isLikelyReplCode(toolCall.args.code)) {
      return null;
    }

    const requestedFormat = detectRequestedExportFormat([
      task,
      description,
      typeof toolCall.args.output === 'string' ? toolCall.args.output : '',
      typeof toolCall.args.out === 'string' ? toolCall.args.out : '',
    ].filter(Boolean).join('\n'));

    if (requestedFormat === 'pdf' && isDocxExportTool(toolCall.name)) {
      const fileName = this.extractRequestedFileName(`${task}\n${description}`) || 'exported-document';
      const outputPath = retargetExportPath(toolCall.args.out ?? toolCall.args.output, '.pdf')
        || `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.pdf')}`;
      return {
        name: 'pdf_create_from_text',
        args: {
          out: outputPath,
          text: toolCall.args.text ?? '$LAST_ASSISTANT_TEXT',
          title: typeof toolCall.args.title === 'string' ? toolCall.args.title : this.toTitle(fileName),
        },
      };
    }

    if (requestedFormat === 'docx' && isPdfExportTool(toolCall.name)) {
      const fileName = this.extractRequestedFileName(`${task}\n${description}`) || 'exported-document';
      const outputPath = retargetExportPath(toolCall.args.output ?? toolCall.args.out, '.docx')
        || `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.docx')}`;
      return {
        name: 'docx_create_from_text',
        args: {
          output: outputPath,
          text: toolCall.args.text ?? '$LAST_ASSISTANT_TEXT',
          title: typeof toolCall.args.title === 'string' ? toolCall.args.title : this.toTitle(fileName),
        },
      };
    }

    if (/^web_search$/i.test(toolCall.name)) {
      const query = typeof toolCall.args.query === 'string' ? toolCall.args.query.trim() : '';
      if (this.isNewsEntityStockAnalysisContext(task, description) && this.isGenericNewsStockSearchQuery(query)) {
        return null;
      }
    }

    return toolCall;
  }

  private isNewsEntityStockAnalysisContext(task: string, description: string): boolean {
    const combined = `${task}\n${description}`;
    return /(热点新闻|新闻).*(公司|企业|品牌|机构|行业|板块|赛道)|(?:公司|企业|品牌|机构|行业|板块|赛道).*(股票|个股|上市公司|证券)|识别相关股票/i.test(combined);
  }

  private isGenericNewsStockSearchQuery(query: string): boolean {
    if (!query) {
      return false;
    }

    const normalized = query.replace(/\s+/g, '');
    return /^(?:热点新闻|新闻)?相关?(?:公司|行业)?股票分析$/.test(normalized)
      || /^(?:热点新闻|新闻).*(?:相关股票分析|股票走势分析)$/.test(normalized)
      || /^热点新闻相关股票分析$/.test(normalized);
  }

  private isLikelyReplCode(value: unknown): boolean {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return false;
    }

    const code = value.trim();
    const candidates = [
      code,
      `return (${code});`,
      `return ${code};`,
    ];

    for (const candidate of candidates) {
      try {
        new Function(candidate);
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  private inferToolCallsFromText(task: string, description: string): Array<{ name: string; args: Record<string, unknown> }> {
    const combined = `${task}\n${description}`.trim();
    if (!combined) {
      return [];
    }

    const fileName = this.extractRequestedFileName(combined) || 'exported-document';
    const exportFormat = detectRequestedExportFormat(combined, ['docx', 'pdf', 'md', 'txt', 'xlsx', 'pptx']);
    if (exportFormat === 'docx') {
      return [{
        name: 'docx_create_from_text',
        args: {
          output: `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.docx')}`,
          text: '$LAST_ASSISTANT_TEXT',
          title: this.toTitle(fileName),
        },
      }];
    }
    if (exportFormat === 'pdf') {
      return [{
        name: 'pdf_create_from_text',
        args: {
          out: `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.pdf')}`,
          text: '$LAST_ASSISTANT_TEXT',
          title: this.toTitle(fileName),
        },
      }];
    }
    if (exportFormat === 'xlsx') {
      return [{
        name: 'xlsx_create_from_text',
        args: {
          output: `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.xlsx')}`,
          text: '$LAST_ASSISTANT_TEXT',
          title: this.toTitle(fileName),
        },
      }];
    }
    if (exportFormat === 'pptx') {
      return [{
        name: 'pptx_create_from_text',
        args: {
          output: `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.pptx')}`,
          text: '$LAST_ASSISTANT_TEXT',
          title: this.toTitle(fileName),
        },
      }];
    }
    if (/(保存|写入|输出|生成|save|write).*(markdown|md)/i.test(combined)) {
      return [{
        name: 'write_file',
        args: {
          path: `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.md')}`,
          content: '$LAST_ASSISTANT_TEXT',
        },
      }];
    }
    if (/(保存|写入|输出|生成|save|write).*(txt|文本)/i.test(combined)) {
      return [{
        name: 'write_file',
        args: {
          path: `$ARTIFACT_OUTPUT_DIR/${this.ensureSuffix(fileName, '.txt')}`,
          content: '$LAST_ASSISTANT_TEXT',
        },
      }];
    }

    const filePattern = this.extractFileGlobPattern(combined);
    if (filePattern) {
      return [{ name: 'glob', args: { pattern: filePattern, cwd: '$WORKSPACE' } }];
    }

    const searchQuery = this.extractSearchQuery(combined);
    if (searchQuery) {
      return [{ name: 'search_files', args: { path: '$WORKSPACE', content: searchQuery } }];
    }

    const explicitPaths = this.extractExplicitPaths(combined);
    if (explicitPaths.length > 1 && /(读取|查看|打开|read|open|inspect)/i.test(combined)) {
      return [{ name: 'read_multiple_files', args: { paths: explicitPaths } }];
    }
    if (explicitPaths.length === 1 && /(读取|查看|打开|read|open|inspect)/i.test(combined)) {
      return [{ name: 'read_file', args: { path: explicitPaths[0] } }];
    }

    return [];
  }

  private async lookupProceduralCandidates(task: string): Promise<Array<{
    name: string;
    description: string;
    score: number;
    confidence?: number;
    whenToUse: string;
    procedureSteps: string[];
    verification: string[];
    tags?: string[];
  }>> {
    if (!this.skillManager?.searchSkillCandidates) {
      return [];
    }

    try {
      return await this.skillManager.searchSkillCandidates(task, 3);
    } catch {
      return [];
    }
  }

  private buildPlanFromCandidate(
    task: string,
    candidate: {
      name: string;
      score: number;
      confidence?: number;
      procedureSteps: string[];
    } | undefined,
  ): { steps: PlanStep[] } | null {
    if (!candidate || candidate.procedureSteps.length === 0) {
      return null;
    }

    const candidateConfidence = candidate.confidence ?? 0.5;
    if (candidate.score < 0.72 && candidateConfidence < 0.72) {
      return null;
    }

    return {
      steps: candidate.procedureSteps.slice(0, this.maxSteps).map((step, index) => ({
        id: `step_${index + 1}`,
        description: step,
        status: 'pending' as const,
        toolCalls: this.inferToolCallsFromText(task, step),
      })),
    };
  }

  private buildProceduralContext(candidates: Array<{
    name: string;
    description: string;
    score: number;
    confidence?: number;
    whenToUse: string;
    procedureSteps: string[];
    tags?: string[];
  }>): string {
    if (candidates.length === 0) {
      return '';
    }

    return [
      '## Procedural Skill Memory',
      '优先参考这些候选 procedural skills，而不是从头重想。只有当它们明显不适用时才重新规划。',
      ...candidates.map((candidate, index) => [
        `${index + 1}. ${candidate.name} (score=${candidate.score.toFixed(2)}, confidence=${(candidate.confidence ?? 0.5).toFixed(2)})`,
        `   description: ${candidate.description}`,
        `   when: ${candidate.whenToUse}`,
        candidate.tags && candidate.tags.length > 0 ? `   tags: ${candidate.tags.join(', ')}` : undefined,
        ...candidate.procedureSteps.slice(0, 4).map((step, stepIndex) => `   step ${stepIndex + 1}: ${step}`),
      ].filter((line): line is string => typeof line === 'string').join('\n')),
    ].join('\n');
  }

  private async buildMemoryPlanningContext(task: string): Promise<string> {
    if (!this.memoryProvider) {
      return '';
    }

    try {
      const layers = await this.memoryProvider.recallLayers(task, 6);
      const procedural = layers.find(layer => layer.layer === 'procedural');
      const facts = layers.find(layer => layer.layer === 'facts');
      const snippets = [procedural, facts]
        .filter((layer): layer is NonNullable<typeof layer> => !!layer)
        .flatMap(layer => [
          `${layer.title}:`,
          ...layer.items.slice(0, 3).map((item, index) => `${index + 1}. ${item.title}: ${item.content}`),
        ]);
      return snippets.length > 0 ? ['## Relevant Memory', ...snippets].join('\n') : '';
    } catch {
      return '';
    }
  }

  private extractSearchQuery(input: string): string | null {
    const patterns = [
      /(?:搜索|查找|grep|find)\s+(?!.*(?:文件|目录))(?:关键词|关键字|内容|文本)?\s*[：:]?\s*['"“”]?([^'"“”\n]+?)['"“”]?(?:\s|$)/i,
      /(?:包含|查找包含)\s*['"“”]?([^'"“”\n]+?)['"“”]?\s*的内容/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const query = match?.[1]?.trim();
      if (query && !/(所有|全部).*(文件|目录)/i.test(query)) {
        return query;
      }
    }

    return null;
  }

  private extractFileGlobPattern(input: string): string | null {
    const patterns = [
      /(?:查找|搜索|列出|寻找).*(?:所有|全部)?\s*([a-z0-9]+)\s*文件/i,
      /(?:查找|搜索|列出|寻找).*(\*\*\/\*\.[a-z0-9]+|\*\.[a-z0-9]+)/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const value = match?.[1]?.trim();
      if (!value) {
        continue;
      }

      if (value.includes('*')) {
        return value.startsWith('**/') ? value : `**/${value}`;
      }

      return `**/*.${value.replace(/^\./, '')}`;
    }

    return null;
  }

  private extractExplicitPaths(input: string): string[] {
    const matches = input.match(/(?:[a-zA-Z]:[\\/][^\s,'"]+|(?:\.{1,2}[\\/]|[\\/])[^\s,'"]+|[^\s,'"]+\.[a-z0-9]{1,8})/g);
    return matches?.map(item => item.trim()) || [];
  }

  private extractRequestedFileName(input: string): string | null {
    const patterns = [
      /(?:文件名叫做|文件名叫|命名为|叫做|named?|name(?: it)? as)\s*[：: ]*['"“]?([^'"”，,。\n]+?)['"”]?(?:\s|$|，|,|。)/i,
      /(?:文件名|命名为|叫做|叫|named?|name(?: it)? as)\s*[：: ]*['"“]?([^'"”，,。\n]+?)['"”]?(?:\s|$|，|,|。)/i,
    ];

    for (const pattern of patterns) {
      const match = input.match(pattern);
      const rawName = match?.[1]?.trim();
      if (rawName) {
        return rawName.replace(/[<>:"/\\|?*]+/g, '-').replace(/\.+$/g, '').trim();
      }
    }

    return null;
  }

  private ensureSuffix(fileName: string, suffix: string): string {
    return fileName.toLowerCase().endsWith(suffix) ? fileName : `${fileName}${suffix}`;
  }

  private toTitle(fileName: string): string {
    return fileName.replace(/\.[a-z0-9]{1,8}$/i, '').replace(/[-_]+/g, ' ').trim() || 'exported document';
  }

  getCurrentPlan(): Plan | undefined {
    return this.currentPlan;
  }

  getNextStep(): PlanStep | null {
    if (!this.currentPlan) return null;
    
    const nextStep = this.currentPlan.steps.find(s => s.status === 'pending');
    if (nextStep) {
      nextStep.status = 'in_progress';
      this.currentPlan.status = 'executing';
    }
    return nextStep || null;
  }

  completeStep(stepId: string, result: string): void {
    if (!this.currentPlan) return;
    
    const step = this.currentPlan.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'completed';
      step.result = result;
    }

    const pendingSteps = this.currentPlan.steps.filter(s => s.status === 'pending');
    if (pendingSteps.length === 0) {
      this.currentPlan.status = 'completed';
    }
  }

  failStep(stepId: string, error: string): void {
    if (!this.currentPlan) return;
    
    const step = this.currentPlan.steps.find(s => s.id === stepId);
    if (step) {
      step.status = 'failed';
      step.result = error;
    }
    this.currentPlan.status = 'failed';
  }

  getProgress(): { current: number; total: number; percentage: number } {
    if (!this.currentPlan) {
      return { current: 0, total: 0, percentage: 0 };
    }
    
    const completed = this.currentPlan.steps.filter(s => s.status === 'completed').length;
    const total = this.currentPlan.steps.length;
    
    return {
      current: completed,
      total,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  formatPlanSummary(): string {
    if (!this.currentPlan) return '';
    
    let summary = `\n📋 **任务规划**\n`;
    summary += `**原任务**: ${this.currentPlan.originalTask}\n\n`;
    
    for (const step of this.currentPlan.steps) {
      const icon = step.status === 'completed' ? '✅' : 
                   step.status === 'in_progress' ? '🔄' : 
                   step.status === 'failed' ? '❌' : '⬜';
      summary += `${icon} ${step.description}`;
      if (step.result && step.status === 'completed') {
        const resultPreview = step.result.slice(0, 100);
        summary += `\n   └─ ${resultPreview}${step.result.length > 100 ? '...' : ''}`;
      }
      summary += '\n';
    }
    
    const progress = this.getProgress();
    summary += `\n进度: ${progress.current}/${progress.total} (${progress.percentage}%)`;
    
    return summary;
  }
}

export function createPlanner(options: PlannerOptions): Planner {
  return new Planner(options);
}
