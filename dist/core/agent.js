import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
export class Agent {
    ollama;
    mcpManager;
    lspManager;
    sandbox;
    builtInTools;
    messages = [];
    systemPrompt;
    maxIterations;
    iteration = 0;
    tools = [];
    onEvent;
    constructor(options) {
        this.ollama = options.ollama;
        this.mcpManager = options.mcpManager ?? new MCPManager();
        this.lspManager = options.lspManager ?? new LSPManager();
        this.sandbox = options.sandbox ?? new Sandbox({ enabled: true });
        this.builtInTools = options.builtInTools ?? new BuiltInTools(this.sandbox, this.lspManager);
        this.systemPrompt = options.systemPrompt ?? this.getDefaultSystemPrompt();
        this.maxIterations = options.maxIterations ?? 100;
        this.initializeTools();
    }
    setEventHandler(handler) {
        this.onEvent = handler;
    }
    async initializeTools() {
        this.tools = this.builtInTools.getTools();
        if (this.mcpManager) {
            const mcpTools = await this.mcpManager.listAllTools();
            for (const { server, tool } of mcpTools) {
                this.tools.push({
                    name: `${server}_${tool.name}`,
                    description: `[${server}] ${tool.description}`,
                    input_schema: tool.inputSchema,
                });
            }
        }
        this.ollama.setTools(this.tools);
    }
    getDefaultSystemPrompt() {
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
    async chat(input) {
        this.messages.push({ role: 'user', content: input });
        const response = await this.generateResponse();
        return response;
    }
    async generateResponse() {
        this.iteration = 0;
        let fullResponse = '';
        while (this.iteration < this.maxIterations) {
            this.iteration++;
            this.onEvent?.({ type: 'thinking', content: 'Generating response...' });
            const allMessages = [
                { role: 'system', content: this.systemPrompt },
                ...this.messages,
            ];
            try {
                const stream = this.ollama.chatStream(allMessages);
                let accumulatedContent = '';
                let toolCalls;
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
            }
            catch (error) {
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
    async executeToolCall(toolCall) {
        const { name, arguments: argsStr } = toolCall.function;
        let args;
        try {
            args = JSON.parse(argsStr);
        }
        catch {
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
            }
            catch (error) {
                return {
                    tool_call_id: toolCall.id,
                    output: `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
                    is_error: true,
                };
            }
        }
        return this.builtInTools.executeTool(name, args);
    }
    getMessages() {
        return [...this.messages];
    }
    clearMessages() {
        this.messages = [];
    }
    setSystemPrompt(prompt) {
        this.systemPrompt = prompt;
    }
    async refreshTools() {
        await this.initializeTools();
    }
    getToolCount() {
        return this.tools.length;
    }
}
export function createAgent(options) {
    return new Agent(options);
}
//# sourceMappingURL=agent.js.map