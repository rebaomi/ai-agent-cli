# Browser Agent 重构接入计划

## 目标

在当前 Node.js + TypeScript 架构内，参考 browser-use 的核心思路，重做一套浏览器智能执行层。

约束如下：

- 不接 Python MCP，不引入外部 browser-use 运行时。
- 保留现有 open_browser 和 browser_automate 的确定性能力。
- 新增一层“智能浏览器代理”能力，用于处理未知页面、多步探索、弱结构网页操作。
- 优先优化两项成本：Token 消耗、单步延迟。
- 浏览器智能代理默认优先走本地 Ollama；仅当 Ollama 不可用时，回退到配置文件 defaultProvider。
- 代码按模块拆分，避免单文件过长与超长函数。

## 现状判断

当前浏览器链路分为两类：

- 直达打开：open_browser，适合打开网站、搜索结果页。
- 固定动作：browser_automate，适合已知 selector、已知流程的确定性动作。

当前缺口：

- 缺少页面状态抽象，无法像 browser-use 那样做连续观察与决策。
- 每一步没有“轻量判断”和“重型判断”分层，未来一旦引入视觉与页面摘要，成本会迅速升高。
- 缺少浏览器会话级记忆、循环检测、失败恢复、动作候选排序。

## 总体方案

新增 Browser Agent 子系统，采用三级执行架构：

1. 直达层：打开网页、打开搜索结果，零或低推理。
2. 确定性层：固定动作脚本，基于 Playwright 精准执行。
3. 智能层：页面观察、动作规划、状态压缩、最小必要视觉输入。

核心原则：

- 能不用模型就不用模型。
- 能不用截图就不用截图。
- 能局部观察就不做整页观察。
- 能复用上一步状态就不重新抽取。
- 能用本地模型先完成就不走远端模型。

## 分阶段计划表

| 阶段 | 模块 | 目标 | 主要产出 | 风险控制 |
| --- | --- | --- | --- | --- |
| P0 | 浏览器域模型 | 抽离统一状态与动作模型 | BrowserState、ActionProposal、ExecutionTrace、PageDigest | 只加新模块，不破坏现有工具 |
| P1 | 智能执行内核 | 建立 observe-plan-act 循环 | BrowserAgentRunner、StepPlanner、ActionExecutor | 默认关闭，通过配置开关启用 |
| P2 | 成本优化 | 降 Token 消耗 | DOM 摘要器、截图门控、局部视觉策略、状态缓存 | 保留全量调试模式作为回退 |
| P3 | 延迟优化 | 降低单步推理等待 | 轻量本地模型路由、动作批处理、并行预取、失败快速短路 | 设置最大推理时长与降级策略 |
| P4 | 模型回退 | 实现 Ollama 优先 | BrowserAgentModelRouter、Ollama 健康缓存 | 健康检查失败再切 defaultProvider |
| P5 | 接入主链路 | 与 direct action / planner 融合 | 智能浏览器意图、升级规则、配置项 | 简单任务仍走旧链路 |
| P6 | 可观测性 | 调试与回放 | step trace、成本统计、页面快照索引 | 不默认保存敏感截图 |

## 架构模块

建议新增模块：

- src/browser-agent/domain/
- src/browser-agent/state/
- src/browser-agent/observe/
- src/browser-agent/plan/
- src/browser-agent/act/
- src/browser-agent/router/
- src/browser-agent/model/
- src/browser-agent/cache/
- src/browser-agent/telemetry/

建议核心文件拆分：

- src/browser-agent/domain/types.ts
- src/browser-agent/domain/actions.ts
- src/browser-agent/state/browser-session-store.ts
- src/browser-agent/state/page-fingerprint.ts
- src/browser-agent/observe/dom-summarizer.ts
- src/browser-agent/observe/visual-decision-gate.ts
- src/browser-agent/observe/page-observer.ts
- src/browser-agent/plan/browser-step-planner.ts
- src/browser-agent/plan/action-ranker.ts
- src/browser-agent/plan/loop-detector.ts
- src/browser-agent/act/playwright-action-executor.ts
- src/browser-agent/act/fallback-action-executor.ts
- src/browser-agent/router/browser-agent-router.ts
- src/browser-agent/model/browser-agent-model-router.ts
- src/browser-agent/cache/browser-state-cache.ts
- src/browser-agent/telemetry/browser-agent-metrics.ts

## 关键优化设计

### 1. Token 优化

不要把“整页截图 + 全量文本”作为每一步默认输入，改成四级观察策略：

1. 零观察：如果是简单跳转、返回、已知站点搜索，直接执行。
2. DOM 轻摘要：提取标题、URL、可见按钮、输入框、主内容块，不带截图。
3. 局部视觉：仅在按钮语义不清、纯图标、Canvas、强前端渲染页面时补截图。
4. 全量视觉：只在连续失败、页面结构异常、验证码/复杂图形场景时启用。

具体技术措施：

- 页面指纹缓存：URL + title + 关键可交互元素 hash。
- 摘要缓存：页面未明显变化时不重复摘要。
- 差量观察：只把“新增元素、消失元素、关键区域变化”发给模型。
- 动作结果压缩：上一步结果转为结构化 trace，不回传冗长原文。
- 局部截图：优先元素截图或可视区截图，不做 fullPage。
- 低成本抽取模型：DOM 结构归纳和可点击项整理优先交给本地小模型或规则器。

### 2. 延迟优化

每一步推理拆成快慢两档：

- Fast Path：规则、缓存、轻量模型做快速决策。
- Deep Path：只有不确定时才调用更强模型。

具体技术措施：

- 规则优先：表单、搜索框、登录按钮、下一页按钮等用规则模板先匹配。
- 批动作输出：允许一次规划 2 到 3 个低风险动作，减少逐步来回。
- 异步预取：页面加载时并行抓标题、表单元素、按钮列表。
- 失败短路：连续 2 次同类失败不再继续重试，直接重规划。
- 会话复用：保留同一个浏览器上下文，避免频繁新开实例。
- Ollama 本地优先：简单规划先走本地小模型。

## 模型路由方案

新增 browserAgent 专用配置段，建议如下：

```yaml
browserAgent:
  enabled: true
  mode: smart
  preferredLocalProvider: ollama
  fallbackProvider: default
  ollamaHealthCheckUrl: http://localhost:11434/api/tags
  ollamaHealthCacheMs: 15000
  plannerModel: qwen3.5:7b
  extractorModel: qwen3.5:3b
  visionProvider: default
  maxSteps: 20
  maxActionsPerPlan: 3
  observe:
    useScreenshotByDefault: false
    forceScreenshotAfterFailures: 2
    fullPageScreenshot: false
    maxDomNodes: 120
    maxTextChars: 4000
  optimization:
    enableStateCache: true
    enableDiffObservation: true
    enableRuleFastPath: true
    enableActionBatching: true
  debug:
    saveTrace: true
    saveScreenshotsOnFailure: true
```

模型选择规则：

1. Browser Agent 默认先检查 Ollama 健康。
2. 若 Ollama 可用，则优先使用 browserAgent.preferredLocalProvider 对应模型。
3. 若 Ollama 不可用，则回退到默认 defaultProvider。
4. 若任务是视觉重型页面，允许视觉模型单独走 defaultProvider。
5. 普通文本规划与 DOM 摘要尽量不走远端模型。

## 建议借鉴的 23 种设计模式

不是为了“凑齐 23 个名字”，而是让每种模式在模块里各司其职。

| 模式 | 用途 | 对应模块 |
| --- | --- | --- |
| Abstract Factory | 统一创建本地/远端/视觉模型客户端 | browser-agent/model |
| Factory Method | 创建不同页面观察器与动作执行器 | observe, act |
| Builder | 构建 StepContext、PromptContext、PageDigest | observe, plan |
| Prototype | 复制已有会话状态与动作模板 | state |
| Singleton | 模型健康缓存、全局浏览器资源池 | model, state |
| Adapter | 适配现有 open_browser 和 browser_automate | router |
| Bridge | 解耦页面观察与模型推理实现 | observe + model |
| Composite | 组织多动作计划与子步骤树 | plan |
| Decorator | 给模型调用叠加缓存、日志、限流、成本统计 | model, telemetry |
| Facade | 向主系统暴露统一 BrowserAgentService | browser-agent/index |
| Flyweight | 复用元素摘要、页面指纹、动作模板 | cache |
| Proxy | 模型调用代理，支持 Ollama 健康探测与回退 | model |
| Chain of Responsibility | 执行动作升级链：规则 -> 确定性 -> 智能 | router |
| Command | 标准化 click/fill/scroll/extract 等动作对象 | domain/actions |
| Interpreter | 解析用户浏览器任务 DSL 与页面规则 | router, plan |
| Iterator | 遍历候选元素、计划步骤、历史 trace | plan |
| Mediator | 协调 observer、planner、executor、cache | BrowserAgentRunner |
| Memento | 保存每一步页面状态快照用于恢复 | state |
| Observer | 订阅页面变化、执行结果、失败事件 | telemetry, state |
| State | 管理 idle/observing/planning/acting/replanning | runner |
| Strategy | 切换摘要策略、截图策略、模型路由策略 | observe, model |
| Template Method | 固定 observe-plan-act 主循环骨架 | runner |
| Visitor | 对页面元素树做摘要、筛选、打分 | observe |

## 主执行链路

```text
User Task
  -> BrowserIntentClassifier
  -> BrowserExecutionRouter
      -> DirectOpenStrategy
      -> DeterministicAutomationStrategy
      -> SmartBrowserAgentStrategy
          -> PageObserver
          -> StepPlanner
          -> ActionExecutor
          -> LoopDetector
          -> TraceStore
```

## 接入规则

以下任务继续走旧链路：

- 打开某网站
- 打开搜索结果页
- 已知 selector 的点击/输入
- 简单 Doubao 输入框填充

以下任务升级到智能浏览器代理：

- 未知页面结构
- 多步网页任务
- 需要理解页面内容后再决定动作
- 前一步失败后需要重规划
- 用户明确要求“自动完成整个网页流程”

## 配置改造计划

涉及文件：

- src/core/config.ts
- src/llm/factory.ts
- src/llm/types.ts
- config.example.yaml

新增内容：

- browserAgent 配置段
- Ollama 健康检查缓存配置
- plannerModel / extractorModel / visionProvider 配置
- 观察策略与调试策略配置

## 实现顺序建议

第一批只做骨架，不碰复杂视觉：

1. 域模型与会话状态
2. BrowserAgentRunner 主循环
3. DOM 轻摘要器
4. 本地 Ollama 优先模型路由
5. 规则优先 + 确定性回退 + 智能升级链

第二批再做成本与延迟优化：

1. 差量观察
2. 动作批处理
3. 局部截图门控
4. 循环检测
5. Trace 与成本统计

第三批再做高级能力：

1. 视觉补偿
2. 页面模式库
3. 任务 DSL
4. 学习型动作模板

## 非目标

当前阶段不做：

- Python sidecar
- MCP 接入
- 云端 browser-use SDK 对接
- 全站点通用视觉自动化一次性打满

## 验收标准

第一阶段验收：

- 能识别何时该升级到智能浏览器代理
- 简单任务仍然比现在更快，不更慢
- Ollama 在线时默认使用本地模型
- Ollama 不在线时可自动回退 defaultProvider
- 单步输入上下文较当前“截图 + 全量文本”方案明显缩小
- 代码按模块拆分，无超长单文件与超长函数
