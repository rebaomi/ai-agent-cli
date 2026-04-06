import chalk from 'chalk';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AgentMember, AgentRole, OrganizationConfig, Task, TaskResult, WorkflowConfig } from './types.js';
import { ROLE_DESCRIPTIONS, DEFAULT_WORKFLOW } from './types.js';
import { AgentFactory } from './factory.js';
import { Agent } from '../agent.js';

export class Organization {
  private config: OrganizationConfig;
  private factory: AgentFactory;
  private tasks: Map<string, Task> = new Map();
  private taskHistory: TaskResult[] = [];
  private eventHandlers: Map<string, Function[]> = new Map();

  constructor(config: OrganizationConfig, factory: AgentFactory) {
    this.config = config;
    this.factory = factory;
    
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
    this.emit('workflow:start', { input });

    const orchestrator = this.getMember('orchestrator');
    if (!orchestrator) {
      return this.simpleFallback(input);
    }

    const orchestratorAgent = this.factory.getAgent(orchestrator.id);
    if (!orchestratorAgent) {
      return this.simpleFallback(input);
    }

    console.log(chalk.cyan('\n🔍 分析任务复杂度...'));
    const analysis = await orchestratorAgent.chat(`分析并分解这个任务：${input}`);
    
    const isComplex = this.detectComplexity(analysis);
    
    if (!isComplex) {
      console.log(chalk.cyan('📝 简单任务，直接执行...'));
      return this.simpleFallback(input);
    }

    console.log(chalk.cyan('\n📋 检测到复杂任务，启动团队协作...\n'));
    return this.executeComplexWorkflow(input, analysis);
  }

  private detectComplexity(analysis: string): boolean {
    const complexIndicators = ['子任务', '分解', '步骤', '多个', '首先', '其次', '然后'];
    const lowerAnalysis = analysis.toLowerCase();
    return complexIndicators.some(indicator => lowerAnalysis.includes(indicator));
  }

  private async simpleFallback(input: string): Promise<string> {
    const executor = this.getMember('executor');
    if (!executor) {
      return '没有可用的执行者';
    }

    const executorAgent = this.factory.getAgent(executor.id);
    if (!executorAgent) {
      return '执行者未就绪';
    }

    console.log(chalk.green(`\n⚡ ${executor.name} 正在执行...`));
    executor.status = 'busy';
    
    try {
      const result = await executorAgent.chat(input);
      executor.status = 'idle';
      return result;
    } catch (error) {
      executor.status = 'idle';
      return `执行失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async executeComplexWorkflow(input: string, analysis: string): Promise<string> {
    const workflow = this.config.workflow?.defaultFlow || DEFAULT_WORKFLOW;
    const results: string[] = [];
    let currentOutput = analysis;

    for (const role of workflow) {
      const member = this.getMember(role);
      if (!member) continue;

      const agent = this.factory.getAgent(member.id);
      if (!agent) continue;

      console.log(chalk.yellow(`\n🔄 ${member.name} 处理中...`));
      member.status = 'busy';

      try {
        const context = `原始任务：${input}\n\n上一阶段输出：\n${currentOutput}`;
        const result = await agent.chat(context);
        results.push(`## ${member.name}\n${result}`);
        currentOutput = result;
        member.status = 'idle';
      } catch (error) {
        member.status = 'idle';
        console.log(chalk.red(`❌ ${member.name} 执行失败`));
        
        if (this.config.workflow?.allowFallback) {
          const fallback = this.getMember('fallback');
          if (fallback) {
            console.log(chalk.cyan(`🔄 启动 ${fallback.name}...`));
            const fallbackAgent = this.factory.getAgent(fallback.id);
            if (fallbackAgent) {
              const fallbackResult = await fallbackAgent.chat(`任务失败：${input}\n\n错误：${error}`);
              results.push(`## ${fallback.name}\n${fallbackResult}`);
            }
          }
        }
      }

      if (this.config.workflow?.autoSupervise) {
        const supervisor = this.getMember('supervisor');
        if (supervisor && role !== 'supervisor') {
          const supervisorAgent = this.factory.getAgent(supervisor.id);
          if (supervisorAgent) {
            console.log(chalk.gray(`👁️ ${supervisor.name} 监督中...`));
            const supervision = await supervisorAgent.chat(`审查结果：\n${currentOutput}`);
            console.log(chalk.gray(`📊 监督意见：${supervision.substring(0, 100)}...`));
          }
        }
      }
    }

    let finalResult = results.join('\n\n');

    if (this.config.workflow?.autoSupervise) {
      const tester = this.getMember('tester');
      if (tester) {
        console.log(chalk.yellow(`\n🧪 ${tester.name} 验收测试...`));
        const testerAgent = this.factory.getAgent(tester.id);
        if (testerAgent) {
          const testResult = await testerAgent.chat(`最终结果：\n${finalResult}\n\n原始需求：${input}`);
          finalResult = `## 最终验收\n${testResult}\n\n---\n## 完整执行记录\n\n${finalResult}`;
        }
      }
    }

    return finalResult;
  }

  createTask(description: string, priority: Task['priority'] = 'medium'): Task {
    const task: Task = {
      id: `task_${Date.now()}`,
      description,
      priority,
      status: 'pending',
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  getTaskHistory(): TaskResult[] {
    return this.taskHistory;
  }

  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)?.push(handler);
  }

  emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(handler => handler(data));
  }

  printOrganization(): void {
    console.log(chalk.bold(`\n🏢 组织架构: ${this.config.name}`));
    if (this.config.description) {
      console.log(chalk.gray(`   ${this.config.description}`));
    }
    console.log(chalk.gray('─'.repeat(60)));

    const roles = ['orchestrator', 'dispatcher', 'executor', 'supervisor', 'tester', 'fallback'] as AgentRole[];
    
    for (const role of roles) {
      const members = this.getMembersByRole(role);
      if (members.length > 0) {
        console.log(chalk.bold(`\n📌 ${role.toUpperCase()} - ${ROLE_DESCRIPTIONS[role]}`));
        for (const member of members) {
          const statusColor = member.status === 'idle' ? chalk.green : 
                            member.status === 'busy' ? chalk.yellow : chalk.gray;
          console.log(`   ${statusColor('●')} ${member.name} ${chalk.gray(`(${member.status})`)}`);
        }
      }
    }
    
    console.log(chalk.gray('─'.repeat(60)));
  }

  printWorkflow(): void {
    const workflow = this.config.workflow?.defaultFlow || DEFAULT_WORKFLOW;
    console.log(chalk.bold('\n📊 工作流程'));
    workflow.forEach((role, index) => {
      const member = this.getMember(role);
      console.log(chalk.cyan(`   ${index + 1}. ${role} ${member ? `- ${member.name}` : ''}`));
    });
  }

  async saveConfig(configPath: string): Promise<void> {
    const configContent = JSON.stringify(this.config, null, 2);
    await fs.writeFile(configPath, configContent, 'utf-8');
  }

  static async loadFromFile(configPath: string, factory: AgentFactory): Promise<Organization> {
    const content = await fs.readFile(configPath, 'utf-8');
    const config: OrganizationConfig = JSON.parse(content);
    return new Organization(config, factory);
  }
}

export async function createOrganization(
  config: OrganizationConfig,
  factory: AgentFactory
): Promise<Organization> {
  return new Organization(config, factory);
}

export async function loadOrganization(
  configPath: string,
  factory: AgentFactory
): Promise<Organization> {
  return Organization.loadFromFile(configPath, factory);
}
