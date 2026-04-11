# Browser Workflows

这个目录用于存放浏览器智能代理的 Markdown 流程文件。

设计目标：

- 类似 agent skills，但更聚焦网页自动化流程
- 用户可以按站点、页面类型或固定任务写专用流程
- 通过 `/browser agent ... --workflow <file>` 显式指定
- 也可以依赖 `browserAgent.autoMatchWorkflows` 按 `match` 自动命中

推荐格式：

```md
---
name: site-task-name
description: 简要说明这个网页流程解决什么问题
startUrl: https://example.com
match:
  - example.com
priority: 100
selectorSlots:
  searchBox:
    - input[type="search"]
    - input[name="q"]
  submitButton:
    - button[type="submit"]
    - input[type="submit"]
preferredSelectors:
  click:
    - $submitButton
  fill:
    - $searchBox
phases:
  search-input:
    steps:
      - Fill the search box with the query.
      - Submit the search.
    preferredSelectors:
      fill:
        - $searchBox
      click:
        - $submitButton
  search-results:
    steps:
      - Open the most relevant result card.
      - Extract result snippets or detail text.
    preferredSelectors:
      click:
        - a[href]
    doneConditions:
      - textIncludes:详情
fallbackActions:
  click:
    - press:Enter
    - wait:800
  fill:
    - fillSelf
    - press:Enter
doneConditions:
  - urlIncludes:/success
maxRetries: 2
---

# site-task-name

## When to Use
当用户需要在这个网站上完成什么任务时使用。

## Steps
1. 先做什么。
2. 再做什么。
3. 最后产出什么。

## Hints
- 优先点击哪个入口。
- 避免什么页面或弹窗。

## Selector Slots
- searchBox: input[type="search"]
- searchBox: input[name="q"]
- submitButton: button[type="submit"]
- submitButton: input[type="submit"]

## Preferred Selectors
- click: $submitButton
- fill: $searchBox

## Phase Steps
### search-input
1. 先在搜索框输入关键词。
2. 再提交搜索。

### search-results
1. 在结果列表里找到最相关的一项。
2. 点进详情或直接提取结果。

## Phase Preferred Selectors
### search-input
- fill: $searchBox
- click: $submitButton

### search-results
- click: a[href]
- extract: body

## Phase Done Conditions
### detail
- textIncludes:详情
- textIncludes:岗位描述

## Fallback Actions
- click: press:Enter
- click: wait:800
- fill: fillSelf

## Done Conditions
- urlIncludes:/success
- textIncludes:操作成功

## Success
- 满足哪些条件就算完成。
```

字段说明：

- `name`: 流程名称
- `description`: 流程描述
- `startUrl`: 可选，命令未指定 `--url` 时可作为默认入口
- `match`: 可选，域名、URL 子串或正则形式 `/.../`
- `priority`: 可选，自动匹配时优先级，越大越优先
- `selectorSlots`: 可选，定义具名 selector 槽位，例如 `searchBox`、`submitButton`，供 `preferredSelectors`、`fallbackActions` 和模型规划结果里的 `$slotName` 复用
- `preferredSelectors`: 可选，按动作类型提供候选 selector，当前支持 `click`、`fill`、`extract`
- `phases`: 可选，按页面阶段声明 phase-aware overrides，当前支持 `unknown`、`landing`、`search-input`、`search-results`、`detail`、`form`
- `fallbackActions`: 可选，按动作类型提供半确定性 fallback 模板，当前支持 `press:<key>`、`wait:<ms>`、`click:<selector>`、`fill:<selector>`、`clickSelf`、`fillSelf`
- `doneConditions`: 可选，满足时 browser-agent 会短路结束。当前支持 `urlIncludes:`、`titleIncludes:`、`textIncludes:`、`urlMatches:`、`textMatches:`
- `maxRetries`: 可选，限制 workflow 注入的 selector/fallback 尝试上限

phase-aware sections 约定：

- `## Phase Steps` / `## Phase Hints` / `## Phase Success` / `## Phase Selector Slots` / `## Phase Preferred Selectors` / `## Phase Fallback Actions` / `## Phase Done Conditions`
- 每个父 section 下用 `### search-input` 这类三级标题区分阶段
- phase 内的 selector slot 会与全局 slot 合并，phase 内的 preferredSelectors / fallbackActions / doneConditions 会在当前阶段额外叠加

命令示例：

- `/browser agent 帮我总结当前页面 --workflow browser-workflows/example-summary.md`
- `/browser agent 帮我在招聘站点筛选前端岗位 --url https://example.com`
- `/browser workflow list`
- `/browser workflow inspect browser-workflows/example-summary.md`
- `/browser workflow lint`
- `/browser workflow lint browser-workflows/example-summary.md`
- `/browser workflow new boss-zhipin-search --url https://www.zhipin.com --match zhipin.com`

第二条命令在配置开启 `autoMatchWorkflows` 且 `match` 命中时，会自动带上对应的流程提示。

校验建议：

- workflow 写完后先执行 `/browser workflow lint`，看有没有 schema error、phase 配置错误或 slot/doneCondition 级别的问题
- 如果只想看单个文件，用 `/browser workflow lint <file>`
- 如果后续要接前端或脚本，可用 `/browser workflow lint --json` 或 `/browser workflow lint <file> --json` 获取稳定 machine-readable 输出
- `list` 只会列出通过 schema 校验的 workflow；校验失败的文件会在 list 结果末尾单独列出