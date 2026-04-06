import type { AgentMember, AgentRole, ROLE_DESCRIPTIONS } from './types.js';
import type { LLMProviderInterface } from '../../llm/types.js';
import { Agent } from '../agent.js';

export interface AgentFactoryOptions {
  llm: LLMProviderInterface;
  mcpManager?: any;
  lspManager?: any;
  sandbox?: any;
}

export class AgentFactory {
  private llm: LLMProviderInterface;
  private mcpManager: any;
  private lspManager: any;
  private sandbox: any;
  private agentInstances: Map<string, Agent> = new Map();

  constructor(options: AgentFactoryOptions) {
    this.llm = options.llm;
    this.mcpManager = options.mcpManager;
    this.lspManager = options.lspManager;
    this.sandbox = options.sandbox;
  }

  createAgent(member: AgentMember): Agent {
    const existingAgent = this.agentInstances.get(member.id);
    if (existingAgent) {
      return existingAgent;
    }

    const systemPrompts: Record<AgentRole, string> = {
      orchestrator: `你是任务分解专家。你的职责是：
1. 分析用户需求
2. 将复杂任务拆分成清晰的子任务
3. 确定每个子任务的优先级
4. 输出结构化的任务分解

格式示例：
## 任务分解
1. [高] 任务A - 描述
2. [中] 任务B - 描述
3. [低] 任务C - 描述`,

      dispatcher: `你是任务分派专家。你的职责是：
1. 分析每个子任务的性质
2. 根据执行者能力分配任务
3. 考虑任务依赖关系
4. 优化执行顺序

格式示例：
## 任务分派
- 任务A → 执行者1 (理由...)
- 任务B → 执行者2 (理由...)`,

      executor: `你是任务执行专家。你的职责是：
1. 接收分配的任务
2. 制定执行计划
3. 使用工具完成任务
4. 报告执行结果

格式示例：
## 执行结果
状态：成功/失败
输出：...
耗时：Xs`,

      supervisor: `你是决策监督专家。你的职责是：
1. 监督任务执行过程
2. 识别潜在问题
3. 提供改进建议
4. 在必要时进行干预

格式示例：
## 监督报告
状态：正常/异常
问题：...
建议：...`,

      tester: `你是验收测试专家。你的职责是：
1. 验证任务结果的质量
2. 检查是否满足需求
3. 提供改进建议
4. 决定是否通过验收

格式示例：
## 验收报告
通过：是/否
评分：X/10
问题：...
建议：...`,

      fallback: `你是备用专家。你的职责是：
1. 当主流程失败时提供备选方案
2. 尝试不同的方法完成任务
3. 提供错误恢复建议
4. 总结失败原因和改进方向

格式示例：
## 备选方案
原因分析：...
备选方案：...
建议：...`
    };

    const agent = new Agent({
      llm: this.llm,
      mcpManager: this.mcpManager,
      lspManager: this.lspManager,
      sandbox: this.sandbox,
      systemPrompt: systemPrompts[member.role],
      maxIterations: 50,
    });

    this.agentInstances.set(member.id, agent);
    return agent;
  }

  getAgent(memberId: string): Agent | undefined {
    return this.agentInstances.get(memberId);
  }

  removeAgent(memberId: string): void {
    this.agentInstances.delete(memberId);
  }

  clearAll(): void {
    this.agentInstances.clear();
  }

  getAgentCount(): number {
    return this.agentInstances.size;
  }
}

export function createAgentFactory(options: AgentFactoryOptions): AgentFactory {
  return new AgentFactory(options);
}
