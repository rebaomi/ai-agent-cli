---
name: example-summary
description: 在 Example Domain 这类静态说明页上直接提取正文并给出总结
startUrl: https://example.com
match:
  - example.com
priority: 100
selectorSlots:
  mainBody:
    - body
preferredSelectors:
  extract:
    - $mainBody
doneConditions:
  - textIncludes:Example Domain
maxRetries: 2
---

# example-summary

## When to Use
当用户要总结、提取、概括当前说明页内容时使用，尤其适合只有少量正文、不需要复杂跳转的静态页面。

## Steps
1. 进入页面后优先观察正文，不要做多余跳转。
2. 直接提取 `body` 的主要文本内容。
3. 基于正文生成简洁总结。

## Hints
- 优先使用 extract，而不是反复点击。
- 如果页面标题和正文已经足够明确，可以尽快结束流程。

## Selector Slots
- mainBody: body

## Preferred Selectors
- extract: $mainBody

## Done Conditions
- textIncludes: Example Domain

## Success
- 返回页面核心信息的简短总结。
- 不进行与任务无关的额外导航。