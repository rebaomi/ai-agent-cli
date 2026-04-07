export type AgentRole = 
  | 'orchestrator'    // 任务编排/分解
  | 'dispatcher'      // 任务分派
  | 'executor'        // 任务执行
  | 'supervisor'      // 决策监督
  | 'tester'          // 验收测试
  | 'fallback';       // 备用/容错

export type AgentStatus = 'idle' | 'busy' | 'waiting' | 'completed' | 'failed' | 'offline';

export type TaskStatus = 'pending' | 'assigned' | 'in_progress' | 'completed' | 'failed' | 'blocked';

export type Priority = 'low' | 'medium' | 'high' | 'critical';

export interface AgentMember {
  id: string;
  name: string;
  role: AgentRole;
  description: string;
  model?: string;
  status: AgentStatus;
  capabilities: string[];
  currentTask?: string;
  skills?: string[];
  maxIterations?: number;
  permissions?: AgentPermissionConfig;
}

export interface AgentPermissionConfig {
  allowedTools?: string[];
  deniedTools?: string[];
  maxToolCalls?: number;
  maxDuration?: number;
  confirmationRequired?: string[];
}

export interface LaneContext {
  laneId: string;
  agentId: string;
  status: AgentStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  input: string;
  output?: string;
  error?: string;
  currentBlocker?: string;
  context: Record<string, any>;
}

export interface PolicyRule {
  name: string;
  condition: PolicyCondition;
  action: PolicyAction;
  priority: number;
}

export type PolicyCondition = 
  | { type: 'lane_completed' }
  | { type: 'lane_failed' }
  | { type: 'has_blocker' }
  | { type: 'timeout' }
  | { type: 'all', conditions: PolicyCondition[] }
  | { type: 'any', conditions: PolicyCondition[] };

export type PolicyAction = 
  | { type: 'continue' }
  | { type: 'rollback' }
  | { type: 'retry' }
  | { type: 'escalate' }
  | { type: 'fallback' }
  | { type: 'complete' };

export interface OrganizationConfig {
  name: string;
  description?: string;
  agents: AgentMember[];
  workflow?: WorkflowConfig;
  policies?: PolicyRule[];
}

export interface ReceptionConfig {
  enabled: boolean;
  agentId: string;
  welcomeMessage: string;
  followUpQuestions?: string[];
}

export interface WorkflowConfig {
  enabled: boolean;
  defaultFlow: AgentRole[];
  autoSupervise: boolean;
  allowFallback: boolean;
  maxRetries?: number;
  timeout?: number;
  reception?: ReceptionConfig;
}

export interface Task {
  id: string;
  description: string;
  priority: Priority;
  status: TaskStatus;
  assignedTo?: string;
  result?: string;
  createdAt: Date;
  completedAt?: Date;
  subtasks?: Task[];
  parentTaskId?: string;
  context?: Record<string, any>;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  output: string;
  error?: string;
  duration: number;
}

export interface AgentEvent {
  type: 'started' | 'completed' | 'failed' | 'blocked' | 'escalated';
  agentId: string;
  timestamp: number;
  data?: Record<string, any>;
}

export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  orchestrator: '任务分解专家，负责分析用户需求并拆分成可执行的子任务',
  dispatcher: '任务分派专家，负责将子任务分配给最合适的执行者',
  executor: '任务执行专家，负责具体执行分配的子任务',
  supervisor: '决策监督专家，负责监督任务执行并在必要时干预',
  tester: '验收测试专家，负责验证任务结果的正确性和质量',
  fallback: '备用专家，当主流程失败时提供备选方案',
};

export const DEFAULT_WORKFLOW: AgentRole[] = [
  'orchestrator',
  'dispatcher', 
  'executor',
  'tester',
];
