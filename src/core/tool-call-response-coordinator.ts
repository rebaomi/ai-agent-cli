import type { Message, ToolCall } from '../types/index.js';
import type { AssistantToolCallMessageOptions, PreparedToolCallBatchLike, ToolCallConversationBridge } from './tool-call-conversation-bridge.js';

export interface PreparedToolCallExecutionBatch extends PreparedToolCallBatchLike {
  contract?: unknown;
}

export interface ToolCallResponseCoordinatorOptions {
  parseToolCalls: (content: string) => ToolCall[];
  prepareToolCallsForExecution: (
    userInput: string,
    assistantContent: string,
    toolCalls: ToolCall[],
    useModelContract: boolean,
  ) => Promise<PreparedToolCallExecutionBatch>;
  conversationBridge: ToolCallConversationBridge;
  addMessage: (message: Message) => void;
  enterToolCallingState: () => void;
  runPreparedToolCalls: (batch: PreparedToolCallExecutionBatch) => Promise<void>;
}

export interface CoordinateToolCallResponseParams {
  userInput: string;
  responseContent: string;
  nativeToolCalls?: ToolCall[];
  prepareFallbackContent?: string;
  assistantMessageOptions?: AssistantToolCallMessageOptions;
}

export interface CoordinateToolCallResponseResult {
  handled: boolean;
  cleanResponse: string;
  toolCallSource: 'native' | 'parsed' | 'none';
}

export class ToolCallResponseCoordinator {
  constructor(private readonly options: ToolCallResponseCoordinatorOptions) {}

  async coordinate(params: CoordinateToolCallResponseParams): Promise<CoordinateToolCallResponseResult> {
    const parsedToolCalls = this.options.parseToolCalls(params.responseContent);
    const nativeToolCalls = params.nativeToolCalls || [];
    const finalToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : parsedToolCalls;
    const cleanResponse = this.stripToolCallMarkup(params.responseContent).trim();

    if (finalToolCalls.length === 0) {
      return {
        handled: false,
        cleanResponse,
        toolCallSource: 'none',
      };
    }

    this.options.enterToolCallingState();

    const prepared = await this.options.prepareToolCallsForExecution(
      params.userInput,
      cleanResponse || params.prepareFallbackContent || '',
      finalToolCalls,
      true,
    );

    const assistantMessage = this.options.conversationBridge.createAssistantToolCallMessage(
      cleanResponse,
      prepared,
      params.assistantMessageOptions,
    );

    if (assistantMessage) {
      this.options.addMessage(assistantMessage);
    }

    await this.options.runPreparedToolCalls(prepared);

    return {
      handled: true,
      cleanResponse,
      toolCallSource: nativeToolCalls.length > 0 ? 'native' : 'parsed',
    };
  }

  private stripToolCallMarkup(content: string): string {
    return content.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  }
}