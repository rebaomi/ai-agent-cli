import chalk from 'chalk';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { 
  AgentMember, 
  AgentRole, 
  AgentStatus,
  OrganizationConfig, 
  Task, 
  TaskResult, 
  WorkflowConfig, 
  LaneContext, 
  PolicyRule, 
  PolicyCondition, 
  PolicyAction, 
  AgentEvent 
} from './types.js';
import { ROLE_DESCRIPTIONS, DEFAULT_WORKFLOW } from './types.js';
import { AgentFactory } from './factory.js';
import { Agent } from '../agent.js';
import { ContextBus, type AgentContextView } from '../context-bus.js';
import type { AgentGraphCheckpoint, ContextBusSnapshot, SessionTaskBindingRelation, SessionTaskRecord } from '../../types/index.js';
import type { EnhancedMemoryManager } from '../memory-enhanced.js';

export interface OrganizationOptions {
  contextBus?: ContextBus;
  enhancedMemory?: EnhancedMemoryManager;
  getContextScopeId?: (laneId: string) => string;
}

interface OrganizationExecutionTraceEntry {
  executionId: string;
  laneId: string;
  agentId: string;
  memberName: string;
  role: AgentRole;
  title: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  snapshotId: string;
  resultSummary?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export class Organization {
  private config: OrganizationConfig;
  private factory: AgentFactory;
  private tasks: Map<string, Task> = new Map();
  private taskHistory: TaskResult[] = [];
  private eventHandlers: Map<string, Function[]> = new Map();
  private lanes: Map<string, LaneContext> = new Map();
  private activeLanes: Set<string> = new Set();
  private policyRules: PolicyRule[] = [];
  private readonly contextBus: ContextBus;
  private readonly enhancedMemory?: EnhancedMemoryManager;
  private readonly getContextScopeId?: (laneId: string) => string;

  constructor(config: OrganizationConfig, factory: AgentFactory, options: OrganizationOptions = {}) {
    this.config = config;
    this.factory = factory;
    this.policyRules = config.policies || [];
    this.contextBus = options.contextBus || new ContextBus();
    this.enhancedMemory = options.enhancedMemory;
    this.getContextScopeId = options.getContextScopeId;
    this.contextBus.setMemoryResolver(this.enhancedMemory ? {
      getLongTermMemoryIds: (agentId) => this.enhancedMemory?.getAgentMemory(agentId) ? [`agent:${agentId}`] : [],
      getShortTermMemory: (agentId) => this.enhancedMemory?.getAgentShortTermMemory(agentId).slice(-10) || [],
    } : undefined);
    
    this.config.agents.forEach(member => {
      this.factory.createAgent(member);
      this.registerAgentMemory(member);
      console.log(chalk.green(`✓ ${member.name} (${member.role}) 已就绪`));
    });
  }

  getConfig(): OrganizationConfig {
    return this.config;
  }

  getMembers(): AgentMember[] {
    return this.config.agents;
  }

  getMember(role: AgentRole): AgentMember | undefined {
    return this.config.agents.find(a => a.role === role);
  }

  getMembersByRole(role: AgentRole): AgentMember[] {
    return this.config.agents.filter(a => a.role === role);
  }

  getContextBus(): ContextBus {
    return this.contextBus;
  }

  async processUserInput(input: string): Promise<string> {
    const laneId = this.createLane(input);
    this.emit('workflow:start', { laneId, input });

    const orchestrator = this.getMember('orchestrator');
    if (!orchestrator) {
      return this.simpleFallback(input, laneId);
    }

    const orchestratorAgent = this.factory.getAgent(orchestrator.id);
    if (!orchestratorAgent) {
      return this.simpleFallback(input, laneId);
    }

    this.updateLaneStatus(laneId, 'busy');
    console.log(chalk.cyan('\n🔍 分析任务复杂度...'));
    
    try {
      const analysisExecution = await this.executeAgentWithContext({
        laneId,
        agentId: orchestrator.id,
        prompt: `分析并分解这个任务：${input}`,
        originalInput: input,
        title: '任务分析',
      });
      const analysis = analysisExecution.result;
      this.updateLaneOutput(laneId, analysis);
      this.lanes.get(laneId)!.context['lastContextSnapshotId'] = analysisExecution.snapshot?.id;
      
      const isComplex = this.detectComplexity(analysis);
      
      if (!isComplex) {
        console.log(chalk.cyan('📝 简单任务，直接执行...'));
        return this.simpleFallback(input, laneId, analysisExecution.snapshot?.id);
      }

      console.log(chalk.cyan('\n📋 检测到复杂任务，启动团队协作...\n'));
      return await this.executeComplexWorkflow(input, analysis, laneId, analysisExecution.snapshot?.id);
    } catch (error) {
      this.updateLaneError(laneId, String(error));
      this.evaluatePolicies(laneId);
      throw error;
    }
  }

  private createLane(input: string): string {
    const laneId = `lane-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const lane: LaneContext = {
      laneId,
      agentId: 'orchestrator',
      status: 'idle',
      createdAt: Date.now(),
      input,
      context: {},
    };
    this.lanes.set(laneId, lane);
    this.activeLanes.add(laneId);
    return laneId;
  }

  private updateLaneStatus(laneId: string, status: AgentStatus): void {
    const lane = this.lanes.get(laneId);
    if (lane) {
      lane.status = status;
      if (status === 'busy' && !lane.startedAt) {
        lane.startedAt = Date.now();
      }
      if (status === 'completed' || status === 'failed') {
        lane.completedAt = Date.now();
        this.activeLanes.delete(laneId);
      }
    }
  }

  private updateLaneOutput(laneId: string, output: string): void {
    const lane = this.lanes.get(laneId);
    if (lane) {
      lane.output = output;
    }
  }

  private updateLaneError(laneId: string, error: string): void {
    const lane = this.lanes.get(laneId);
    if (lane) {
      lane.error = error;
      lane.status = 'failed';
    }
  }

  private detectComplexity(analysis: string): boolean {
    const complexIndicators = ['子任务', '分解', '步骤', '多个', '首先', '其次', '然后', 'phase', 'stage'];
    const lowerAnalysis = analysis.toLowerCase();
    return complexIndicators.some(indicator => lowerAnalysis.includes(indicator));
  }

  private async simpleFallback(input: string, laneId: string, parentSnapshotId?: string): Promise<string> {
    const executor = this.getMember('executor');
    if (!executor) {
      return '没有可用的执行者';
    }

    const executorAgent = this.factory.getAgent(executor.id);
    if (!executorAgent) {
      return '执行者未就绪';
    }

    this.updateLaneStatus(laneId, 'busy');
    console.log(chalk.green(`\n⚡ ${executor.name} 正在执行...`));
    executor.status = 'busy';
    this.updateLaneAgent(laneId, executor.id);
    
    try {
      const execution = await this.executeAgentWithContext({
        laneId,
        agentId: executor.id,
        prompt: input,
        originalInput: input,
        parentSnapshotId,
        title: '简单任务执行',
      });
      const result = execution.result;
      executor.status = 'idle';
      this.updateLaneOutput(laneId, result);
      this.updateLaneStatus(laneId, 'completed');
      this.evaluatePolicies(laneId);
      return result;
    } catch (error) {
      executor.status = 'idle';
      const errorMsg = `执行失败：${error instanceof Error ? error.message : String(error)}`;
      this.updateLaneError(laneId, errorMsg);
      this.evaluatePolicies(laneId);
      return errorMsg;
    }
  }

  private updateLaneAgent(laneId: string, agentId: string): void {
    const lane = this.lanes.get(laneId);
    if (lane) {
      lane.agentId = agentId;
    }
  }

  private async executeComplexWorkflow(input: string, analysis: string, laneId: string, parentSnapshotId?: string): Promise<string> {
    const workflow = this.config.workflow?.defaultFlow || DEFAULT_WORKFLOW;
    const results: string[] = [];
    let currentOutput = analysis;
    let currentParentSnapshotId = parentSnapshotId;

    for (const role of workflow) {
      const member = this.getMember(role);
      if (!member) continue;

      const agent = this.factory.getAgent(member.id);
      if (!agent) continue;

      this.updateLaneStatus(laneId, 'busy');
      this.updateLaneAgent(laneId, member.id);
      console.log(chalk.yellow(`\n🔄 ${member.name} 处理中...`));
      member.status = 'busy';

      try {
        const context = `原始任务：${input}\n\n上一阶段输出：\n${currentOutput}`;
        const execution = await this.executeAgentWithContext({
          laneId,
          agentId: member.id,
          prompt: context,
          originalInput: input,
          parentSnapshotId: currentParentSnapshotId,
          title: `${member.role} 执行`,
          currentOutput,
        });
        const result = execution.result;
        results.push(`## ${member.name}\n${result}`);
        currentOutput = result;
        currentParentSnapshotId = execution.snapshot?.id;
        this.updateLaneOutput(laneId, result);
        member.status = 'idle';
        this.evaluatePolicies(laneId);
      } catch (error) {
        member.status = 'idle';
        console.log(chalk.red(`❌ ${member.name} 执行失败`));
        this.updateLaneError(laneId, String(error));
        
        const escalation = this.evaluatePolicies(laneId);
        if (escalation?.type === 'fallback' || this.config.workflow?.allowFallback) {
          const fallback = this.getMember('fallback');
          if (fallback) {
            console.log(chalk.cyan(`🔄 启动 ${fallback.name}...`));
            const fallbackAgent = this.factory.getAgent(fallback.id);
            if (fallbackAgent) {
              this.updateLaneAgent(laneId, fallback.id);
              const fallbackExecution = await this.executeAgentWithContext({
                laneId,
                agentId: fallback.id,
                prompt: `任务执行失败，需要备选方案。\n\n原始任务：${input}\n\n错误：${error}\n\n之前的结果：${currentOutput}`,
                originalInput: input,
                parentSnapshotId: currentParentSnapshotId,
                title: '失败回退',
                currentOutput,
              });
              const fallbackResult = fallbackExecution.result;
              results.push(`## ${fallback.name}\n${fallbackResult}`);
              currentOutput = fallbackResult;
              currentParentSnapshotId = fallbackExecution.snapshot?.id;
            }
          }
        }
      }
    }

    this.updateLaneStatus(laneId, 'completed');
    const finalResponse = results.join('\n\n---\n\n');
    return finalResponse;
  }

  private evaluatePolicies(laneId: string): PolicyAction | null {
    const lane = this.lanes.get(laneId);
    if (!lane) return null;

    for (const rule of this.policyRules) {
      if (this.checkCondition(rule.condition, lane)) {
        this.executeAction(rule.action, laneId);
        return rule.action;
      }
    }

    return null;
  }

  private checkCondition(condition: PolicyCondition, lane: LaneContext): boolean {
    switch (condition.type) {
      case 'lane_completed':
        return lane.status === 'completed';
      case 'lane_failed':
        return lane.status === 'failed';
      case 'has_blocker':
        return !!lane.currentBlocker;
      case 'timeout':
        return lane.startedAt ? (Date.now() - lane.startedAt > 300000) : false;
      case 'all':
        return condition.conditions.every(c => this.checkCondition(c, lane));
      case 'any':
        return condition.conditions.some(c => this.checkCondition(c, lane));
      default:
        return false;
    }
  }

  private executeAction(action: PolicyAction, laneId: string): void {
    const lane = this.lanes.get(laneId);
    if (!lane) return;

    switch (action.type) {
      case 'continue':
        console.log(chalk.green('✅ 继续执行'));
        break;
      case 'rollback':
        console.log(chalk.yellow('🔙 回滚'));
        lane.context['rollback'] = true;
        break;
      case 'retry':
        console.log(chalk.yellow('🔄 重试'));
        lane.status = 'idle';
        break;
      case 'escalate':
        console.log(chalk.red('⚠️ 升级处理'));
        this.emit('escalation', { laneId, lane });
        break;
      case 'fallback':
        console.log(chalk.cyan('🔄 使用备选方案'));
        break;
      case 'complete':
        console.log(chalk.green('✅ 任务完成'));
        break;
    }
  }

  getLane(laneId: string): LaneContext | undefined {
    return this.lanes.get(laneId);
  }

  getActiveLanes(): LaneContext[] {
    return Array.from(this.activeLanes).map(id => this.lanes.get(id)).filter(Boolean) as LaneContext[];
  }

  getAllLanes(): LaneContext[] {
    return Array.from(this.lanes.values());
  }

  async shareContext(agentId: string, snapshot: ContextBusSnapshot): Promise<void> {
    const member = this.config.agents.find(item => item.id === agentId);
    if (!this.enhancedMemory || !member) {
      return;
    }

    const state = snapshot.payload.metadata?.state;
    const summary = typeof state === 'object' && state
      ? JSON.stringify(state)
      : snapshot.title || agentId;
    this.enhancedMemory.updateAgentMemory(agentId, {
      context: summary,
    });
    this.enhancedMemory.addShortTermMemory(agentId, {
      type: 'observation',
      content: summary,
      metadata: {
        laneId: snapshot.scopeId,
        snapshotId: snapshot.id,
        parentId: snapshot.parentId,
      },
    });
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  private emit(event: string, data: any): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(h => h(data));
    
    const eventData: AgentEvent = {
      type: 'started',
      agentId: data.laneId || 'system',
      timestamp: Date.now(),
      data,
    };
    this.emit('agent_event', eventData);
  }

  private registerAgentMemory(member: AgentMember): void {
    if (!this.enhancedMemory) {
      return;
    }

    const existing = this.enhancedMemory.getAgentMemory(member.id);
    if (existing) {
      this.enhancedMemory.updateAgentMemory(member.id, {
        agentName: member.name,
        role: member.role,
        context: existing.context || ROLE_DESCRIPTIONS[member.role],
      });
      return;
    }

    this.enhancedMemory.addAgentMemory({
      agentId: member.id,
      agentName: member.name,
      role: member.role,
      shortTerm: [],
      context: ROLE_DESCRIPTIONS[member.role],
      lastUpdated: Date.now(),
    });
  }

  private getOrganizationState(): Record<string, unknown> {
    return {
      organizationName: this.config.name,
      activeLaneCount: this.activeLanes.size,
      workflow: this.config.workflow?.defaultFlow || DEFAULT_WORKFLOW,
      agentCount: this.config.agents.length,
      recentTaskCount: this.taskHistory.length,
    };
  }

  private async executeAgentWithContext(input: {
    laneId: string;
    agentId: string;
    prompt: string;
    originalInput: string;
    parentSnapshotId?: string;
    title?: string;
    currentOutput?: string;
  }): Promise<{ result: string; snapshot?: ContextBusSnapshot }> {
    const agent = this.factory.getAgent(input.agentId);
    const member = this.config.agents.find(item => item.id === input.agentId);
    if (!agent || !member) {
      throw new Error(`Agent not available: ${input.agentId}`);
    }

    const snapshot = this.contextBus.pushAgentContext({
      agentId: input.agentId,
      scopeId: input.laneId,
      parentSnapshotId: input.parentSnapshotId,
      title: input.title || member.name,
      state: {
        prompt: input.prompt,
        originalInput: input.originalInput,
        currentOutput: input.currentOutput,
        role: member.role,
        organization: this.getOrganizationState(),
      },
      tags: [member.role, input.laneId],
      metadata: {
        role: member.role,
        memberName: member.name,
      },
    });

    const traceEntry = this.recordOrganizationExecution({
      laneId: input.laneId,
      agentId: input.agentId,
      memberName: member.name,
      role: member.role,
      title: input.title || member.name,
      prompt: input.prompt,
      snapshotId: snapshot.id,
      status: 'running',
    });
    this.captureOrganizationGraphSnapshot(input.laneId, traceEntry, 'running');

    try {
      const contextView = this.contextBus.getContextForAgent(input.agentId, {
        scopeId: input.laneId,
        includeParent: true,
        includeMemory: true,
      });
      const result = await agent.chat(this.buildContextPrompt(input.prompt, contextView));
      this.lanes.get(input.laneId)?.context && (this.lanes.get(input.laneId)!.context['lastContextSnapshotId'] = snapshot.id);
      this.completeOrganizationExecution(traceEntry, result);
      this.captureOrganizationGraphSnapshot(input.laneId, traceEntry, 'completed', result);
      this.captureOrganizationTaskContextSnapshot(input.laneId, this.getLaneExecutionTrace(input.laneId), this.buildOrganizationCheckpoint(traceEntry, 'completed', result));
      await this.shareContext(input.agentId, snapshot);
      return { result, snapshot };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.failOrganizationExecution(traceEntry, errorMessage);
      this.captureOrganizationGraphSnapshot(input.laneId, traceEntry, 'failed', undefined, errorMessage);
      this.captureOrganizationTaskContextSnapshot(input.laneId, this.getLaneExecutionTrace(input.laneId), this.buildOrganizationCheckpoint(traceEntry, 'failed', undefined, errorMessage));
      throw error;
    } finally {
      this.contextBus.popAgentContext(input.laneId, snapshot.id);
    }
  }

  private buildContextPrompt(prompt: string, contextView: AgentContextView): string {
    const currentState = asRecord(contextView.current?.payload.metadata?.state);
    const parentState = asRecord(contextView.parent?.payload.metadata?.state);
    const currentMemory = {
      longTermMemoryIds: asArray(contextView.current?.payload.metadata?.longTermMemoryIds),
      shortTermMemory: asArray(contextView.current?.payload.metadata?.shortTermMemory),
    };

    const chainSummary = contextView.chain
      .slice(-5)
      .map((snapshot, index) => {
        const metadata = asRecord(snapshot.payload.metadata);
        const role = typeof metadata.role === 'string' ? metadata.role : 'unknown';
        const agentId = typeof metadata.agentId === 'string' ? metadata.agentId : 'unknown';
        const memberName = typeof metadata.memberName === 'string' ? metadata.memberName : agentId;
        return `${index + 1}. ${memberName} (${role}) -> ${snapshot.title || snapshot.id}`;
      });

    const memorySummary = currentMemory.shortTermMemory
      .slice(-3)
      .map((entry, index) => `- ${index + 1}. ${summarizeMemoryEntry(entry)}`)
      .join('\n');

    return [
      '你正在组织协作模式下执行任务，请基于以下摘要继续，不要重复索取上游已经给出的信息。',
      `当前任务\n- ${truncateText(prompt, 480)}`,
      buildStateSummarySection('当前 Agent 摘要', currentState),
      buildStateSummarySection('父级交接摘要', parentState),
      chainSummary.length > 0 ? `协作链路\n${chainSummary.map(item => `- ${item}`).join('\n')}` : '',
      currentMemory.longTermMemoryIds.length > 0 ? `长期记忆引用\n- ${currentMemory.longTermMemoryIds.slice(0, 5).join('\n- ')}` : '',
      memorySummary ? `最近短期记忆\n${memorySummary}` : '',
      '执行要求\n- 继承上游约束与已完成产出\n- 仅输出当前阶段需要交付的内容\n- 若信息不足，优先根据已有摘要补全，不要回退成泛化分析',
    ].filter(Boolean).join('\n\n');
  }

  private recordOrganizationExecution(input: {
    laneId: string;
    agentId: string;
    memberName: string;
    role: AgentRole;
    title: string;
    prompt: string;
    snapshotId: string;
    status: 'running' | 'completed' | 'failed';
  }): OrganizationExecutionTraceEntry {
    const entry: OrganizationExecutionTraceEntry = {
      executionId: `org_exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      laneId: input.laneId,
      agentId: input.agentId,
      memberName: input.memberName,
      role: input.role,
      title: input.title,
      prompt: input.prompt,
      snapshotId: input.snapshotId,
      status: input.status,
      startedAt: Date.now(),
    };
    const lane = this.lanes.get(input.laneId);
    if (lane) {
      const trace = Array.isArray(lane.context['executionTrace']) ? lane.context['executionTrace'] as OrganizationExecutionTraceEntry[] : [];
      trace.push(entry);
      lane.context['executionTrace'] = trace;
    }
    return entry;
  }

  private completeOrganizationExecution(entry: OrganizationExecutionTraceEntry, result: string): void {
    entry.status = 'completed';
    entry.completedAt = Date.now();
    entry.resultSummary = truncateText(result, 220);
  }

  private failOrganizationExecution(entry: OrganizationExecutionTraceEntry, error: string): void {
    entry.status = 'failed';
    entry.completedAt = Date.now();
    entry.error = truncateText(error, 220);
  }

  private getLaneExecutionTrace(laneId: string): OrganizationExecutionTraceEntry[] {
    const lane = this.lanes.get(laneId);
    const trace = lane?.context['executionTrace'];
    return Array.isArray(trace) ? trace as OrganizationExecutionTraceEntry[] : [];
  }

  private captureOrganizationGraphSnapshot(
    laneId: string,
    entry: OrganizationExecutionTraceEntry,
    status: 'running' | 'completed' | 'failed',
    result?: string,
    error?: string,
  ): void {
    const scopeId = this.resolveContextScopeId(laneId);
    const parentSnapshotId = this.contextBus.getCurrentSnapshotId('graph', scopeId);
    this.contextBus.captureSnapshot({
      layer: 'graph',
      scopeId,
      parentId: parentSnapshotId,
      taskId: laneId,
      title: `${entry.memberName}:${status}`,
      payload: {
        checkpoint: this.buildOrganizationCheckpoint(entry, status, result, error),
        metadata: {
          source: 'organization',
          laneId,
          agentId: entry.agentId,
          role: entry.role,
          memberName: entry.memberName,
          resultSummary: entry.resultSummary,
        },
      },
    });
  }

  private captureOrganizationTaskContextSnapshot(
    laneId: string,
    trace: OrganizationExecutionTraceEntry[],
    checkpoint: AgentGraphCheckpoint,
  ): void {
    const scopeId = this.resolveContextScopeId(laneId);
    const parentSnapshotId = this.contextBus.getCurrentSnapshotId('task_stack', scopeId);
    const recentTasks = trace
      .filter(entry => entry.status === 'completed' || entry.status === 'failed')
      .map((entry) => this.buildOrganizationTaskRecord(entry));
    const recentBindings = this.buildOrganizationBindings(recentTasks);
    const activeTask = recentTasks[recentTasks.length - 1];

    this.contextBus.captureSnapshot({
      layer: 'task_stack',
      scopeId,
      parentId: parentSnapshotId,
      taskId: laneId,
      title: `organization:${laneId}`,
      payload: {
        taskContext: {
          activeTask,
          bindableTask: activeTask,
          recentTasks,
          recentBindings,
          checkpoint,
        },
        checkpoint,
        metadata: {
          source: 'organization',
          laneId,
          recentAgentCount: recentTasks.length,
        },
      },
    });
  }

  private buildOrganizationTaskRecord(entry: OrganizationExecutionTraceEntry): SessionTaskRecord {
    return {
      id: entry.executionId,
      channel: 'agent',
      title: `${entry.memberName} · ${entry.title}`,
      input: truncateText(entry.prompt, 240),
      effectiveInput: entry.resultSummary || entry.error,
      category: `organization:${entry.role}`,
      handlerName: entry.agentId,
      status: entry.status === 'failed' ? 'failed' : 'completed',
      metadata: {
        laneId: entry.laneId,
        role: entry.role,
        snapshotId: entry.snapshotId,
        resultSummary: entry.resultSummary,
        error: entry.error,
      },
      createdAt: new Date(entry.startedAt).toISOString(),
      updatedAt: new Date(entry.completedAt || entry.startedAt).toISOString(),
    };
  }

  private buildOrganizationBindings(tasks: SessionTaskRecord[]): SessionTaskBindingRelation[] {
    const bindings: SessionTaskBindingRelation[] = [];
    for (let index = 1; index < tasks.length; index += 1) {
      const sourceTask = tasks[index];
      const targetTask = tasks[index - 1];
      if (!sourceTask || !targetTask) {
        continue;
      }
      bindings.push({
        sourceTask,
        targetTask,
        targetTaskId: targetTask.id,
        targetTaskTitle: targetTask.title,
      });
    }
    return bindings;
  }

  private buildOrganizationCheckpoint(
    entry: OrganizationExecutionTraceEntry,
    status: 'running' | 'completed' | 'failed',
    result?: string,
    error?: string,
  ): AgentGraphCheckpoint {
    return {
      node: status === 'running' ? 'execute_step' : 'finalize',
      status: status === 'running' ? 'running' : status === 'failed' ? 'failed' : 'completed',
      updatedAt: new Date().toISOString(),
      summary: status === 'failed'
        ? `${entry.memberName} 执行失败: ${truncateText(error || entry.error || 'unknown error', 180)}`
        : status === 'completed'
          ? `${entry.memberName} 已完成: ${truncateText(result || entry.resultSummary || '', 180)}`
          : `${entry.memberName} 正在处理 ${entry.title}`,
      input: truncateText(entry.prompt, 240),
      metadata: {
        source: 'organization',
        laneId: entry.laneId,
        agentId: entry.agentId,
        role: entry.role,
        memberName: entry.memberName,
      },
    };
  }

  private resolveContextScopeId(laneId: string): string {
    return this.getContextScopeId?.(laneId) || laneId;
  }

  addPolicy(rule: PolicyRule): void {
    this.policyRules.push(rule);
    this.policyRules.sort((a, b) => b.priority - a.priority);
  }

  printWorkflow(): void {
    const workflow = this.config.workflow?.defaultFlow || DEFAULT_WORKFLOW;
    console.log(chalk.bold('\n📋 工作流:'));
    workflow.forEach((role, idx) => {
      const member = this.getMember(role);
      const status = member ? chalk.green('✓') : chalk.red('✗');
      console.log(`  ${status} ${idx + 1}. ${role} ${member ? `(${member.name})` : '(未配置)'}`);
    });
  }

  printOrganization(): void {
    console.log(chalk.bold(`\n🏢 组织: ${this.config.name}`));
    if (this.config.description) {
      console.log(chalk.gray(`  ${this.config.description}`));
    }
    console.log(chalk.bold('\n成员:'));
    for (const agent of this.config.agents) {
      const statusColors = {
        idle: chalk.green,
        busy: chalk.yellow,
        waiting: chalk.cyan,
        completed: chalk.green,
        failed: chalk.red,
        offline: chalk.gray,
      };
      const status = statusColors[agent.status] || chalk.gray;
      console.log(`  ${status('●')} ${agent.name} (${agent.role}) - ${agent.status}`);
    }
    console.log();
  }
}

export async function loadOrganization(configPath: string, factory: AgentFactory, options: OrganizationOptions = {}): Promise<Organization> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config: OrganizationConfig = JSON.parse(content);
    return new Organization(config, factory, options);
  } catch (error) {
    throw new Error(`Failed to load organization: ${error}`);
  }
}

export function createOrganization(config: OrganizationConfig, factory: AgentFactory, options: OrganizationOptions = {}): Organization {
  return new Organization(config, factory, options);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function buildStateSummarySection(title: string, state: Record<string, unknown>): string {
  const entries = Object.entries(state)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 6)
    .map(([key, value]) => `- ${key}: ${truncateText(formatSummaryValue(value), 160)}`);

  if (entries.length === 0) {
    return '';
  }

  return `${title}\n${entries.join('\n')}`;
}

function summarizeMemoryEntry(entry: unknown): string {
  if (typeof entry === 'string') {
    return truncateText(entry, 180);
  }

  const record = asRecord(entry);
  const summary = [
    record['summary'],
    record['content'],
    record['text'],
    record['message'],
    record['result'],
  ].find(value => typeof value === 'string' && value.trim().length > 0);

  if (typeof summary === 'string') {
    return truncateText(summary, 180);
  }

  const parts = Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${truncateText(formatSummaryValue(value), 80)}`);

  return parts.length > 0 ? parts.join('; ') : truncateText(String(entry), 180);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function formatSummaryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 4).map(item => formatSummaryValue(item)).join(', ');
  }
  return safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}