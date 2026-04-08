# Phase 1 Run Kernel Implementation Draft

## Goal

Phase 1 only solves one problem: turn the current confirmed-plan execution path into a persistent run model that can be resumed.

This phase does not attempt to introduce:

- multi-agent orchestration
- full background job queues
- capability registry refactor
- large Tool Registry redesign

The target outcome is:

1. a confirmed plan is materialized into a persistent run
2. each plan step becomes a persistent step run
3. execution writes step status, events, and checkpoints
4. failed runs can be resumed without replaying completed steps

## Existing Anchors

These are the current code points Phase 1 must attach to.

- Plan creation: [src/core/planner.ts](src/core/planner.ts)
- Plan execution loop: [src/core/agent.ts](src/core/agent.ts#L617)
- Tool execution: [src/core/agent.ts](src/core/agent.ts#L1503)
- Cron trigger: [src/core/cron-manager.ts](src/core/cron-manager.ts#L115)
- Current task persistence: [src/core/task-manager.ts](src/core/task-manager.ts)

## New Files

### 1. [src/core/run-types.ts](../src/core/run-types.ts)

Purpose:

- hold all run and step-run types
- keep the first-phase data model stable and explicit
- avoid leaking ad-hoc object shapes across Agent, Planner, and TaskManager

Recommended contents:

```ts
export type WorkflowRunSource = 'chat' | 'cron' | 'direct' | 'resume';

export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export type StepRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export type RunEventType =
  | 'run_created'
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'tool_called'
  | 'tool_succeeded'
  | 'tool_failed'
  | 'checkpoint_saved'
  | 'resumed';

export interface RunCheckpoint {
  stepRunId: string;
  lastToolCallId?: string;
  lastToolName?: string;
  lastToolArgs?: Record<string, unknown>;
  lastToolOutput?: string;
  savedAt: number;
}

export interface StepRun {
  id: string;
  runId: string;
  planStepId: string;
  title: string;
  status: StepRunStatus;
  attempt: number;
  input?: string;
  output?: string;
  lastError?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  artifacts?: string[];
  checkpoint?: RunCheckpoint;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowRun {
  id: string;
  source: WorkflowRunSource;
  originalTask: string;
  planId?: string;
  status: WorkflowRunStatus;
  currentStepIndex: number;
  stepOrder: string[];
  resultSummary?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface RunEvent {
  id: string;
  runId: string;
  stepRunId?: string;
  type: RunEventType;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface CreateRunInput {
  source: WorkflowRunSource;
  originalTask: string;
  planId?: string;
  steps: Array<{
    planStepId: string;
    title: string;
    input?: string;
    toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  }>;
  metadata?: Record<string, unknown>;
}
```

### 2. [src/core/run-store.ts](../src/core/run-store.ts)

Purpose:

- persist runs independently of the existing task/team/inbox store
- keep first-phase migration low-risk by avoiding deep changes to store.json

Recommended storage layout:

- `~/.ai-agent-cli/runs/runs.json`
- `~/.ai-agent-cli/runs/step-runs.json`
- `~/.ai-agent-cli/runs/events.json`

Recommended API:

```ts
export class RunStore {
  constructor(storeDir?: string)

  async initialize(): Promise<void>

  async createRun(input: CreateRunInput): Promise<{ run: WorkflowRun; steps: StepRun[] }>
  getRun(id: string): WorkflowRun | undefined
  listRuns(status?: WorkflowRunStatus): WorkflowRun[]
  async updateRun(id: string, updates: Partial<WorkflowRun>): Promise<WorkflowRun | null>

  getStepRuns(runId: string): StepRun[]
  getStepRun(runId: string, stepRunId: string): StepRun | undefined
  async updateStepRun(runId: string, stepRunId: string, updates: Partial<StepRun>): Promise<StepRun | null>

  async appendRunEvent(event: Omit<RunEvent, 'id' | 'createdAt'>): Promise<RunEvent>
  listRunEvents(runId: string): RunEvent[]
}
```

Implementation notes:

- keep everything in memory after initialize and flush with save methods
- use separate arrays for runs, stepRuns, events
- sort read views by updatedAt descending for runs and createdAt ascending for events
- do not over-optimize indexes in phase 1

### 3. [src/core/run-serializer.ts](../src/core/run-serializer.ts)

Purpose:

- convert an existing `Plan` from Planner into a `CreateRunInput`
- keep mapping logic out of Agent and Planner bodies

Recommended API:

```ts
import type { Plan } from './planner.js';
import type { CreateRunInput, WorkflowRunSource } from './run-types.js';

export function materializePlanToRun(
  originalTask: string,
  plan: Plan,
  source: WorkflowRunSource,
  metadata?: Record<string, unknown>,
): CreateRunInput
```

Mapping rules:

- `plan.id -> planId`
- `plan.steps[].id -> planStepId`
- `plan.steps[].description -> title`
- `plan.steps[].toolCalls -> toolCalls`
- include `confirmedPlan` summary in metadata when called from a confirmed plan path

### 4. [src/core/execution-coordinator.ts](../src/core/execution-coordinator.ts)

Purpose:

- own run execution and resume orchestration
- keep Agent from becoming a permanent state machine god object

Recommended API:

```ts
export interface ExecutionCoordinatorOptions {
  agent: Agent;
  taskManager: TaskManager;
}

export class ExecutionCoordinator {
  constructor(options: ExecutionCoordinatorOptions)

  async executeRun(runId: string): Promise<string>
  async resumeRun(runId: string): Promise<string>
}
```

Phase 1 rule:

- do not extract all execution logic on day one
- it is acceptable to let `executeRun()` call back into `agent.executePlanStepRun(...)`
- the first goal is stable persistence boundaries, not perfect layering

## Existing Files To Modify

### 1. [src/core/task-manager.ts](../src/core/task-manager.ts)

Do not remove or rename current task APIs.

Add:

```ts
private runStore: RunStore;

async createRun(input: CreateRunInput): Promise<WorkflowRun>
getRun(id: string): WorkflowRun | undefined
listRuns(status?: WorkflowRunStatus): WorkflowRun[]
async updateRun(id: string, updates: Partial<WorkflowRun>): Promise<WorkflowRun | null>

getStepRuns(runId: string): StepRun[]
getStepRun(runId: string, stepRunId: string): StepRun | undefined
async updateStepRun(runId: string, stepRunId: string, updates: Partial<StepRun>): Promise<StepRun | null>

async appendRunEvent(event: Omit<RunEvent, 'id' | 'createdAt'>): Promise<RunEvent>
listRunEvents(runId: string): RunEvent[]
```

Minimal integration strategy:

- initialize `runStore` in the constructor
- call `await this.runStore.initialize()` inside `initialize()`
- keep the existing `store.json` untouched
- do not merge runs into `TaskStore`

This is intentionally conservative. Phase 1 is not the time to rewrite task persistence.

### 2. [src/core/planner.ts](../src/core/planner.ts)

Do not change:

- `createPlan(task: string): Promise<Plan>`

Add:

```ts
materializePlan(
  task: string,
  plan: Plan,
  source: WorkflowRunSource = 'chat',
  metadata?: Record<string, unknown>,
): CreateRunInput
```

Implementation:

- delegate to `materializePlanToRun()` from `run-serializer.ts`
- keep Planner responsible for plan generation, not execution persistence

### 3. [src/core/agent.ts](../src/core/agent.ts)

Keep current external behavior intact, but introduce these changes.

#### Keep as adapter

Current method:

- [src/core/agent.ts](../src/core/agent.ts#L617) `executePlan(originalTask, plan)`

Recommended behavior after patch:

1. materialize plan into run input
2. create persistent run via task manager
3. delegate actual execution to `executeRun(run.id)`

Add:

```ts
async executeRun(runId: string): Promise<string>
```

Add internal helper:

```ts
private async executeRunStep(
  runId: string,
  stepRunId: string,
  originalTask: string,
  totalSteps: number,
): Promise<string>
```

#### Required signature changes

Current:

- [src/core/agent.ts](../src/core/agent.ts#L1503) `executeToolCall(toolCall: ToolCall)`

Change to:

```ts
private async executeToolCall(
  toolCall: ToolCall,
  context?: { runId?: string; stepRunId?: string },
): Promise<ToolResult>
```

Current:

- [src/core/agent.ts](../src/core/agent.ts#L1655) `prepareToolCallsForExecution(...)`

Change to:

```ts
private async prepareToolCallsForExecution(
  userInput: string,
  assistantContent: string,
  toolCalls: ToolCall[],
  useModelContract: boolean,
  context?: { runId?: string; stepRunId?: string },
)
```

Why now:

- step-level checkpoints need run context at the tool execution boundary
- if this is not added in phase 1, phase 2 will have to change the same signatures again

#### New helper boundaries

Recommended internal helper methods to add now:

```ts
private async recordRunStarted(runId: string): Promise<void>
private async recordStepStarted(runId: string, stepRunId: string): Promise<void>
private async recordStepCompleted(runId: string, stepRunId: string, output: string): Promise<void>
private async recordStepFailed(runId: string, stepRunId: string, error: string): Promise<void>
private async saveToolCheckpoint(
  runId: string,
  stepRunId: string,
  toolCall: ToolCall,
  result: ToolResult,
): Promise<void>
```

Do not over-abstract. These helpers can live in Agent during phase 1.

### 4. [src/core/cron-manager.ts](../src/core/cron-manager.ts)

Keep this signature unchanged in phase 1:

```ts
async runDueJobs(now = new Date()): Promise<void>
```

Keep this executor shape unchanged in phase 1:

```ts
type CronExecutor = (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>
```

But change executor semantics in CLI wiring later.

Current wiring site:

- [src/cli/index.ts](../src/cli/index.ts#L219)

Phase 1 target behavior:

- cron should create a run and execute it
- cron should no longer be conceptually treated as a direct tool call path

This lets you ship resumable cron without rewriting CronManager itself.

## First-Phase Commit Order

### Commit 1

Title:

`feat: add persistent workflow run types and store`

Files:

- add [src/core/run-types.ts](../src/core/run-types.ts)
- add [src/core/run-store.ts](../src/core/run-store.ts)
- update [src/core/task-manager.ts](../src/core/task-manager.ts)

Patch contents:

1. add run types
2. implement in-memory + json persistence for runs, stepRuns, events
3. expose run API through TaskManager
4. do not touch Planner or Agent yet

Acceptance:

- build passes
- temporary script or regression can create and read a run

### Commit 2

Title:

`feat: materialize planner output into workflow runs`

Files:

- add [src/core/run-serializer.ts](../src/core/run-serializer.ts)
- update [src/core/planner.ts](../src/core/planner.ts)

Patch contents:

1. add `materializePlanToRun()`
2. add `planner.materializePlan()`
3. keep `createPlan()` unchanged

Acceptance:

- any existing `Plan` can be turned into `CreateRunInput`
- no current chat flow changes yet

### Commit 3

Title:

`feat: route confirmed plan execution through workflow runs`

Files:

- add [src/core/execution-coordinator.ts](../src/core/execution-coordinator.ts)
- update [src/core/agent.ts](../src/core/agent.ts)

Patch contents:

1. make `executePlan()` create a run first
2. add `executeRun(runId)`
3. reuse existing step-loop logic but feed it from stored step runs
4. write run and step status changes

Acceptance:

- confirmed plans still execute end-to-end
- run records are visible on disk

### Commit 4

Title:

`feat: persist tool checkpoints and run events`

Files:

- update [src/core/agent.ts](../src/core/agent.ts)

Patch contents:

1. add run context to `executeToolCall()`
2. add run context to `prepareToolCallsForExecution()`
3. write `tool_called`, `tool_succeeded`, `tool_failed`
4. save checkpoint on every successful tool result

Acceptance:

- a failed step shows which tool failed
- step checkpoint shows the last successful tool boundary

### Commit 5

Title:

`feat: add resume support for failed workflow runs`

Files:

- update [src/core/execution-coordinator.ts](../src/core/execution-coordinator.ts)
- update [src/core/agent.ts](../src/core/agent.ts)
- update [src/core/task-manager.ts](../src/core/task-manager.ts)

Patch contents:

1. add `resumeRun(runId)`
2. detect next resumable step from run state
3. skip already completed steps

Acceptance:

- resuming a failed run continues from the failed or next pending step

### Commit 6

Title:

`feat: route cron triggers through workflow runs`

Files:

- update [src/cli/index.ts](../src/cli/index.ts)
- optionally update [src/core/cron-manager.ts](../src/core/cron-manager.ts)

Patch contents:

1. change cron executor wiring to create and execute runs
2. change cron notifier to print run summary instead of raw tool-only summary

Acceptance:

- `create-news` and Lark news cron flows still work
- each cron fire produces a resumable run record

## Exact Function Signature Changes

These are the only signature changes recommended in phase 1.

### In Agent

```ts
private async executeToolCall(
  toolCall: ToolCall,
  context?: { runId?: string; stepRunId?: string },
): Promise<ToolResult>
```

```ts
private async prepareToolCallsForExecution(
  userInput: string,
  assistantContent: string,
  toolCalls: ToolCall[],
  useModelContract: boolean,
  context?: { runId?: string; stepRunId?: string },
): Promise<{
  contract: IntentContract;
  toolCalls: ToolCall[];
  rejections: RejectedToolCall[];
}>
```

### In Planner

```ts
materializePlan(
  task: string,
  plan: Plan,
  source?: WorkflowRunSource,
  metadata?: Record<string, unknown>,
): CreateRunInput
```

### In TaskManager

```ts
async createRun(input: CreateRunInput): Promise<WorkflowRun>
getRun(id: string): WorkflowRun | undefined
listRuns(status?: WorkflowRunStatus): WorkflowRun[]
async updateRun(id: string, updates: Partial<WorkflowRun>): Promise<WorkflowRun | null>
getStepRuns(runId: string): StepRun[]
getStepRun(runId: string, stepRunId: string): StepRun | undefined
async updateStepRun(runId: string, stepRunId: string, updates: Partial<StepRun>): Promise<StepRun | null>
async appendRunEvent(event: Omit<RunEvent, 'id' | 'createdAt'>): Promise<RunEvent>
listRunEvents(runId: string): RunEvent[]
```

## Minimal Migration Strategy

Phase 1 should follow these rules.

1. Do not migrate `TaskStore` in-place.
Use a separate run store.

2. Do not rewrite `executePlan()` from scratch.
Wrap the existing plan loop inside a run-aware adapter first.

3. Do not build tool-level resume initially.
Resume at step boundary first.

4. Do not introduce new slash commands until the core run path is stable.
Run inspection commands can come after commit 3 or 4.

## Minimal Test Checklist

### After Commit 1

- createRun writes a run and stepRuns to disk
- listRuns returns the created run
- updateStepRun changes status and persists it

### After Commit 2

- createPlan + materializePlan produces stable step mapping
- toolCalls survive serialization unchanged

### After Commit 3

- executePlan still returns a synthesized final response
- run status becomes completed on success
- failed step marks run failed

### After Commit 4

- tool_called and tool_succeeded events appear
- checkpoint is saved after each successful tool call

### After Commit 5

- resumeRun continues from failed step
- completed steps are not rerun

### After Commit 6

- cron-created early morning news push produces a run
- cron notifier prints run outcome summary

## Recommended First Cut

If starting implementation immediately, begin with Commit 1 only.

The safest first patch order is:

1. add [src/core/run-types.ts](../src/core/run-types.ts)
2. add [src/core/run-store.ts](../src/core/run-store.ts)
3. extend [src/core/task-manager.ts](../src/core/task-manager.ts) with run APIs
4. build and verify with a minimal smoke path

Do not touch Agent until that layer is stable.