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
    return `You are an AI coding assistant that helps users with software development tasks.

You have access to various tools to help you complete tasks:
- File operations: read_file, write_file, edit_file, delete_file
- Directory operations: list_directory, create_directory
- Search: search_files, glob
- Command execution: execute_command
- LSP features: lsp_complete, lsp_diagnostics, lsp_definition

When working with files:
1. Always prefer using built-in tools over execute_command for file operations
2. Use proper file paths and handle errors gracefully
3. Be careful with delete_file - it cannot be undone

When executing commands:
1. Explain what the command will do before running it
2. Show the output and explain what happened
3. If a command fails, diagnose the issue and try alternatives

Be concise, helpful, and follow the user's instructions.`;
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
        let toolCalls: ToolCall[] | undefined;

        for await (const chunk of stream) {
          accumulatedContent += chunk.content;
          if (chunk.toolCalls) {
            toolCalls = chunk.toolCalls;
          }
          this.onEvent?.({ type: 'response', content: chunk.content });
        }

        fullResponse = accumulatedContent;

        if (toolCalls && toolCalls.length > 0) {
          this.messages.push({ role: 'assistant', content: fullResponse, tool_calls: toolCalls });

          for (const toolCall of toolCalls) {
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

  getMessages(): Message[] {
    return [...this.messages];
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
