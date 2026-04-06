# AI Agent CLI

> ⚠️ **目前测试中，欢迎提 [Issue](https://github.com/rebaomi/ai-agent-cli/issues)**

**[简体中文](#简体中文) | [English](#english)**

---

## 简体中文

一个基于 Ollama 的智能编程助手 CLI 工具，支持 MCP、LSP 和 Skills 扩展。

### 特性

- 🤖 **多模型支持** - 支持 Ollama、DeepSeek、Kimi、GLM、Doubao、MiniMax、GPT、Claude、Gemini 等
- 🔌 **MCP 协议** - 接入 Model Context Protocol 服务器
- 📝 **LSP 支持** - Language Server Protocol 代码智能提示
- 🎯 **Skills 系统** - 安装和管理第三方技能扩展
- 🛡️ **安全沙箱** - 代码执行在受控环境中运行
- 💬 **交互式对话** - 类 Claude Code 的命令行界面
- 💾 **长期+短期记忆** - 模拟人脑记忆机制，Agent 专属记忆区域
- 🌊 **流式输出** - AI 回复逐字显示，打字机效果
- ⚡ **智能工具调用** - AI 自动调用合适工具完成任务
- 📊 **任务规划器** - 复杂任务自动拆分成步骤执行，逐步完成
- 🏢 **多 Agent 组织架构** - 模拟企业团队协作，多角色 Agent 协同工作
- 🐱 **AgentCat 电子宠物** - 健康提醒助手，提醒喝水、休息、运动
- 📋 **任务进度追踪** - 实时查看任务执行进度和状态
- 🎭 **智能接待系统** - 自动识别话题、加载技能、切换 Agent
- 🔄 **多模型对比** - 同时调用多个模型，综合分析给出最佳答案
- 👤 **用户画像系统** - 记住用户偏好，完善用户画像，提供个性化服务
- 🛡️ **内容安全过滤** - 自动过滤不当内容，维护健康交流环境
- 🔐 **权限管理系统** - 细粒度控制文件、网络、命令执行权限，交互式授权确认

### 🚀 快速开始

**1. 启动 Ollama（必需）**
```bash
# 在另一个终端运行
ollama serve

# 如未安装，访问 https://ollama.ai 下载安装
ollama pull qwen3.5:9b  # 下载模型
```

**2. 运行 coolAI**
```bash
npm install
npm link
coolAI
```

### 使用

安装后，在任意目录运行：

```bash
coolAI
```

其他启动方式：
```bash
ai-agent          # 也可以用这个命令
node dist/cli/index.js  # 直接运行
npm run dev       # 开发模式
```

### 配置

在 `~/.ai-agent-cli/config.yaml` 创建配置文件：

```yaml
ollama:
  baseUrl: http://localhost:11434
  model: qwen3.5:9b  # 选择你的模型
  temperature: 0.7
```

> 注意：首次使用需要先启动 Ollama 服务 `ollama serve` 并下载模型 `ollama pull qwen3.5:9b`

### 命令

在 CLI 中输入以下命令：

| 命令 | 说明 |
|------|------|
| `/？` | 显示快速帮助 |
| `/quit` | 退出 |
| `/model` | 查看/切换模型 |
| `/tools` | 列出可用工具 |
| `/config` | 显示配置 |
| `/skill` | 管理 Skills |
| `/org` | 管理组织架构/团队 |
| `/cat` | 电子宠物 AgentCat |
| `/progress` | 查看任务进度 |
| `/memory` | 记忆管理 |
| `/templates` | 查看组织架构模板 |
| `/mcp` | 管理 MCP 服务器 |
| `/perm` | 权限管理 |
| `/sessions` | 查看历史会话 |
| `/load <id>` | 加载历史会话 |
| `/new` | 创建新会话（存档旧会话） |
| `/reset` | 清空对话 |
| `/wipe` | 重置用户数据（重新接待） |

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
```

#### 配合 MCP 扩展
如果配置了 Obsidian MCP：
```
用户：搜索我的笔记库中关于 "学习方法" 的笔记
AI：自动调用 Obsidian 搜索工具
```

### 多 Agent 组织架构

coolAI 支持多 Agent 协作系统，模拟企业团队的工作方式。用户可以定义不同的角色（产品经理、项目经理、工程师、测试等），让它们协同完成复杂任务。

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
llm:
  default: ollama
  providers:
    ollama:
      enabled: true
      baseUrl: http://localhost:11434
      model: qwen3.5:9b
    deepseek:
      enabled: true
      apiKey: your-api-key
      model: deepseek-chat
    kimi:
      enabled: true
      apiKey: your-api-key
      model: moonshot-v1-128k
```

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

#### IM 集成（飞书、钉钉、Telegram）

##### 飞书（Lark）

方式一：使用飞书开放平台应用
```yaml
mcp:
  - name: lark
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-lark
    env:
      LARK_APP_ID: your-app-id
      LARK_APP_SECRET: your-app-secret
```

方式二：使用飞书 CLI（本地调试更方便）
```yaml
mcp:
  - name: lark-cli
    command: lark-oapi
    args:
      - mcp
      - --config
      - /path/to/your/lark-config.json
    env:
      DEBUG: "false"
```

飞书 CLI 配置文件示例 `lark-config.json`：
```json
{
  "appId": "your-app-id",
  "appSecret": "your-app-secret",
  "botName": "AI助手"
}
```

##### 钉钉（DingTalk）
```yaml
mcp:
  - name: dingtalk
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-dingtalk
    env:
      DINGTALK_ROBOT_TOKEN: your-robot-token
      DINGTALK_ROBOT_SECRET: your-robot-secret
```

##### Telegram
```yaml
mcp:
  - name: telegram
    command: npx
    args:
      - -y
      - @modelcontextprotocol/server-telegram
    env:
      TELEGRAM_BOT_TOKEN: your-bot-token
```

配置完成后，你可以让 AI：
- 发送消息到群组或频道
- 查询消息历史
- 管理群组成员
- 定时发送通知

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

An intelligent coding assistant CLI tool powered by Ollama, with support for MCP, LSP, and Skills extensions.

### Features

- 🤖 **Ollama Local Models** - Support all Ollama models, no cloud API needed
- 🔌 **MCP Protocol** - Connect to Model Context Protocol servers
- 📝 **LSP Support** - Language Server Protocol for code intelligence
- 🎯 **Skills System** - Install and manage third-party skill extensions
- 🛡️ **Secure Sandbox** - Code execution in controlled environment
- 💬 **Interactive Chat** - Claude Code-like command line interface
- 💾 **Long-term + Short-term Memory** - Human brain-like memory with agent-specific areas
- 🌊 **Streaming Output** - Typewriter effect for AI responses
- ⚡ **Smart Tool Calling** - AI automatically calls appropriate tools to complete tasks
- 📊 **Task Planner** - Complex tasks automatically split into steps for sequential execution
- 🏢 **Multi-Agent Organization** - Simulate enterprise team collaboration with multiple agent roles
- 🐱 **AgentCat Companion** - Health reminder assistant for water, rest, and exercise
- 📋 **Task Progress Tracking** - Real-time task execution progress and status
- 🔐 **Permission Management** - Fine-grained control over file, network, command execution permissions

### Installation

```bash
npm install
npm link
```

### Usage

Run in any directory:

```bash
coolAI
```

Other options:
```bash
ai-agent          # alternative command
node dist/cli/index.js  # direct run
npm run dev       # development mode
```

### Configuration

Create `~/.ai-agent-cli/config.yaml`:

```yaml
ollama:
  baseUrl: http://localhost:11434
  model: qwen3.5:9b
  temperature: 0.7
```

> Note: Start Ollama service first with `ollama serve` and download models with `ollama pull qwen3.5:9b`

### Commands

| Command | Description |
|---------|-------------|
| `/？` | Show quick help |
| `/quit` | Exit |
| `/model` | Show/change model |
| `/tools` | List available tools |
| `/config` | Show configuration |
| `/skill` | Manage Skills |
| `/org` | Manage organization/team |
| `/cat` | AgentCat companion pet |
| `/progress` | Show task progress |
| `/memory` | Memory management |
| `/templates` | List organization templates |
| `/mcp` | Manage MCP servers |
| `/perm` | Permission management |
| `/sessions` | List conversation sessions |
| `/load <id>` | Load a previous session |
| `/new` | Create new session (archive old) |
| `/reset` | Clear conversation |
| `/wipe` | Reset user data (restart onboarding) |

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

### Tech Stack

- TypeScript
- Node.js 20+
- Ollama API
- MCP Protocol
- LSP Protocol

### License

MIT
