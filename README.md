# AI Agent CLI

> ⚠️ **目前测试中，欢迎提 [Issue](https://github.com/rebaomi/ai-agent-cli/issues)**

**[简体中文](#简体中文) | [English](#english)**

---

## 简体中文

一个以 Agent 为主、以 deterministic direct action 为辅的智能编程助手 CLI。

当前系统的核心原则是：

- 能靠确定规则直接完成的一步操作，走 direct action
- 需要理解、检索、规划、生成内容的请求，必须回到 agent 主链路
- 工具调用统一经过 Tool Registry、权限控制、意图校验与回归约束

这意味着它不是“见到关键词就触发工具”的脚本集合，而是一个带执行边界的 agent runtime。

### 特性

- 🤖 **多模型支持** - 支持 Ollama、DeepSeek、Kimi、GLM、Doubao、MiniMax、GPT、Claude、Gemini，以及 Hybrid 混合路由
- 🧠 **Agent 主链路已模块化** - 响应轮次、tool-call bridge、planning、plan runtime、task synthesis、known-gap、skill learning 已拆成独立组件
- ⚡ **Direct Action 边界明确** - 仅处理确定性请求，例如“把刚刚结果发飞书”“把内容导出成 docx”“抓腾讯新闻并推送”
- 🧰 **统一 Tool Registry** - 内置工具、Skills 工具、MCP 工具统一注册、分发、归一化结果
- 🛡️ **工具调用保护链** - 权限控制、intent contract、占位符解析、结果后处理、回归校验统一生效
- 📊 **任务规划与恢复** - 复杂任务自动拆分计划，支持暂停、补充信息、恢复执行
- 💬 **交互式对话** - 类 Claude Code 的命令行界面
- ⌨️ **命令补全与输入历史** - 支持 Tab 补全 slash 命令与二级子命令，支持上下键浏览并持久化历史输入
- 💾 **长期+短期记忆** - 本地 Memory Palace + 可选 MemPalace MCP 长期记忆后端
- 🌊 **流式输出** - AI 回复逐字显示，打字机效果
- 🔌 **MCP 协议** - 接入 Model Context Protocol 服务器
- 📝 **LSP 支持** - Language Server Protocol 代码智能提示
- 🎯 **Skills 系统** - 安装、启用、学习和转正第三方技能扩展
- 🛡️ **安全沙箱** - 文件、命令、浏览器、网络操作均在受控环境与权限模型下运行
- 📨 **任务与轻量协作工具** - 本地 Task、Team、Peer 消息、Cron 调度统一接入
- 🏢 **多 Agent 组织架构** - 模拟企业团队协作，多角色 Agent 协同工作
- 🐱 **AgentCat 电子宠物** - 健康提醒助手，提醒喝水、休息、运动
- 📋 **任务进度追踪** - 实时查看任务执行进度和状态
- 🔄 **多模型对比** - 同时调用多个模型，综合分析给出最佳答案
- 👤 **用户画像系统** - 记住用户偏好，完善用户画像，提供个性化服务
- 🛡️ **内容安全过滤** - 自动过滤不当内容，维护健康交流环境
- 🔐 **权限管理系统** - 细粒度控制文件、网络、命令执行权限，交互式授权确认

### 当前执行路径

当前版本会先判断请求属于哪条路径，再决定是否规划或直接执行：

1. **Direct Action**
  适合一步、确定性、无需语义推理的操作，例如：
  - 读取明确文件
  - 把刚生成的内容导出成 pdf/docx/pptx/xlsx
  - 把已有正文、已有附件、新闻结果发送到飞书

2. **Agent 主链路**
  适合理解、检索、规划、生成内容后再执行的请求，例如：
  - “解释一下这首诗，再发我飞书”
  - “先搜资料，整理成周报，再发出去”
  - “修改代码、跑测试、总结结果”

3. **Planner / Plan Runtime**
  当任务是多步骤或带依赖的复合流程时，会自动生成计划、等待确认、逐步执行，并支持中断恢复。

### 重构后的架构概览

这轮重构的目标不是增加新功能，而是把原本过大的主链路拆成稳定、可测试的运行时组件。

- **Agent 外壳**：收敛为编排入口、状态管理和兼容公开面
- **Response Turn**：单轮响应拆成 collector、processor、executor、final assembler
- **Planning Runtime**：planning、plan execution、plan resume、pending interaction 分离
- **Tool Call Bridge**：工具调用解析、意图契约校验、执行与结果回写分层
- **Direct Action Runtime**：router、dispatch、handler、support、legacy fallback 分层
- **Lark Delivery Workflow**：飞书发送保留在独立 workflow，只接确定性发送场景

如果你想看更细的拆分清单，可参考 [docs/agent-refactor-progress.md](docs/agent-refactor-progress.md)。

### 🚀 快速开始

**1. 准备运行环境**

要求：

- Node.js 20+
- npm
- 如果使用本地模型，准备 Ollama

本地模型用户先启动 Ollama：

```bash
ollama serve
ollama pull qwen3.5:9b
```

**2. 安装并构建 CLI**

Windows:
```bash
git clone https://github.com/rebaomi/ai-agent-cli.git
cd ai-agent-cli
npm install
npm run build
npm link
```

Linux / Mac:
```bash
git clone https://github.com/rebaomi/ai-agent-cli.git
cd ai-agent-cli
npm install
npm run build
npm link
```

或使用一键方式：

```bash
git clone https://github.com/rebaomi/ai-agent-cli.git
cd ai-agent-cli
npm run setup
npm link
```

**3. 启动**

```bash
coolAI
```

也可以：

- `ai-agent`
- `node dist/cli/index.js`
- `npm run dev`

启动时可直接用参数查看帮助：

```bash
coolAI /help
coolAI /?
node dist/cli/index.js --version
```

### 配置

首次使用会自动生成默认配置。如需自定义，编辑 `~/.ai-agent-cli/config.yaml`：

```yaml
defaultProvider: ollama

ollama:
  enabled: true
  baseUrl: http://localhost:11434
  model: qwen3.5:9b

workspace: .
maxIterations: 100
artifactOutputDir: C:/Users/your-name/.ai-agent-cli/outputs
maxToolCallsPerTurn: 10
autoContinueOnToolLimit: true
maxContinuationTurns: 3

sandbox:
  enabled: true
  timeout: 30000
```

常用配置文件：

- `config.example.yaml`
- `config/example.yaml`

### 常用命令

CLI 内的帮助已经统一到共享帮助文本，下面列出最常用的一组：

| 命令 | 说明 |
|------|------|
| `/?, /？` | 快速帮助 |
| `/help, /h` | 完整帮助 |
| `/q, /quit, /bye` | 退出当前 CLI，保留后台 daemon |
| `/exit` | 停止后台 daemon 并彻底退出 |
| `/clear, /cls` | 清屏 |
| `/history, /hi` | 查看命令历史 |
| `/tools, /t` | 查看可用工具 |
| `/config, /c` | 查看当前配置 |
| `/config edit` | 在终端内编辑配置文件 |
| `/config update`, `/config reload` | 重新加载配置并刷新运行时 |
| `/model, /m` | 查看或切换当前模型 |
| `/model switch <provider>` | 切换默认 provider |
| `/workspace, /w` | 查看或切换当前工作区 |
| `/mode status` | 查看当前输入模式（cli / feishu） |
| `/mode switch <cli\|feishu>` | 在命令行输入和飞书输入之间切换唯一接待端 |
| `/split status` | 查看分屏状态 |
| `/split on`, `/split off` | 开启/关闭左右分屏视图 |
| `/relay` | 查看飞书 relay 状态、启动、停止、重连 |
| `/browser` | 浏览器打开与自动化命令 |
| `/news` | 腾讯新闻快捷命令 |
| `/cron` | 管理定时任务与新闻/天气推送 |
| `/daemon` | 查看、启动、停止、重启后台 daemon |
| `/mcp` | 管理 MCP 服务 |
| `/lsp` | 管理 LSP 服务 |
| `/skill`, `/skills` | 管理 Skills、候选草稿与启停状态 |
| `/org, /team` | 管理组织模式 |
| `/cat` | 管理 AgentCat 电子宠物 |
| `/progress, /p` | 查看当前任务进度 |
| `/memory` | 查看或清理长短期记忆 |
| `/templates` | 查看模板 |
| `/profile` | 查看或更新用户画像 |
| `/perm`, `/permission` | 权限管理 |
| `/sessions` | 查看历史会话 |
| `/load <id>` | 加载历史会话 |
| `/new` | 新建会话 |
| `/reset, /r` | 重置当前对话 |
| `/wipe` | 清空用户数据并重新接待 |

### 按类别查看命令

如果你不想在整张表里逐条找，可以按功能块快速查看：

#### 会话与基础操作

| 类别 | 命令 |
|------|------|
| 帮助与退出 | `/?, /help, /q, /exit, /clear, /history` |
| 会话管理 | `/sessions, /load <id>, /new, /reset, /wipe` |
| 当前状态 | `/tools, /progress, /workspace, /templates` |

#### 配置、模型与输入模式

| 类别 | 命令 |
|------|------|
| 配置管理 | `/config, /config edit, /config update, /config reload` |
| 模型管理 | `/model, /model switch <provider>` |
| 输入模式 | `/mode status, /mode switch cli, /mode switch feishu` |
| 终端视图 | `/split status, /split on, /split off` |

#### 飞书、浏览器与资讯

| 类别 | 命令 |
|------|------|
| Relay 控制 | `/relay status, /relay start, /relay stop, /relay reconnect` |
| 浏览器 | `/browser open <url>, /browser run <url> [actionsJson|@actions.json]` |
| 新闻浏览 | `/news hot, /news search <keyword>, /news morning, /news evening` |
| 新闻落盘与推送 | `/news save ... , /news push <type> [flags], /news output-dir` |

#### 定时任务与后台进程

| 类别 | 命令 |
|------|------|
| Cron 查看与执行 | `/cron, /cron list, /cron run <idOrName>, /cron run-due` |
| Cron 创建 | `/cron create, /cron create-news, /cron create-news-lark, /cron create-weather-lark` |
| Cron 启停与删除 | `/cron start [idOrName], /cron stop [idOrName], /cron delete <idOrName>` |
| Daemon | `/daemon status, /daemon start, /daemon stop, /daemon restart` |

#### 集成、技能与组织

| 类别 | 命令 |
|------|------|
| MCP / LSP | `/mcp list, /mcp tools, /mcp status [name], /mcp reconnect [name], /lsp list, /lsp status` |
| Skills | `/skill list, /skill candidates, /skill todos, /skill adopt, /skill install, /skill enable, /skill disable` |
| 组织模式 | `/org view, /org load <config>, /org mode on|off, /org workflow` |

#### 记忆、画像、权限与 AgentCat

| 类别 | 命令 |
|------|------|
| 记忆 | `/memory long, /memory short [agentId], /memory palace, /memory palace room [roomId], /memory palace go <roomId>, /memory clear` |
| 用户画像 | `/profile, /profile set <key> <value>, /profile personality <type>, /profile style <type>` |
| 权限管理 | `/perm view, /perm grant <type>, /perm revoke <type>, /perm group, /perm audit, /perm ask on|off` |
| AgentCat | `/cat status, /cat start, /cat stop, /cat water, /cat rest, /cat walk, /cat interact` |

### 当前推荐的飞书发送语义

飞书相关请求在当前版本有明确边界：

- **直接发送已有内容**：可以走 direct action
- **先理解/检索/生成内容，再发送飞书**：必须先经过 agent 主链路
- **复杂请求会自动拆成两部分**：先完成正文需求，再执行发送

例如：

- “把刚刚的摘要发我飞书” 可以直接处理
- “解释一下杜甫的《茅屋为秋风所破歌》，再发我飞书” 不会直接发送原问题，而是先生成正文

### 输入体验

- `Tab` 补全 slash 命令与常用二级子命令，如 `/model switch`、`/config edit`、`/mode switch`、`/split on`、`/cron create-news`
- `↑ / ↓` 浏览历史输入
- 输入历史持久化保存在 `~/.ai-agent-cli/input-history.json`
- 历史输入同时覆盖普通对话和 slash 命令

### 定时任务与新闻推送

系统内置了持久化 cron 调度器，可以把内置工具挂到定时任务上。适合做新闻播报、例行检查、定时摘要。

常用命令：

```bash
/cron list
/cron create-news morning-brief morning 0 8 * * * Asia/Shanghai
/cron create hot-news 0 9 * * * tencent_hot_news {"limit":5}
/cron create-weather-lark daily-weather 0 9 * * * --city 北京
/cron delete morning-brief
```

也可以单独启动 cron runner，不进入交互聊天：

```bash
coolAI --cron-daemon
coolAI --cron-once
```

说明：
- 普通 `coolAI` 启动时会自动确保后台 daemon 存在，关闭当前命令行后定时任务仍继续执行
- `/q`、`/quit`、`/bye` 只退出当前命令行，不停止后台 daemon
- `/exit` 会停止后台 daemon 并退出
- `--cron-daemon` 会常驻前台运行定时任务调度器
- `--cron-once` 会立即检查一次当前到期任务并退出
- cron 任务保存在 `~/.ai-agent-cli/cron/jobs.json`
- 已内置腾讯新闻 CLI 对接，可直接调用 `tencent_hot_news`、`tencent_search_news`、`tencent_morning_news`、`tencent_evening_news`
- 已内置天气工具，可直接调用 `get_weather`、`push_weather_to_lark`

也支持直接用 slash 命令查看腾讯新闻：

```bash
/news hot
/news hot 5
/news search AI
/news search AI 5
/news morning
/news evening
/news save hot 10
/news save search AI 5
/news push morning --save
/news push hot --limit 5
/news output-dir
```

说明：
- `/news hot [limit]` 查看腾讯热榜
- `/news search <keyword> [limit]` 搜索腾讯新闻
- `/news morning` 查看腾讯早报
- `/news evening` 查看腾讯晚报
- `/news save ...` 固定保存到 `~/.ai-agent-cli/outputs/tencent-news`
- `/news output-dir` 查看本地输出目录
- `/news help` 查看帮助

### Obsidian Vault 接入

Obsidian 本质上是一个 Markdown vault。当前最稳的接法是直接把 vault 目录挂成 `filesystem MCP`，让 Agent 通过 MCP 方式读写笔记，而不是依赖一个额外的专有 bridge。

配置示例：

```yaml
mcp:
  - name: obsidian
    command: npx.cmd
    args:
      - -y
      - @modelcontextprotocol/server-filesystem
      - C:/Users/your-name/Documents/Your-Obsidian-Vault
```

推荐目录结构：

- `Inbox/`：Agent 临时整理的初稿
- `Knowledge/`：整理后的长期知识文档

这样后面就可以让 Agent 定期学习某个主题，再把结果整理成 Markdown 文档写入 Obsidian vault。CLI 中也可以直接检查：

```bash
/mcp check obsidian
```

### MemPalace 长期记忆接入

当前推荐的记忆方案是分层使用：

- CLI 内置的 Memory Palace 继续负责本地可导航记忆、用户偏好、任务进度和会话侧展示
- MemPalace 通过 MCP 接入，负责长期语义检索、知识图谱、历史事实校验和 Agent Diary

安装 MemPalace：

```bash
pip install mempalace
mempalace init
```

如果你想先把当前项目资料导入 MemPalace：

```bash
mempalace mine .
```

在 `~/.ai-agent-cli/config.yaml` 里加入 MCP 配置：

```yaml
mcp:
  - name: mempalace
    command: python
    args:
      - -m
      - mempalace.mcp_server
    env:
      MEMPALACE_PALACE_PATH: C:/Users/your-name/.mempalace/palace
```

Windows 如果 `python` 命令不可用，可以改成：

```yaml
mcp:
  - name: mempalace
    command: py
    args:
      - -3
      - -m
      - mempalace.mcp_server
    env:
      MEMPALACE_PALACE_PATH: C:/Users/your-name/.mempalace/palace
```

接入后，MemPalace 的 MCP 工具会自动进入统一 Tool Registry。默认 Agent 提示词也会启用最小记忆协议：

- 涉及人物、项目、历史决策、过去事件时，优先用 `mempalace_search` 或 `mempalace_kg_query` 校验，再回答
- 学到稳定的新事实时，可写入 `mempalace_add_drawer` 或 `mempalace_kg_add`
- 重要任务或会话结束后，可调用 `mempalace_diary_write` 做长期归档

这意味着现有的本地记忆宫殿不会被替换，而是多了一层更强的长期记忆后端。

### 飞书官方 lark-cli 接入

飞书官方的 `lark-cli` 本身不是 stdio MCP server。它是一个 AI-friendly CLI，本体会去调用飞书云侧的 MCP HTTP 端点。

当前项目已经补了一个本地 `lark-cli` MCP bridge，可以把 MCP tool 调用转成 `lark-cli` 子命令，因此可以无缝挂进现有 MCP Manager。

准备步骤：

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login --recommend
npm run build
```

然后在 `~/.ai-agent-cli/config.yaml` 里加入：

```yaml
mcp:
  - name: lark
    command: node
    args:
      - D:/workspace/ai-agent-cli/dist/mcp/lark-bridge.js
    env:
      LARK_CLI_BIN: lark-cli
```

Windows 上如果提示 `spawn lark-cli ENOENT`，通常是因为全局 npm 可执行文件实际名称为 `lark-cli.cmd`。可以改成：

```yaml
mcp:
  - name: lark
    command: node
    args:
      - D:/workspace/ai-agent-cli/dist/mcp/lark-bridge.js
    env:
      LARK_CLI_BIN: lark-cli.cmd
```

当前 bridge 也会在 Windows 上自动尝试 `lark-cli.cmd`、`lark-cli.exe`、`lark-cli.bat` 以及常见全局 npm bin 路径。

接入后常用 MCP 工具包括：

- `lark_help`
- `lark_doctor`
- `lark_auth_status`
- `lark_schema`
- `lark_shortcut`
- `lark_service`
- `lark_api`

几个典型调用：

```json
{ "service": "calendar", "command": "+agenda" }
{ "service": "contact", "command": "+search-user", "flags": { "query": "张三" } }
{ "service": "docs", "command": "+create", "flags": { "title": "周报", "markdown": "# 本周进展" } }
{ "service": "calendar", "resource": "calendars", "method": "list" }
{ "httpMethod": "GET", "path": "/open-apis/calendar/v4/calendars" }
```

CLI 内也可以直接检查 bridge：

```bash
/mcp check lark
```

### 工具体系

当前工具按八类能力组织：

- 文件操作：读写、编辑、删除、复制、移动、glob、grep、多文件读取
- 执行：命令执行、REPL、数学计算
- 搜索与抓取：网页搜索、网页抓取、浏览器打开、腾讯新闻工具
- Agents 与 Tasks：本地 task、team、peer 消息工具
- 规划：plan mode、worktree、计划验证
- MCP：MCP 工具、资源与认证入口
- 系统：配置、权限、todo、cron、skill 配置
- 实验：LSP、sleep 等

### Skill 学习草稿

当前系统支持一种保守版的“自动学习 skill”闭环：

- 对于已确认计划并成功执行的复杂任务，Agent 会从实际步骤和结果中生成候选 skill 草稿
- 草稿默认保存到 `~/.ai-agent-cli/skill-candidates`
- 系统不会自动下载安装外部 skill，也不会自动启用草稿
- 你可以用 `/skill candidates` 查看候选，再用 `/skill adopt <name>` 手动转正

这样可以保留经验沉淀能力，同时避免 Agent 擅自修改技能环境。

### 智能工具调用示例

AI 可以自动调用工具完成各种任务：

#### 文件操作
```
用户：帮我读取 src/index.ts 文件
AI：自动调用 read_file 工具读取文件

用户：创建一个新的 React 组件
AI：自动调用 write_file 工具创建文件
```

#### 命令执行
```
用户：帮我运行 npm install
AI：自动调用 execute_command 执行命令
```

#### 目录操作
```
用户：列出当前目录的文件
AI：自动调用 list_directory 工具
```

#### 代码搜索
```
用户：在 src 目录下搜索包含 "hello" 的文件
AI：自动调用 search_files 或 glob 工具
```

### 任务规划器 (Planner)

复杂任务会被自动检测并拆分成步骤执行：

```
用户：帮我完成这几个任务：1) 读取配置文件 2) 修改代码 3) 运行测试

AI：📋 任务规划已创建
    执行步骤 (3 步):
    1. 读取配置文件
    2. 修改代码
    3. 运行测试

    🔄 执行步骤 1/3: 读取配置文件
    ✅ 步骤 1 完成

    🔄 执行步骤 2/3: 修改代码
    ✅ 步骤 2 完成

    🔄 执行步骤 3/3: 运行测试
    ✅ 步骤 3 完成

    ## ✅ 任务完成
    完成进度: 3/3 步骤成功完成
```

规划器会自动：
- 分析任务复杂度
- 拆分可执行的步骤
- 逐步执行每个步骤
- 汇总最终结果

#### 联网搜索和浏览器
```
用户：搜索一下最新的 AI 新闻
AI：自动调用 web_search 工具获取搜索结果

用户：帮我打开 GitHub 首页
AI：自动调用 open_browser 工具打开浏览器

用户：获取这个网页的内容 https://example.com
AI：自动调用 fetch_url 工具抓取网页

用户：给我看今天的腾讯早报
AI：自动调用 tencent_morning_news 工具
```

#### 配合 MCP 扩展
如果配置了 Obsidian MCP：
```
用户：搜索我的笔记库中关于 "学习方法" 的笔记
AI：自动调用 Obsidian 搜索工具
```

### 多 Agent 组织架构

coolAI 支持多 Agent 协作系统，模拟企业团队的工作方式。用户可以定义不同的角色（产品经理、项目经理、工程师、测试等），让它们协同完成复杂任务。

重构设计建议见：`docs/organization-mode-refactor.md`

#### 角色说明

| 角色 | 说明 |
|------|------|
| `orchestrator` | 任务分解专家，分析需求并拆分成子任务 |
| `dispatcher` | 任务分派专家，将任务分配给最合适的执行者 |
| `executor` | 任务执行专家，负责具体执行任务 |
| `supervisor` | 决策监督专家，监督执行并在必要时干预 |
| `tester` | 验收测试专家，验证结果质量 |
| `fallback` | 备用专家，提供备选方案 |

#### 快速开始

```bash
# 在 CLI 中加载默认组织架构
/org load

# 查看组织结构
/org view

# 启用组织模式
/org mode on

# 查看工作流程
/org workflow
```

#### 自定义组织架构

编辑 `~/.ai-agent-cli/organization.json` 配置文件：

```json
{
  "name": "AI开发团队",
  "agents": [
    { "id": "pm_1", "name": "产品经理", "role": "orchestrator" },
    { "id": "tl_1", "name": "项目经理", "role": "dispatcher" },
    { "id": "dev_1", "name": "后端工程师", "role": "executor" },
    { "id": "qa_1", "name": "测试工程师", "role": "tester" }
  ],
  "workflow": {
    "enabled": true,
    "defaultFlow": ["orchestrator", "dispatcher", "executor", "tester"],
    "autoSupervise": true,
    "allowFallback": true
  }
}
```

#### 组织模式示例

```
用户：帮我完成这个项目：1) 创建 API 2) 编写前端 3) 写测试

🏢 组织模式激活
✓ 产品经理 (orchestrator) 已就绪
✓ 项目经理 (dispatcher) 已就绪
✓ 后端工程师 (executor) 已就绪
✓ 测试工程师 (tester) 已就绪

🔄 产品经理 分析任务中...
   任务已分解为 3 个子任务

🔄 项目经理 分配任务中...
   后端工程师 → 创建 API
   后端工程师 → 编写前端
   测试工程师 → 编写测试

🔄 后端工程师 执行中...
🔄 测试工程师 验收中...

✅ 任务完成！
```

#### 组织架构模板

coolAI 提供了多种预设的组织架构模板，位于 `config/templates/` 目录：

| 模板 | 说明 |
|------|------|
| `enterprise-it.json` | IT 互联网公司 |
| `administrative-government.json` | 政府行政中心 |
| `team-agile.json` | 敏捷开发团队 |
| `financial-bank.json` | 银行网点 |
| `ecommerce-customer-service.json` | 电商客服团队 |

```bash
# 查看所有模板
/templates

# 使用模板创建组织
/org load config/templates/enterprise-it.json
```

### 接待 Agent（Reception Agent）

接待 Agent 类似企业前台或银行大堂经理，负责：
- 友好地迎接用户
- 收集和理解用户需求
- 必要时询问更多细节
- 将需求传递给团队处理

配置示例：
```json
{
  "workflow": {
    "reception": {
      "enabled": true,
      "agentId": "pm_1",
      "welcomeMessage": "您好！我是产品经理，很高兴为您服务。"
    }
  }
}
```

### 长期记忆与短期记忆

coolAI 模拟人类大脑的记忆机制：

- **长期记忆**：持久化存储，包括用户偏好、知识库、组织记忆
- **短期记忆**：任务相关的临时信息，每个 Agent 有独立区域
- **记忆共享**：不同 Agent 可以互相查看和串联记忆

```bash
/memory long    # 查看长期记忆
/memory short   # 查看所有 Agent 的短期记忆
/memory short <agentId>  # 查看特定 Agent 的短期记忆
/memory clear   # 清空所有短期记忆
```

### AgentCat 电子宠物

AgentCat 是一个健康提醒助手，类似 Claude Code 的电子宠物：

```bash
/cat start      # 启动 AgentCat
/cat status     # 查看状态
/cat water      # 确认喝水
/cat rest       # 确认休息
/cat walk       # 确认运动
/cat interact   # 与猫猫互动
/cat stop       # 暂停提醒
```

AgentCat 会按时提醒：
- 💧 每 30 分钟提醒喝水
- 👀 每 20 分钟提醒让眼睛休息
- 🚶 每 60 分钟提醒起身运动
- 🍽️ 按时提醒吃饭

### 任务进度追踪

实时查看任务执行进度：

```bash
/progress       # 或 /p
```

输出示例：
```
📊 任务进度:

  用户登录功能开发
  进度: 65%
  状态: in_progress
  当前: 编写后端 API
  已完成: 需求分析, 数据库设计, 创建用户表
```

### 多模型支持

coolAI 支持多种大模型提供商，可以同时使用多个模型：

#### 支持的模型

| 提供商 | 模型示例 | 说明 |
|--------|----------|------|
| Ollama | qwen3.5:9b, llama3.2 | 本地运行，无需 API key |
| DeepSeek | deepseek-chat | 深度求索 |
| Kimi | moonshot-v1-128k | 月之暗面，长上下文 |
| GLM | glm-4, glm-4-flash | 智谱 AI |
| Doubao | doubao-pro-32k | 字节豆包 |
| MiniMax | abab6.5s-chat | 稀宇科技 |
| OpenAI | gpt-4o, gpt-4o-mini | GPT 系列 |
| Claude | claude-3-5-sonnet | Anthropic |
| Gemini | gemini-2.0-flash | Google |

#### 配置示例

```yaml
# 默认模型（必须配置一个）
defaultProvider: ollama

# Ollama（本地模型）
ollama:
  enabled: true
  baseUrl: http://localhost:11434
  model: qwen3.5:9b

# DeepSeek（云端模型）
deepseek:
  enabled: false
  apiKey: your-api-key
  model: deepseek-chat
  baseUrl: https://api.deepseek.com

# Kimi（月之暗面）
kimi:
  enabled: false
  apiKey: your-api-key
  model: moonshot-v1-8k
  baseUrl: https://api.moonshot.cn/v1

# Hybrid（简单任务走本地，复杂任务走远端）
hybrid:
  enabled: true
  localProvider: ollama
  remoteProvider: deepseek
  simpleTaskMaxChars: 80
  simpleConversationMaxChars: 6000
  preferRemoteForToolMessages: true
  localAvailabilityCacheMs: 15000
```

当 defaultProvider 设为 hybrid 时，CLI 会优先把短问答、简单说明这类轻量请求发给本地模型；涉及长上下文、规划、工具消息或多步骤描述时，会自动切到远端模型。
本地可用性会做短期缓存，避免每次简单请求都重复探活；CLI 也会额外输出一行轻量路由日志，便于现场确认请求最终落在 local 还是 remote。

### 多模型对比

coolAI 可以同时调用多个模型进行对比分析：

```bash
/compare model1:deepseek model2:kimi model3:glm 帮我分析这段代码
```

输出示例：
```
📊 模型对比结果

🥇 deepseek-chat (deepseek)
   耗时: 1500ms | Token: 500
   评分: 8.5/10
   响应: 根据代码分析...

🥈 moonshot-v1-128k (kimi)
   耗时: 2000ms | Token: 600
   评分: 7.8/10
   响应: 从多个角度分析...

🥉 glm-4 (glm)
   耗时: 1200ms | Token: 450
   评分: 7.2/10
   响应: 代码结构分析...
```

### 智能接待系统

接待 Agent 会自动识别用户话题并创建对应的专业 Agent：

#### 支持的话题

| 话题 | 关键词 | 创建的 Agent |
|------|--------|--------------|
| 美食 | 好吃、餐厅、菜谱 | 美食专家 |
| 旅游 | 旅游、景点、酒店 | 旅游顾问 |
| 金融 | 股票、基金、理财 | 财经顾问 |
| 编程 | 代码、bug、API | 编程助手 |
| 健康 | 健康、运动、健身 | 健康顾问 |

#### 接待员性格

```
/reception personality humorous  # 幽默风格
/reception personality gentle   # 温柔风格
/reception personality professional  # 专业风格
```

性格选项：
- `professional` - 专业、礼貌
- `friendly` - 友好、热情
- `humorous` - 幽默、风趣
- `gentle` - 温柔、耐心
- `energetic` - 活力、积极

### 用户画像系统

coolAI 会记住您的偏好，随着使用次数增加，画像越来越完善：

```bash
/profile              # 查看用户档案
/profile set job 程序员     # 设置职业
/profile set purpose 写代码  # 设置使用目的
/profile personality humorous  # 设置性格
/profile style detailed       # 设置沟通风格
```

首次使用时会自动询问：
- 您的职业是什么？
- 您主要用 coolAI 来做什么？
- 您喜欢什么样的交流风格？

coolAI 会根据您的画像调整回复风格和内容。

### 内容安全

coolAI 内置内容安全过滤：

- 🚫 自动检测并过滤不文明用语
- 🚫 自动检测违法内容
- 🚫 自动检测不适宜内容
- ⚠️ 提醒用户保持理性交流

多次发送违规内容会被记录。

### 权限管理

coolAI 权限管理系统确保操作安全可控：

```bash
/perm                      # 查看权限设置
/perm view                # 查看当前权限状态
/perm grant <type> [resource]  # 授予权限
/perm revoke <type> [resource] # 撤销权限
/perm revokeall           # 撤销所有权限
/perm trust <cmd>         # 添加可信命令（如 git, npm）
/perm allow <path>        # 添加允许路径
/perm deny <path>         # 添加禁止路径
/perm auto [on|off]       # 自动授权危险操作
/perm ask [on|off]        # 询问权限（默认开启）
```

**权限类型：**
- `file_read` - 读取文件
- `file_write` - 写入文件
- `file_delete` - 删除文件
- `command_execute` - 执行命令
- `network_request` - 网络请求
- `browser_open` - 打开浏览器
- `mcp_access` - 访问 MCP 服务
- `tool_execute` - 执行工具
- `env_read` - 读取环境变量
- `process_list` - 查看进程列表
- `clipboard_read` - 读取剪贴板
- `clipboard_write` - 写入剪贴板

执行危险操作时会自动弹出授权确认：

| 输入 | 说明 |
|------|------|
| `yes` / `y` | 授权本次 |
| `all` | 永久授权此类操作 |
| `10m` | 授权 10 分钟 |
| `1h` | 授权 1 小时 |
| `24h` | 授权 24 小时 |
| `no` / `n` | 拒绝 |

#### 权限组

```
/perm group              # 查看权限组
/perm group grant <id>   # 授予权限组
/perm group revoke <id>  # 撤销权限组
```

可用权限组：`file_ops`（基础文件）、`file_dangerous`（危险文件）、`network`（网络）、`system`（系统）

#### 审计日志

```
/perm audit [n]           # 查看最近 n 条审计日志（默认 20 条）
```

### 任务进度显示

任务执行时会实时显示进度：

```
📋 用户登录功能开发

  进度: [████████████░░░░░░░░░] 65%

  ✓ 需求分析 (3s)
  ✓ 数据库设计 (5s)
  ⟳ 编写后端 API 运行中...
  ○ 前端界面
  ○ 编写测试
  ○ 部署上线
```

### 安装 Ollama 模型

```bash
# 下载模型
ollama pull qwen3.5:9b
ollama pull llama3.2
ollama pull gemma4:3b

# 查看已安装模型
ollama list
```

### Skills 扩展

Skills 扩展 coolAI 的能力，让 AI 可以执行自定义命令和工具。

#### 管理 Skills

在 CLI 中使用以下命令：

```bash
/skill list              # 查看已安装的 skills
/skill install npm:xxx   # 从 npm 安装
/skill install github:xxx/xxx  # 从 GitHub 安装
/skill install ./path    # 从本地路径安装
/skill uninstall xxx     # 卸载 skill
/skill enable xxx       # 启用 skill
/skill disable xxx       # 禁用 skill
```

#### 开发自己的 Skill

创建一个 skill 目录，添加 `skill.json` 配置文件：

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "我的自定义技能",
  "main": "index.js"
}
```

编写 `index.js`：

```javascript
export default async function createSkill() {
  return {
    name: 'my-skill',
    version: '1.0.0',
    description: '我的自定义技能',
    
    // 自定义命令
    commands: [
      {
        name: 'hello',
        description: '打招呼',
        handler: async (args, ctx) => {
          const name = args[0] || 'World';
          return `Hello, ${name}!`;
        }
      }
    ],

    // 自定义工具（AI 可调用）
    tools: [
      {
        name: 'get_weather',
        description: '获取天气信息',
        inputSchema: {
          type: 'object',
          properties: {
            city: { type: 'string', description: '城市名称' }
          }
        },
        handler: async (args, ctx) => {
          const { city } = args;
          return {
            content: [{ type: 'text', text: `${city} 今天晴天，25度` }]
          };
        }
      }
    ],

    // 钩子函数
    hooks: {
      onStart: async (ctx) => {
        console.log('Skill loaded!');
      },
      onMessage: async (message, ctx) => {
        // 拦截消息处理
        return null; // 返回 null 表示不拦截
      }
    }
  };
}
```

#### Skill 目录结构

```
~/.ai-agent-cli/skills/
├── skill-1/
│   ├── skill.json
│   └── index.js
└── skill-2/
    ├── skill.json
    └── index.js
```

### MCP 服务器

MCP (Model Context Protocol) 服务器可以扩展 AI 的能力。

#### 常用 MCP 服务器

##### 文件系统
```yaml
mcp:
  - name: filesystem
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-filesystem
    env:
      ROOT_DIR: .
```

##### Obsidian 笔记
接入你的 Obsidian 笔记库，让 AI 可以搜索和管理笔记：
```yaml
mcp:
  - name: obsidian
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-obsidian
    env:
      OBSIDIAN_VAULT_PATH: C:\Users\你的用户名\Documents\Obsidian\我的笔记库
```

然后在 CLI 中说：
```
帮我搜索包含 "编程" 的笔记
```
AI 会自动调用 Obsidian MCP 工具搜索你的笔记库。

##### GitHub
```yaml
mcp:
  - name: github
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-github
    env:
      GITHUB_TOKEN: your-github-token
```

##### Brave 搜索
```yaml
mcp:
  - name: brave-search
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-brave-search
    env:
      BRAVE_API_KEY: your-api-key
```

更多 MCP 服务器请搜索 npm 上的 `@modelcontextprotocol/server-*` 包。

### 内置工具

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件 |
| `write_file` | 写入文件 |
| `edit_file` | 编辑文件 |
| `delete_file` | 删除文件 |
| `copy_file` | 复制文件 |
| `move_file` | 移动/重命名文件 |
| `file_info` | 获取文件信息（大小、时间等） |
| `list_directory` | 列出目录 |
| `glob` | 文件匹配 |
| `grep` | 正则搜索文件内容 |
| `execute_command` | 执行命令 |
| `get_current_time` | 获取当前时间 |
| `calculate` | 数学计算 |
| `web_search` | 联网搜索（DuckDuckGo，无需 API key） |
| `fetch_url` | 获取网页内容 |
| `open_browser` | 打开浏览器 |
| `lsp_complete` | 代码补全 |
| `lsp_diagnostics` | 代码诊断 |
| `lsp_definition` | 跳转到定义 |

### 技术栈

- TypeScript
- Node.js 20+
- Ollama API
- MCP Protocol
- LSP Protocol

### License

MIT

---

## English

An intelligent coding assistant CLI built around an agent-first runtime, with deterministic direct actions as a narrow fast path.

Current design principles:

- One-step deterministic operations can go through direct action
- Requests that require understanding, retrieval, planning, or content generation must go through the main agent path
- Tool calls are consistently gated by the unified Tool Registry, permissions, intent-contract validation, and regression coverage

This is no longer just a keyword-triggered tool shell. It is an agent runtime with explicit execution boundaries.

### Features

- 🤖 **Multi-Model Support** - Ollama, DeepSeek, Kimi, GLM, Doubao, MiniMax, GPT, Claude, Gemini, and hybrid routing
- 🧠 **Modularized Agent Main Path** - response turn, tool-call bridge, planning, plan runtime, task synthesis, known-gap handling, and skill learning are separated into dedicated runtime components
- ⚡ **Explicit Direct Action Boundary** - deterministic requests only, such as exporting the latest result, sending existing content to Lark, or pushing Tencent News
- 🧰 **Unified Tool Registry** - built-in tools, skill tools, and MCP tools are normalized and dispatched through one path
- 🛡️ **Protected Tool Execution Chain** - permissions, intent contracts, placeholder resolution, post-processing, and regression protection work together
- 📊 **Planning and Resume Support** - complex tasks can be planned, confirmed, paused, resumed, and synthesized
- 💬 **Interactive Chat** - Claude Code-like command line interface
- ⌨️ **Tab Completion + Persistent History** - Tab completion for slash commands and subcommands, plus persisted input history
- 💾 **Long-term + Short-term Memory** - local Memory Palace plus optional MemPalace MCP integration
- 🌊 **Streaming Output** - Typewriter effect for AI responses
- 🔌 **MCP Protocol** - Connect to Model Context Protocol servers
- 📝 **LSP Support** - Language Server Protocol for code intelligence
- 🎯 **Skills System** - install, enable, learn, and adopt third-party skill extensions
- 🛡️ **Secure Sandbox** - file, command, browser, and network actions run under controlled permission rules
- 📨 **Tasks, Teams, and Cron Jobs** - Local task records, peer messaging, lightweight teams, and persistent cron scheduling
- 🏢 **Multi-Agent Organization** - Simulate enterprise team collaboration with multiple agent roles
- 🐱 **AgentCat Companion** - Health reminder assistant for water, rest, and exercise
- 📋 **Task Progress Tracking** - Real-time task execution progress and status
- 🔐 **Permission Management** - Fine-grained control over file, network, command execution permissions

### Current Execution Paths

The current runtime decides which path to use before execution:

1. **Direct Action**
   Best for deterministic, one-step requests that do not require semantic reasoning, for example:
   - read a clearly specified file
   - export the latest generated content to pdf/docx/pptx/xlsx
   - send already-available text, attachments, or Tencent News results to Lark

2. **Main Agent Path**
   Used when the request requires understanding, retrieval, planning, or generation before execution, for example:
   - "Explain this poem and then send it to Lark"
   - "Search for sources, turn them into a report, and then send it"
   - "Modify the code, run tests, and summarize the result"

3. **Planner / Plan Runtime**
   Multi-step or dependency-heavy tasks are upgraded into plans, confirmed with the user, executed step by step, and can be resumed after interruptions.

### Refactored Architecture Overview

This refactor was about stabilizing the runtime architecture, not about adding flashy new features.

- **Agent shell**: reduced to orchestration entry, runtime state, and compatibility-facing public methods
- **Response turn**: split into collector, processor, executor, and final assembler
- **Planning runtime**: planning, plan execution, plan resume, and pending interaction are separated
- **Tool-call bridge**: parsing, intent-contract validation, execution, and result write-back are layered
- **Direct action runtime**: router, dispatch, handlers, support modules, and legacy fallback are separated
- **Lark delivery workflow**: Lark delivery remains an isolated workflow and only handles deterministic delivery cases

For the detailed refactor inventory, see [docs/agent-refactor-progress.md](docs/agent-refactor-progress.md).

### Installation

Requirements:

- Node.js 20+
- npm
- Ollama if you want a local model path

If you use local models, start Ollama first:

```bash
ollama serve
ollama pull qwen3.5:9b
```

**Windows:**
```bash
git clone https://github.com/rebaomi/ai-agent-cli.git
cd ai-agent-cli
npm install
npm run build
npm link
```

**Linux / Mac:**
```bash
git clone https://github.com/rebaomi/ai-agent-cli.git
cd ai-agent-cli
npm install
npm run build
npm link
```

Or use the one-shot setup:

```bash
git clone https://github.com/rebaomi/ai-agent-cli.git
cd ai-agent-cli
npm run setup
npm link
```

### Usage

Start the CLI:

```bash
coolAI
```

Other entry points:

```bash
ai-agent
node dist/cli/index.js
npm run dev
```

You can also use startup shortcuts directly:

```bash
coolAI /help
coolAI /?
node dist/cli/index.js --version
```

### Configuration

Default config is created automatically. To customize it, edit `~/.ai-agent-cli/config.yaml`:

```yaml
defaultProvider: ollama

ollama:
  enabled: true
  baseUrl: http://localhost:11434
  model: qwen3.5:9b

workspace: .
maxIterations: 100
artifactOutputDir: C:/Users/your-name/.ai-agent-cli/outputs
maxToolCallsPerTurn: 10
autoContinueOnToolLimit: true
maxContinuationTurns: 3

sandbox:
  enabled: true
  timeout: 30000
```

Common example files:

- `config.example.yaml`
- `config/example.yaml`

### Common Commands

CLI help has been unified into shared shell text. The most useful commands are:

| Command | Description |
|---------|-------------|
| `/?`, `/？` | Show quick help |
| `/help`, `/h` | Show full help |
| `/q`, `/quit`, `/bye` | Exit the current CLI while keeping the background daemon running |
| `/exit` | Stop the background daemon and exit completely |
| `/clear`, `/cls` | Clear the screen |
| `/history`, `/hi` | Show command history |
| `/tools`, `/t` | List available tools |
| `/config`, `/c` | Show the current configuration |
| `/config edit` | Edit the config file in the terminal |
| `/config update`, `/config reload` | Reload config and refresh runtime |
| `/model`, `/m` | Show or switch the active model |
| `/model switch <provider>` | Switch the default provider |
| `/workspace`, `/w` | Show or change the current workspace |
| `/mode status` | Show the current active input mode |
| `/mode switch <cli\|feishu>` | Switch the single active input source between CLI and Feishu |
| `/split status` | Show split-view status |
| `/split on`, `/split off` | Enable or disable split view |
| `/relay` | Lark relay status, start, stop, reconnect |
| `/browser` | Browser open and automation commands |
| `/news` | Tencent News shortcuts |
| `/cron` | Manage cron jobs and scheduled news/weather delivery |
| `/daemon` | Show, start, stop, or restart the background daemon |
| `/org`, `/team` | Manage organization/team mode |
| `/mcp` | Manage MCP servers |
| `/lsp` | Manage LSP servers |
| `/skill`, `/skills` | Manage Skills and candidate drafts |
| `/cat` | Manage AgentCat |
| `/progress`, `/p` | Show current task progress |
| `/memory` | Inspect or clear memory |
| `/templates` | Show templates |
| `/profile` | View or update the user profile |
| `/perm`, `/permission` | Permission management |
| `/sessions` | List conversation sessions |
| `/load <id>` | Load a previous session |
| `/new` | Create a new session |
| `/reset`, `/r` | Clear the current conversation |
| `/wipe` | Reset user data (restart onboarding) |

### Command Reference By Area

If the flat table feels too dense, use the grouped reference below.

#### Sessions and Basics

| Area | Commands |
|------|----------|
| Help and exit | `/?`, `/help`, `/q`, `/exit`, `/clear`, `/history` |
| Session lifecycle | `/sessions`, `/load <id>`, `/new`, `/reset`, `/wipe` |
| Current state | `/tools`, `/progress`, `/workspace`, `/templates` |

#### Config, Models, and Input Mode

| Area | Commands |
|------|----------|
| Config | `/config`, `/config edit`, `/config update`, `/config reload` |
| Models | `/model`, `/model switch <provider>` |
| Input source | `/mode status`, `/mode switch cli`, `/mode switch feishu` |
| Terminal layout | `/split status`, `/split on`, `/split off` |

#### Lark, Browser, and News

| Area | Commands |
|------|----------|
| Relay control | `/relay status`, `/relay start`, `/relay stop`, `/relay reconnect` |
| Browser | `/browser open <url>`, `/browser run <url> [actionsJson|@actions.json]` |
| News browse | `/news hot`, `/news search <keyword>`, `/news morning`, `/news evening` |
| News save and push | `/news save ...`, `/news push <type> [flags]`, `/news output-dir` |

#### Scheduling and Background Runtime

| Area | Commands |
|------|----------|
| Cron inspect and run | `/cron`, `/cron list`, `/cron run <idOrName>`, `/cron run-due` |
| Cron creation | `/cron create`, `/cron create-news`, `/cron create-news-lark`, `/cron create-weather-lark` |
| Cron lifecycle | `/cron start [idOrName]`, `/cron stop [idOrName]`, `/cron delete <idOrName>` |
| Daemon | `/daemon status`, `/daemon start`, `/daemon stop`, `/daemon restart` |

#### Integrations, Skills, and Organization

| Area | Commands |
|------|----------|
| MCP / LSP | `/mcp list`, `/mcp tools`, `/mcp status [name]`, `/mcp reconnect [name]`, `/lsp list`, `/lsp status` |
| Skills | `/skill list`, `/skill candidates`, `/skill todos`, `/skill adopt`, `/skill install`, `/skill enable`, `/skill disable` |
| Organization mode | `/org view`, `/org load <config>`, `/org mode on|off`, `/org workflow` |

#### Memory, Profile, Permissions, and AgentCat

| Area | Commands |
|------|----------|
| Memory | `/memory long`, `/memory short [agentId]`, `/memory palace`, `/memory palace room [roomId]`, `/memory palace go <roomId>`, `/memory clear` |
| Profile | `/profile`, `/profile set <key> <value>`, `/profile personality <type>`, `/profile style <type>` |
| Permissions | `/perm view`, `/perm grant <type>`, `/perm revoke <type>`, `/perm group`, `/perm audit`, `/perm ask on|off` |
| AgentCat | `/cat status`, `/cat start`, `/cat stop`, `/cat water`, `/cat rest`, `/cat walk`, `/cat interact` |

### Current Lark Delivery Semantics

Lark-related requests now have an explicit execution boundary:

- **Send existing content** can go through direct action
- **Understand, retrieve, or generate content before sending** must go through the main agent path first
- **Composite delivery requests** are treated as two-stage work: finish the content requirement first, then deliver the final body to Lark

Examples:

- "Send the summary I just generated to Lark" can be handled directly
- "Explain Du Fu's poem and then send it to Lark" will not send the raw question; it must generate the final text first

### Input Experience

- `Tab` completes slash commands and common subcommands such as `/model switch`, `/config edit`, `/mode switch`, `/split on`, and `/cron create-news`
- `Up / Down` browse previous inputs
- Input history is persisted in `~/.ai-agent-cli/input-history.json`

### Cron Jobs and News Delivery

The CLI includes a persistent cron scheduler that can run built-in tools on schedule. This is useful for news briefings, recurring checks, and periodic summaries.

```bash
/cron list
/cron create-news morning-brief morning 0 8 * * * Asia/Shanghai
/cron create hot-news 0 9 * * * tencent_hot_news {"limit":5}
/cron delete morning-brief
```

You can also run the scheduler without entering chat mode:

```bash
coolAI --cron-daemon
coolAI --cron-once
```

Notes:
- `--cron-daemon` keeps the scheduler running in the foreground
- `--cron-once` checks due jobs once and exits
- Cron jobs are stored in `~/.ai-agent-cli/cron/jobs.json`
- Tencent News CLI tools are already wired in: `tencent_hot_news`, `tencent_search_news`, `tencent_morning_news`, `tencent_evening_news`

You can also use slash commands for Tencent News directly:

```bash
/news hot
/news hot 5
/news search AI
/news search AI 5
/news morning
/news evening
/news save hot 10
/news save search AI 5
/news output-dir
```

Notes:
- `/news hot [limit]` shows Tencent hot news
- `/news search <keyword> [limit]` searches Tencent News
- `/news morning` shows the morning briefing
- `/news evening` shows the evening briefing
- `/news save ...` always saves into `~/.ai-agent-cli/outputs/tencent-news`
- `/news push <type> ...` fetches Tencent News and sends it to Lark through the configured `lark` MCP bridge, defaulting to `notifications.lark.morningNews.chatId`
- `/news output-dir` shows the local output directory
- `/news help` shows usage help

If you want scheduled delivery to Lark inside the built-in cron system, create a cron job against the built-in `push_news_to_lark` tool through the shortcut command:

```bash
/cron create-news-lark morning-feishu morning 0 8 * * * --save
/cron create-news-lark hot-feishu hot 0 9 * * * --limit 5
/cron create-news-lark ai-search search 0 10 * * * --keyword AI --save
```

For the most common morning briefing case, you can define the default recipient in config and then use a fixed short command.

Config example:

```yaml
notifications:
  lark:
    morningNews:
      chatId: oc_xxx
      # userId: ou_xxx  # optional, only needed for direct-message delivery
      schedule: '0 8 * * *'
      timezone: Asia/Shanghai
      saveOutput: true
```

If you only want group delivery, `chatId` is enough. `userId` is optional and only used by `/cron create-morning-feishu` for direct messages.

Then inside the CLI you can create the cron job without repeating the target and schedule:

```bash
/cron create-morning-feishu-group
/cron create-morning-feishu
```

You can still override the configured target inline when needed:

```bash
/cron create-morning-feishu ou_xxx
/cron create-morning-feishu-group oc_xxx
```

### Integrating Official lark-cli

The official `lark-cli` is not a stdio MCP server. It is an AI-friendly CLI that itself calls Lark's cloud MCP HTTP endpoint.

This project now includes a local `lark-cli` MCP bridge. The bridge accepts MCP tool calls and translates them into `lark-cli` subcommands, so it plugs into the existing MCP Manager without changing the rest of the system.

Setup:

```bash
npm install -g @larksuite/cli
lark-cli config init --new
lark-cli auth login --recommend
npm run build
```

Then add this to `~/.ai-agent-cli/config.yaml`:

```yaml
mcp:
  - name: lark
    command: node
    args:
      - D:/workspace/ai-agent-cli/dist/mcp/lark-bridge.js
    env:
      LARK_CLI_BIN: lark-cli
```

On Windows, if `spawn lark-cli ENOENT` appears, the global executable is often `lark-cli.cmd`. In that case, set:

```yaml
mcp:
  - name: lark
    command: node
    args:
      - D:/workspace/ai-agent-cli/dist/mcp/lark-bridge.js
    env:
      LARK_CLI_BIN: lark-cli.cmd
```

The bridge also tries common Windows executable candidates automatically, including `lark-cli.cmd`, `lark-cli.exe`, and `lark-cli.bat`.

Available MCP tools include:

- `lark_help`
- `lark_doctor`
- `lark_auth_status`
- `lark_schema`
- `lark_shortcut`
- `lark_service`
- `lark_api`

Typical calls:

```json
{ "service": "calendar", "command": "+agenda" }
{ "service": "contact", "command": "+search-user", "flags": { "query": "Alice" } }
{ "service": "docs", "command": "+create", "flags": { "title": "Weekly Report", "markdown": "# Progress" } }
{ "service": "calendar", "resource": "calendars", "method": "list" }
{ "httpMethod": "GET", "path": "/open-apis/calendar/v4/calendars" }
```

You can also inspect the bridge inside the CLI:

```bash
/mcp check lark
```

Current behavior boundary for Lark delivery:

- deterministic delivery requests can stay on the direct-action path
- requests that still need understanding, retrieval, or content generation must go through the main agent path first
- if the user asks for "find/interpret/generate something and send it to Lark", the runtime should finish the content requirement before sending the final body

If you want a simple scheduled delivery path without extending the built-in cron orchestration, use the standalone script below. It fetches Tencent News and sends the result through `lark-cli im +messages-send`:

```bash
npm run push:news:lark -- --type morning --user-id ou_xxx --save
npm run push:news:lark -- --type hot --limit 8 --chat-id oc_xxx
npm run push:news:lark -- --type search --keyword AI --chat-id oc_xxx --save
```

Windows Task Scheduler example:

```powershell
schtasks /Create /SC DAILY /TN "AI-Agent Morning News to Lark" /TR "powershell -NoProfile -Command \"cd D:\workspace\ai-agent-cli; npm.cmd run push:news:lark -- --type morning --user-id ou_xxx --save\"" /ST 08:00
```

The script lives at `scripts/news-to-lark.mjs`. It requires:

- `@larksuite/cli` installed and authenticated
- the app bot already able to message the target user or chat
- `@tencentnews/cli` available through `npx`

### Tool System

The current tool surface is organized into eight capability groups:

- File operations
- Execution
- Search & fetch
- Agents & tasks
- Planning
- MCP
- System
- Experimental

### Intelligent Tool Calling Examples

The AI can automatically call tools to complete various tasks:

#### File Operations
```
User: Read the src/index.ts file
AI: Automatically calls read_file tool

User: Create a new React component
AI: Automatically calls write_file tool
```

#### Command Execution
```
User: Run npm install
AI: Automatically calls execute_command
```

#### News Tools
```
User: Show me today's Tencent morning briefing
AI: Automatically calls tencent_morning_news

User: Schedule a hot news push for 9 AM every day
AI: Can use cron_create with tencent_hot_news
```

### Task Planner

Complex tasks are automatically detected and split into steps:

```
User: Help me with these tasks: 1) Read config file 2) Modify code 3) Run tests

AI: 📋 Task Plan Created
    Steps (3 total):
    1. Read config file
    2. Modify code
    3. Run tests

    🔄 Step 1/3: Read config file
    ✅ Step 1 complete

    🔄 Step 2/3: Modify code
    ✅ Step 2 complete

    🔄 Step 3/3: Run tests
    ✅ Step 3 complete

    ## ✅ Task Complete
    Progress: 3/3 steps completed successfully
```

The Planner automatically:
- Analyzes task complexity
- Splits into executable steps
- Executes each step sequentially
- Synthesizes final results

#### MCP Extensions
With Obsidian MCP configured:
```
User: Search my notes about "learning methods"
AI: Automatically calls Obsidian search tool
```

### Multi-Agent Organization

coolAI supports multi-agent collaboration system that simulates enterprise team workflows. You can define different roles (product manager, project manager, engineers, QA, etc.) and let them work together on complex tasks.

#### Role Descriptions

| Role | Description |
|------|-------------|
| `orchestrator` | Task decomposition expert, analyzes requirements and splits into subtasks |
| `dispatcher` | Task distribution expert, assigns tasks to the most suitable executor |
| `executor` | Task execution expert, responsible for executing tasks |
| `supervisor` | Decision supervision expert, monitors execution and intervenes when necessary |
| `tester` | Acceptance testing expert, verifies result quality |
| `fallback` | Backup specialist, provides alternative solutions |

#### Quick Start

```bash
# Load default organization in CLI
/org load

# View organization structure
/org view

# Enable organization mode
/org mode on

# View workflow
/org workflow
```

#### Custom Organization

Edit `~/.ai-agent-cli/organization.json` config file:

```json
{
  "name": "AI Development Team",
  "agents": [
    { "id": "pm_1", "name": "Product Manager", "role": "orchestrator" },
    { "id": "tl_1", "name": "Project Lead", "role": "dispatcher" },
    { "id": "dev_1", "name": "Backend Engineer", "role": "executor" },
    { "id": "qa_1", "name": "QA Engineer", "role": "tester" }
  ],
  "workflow": {
    "enabled": true,
    "defaultFlow": ["orchestrator", "dispatcher", "executor", "tester"],
    "autoSupervise": true,
    "allowFallback": true
  }
}
```

### Skills Extension

Skills extend coolAI's capabilities.

#### Manage Skills

```bash
/skill list              # List installed skills
/skill install npm:xxx   # Install from npm
/skill install github:xxx/xxx  # Install from GitHub
/skill install ./path    # Install from local path
/skill uninstall xxx     # Uninstall skill
/skill enable xxx        # Enable skill
/skill disable xxx       # Disable skill
```

### MCP Servers

```yaml
mcp:
  - name: obsidian
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-obsidian
    env:
      OBSIDIAN_VAULT_PATH: /path/to/your/vault
```

### Permission Management

coolAI's permission system ensures operations are safe and controllable:

```bash
/perm                      # View permission settings
/perm view                # View current permissions
/perm grant <type> [resource] [10m|1h|24h]  # Grant permission with optional expiry
/perm revoke <type> [resource] # Revoke permission
/perm revokeall           # Revoke all permissions
/perm group               # View permission groups
/perm group grant <id>    # Grant permission group
/perm group revoke <id>    # Revoke permission group
/perm audit [n]           # View audit log (default 20 entries)
/perm trust <cmd>         # Add trusted command (e.g., git, npm)
/perm allow <path>        # Add allowed path
/perm deny <path>         # Add denied path
/perm auto [on|off]       # Auto-grant dangerous operations
/perm ask [on|off]        # Ask for permissions (default: on)
```

**Permission Types:**
- `file_read` - Read files
- `file_write` - Write files
- `file_delete` - Delete files
- `file_copy` - Copy files
- `file_move` - Move files
- `directory_list` - List directories
- `directory_create` - Create directories
- `command_execute` - Execute commands
- `network_request` - Network requests
- `browser_open` - Open browser
- `mcp_access` - Access MCP services
- `tool_execute` - Execute tools
- `env_read` - Read environment variables
- `process_list` - List processes

Dangerous operations prompt for confirmation:

| Input | Description |
|-------|-------------|
| `yes` / `y` | Grant this time |
| `all` | Permanently grant |
| `10m` | Grant for 10 minutes |
| `1h` | Grant for 1 hour |
| `24h` | Grant for 24 hours |
| `no` / `n` | Deny |

#### Permission Groups

```
/perm group              # View permission groups
/perm group grant <id>   # Grant permission group
/perm group revoke <id>  # Revoke permission group
```

Available groups: `file_ops` (basic file), `file_dangerous` (dangerous file), `network`, `system`

#### Audit Log

```
/perm audit [n]           # View last n audit entries (default 20)
```

### Built-in Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write content to file |
| `edit_file` | Edit file |
| `delete_file` | Delete file |
| `copy_file` | Copy file |
| `move_file` | Move/rename file |
| `file_info` | Get file info (size, dates) |
| `list_directory` | List directory contents |
| `glob` | Find files by pattern |
| `grep` | Regex search file contents |
| `execute_command` | Execute shell command |
| `get_current_time` | Get current time |
| `calculate` | Math calculator |
| `web_search` | Web search (DuckDuckGo, no API key needed) |
| `fetch_url` | Fetch webpage content |
| `open_browser` | Open URL in browser |
| `lsp_complete` | Code completion |
| `lsp_diagnostics` | Code diagnostics |
| `lsp_definition` | Go to definition |
| `task_create` / `task_get_list` / `task_update` / `task_stop` / `task_output` | Local task management |
| `team_create` / `team_delete` / `list_peers` / `agent_send_message` | Lightweight collaboration tools |
| `cron_create` / `cron_delete` / `cron_list` | Persistent cron scheduler |
| `mcp_list` / `mcp_resources` / `read_mcp_resource` / `mcp_auth` | MCP management helpers |
| `tencent_hot_news` / `tencent_search_news` / `tencent_morning_news` / `tencent_evening_news` | Tencent News integration |

### Tech Stack

- TypeScript
- Node.js 20+
- Ollama API
- MCP Protocol
- LSP Protocol

### License

MIT
