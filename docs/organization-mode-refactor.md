# Organization Mode Refactor Proposal

## Summary

当前的 organization mode 更接近“多角色串行协作器”，适合做任务流转演示，但还不足以支撑三类差异很大的组织模型：

- 小团队协作
- 企业项目交付
- 行政事项办理

建议将当前实现拆成一层通用底座，外加两类引擎：

1. task workflow engine
2. case workflow engine

其中：

- 小团队版和企业版共用 task workflow engine
- 行政版单独使用 case workflow engine

## Current Problems

当前组织模式的主要问题：

1. 角色抽象统一，但工作流语义不统一。
2. 默认工作流是串行的，无法表达并行协作。
3. capabilities、permissions 等字段更多停留在配置层，没有真正进入调度和执行约束。
4. supervisor、tester、fallback 更像 prompt 身份，而不是硬流程节点。
5. reception 存在，但并没有成为真正的统一入口。
6. 行政模板与企业模板共享同一执行模型，导致领域规则被弱化为自然语言协作。

## Refactor Direction

### Layer 1: Common Organization Kernel

保留并增强以下通用能力：

- agent registry
- member capabilities
- member permissions
- execution lane tracking
- workflow event bus
- audit log
- escalation hooks

这一层不关心“小团队 / 企业 / 行政”的具体语义，只负责：

- 成员注册
- 状态管理
- 任务上下文流转
- 事件广播
- 权限边界控制

### Layer 2A: Task Workflow Engine

适用场景：

- 小团队研发
- 企业项目交付
- 知识型协作任务

特点：

- 支持任务拆解
- 支持并行子任务
- 支持汇总验收
- 支持审批和升级
- 支持失败重试与 fallback

### Layer 2B: Case Workflow Engine

适用场景：

- 行政事项办理
- 审批流
- 合规检查型流程

特点：

- 显式状态机
- 显式材料清单
- 显式规则引擎
- 状态迁移受规则严格控制
- 全量审计留痕

## Proposed Directory Structure

建议在现有目录基础上重构为：

```text
src/core/organization/
  kernel/
    registry.ts
    member-state.ts
    permissions.ts
    event-bus.ts
    lane-store.ts
    audit.ts
    types.ts
  reception/
    intake.ts
    classifier.ts
    clarification.ts
    context-builder.ts
  workflow/
    task/
      engine.ts
      planner.ts
      dispatcher.ts
      executor-router.ts
      approval.ts
      aggregator.ts
      policies.ts
      types.ts
    case/
      engine.ts
      state-machine.ts
      rules.ts
      materials.ts
      reviewer.ts
      escalation.ts
      types.ts
  templates/
    small-team.ts
    enterprise.ts
    administrative.ts
  compatibility/
    legacy-manager.ts
    legacy-loader.ts
  index.ts
```

## Migration of Existing Files

当前文件建议这样迁移：

### Existing File Mapping

- `manager.ts` → 拆成 `kernel/lane-store.ts` + `workflow/task/engine.ts`
- `factory.ts` → 保留为 `kernel/registry.ts` 的上层封装
- `reception.ts` → 拆成 `reception/intake.ts` 和 `reception/clarification.ts`
- `types.ts` → 拆成 `kernel/types.ts`、`workflow/task/types.ts`、`workflow/case/types.ts`

### Compatibility Strategy

为了避免一次性打爆现有 CLI，建议保留一层兼容入口：

- 现有 `Organization` 类先作为 facade
- 内部逐步切换到新的 task engine
- 行政版不走旧 `Organization`，单独创建 `AdministrativeOrganization`

## File-Level Refactor Checklist

建议按下面的文件粒度推进，而不是一次性重写整个 organization 目录。

### Step 1: Extract Kernel

目标：先把“成员注册、状态、事件、执行车道”抽出来。

- 从 `manager.ts` 提取 lane 状态读写到 `kernel/lane-store.ts`
- 从 `manager.ts` 提取事件发布到 `kernel/event-bus.ts`
- 从 `factory.ts` 提取成员注册和实例缓存到 `kernel/registry.ts`
- 从 `types.ts` 提取成员基础类型到 `kernel/types.ts`

完成标准：

- 旧 `Organization` 仍然可用
- lane/event/member 的职责不再耦合在一个类里

### Step 2: Build Task Workflow Engine

目标：让现有组织模式升级为任务型引擎。

- 新建 `workflow/task/types.ts`
- 新建 `workflow/task/dispatcher.ts`
- 新建 `workflow/task/executor-router.ts`
- 新建 `workflow/task/aggregator.ts`
- 新建 `workflow/task/engine.ts`

完成标准：

- 复杂任务能够拆分为多个子任务
- 支持至少 2 个 executor 并行执行
- 最终结果由 aggregator 汇总

### Step 3: Introduce Approval and Policy

目标：在 task workflow 上增加企业能力。

- 新建 `workflow/task/approval.ts`
- 新建 `workflow/task/policies.ts`
- 让 `AgentPermissionConfig` 真正进入路由与执行链路
- 在 CLI 的 `/org` 模式下增加简单的审批态显示

完成标准：

- 某些子任务可以进入 `approval_pending`
- 高风险节点能被阻断或升级
- 审批与执行责任可以分离

### Step 4: Separate Administrative Engine

目标：不要继续把行政逻辑塞进 task workflow。

- 新建 `workflow/case/types.ts`
- 新建 `workflow/case/state-machine.ts`
- 新建 `workflow/case/rules.ts`
- 新建 `workflow/case/materials.ts`
- 新建 `workflow/case/engine.ts`

完成标准：

- 行政事项以 case 为核心对象
- 状态迁移必须经过 validator
- 缺件、驳回、补件、审批都有明确状态

## Suggested PR Split

为了控制风险，建议按 4 个 PR 拆：

1. kernel 拆分 PR
2. small-team workflow PR
3. enterprise governance PR
4. administrative engine PR

这样有两个好处：

1. 每个 PR 都能独立验证
2. 行政版不会拖慢前两条主线

## Small Team Version

### Product Goal

小团队版的目标不是模拟组织层级，而是提升交付效率。

应该围绕以下链路设计：

1. intake
2. decomposition
3. assignment
4. parallel execution
5. review
6. merge result

### Recommended Roles

保留少量执行角色：

- intake lead
- planner
- tech lead
- executor
- reviewer
- fallback

这些角色是交付角色，不是公司头衔。

### Data Structure Draft

```ts
export interface TeamWorkflowTask {
  id: string;
  title: string;
  goal: string;
  status: 'draft' | 'ready' | 'running' | 'reviewing' | 'done' | 'failed';
  ownerId: string;
  subtasks: TeamSubtask[];
  sharedContext: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TeamSubtask {
  id: string;
  type: 'frontend' | 'backend' | 'qa' | 'docs' | 'ops' | 'general';
  description: string;
  assigneeId?: string;
  status: 'pending' | 'assigned' | 'running' | 'blocked' | 'done' | 'failed';
  dependencies: string[];
  output?: string;
  reviewNotes?: string[];
}
```

### Key Capabilities to Add

1. 支持并行 executor。
2. dispatcher 基于 task type 和 capability 路由。
3. reviewer 对各子任务汇总验收。
4. fallback 只接失败任务，不进入主线。
5. 每个成员具备目录级、工具级权限边界。

### Engineering Implementation Notes

小团队版建议复用当前 Agent 和 BuiltInTools，不要引入新的 Agent 类型。

直接改造点：

- `dispatcher` 负责把 subtasks 分发到 executor 列表
- `executor-router` 负责按 capability 和 permission 过滤候选成员
- `aggregator` 汇总多个 executor 输出后交给 reviewer
- `reviewer` 负责生成最终用户可见结果

这意味着小团队版更多是在 workflow 层重构，而不是在 llm/tool 层重写。

### Success Criteria

小团队版完成后应该能稳定支持：

- 一个需求拆成多个子任务
- 多个 executor 并发处理
- reviewer 汇总结果
- supervisor 只在异常时介入

## Enterprise Version

### Product Goal

企业版的目标是项目治理，而不是组织展示。

应重点补充：

- ownership
- approval
- domain routing
- policy enforcement
- persistence
- audit

### Recommended Domain Model

企业版应该引入“项目 / 工作项 / 审批节点”三层模型。

```ts
export interface EnterpriseProject {
  id: string;
  name: string;
  objective: string;
  sponsorId?: string;
  ownerId: string;
  status: 'planning' | 'active' | 'blocked' | 'review' | 'completed' | 'cancelled';
  workItems: EnterpriseWorkItem[];
  milestones: EnterpriseMilestone[];
  auditTrail: EnterpriseAuditEntry[];
}

export interface EnterpriseWorkItem {
  id: string;
  title: string;
  type: 'product' | 'architecture' | 'development' | 'qa' | 'ops' | 'security' | 'legal';
  priority: 'low' | 'medium' | 'high' | 'critical';
  ownerId?: string;
  approverIds: string[];
  status: 'draft' | 'queued' | 'running' | 'approval_pending' | 'approved' | 'rejected' | 'done' | 'failed';
  dependencies: string[];
  artifacts: string[];
  riskLevel: 'low' | 'medium' | 'high';
}

export interface EnterpriseMilestone {
  id: string;
  name: string;
  dueAt?: number;
  workItemIds: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
}

export interface EnterpriseAuditEntry {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  detail?: string;
  timestamp: number;
}
```

### Key Capabilities to Add

1. 审批节点不是一个“角色”，而是一个状态。
2. dispatcher 需要升级为 domain router。
3. supervisor 需要能真正阻断危险流程。
4. 每个 work item 要有 owner。
5. 需要持久化项目状态，不能只依赖聊天上下文。

### Engineering Implementation Notes

企业版最容易失控的点是“把所有治理能力都塞进 manager.ts”。

建议强制按组件拆：

- `approval.ts` 只负责审批状态
- `policies.ts` 只负责规则评估
- `engine.ts` 只负责编排
- `registry.ts` 不处理业务规则

只要职责不拆，企业版很快会回到现在这种“一个 manager 包所有事情”的状态。

### Suggested Role Mapping

可以继续保留现实岗位名称作为显示层，例如：

- 产品经理
- 架构师
- 项目经理
- 开发负责人
- QA
- 法务/安全顾问

但执行层不要直接依赖这些头衔，而要依赖：

- domain
- permission profile
- approval authority
- escalation policy

## Administrative Version

### Why It Needs a Separate Engine

行政版不应该作为企业版模板存在，而应该单独实现。

原因：

1. 它处理的是事项，不是开放任务。
2. 它的核心对象是材料和规则，不是对话文本。
3. 它要求严格状态迁移。
4. 它要求更强的可解释性和审计。

### Recommended State Machine

```ts
export type CaseStatus =
  | 'submitted'
  | 'prechecked'
  | 'awaiting_materials'
  | 'accepted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'archived';

export interface AdministrativeCase {
  id: string;
  caseType: string;
  applicant: {
    name?: string;
    idNo?: string;
    contact?: string;
  };
  status: CaseStatus;
  materials: CaseMaterial[];
  reviewTrail: CaseReviewRecord[];
  currentHandlerId?: string;
  rejectionReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CaseMaterial {
  id: string;
  name: string;
  required: boolean;
  provided: boolean;
  valid: boolean;
  remarks?: string;
}

export interface CaseReviewRecord {
  id: string;
  handlerId: string;
  action: 'precheck' | 'request_materials' | 'accept' | 'review' | 'approve' | 'reject' | 'archive';
  reason?: string;
  timestamp: number;
}
```

### Recommended Rule Engine Model

```ts
export interface CaseRule {
  id: string;
  caseType: string;
  when: CaseCondition[];
  then: CaseAction[];
  priority: number;
}

export type CaseCondition =
  | { type: 'status_is'; value: CaseStatus }
  | { type: 'material_missing'; materialName: string }
  | { type: 'material_invalid'; materialName: string }
  | { type: 'applicant_field_missing'; field: string };

export type CaseAction =
  | { type: 'transition'; to: CaseStatus }
  | { type: 'assign'; handlerId: string }
  | { type: 'emit_notice'; template: string }
  | { type: 'reject'; reason: string }
  | { type: 'request_material'; materialName: string };
```

### Key Capabilities to Add

1. case type registry
2. material checklist
3. transition validator
4. rule evaluation engine
5. immutable review trail
6. escalation to human review

### Engineering Implementation Notes

行政版不要复用 task 的 subtask 模型。

应该明确区分：

- task: 为了完成目标而拆分的工作
- case: 围绕事项和材料推进的法定流程

这两者的数据模型、流程控制、审计要求都不一样。行政版如果沿用 task 模型，后面一定会出现状态错乱和规则失控。

### What Should Not Be Reused Directly

行政版不应直接复用以下逻辑作为主流程：

- 纯文本复杂度分析
- 角色串行接力
- fallback 自由尝试
- reviewer 作为通用测试角色

这些逻辑可以用于咨询导办，但不能作为正式事项处理主引擎。

## Implementation Phases

### Phase 1

先重构现有 task workflow，服务小团队版：

1. 引入 workflow/task 目录
2. 拆出 dispatcher/router
3. 支持并行 subtasks
4. 落地 member permissions
5. 保留旧 CLI 命令兼容

建议在这一阶段就完成以下 CLI 对齐：

- `/org mode` 仍然保持可用
- `/org view` 展示新的成员能力和权限摘要
- `/org workflow` 能显示并行节点和汇总节点

### Phase 2

在 task workflow 上增强企业能力：

1. approval state
2. owner and approver model
3. persistence for work items
4. richer audit trail
5. domain-based routing

建议在这一阶段引入最小持久化：

- work items 保存到本地 JSON store
- audit trail 单独存储
- 审批状态可恢复

### Phase 3

单独实现行政版：

1. 建立 case workflow 目录
2. 引入状态机
3. 引入规则引擎
4. 引入材料清单模型
5. 做行政模板与 CLI 接口适配

建议 CLI 新增单独入口，而不是复用 `/org` 的全部语义：

- `/org` 保留任务型组织模式
- `/case` 或 `/gov` 用于行政事项模式

## Recommendation

如果只选一条主线优先落地，应先做小团队版。

原因：

1. 和现有实现最接近
2. 可复用当前 Agent 和工具调用主链路
3. 可以最快验证组织模式是否真有用户价值

企业版可以作为第二阶段，行政版应当作为第三阶段独立产品线处理。