# AI Agent CLI

一个基于 Ollama 的智能编程助手 CLI 工具，支持 MCP、LSP 和 Skills 扩展。

## 特性

- 🤖 **Ollama 本地模型** - 支持所有 Ollama 模型，无需云端 API
- 🔌 **MCP 协议** - 接入 Model Context Protocol 服务器
- 📝 **LSP 支持** - Language Server Protocol 代码智能提示
- 🎯 **Skills 系统** - 安装和管理第三方技能扩展
- 🛡️ **安全沙箱** - 代码执行在受控环境中运行
- 💬 **交互式对话** - 类 Claude Code 的命令行界面

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置

在 `~/.ai-agent-cli/config.yaml` 创建配置文件：

```yaml
ollama:
  baseUrl: http://localhost:11434
  model: qwen3.5:9b  # 选择你的模型
  temperature: 0.7
```

### 运行

```bash
node dist/cli/index.js
```

或者开发模式：

```bash
npm run dev
```

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

安装第三方技能：

```bash
# 在 CLI 中
/skill install npm:package-name
/skill install github:owner/repo
/skill install ./local/path
```

## MCP 服务器

在配置文件中添加 MCP 服务器：

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
