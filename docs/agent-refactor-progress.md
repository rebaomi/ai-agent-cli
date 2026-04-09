# Agent Refactor Progress

## Scope

这份文档记录当前 agent 主链路重构的目标、已完成项、现状和下一步，不覆盖 organization mode 与 run kernel 两条独立方案文档。

当前这轮重构主要聚焦两件事：

1. 缩小 `src/core/agent.ts`，把单轮响应、known-gap、skill learning 等职责拆成组件。
2. 缩小 `src/core/direct-action-router.ts`，把 direct-action 的识别、路径推导、导出决策、已知缺口提示、Lark 工作流支持拆成更细的 support / handler 层。

## Refactor Goals

- 保持 agent 仍然是 agent，不破坏原有能力闭环。
- 把 `agent.ts` 收敛为编排入口，而不是大而全实现。
- 把 `direct-action-router.ts` 收敛为 direct-action orchestration layer。
- 用回归测试封住拆分后的关键行为，减少后续回归成本。

## Completed

### Agent Main Loop

- 已拆出单轮响应相关组件：
  - `src/core/response-stream-collector.ts`
  - `src/core/final-response-assembler.ts`
  - `src/core/response-turn-executor.ts`
  - `src/core/response-turn-processor.ts`
- `src/core/agent.ts` 已接线到新的 response-turn 组件。
- 已继续从 `src/core/agent.ts` 抽出规划入口相关组件：
  - `src/core/planned-tool-args-resolver.ts`
  - `src/core/plan-execution-service.ts`
  - `src/core/agent-interaction-service.ts`
  - `src/core/agent-planning-service.ts`
- 已继续从 `src/core/agent.ts` 抽出任务结果汇总与归档组件：
  - `src/core/task-synthesis-service.ts`
- 已继续从 `src/core/agent.ts` 抽出 tool call bridge 组件：
  - `src/core/agent-tool-call-service.ts`
- 已继续从 `src/core/agent.ts` 抽出构造期组件装配工厂：
  - `src/core/agent-runtime-factory.ts`
- 已继续从 `src/core/agent.ts` 抽出 plan 恢复与 planned tool-call 编排组件：
  - `src/core/agent-plan-runtime-service.ts`
- 已继续从 `src/core/agent.ts` 抽出消息视图与工具执行日志组件：
  - `src/core/agent-message-view-service.ts`
  - `src/core/agent-tool-execution-logger.ts`
- 已继续清理 `src/core/agent.ts` 中历史过渡桥接与冗余 runtime 组件缓存字段，减少仅赋值不再读取的外壳噪音。
- 已继续收窄 `src/core/agent-runtime-factory.ts` 的返回面，只向 `agent.ts` 暴露仍被主外壳实际消费的核心 runtime 组件，并同步移除 `agent.ts` 中残留的无效导入与未再使用的 planning 薄桥接。
- 已继续把 planning / plan-runtime / plan-execution 之间原先经由 `agent.ts` 回传的内部桥接回调收回 `src/core/agent-runtime-factory.ts` 内部装配，进一步减少 `agent.ts` 里“传给 factory 再转回来”的 execution 壳层方法。
- 已继续清理 `src/core/agent.ts` 中仅构造期使用一次的运行时字段，并把默认 system prompt 里的 skills 描述读取内联到实际消费点，移除不再被外部使用的 skill 访问薄方法。
- 已继续把默认 Agent system prompt 生成逻辑从 `src/core/agent.ts` 提取到独立 helper，减少主外壳中的长模板拼装噪音。
- 已继续把 `agent.ts` 内重复的响应轮次状态重置收敛为私有 helper，并移除构造期专用的 `maxIterations` 实例字段。
- 已恢复少量仍被回归夹具依赖的 Agent 兼容公开面（如 `getMessagesForLLM`、`detectComplexTask`、`synthesizeResults`），兼容入口改为薄代理，不回退之前已经完成的内部职责下沉。
- 已继续把 skill tool 执行结果归一化抽成共享 helper，消除 `tool-executor` 与 direct-action tool-support 之间重复的错误文案归一化与文本结果拼装逻辑。
- 已继续把 CLI 版本号、帮助文案与启动参数帮助判定抽到独立 helper，并为 `/help`、`/h`、`/?` 启动参数增加短路输出路径。
- 已补 CLI shell text 与 Agent 兼容公开面相关回归，避免后续继续重构时再次打掉 `getMessagesForLLM`、`detectComplexTask`、`synthesizeResults` 或 CLI 启动帮助判定。
- 当前 `agent.ts` 已把复杂度判定、plan 执行、pending interaction、planning 入口、任务结果汇总与归档、tool call parse/prepare/execute bridge、plan 恢复与计划工具执行编排都下沉到独立 service / factory。

### Known Gap / Skill Learning

- 已从 `src/core/agent.ts` 抽出：
  - `src/core/known-gap-manager.ts`
  - `src/core/skill-learning-service.ts`
- 相关回归已从“直接测 Agent 私有方法”切到组件级测试。

### Direct Action Router

- 已抽出 direct-action support 组件：
  - `src/core/direct-actions/artifact-support.ts`
  - `src/core/direct-actions/export-support.ts`
  - `src/core/direct-actions/known-gap-support.ts`
  - `src/core/direct-actions/document-export-verifier.ts`
- 已把 Lark 发送工作流继续留在独立工作流实现：
  - `src/core/workflows/lark-delivery.ts`
- 已新增 direct-action handler 分层：
  - `src/core/direct-actions/handlers/file-action-handler.ts`
  - `src/core/direct-actions/handlers/document-action-handler.ts`
  - `src/core/direct-actions/handlers/external-search-handler.ts`
  - `src/core/direct-actions/handlers/lark-workflow-handler.ts`
- 已继续抽出 direct-action 构造期组件装配工厂：
  - `src/core/direct-action-runtime-factory.ts`
- 已继续抽出 direct-action dispatch 与 legacy fallback 组件：
  - `src/core/direct-action-dispatch-service.ts`
  - `src/core/direct-actions/legacy-fallback-service.ts`
- 已继续清理 `src/core/direct-action-router.ts` 中仅一层转发的 Lark workflow 私有桥接，使 router 更接近纯 dispatch shell。
- 已继续把 `src/core/direct-actions/runtime-context.ts` 从单个大接口按 handler 实际使用面拆为更窄的 runtime 接口，降低 handler 对共享上下文的耦合。
- 已继续把 `src/core/direct-action-runtime-factory.ts` 从统一 runtime wrapper 类 + 大块内联 lambda，收敛为按职责分组构建的 plain runtime 对象与 helper builder。
- 已继续把 `src/core/direct-action-runtime-factory.ts` 的顶层 support / handler runtime 装配再分成 bundle helper，并同步压薄 `src/core/direct-action-router.ts` 中仅用于保存装配中间态的字段。

### Regression Coverage

- 已补 response-turn 基础回归。
- 已补 known-gap / skill-learning 组件回归。
- 已补 direct-action support 定向回归。
- 已补一条 response-turn continuation 回归，确保工具调用接管时不会提前 finalize。
- 已补 task synthesis service 回归，封住结果汇总与 memory archive 行为。
- 已补 agent tool-call service 回归，封住占位符解析、工具执行与 reusable content 回写链路。
- 已为回归脚本补充可选 trace 开关，便于后续定位长链路静默卡点而不影响默认输出。
- 已清理并同步多条与当前实现不一致的历史回归断言，包括 direct-action 权限夹具、DeepSeek 路由基线、placeholder/tool message 夹具、Windows 路径断言与 plan failure 夹具。

### Stability Fixes

- 已修复 PDF 导出链路在 Windows 下可能卡住的问题：
  - `src/utils/pdf-export.ts` 不再为子进程保留未消费的 stdout pipe
  - 为 headless 浏览器打印引入隔离 `user-data-dir`
  - 为浏览器打印增加超时保护，避免整条 direct-action / regression 被无限挂起

## Current Status

### Agent Side

- 当前 scope 内的主体重构已完成，`agent.ts` 已收敛为以运行期必要状态、兼容公开面和编排入口为主的薄外壳。
- planning 入口、task synthesis / archive、tool-call bridge、plan runtime、message view、tool execution logging 与 runtime component wiring 已完成 service / factory 化。
- 当前剩余仅是可选的进一步美化型收敛，不再属于这轮主链路重构的必做项。

### Direct Action Side

- 当前 scope 内的 direct-action 主链路重构已完成。
- 构造期 wiring 已下沉到 runtime factory，handler loop 已下沉到 dispatch service，legacy tool / skill fallback 已从 `tool-support` 拆出，router 本体已接近 dispatch shell。
- 最近一次修复重点是 recent artifact 误判：
  - “把刚刚的内容保存成 ppt” 不应被错误识别为“把最近生成的 csv 当源文件转换”。
- direct-action 的 PPTX 路径回归问题已排除。

## Open Items

- 当前主链路重构 scope 已完成。
- 后续如继续推进，属于可选的增量美化：例如进一步压缩少量兼容桥接、继续统一更多 support utility，或顺手修整 CLI 参数帮助的用户体验细节。

## Next Steps

1. 当前主链路重构可以收口，后续改动建议按独立小主题推进，而不是继续大范围拆分。
2. 如果后续继续演进，优先以新增测试覆盖或体验修整为主，而不是继续大规模搬动主链路结构。

## Validation Snapshot

- `npm.cmd run build`: 通过
- `npm.cmd run typecheck`: 通过
- `npm.cmd run test:regression`: 通过
- CLI 冒烟：`node dist/cli/index.js /help` 可启动到交互提示符，并能正确处理 `/help`。
- CLI 源码级参数冒烟：`npx.cmd tsx src/cli/index.ts /help` 会直接输出帮助；`npx.cmd tsx src/cli/index.ts --version` 输出 `1.3.0`。
