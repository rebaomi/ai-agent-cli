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

export class Organization {
  private config: OrganizationConfig;
  private factory: AgentFactory;
  private tasks: Map<string, Task> = new Map();
  private taskHistory: TaskResult[] = [];
  private eventHandlers: Map<string, Function[]> = new Map();
  private lanes: Map<string, LaneContext> = new Map();
  private activeLanes: Set<string> = new Set();
  private policyRules: PolicyRule[] = [];

  constructor(config: OrganizationConfig, factory: AgentFactory) {
    this.config = config;
    this.factory = factory;
    this.policyRules = config.policies || [];
    
    this.config.agents.forEach(member => {
      this.factory.createAgent(member);
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
      const analysis = await orchestratorAgent.chat(`分析并分解这个任务：${input}`);
      this.updateLaneOutput(laneId, analysis);
      
      const isComplex = this.detectComplexity(analysis);
      
      if (!isComplex) {
        console.log(chalk.cyan('📝 简单任务，直接执行...'));
        return this.simpleFallback(input, laneId);
      }

      console.log(chalk.cyan('\n📋 检测到复杂任务，启动团队协作...\n'));
      return await this.executeComplexWorkflow(input, analysis, laneId);
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

  private async simpleFallback(input: string, laneId: string): Promise<string> {
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
      const result = await executorAgent.chat(input);
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

  private async executeComplexWorkflow(input: string, analysis: string, laneId: string): Promise<string> {
    const workflow = this.config.workflow?.defaultFlow || DEFAULT_WORKFLOW;
    const results: string[] = [];
    let currentOutput = analysis;

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
        const result = await agent.chat(context);
        results.push(`## ${member.name}\n${result}`);
        currentOutput = result;
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
              const fallbackResult = await fallbackAgent.chat(`任务执行失败，需要备选方案。\n\n原始任务：${input}\n\n错误：${error}\n\n之前的结果：${currentOutput}`);
              results.push(`## ${fallback.name}\n${fallbackResult}`);
              currentOutput = fallbackResult;
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

export async function loadOrganization(configPath: string, factory: AgentFactory): Promise<Organization> {
  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config: OrganizationConfig = JSON.parse(content);
    return new Organization(config, factory);
  } catch (error) {
    throw new Error(`Failed to load organization: ${error}`);
  }
}

export function createOrganization(config: OrganizationConfig, factory: AgentFactory): Organization {
  return new Organization(config, factory);
}