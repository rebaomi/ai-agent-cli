# AI Agent CLI

**[简体中文](#简体中文) | [English](#english)**

---

## 简体中文

一个基于 Ollama 的智能编程助手 CLI 工具，支持 MCP、LSP 和 Skills 扩展。

### 特性

- 🤖 **Ollama 本地模型** - 支持所有 Ollama 模型，无需云端 API
- 🔌 **MCP 协议** - 接入 Model Context Protocol 服务器
- 📝 **LSP 支持** - Language Server Protocol 代码智能提示
- 🎯 **Skills 系统** - 安装和管理第三方技能扩展
- 🛡️ **安全沙箱** - 代码执行在受控环境中运行
- 💬 **交互式对话** - 类 Claude Code 的命令行界面
- 💾 **记忆管理** - 对话历史持久化，支持会话切换
- 🌊 **流式输出** - AI 回复逐字显示，打字机效果
- ⚡ **智能工具调用** - AI 自动调用合适工具完成任务
- 📊 **任务规划器** - 复杂任务自动拆分成步骤执行，逐步完成

### 安装

```bash
npm install
npm link
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
| `/mcp` | 管理 MCP 服务器 |
| `/sessions` | 查看历史会话 |
| `/load <id>` | 加载历史会话 |
| `/reset` | 清空对话 |

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

#### 配合 MCP 扩展
如果配置了 Obsidian MCP：
```
用户：搜索我的笔记库中关于 "学习方法" 的笔记
AI：自动调用 Obsidian 搜索工具
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
- 💾 **Memory Management** - Persistent conversation history with session switching
- 🌊 **Streaming Output** - Typewriter effect for AI responses
- ⚡ **Smart Tool Calling** - AI automatically calls appropriate tools to complete tasks
- 📊 **Task Planner** - Complex tasks automatically split into steps for sequential execution

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
| `/mcp` | Manage MCP servers |
| `/sessions` | List conversation sessions |
| `/load <id>` | Load a previous session |
| `/reset` | Clear conversation |

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
