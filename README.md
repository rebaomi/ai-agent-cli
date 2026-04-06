# AI Agent CLI

一个基于 Ollama 的智能编程助手 CLI 工具，支持 MCP、LSP 和 Skills 扩展。

## 特性

- 🤖 **Ollama 本地模型** - 支持所有 Ollama 模型，无需云端 API
- 🔌 **MCP 协议** - 接入 Model Context Protocol 服务器
- 📝 **LSP 支持** - Language Server Protocol 代码智能提示
- 🎯 **Skills 系统** - 安装和管理第三方技能扩展
- 🛡️ **安全沙箱** - 代码执行在受控环境中运行
- 💬 **交互式对话** - 类 Claude Code 的命令行界面
- 💾 **记忆管理** - 对话历史持久化，支持会话切换
- 🌊 **流式输出** - AI 回复逐字显示，打字机效果
- ⚡ **智能工具调用** - AI 自动调用合适工具完成任务

## 安装

```bash
npm install
npm link
```

## 使用

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

## 配置

在 `~/.ai-agent-cli/config.yaml` 创建配置文件：

```yaml
ollama:
  baseUrl: http://localhost:11434
  model: qwen3.5:9b  # 选择你的模型
  temperature: 0.7
```

> 注意：首次使用需要先启动 Ollama 服务 `ollama serve` 并下载模型 `ollama pull qwen3.5:9b`

## 命令

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

## 安装 Ollama 模型

```bash
# 下载模型
ollama pull qwen3.5:9b
ollama pull llama3.2
ollama pull gemma4:3b

# 查看已安装模型
ollama list
```

## Skills 扩展

Skills 扩展 coolAI 的能力，让 AI 可以执行自定义命令和工具。

### 管理 Skills

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

### 开发自己的 Skill

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

### Skill 目录结构

```
~/.ai-agent-cli/skills/
├── skill-1/
│   ├── skill.json
│   └── index.js
└── skill-2/
    ├── skill.json
    └── index.js
```

## MCP 服务器

MCP (Model Context Protocol) 服务器可以扩展 AI 的能力。

### 常用 MCP 服务器

#### 文件系统
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

#### Obsidian 笔记
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

#### GitHub
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

#### Brave 搜索
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

更多 MCP 服务器：https://modelcontextprotocol.io/servers

## 内置工具

- `read_file` - 读取文件
- `write_file` - 写入文件
- `edit_file` - 编辑文件
- `delete_file` - 删除文件
- `list_directory` - 列出目录
- `glob` - 文件匹配
- `execute_command` - 执行命令
- `lsp_complete` - 代码补全
- `lsp_diagnostics` - 代码诊断

## 技术栈

- TypeScript
- Node.js 20+
- Ollama API
- MCP Protocol
- LSP Protocol

## License

MIT
