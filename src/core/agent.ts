import chalk from 'chalk';
import EventSource from 'eventsource';
import type { Message, Tool, ToolCall, ToolResult } from '../types/index.js';
import { OllamaClient } from '../ollama/client.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';

export interface AgentOptions {
  ollama: OllamaClient;
  mcpManager?: MCPManager;
  lspManager?: LSPManager;
  sandbox?: Sandbox;
  builtInTools?: BuiltInTools;
  systemPrompt?: string;
  maxIterations?: number;
}

export interface AgentEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'response' | 'error';
  content: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

export class Agent {
  private ollama: OllamaClient;
  private mcpManager: MCPManager;
  private lspManager: LSPManager;
  private sandbox: Sandbox;
  private builtInTools: BuiltInTools;
  private messages: Message[] = [];
  private systemPrompt: string;
  private maxIterations: number;
  private iteration = 0;
  private tools: Tool[] = [];
  private onEvent?: (event: AgentEvent) => void;

  constructor(options: AgentOptions) {
    this.ollama = options.ollama;
    this.mcpManager = options.mcpManager ?? new MCPManager();
    this.lspManager = options.lspManager ?? new LSPManager();
    this.sandbox = options.sandbox ?? new Sandbox({ enabled: true });
    this.builtInTools = options.builtInTools ?? new BuiltInTools(this.sandbox, this.lspManager);
    this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
    this.maxIterations = options.maxIterations ?? 100;

    this.initializeTools();
  }

  setEventHandler(handler: (event: AgentEvent) => void): void {
    this.onEvent = handler;
  }

  private async initializeTools(): Promise<void> {
    this.tools = this.builtInTools.getTools();

    if (this.mcpManager) {
      const mcpTools = await this.mcpManager.listAllTools();
      for (const { server, tool } of mcpTools) {
        this.tools.push({
          name: `${server}_${tool.name}`,
          description: `[${server}] ${tool.description}`,
          input_schema: tool.inputSchema as Record<string, unknown>,
        });
      }
    }

    this.ollama.setTools(this.tools);
  }

  private getDefaultSystemPrompt(): string {
    return `You are an expert AI coding assistant, like Claude Code or OpenClaw.

## Your Capabilities
You can help with:
- Reading, writing, and editing code files
- Running shell commands
- Searching and analyzing codebases
- Explaining complex concepts
- Debugging issues
- Writing tests and documentation

## Tool Usage (IMPORTANT - Read Carefully)

When you need to use a tool, you MUST respond with this EXACT format:

\`\`\`
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>
\`\`\`

For example:
- To read a file: <tool_call>{"name": "read_file", "arguments": {"path": "src/index.ts"}}</tool_call>
- To list directory: <tool_call>{"name": "list_directory", "arguments": {"path": "."}}</tool_call>
- To run command: <tool_call>{"name": "execute_command", "arguments": {"command": "npm install"}}</tool_call>

## Available Tools
- read_file(path) - Read file contents
- write_file(path, content) - Write content to file
- edit_file(path, old_string, new_string) - Edit file
- delete_file(path) - Delete file
- list_directory(path) - List directory contents
- create_directory(path) - Create directory
- search_files(path, pattern, content) - Search files
- glob(pattern, cwd) - Find files by pattern
- execute_command(command) - Execute shell command
- read_multiple_files(paths) - Read multiple files

## Response Rules
1. FIRST decide if you need to use a tool
2. If yes, respond ONLY with the <tool_call> block, nothing else
3. After seeing the tool result, provide your response
4. NEVER use markdown code blocks for tool calls - use <tool_call> tags
5. Be concise and helpful

## Workflow Example
User: "Read the package.json file"
You: <tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>

[You receive result]

You: "Here's the content of package.json..."`;
  }

  async chat(input: string): Promise<string> {
    this.messages.push({ role: 'user', content: input });

    const response = await this.generateResponse();
    return response;
  }

  private async generateResponse(): Promise<string> {
    this.iteration = 0;
    let fullResponse = '';

    while (this.iteration < this.maxIterations) {
      this.iteration++;

      this.onEvent?.({ type: 'thinking', content: 'Generating response...' });

      const allMessages = [
        { role: 'system' as const, content: this.systemPrompt },
        ...this.messages,
      ];

      try {
        const stream = this.ollama.chatStream(allMessages);
        let accumulatedContent = '';

        for await (const chunk of stream) {
          accumulatedContent += chunk.content;
          this.onEvent?.({ type: 'response', content: chunk.content });
        }

        fullResponse = accumulatedContent;

        const parsedToolCalls = this.parseToolCalls(fullResponse);

        if (parsedToolCalls.length > 0) {
          let cleanResponse = fullResponse
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
            .trim();

          if (cleanResponse) {
            this.messages.push({ role: 'assistant', content: cleanResponse });
          }

          for (const toolCall of parsedToolCalls) {
            this.onEvent?.({
              type: 'tool_call',
              content: `Calling tool: ${toolCall.function.name}`,
              toolCall,
            });

            const result = await this.executeToolCall(toolCall);
            
            this.onEvent?.({
              type: 'tool_result',
              content: result.output || '',
              toolResult: result,
            });

            this.messages.push({
              role: 'tool',
              content: result.output || '',
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
            });
          }

          continue;
        }

        this.messages.push({ role: 'assistant', content: fullResponse });
        break;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.onEvent?.({ type: 'error', content: errorMessage });
        this.messages.push({ role: 'assistant', content: `Error: ${errorMessage}` });
        return fullResponse || `Error occurred: ${errorMessage}`;
      }
    }

    if (this.iteration >= this.maxIterations) {
      return 'Maximum iterations reached. Please try a simpler task.';
    }

    return fullResponse;
  }

  private async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    const { name, arguments: argsStr } = toolCall.function;
    
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsStr);
    } catch {
      return { tool_call_id: toolCall.id, output: 'Invalid JSON arguments', is_error: true };
    }

    if (name.includes('_')) {
      const parts = name.split('_');
      const server = parts[0] || '';
      const toolName = parts.slice(1).join('_');
      if (!server || !toolName) {
        return { tool_call_id: toolCall.id, output: 'Invalid tool name format', is_error: true };
      }
      try {
        const result = await this.mcpManager.callTool(server, toolName, args);
        return { tool_call_id: toolCall.id, output: JSON.stringify(result), content: result.content };
      } catch (error) {
        return {
          tool_call_id: toolCall.id,
          output: `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
          is_error: true,
        };
      }
    }

    return this.builtInTools.executeTool(name, args);
  }

  private parseToolCalls(content: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const regex = /<tool_call>\s*({[\s\S]*?})\s*<\/tool_call>/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      try {
        const jsonStr = match[1];
        if (!jsonStr) continue;
        const parsed = JSON.parse(jsonStr);
        if (parsed.name && parsed.arguments) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments),
            },
          });
        }
      } catch {
        continue;
      }
    }

    return toolCalls;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
  }

  clearMessages(): void {
    this.messages = [];
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  async refreshTools(): Promise<void> {
    await this.initializeTools();
  }

  getToolCount(): number {
    return this.tools.length;
  }
}

export function createAgent(options: AgentOptions): Agent {
  return new Agent(options);
}
