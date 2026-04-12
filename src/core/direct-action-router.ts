import { BuiltInTools } from '../tools/builtin.js';
import { SkillManager } from './skills.js';
import { PermissionManager } from './permission-manager.js';
import type { MemoryProvider } from './memory-provider.js';
import type { Message } from '../types/index.js';
import { LarkDeliveryWorkflow } from './workflows/lark-delivery.js';
import { createDirectActionRuntimeComponents } from './direct-action-runtime-factory.js';
import { DirectActionDispatchService } from './direct-action-dispatch-service.js';
import type { DirectActionDispatchPreview } from './direct-action-dispatch-service.js';
import type { IntentResolver } from './intent-resolver.js';
import type { SessionTaskRecord } from '../types/index.js';

export interface DirectActionResult {
  handled: boolean;
  title?: string;
  output?: string;
  isError?: boolean;
  handlerName?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface DirectActionBindingContext {
  effectiveInput?: string;
  isFollowUp?: boolean;
  boundTask?: SessionTaskRecord;
}

export interface DirectActionRouterOptions {
  builtInTools: BuiltInTools;
  skillManager: SkillManager;
  permissionManager: PermissionManager;
  workspace: string;
  config?: unknown;
  getConversationMessages?: () => Message[];
  memoryProvider?: MemoryProvider;
  intentResolver?: IntentResolver;
  onConversationPreamble?: (message: string) => Promise<void> | void;
}

export class DirectActionRouter {
  private dispatchService: DirectActionDispatchService;

  constructor(options: DirectActionRouterOptions) {
    let larkDeliveryWorkflow: LarkDeliveryWorkflow | undefined;
    const runtimeComponents = createDirectActionRuntimeComponents({
      ...options,
      handleLarkWorkflow: (input) => larkDeliveryWorkflow?.tryHandle(input) ?? Promise.resolve(null),
    });
    larkDeliveryWorkflow = runtimeComponents.larkDeliveryWorkflow;
    this.dispatchService = new DirectActionDispatchService({
      handlers: () => runtimeComponents.handlers,
      tryLegacyFallbacks: (input) => runtimeComponents.toolSupport.tryLegacyFallbacks(input),
      resolveIntent: options.intentResolver ? (input) => options.intentResolver!.resolve(input) : undefined,
      conversationMode: this.resolveConversationMode(options.config),
      onConversationPreamble: options.onConversationPreamble,
    });
  }

  async tryHandle(input: string, binding?: DirectActionBindingContext): Promise<DirectActionResult | null> {
    return this.dispatchService.tryHandle({
      originalInput: input,
      effectiveInput: binding?.effectiveInput || input,
      isFollowUp: binding?.isFollowUp === true,
      boundTask: binding?.boundTask,
    });
  }

  async preview(input: string, binding?: DirectActionBindingContext): Promise<DirectActionDispatchPreview | null> {
    return this.dispatchService.preview({
      originalInput: input,
      effectiveInput: binding?.effectiveInput || input,
      isFollowUp: binding?.isFollowUp === true,
      boundTask: binding?.boundTask,
    });
  }

  private resolveConversationMode(config: unknown): { enabled: boolean; preambleThreshold: number } {
    const normalized = config && typeof config === 'object' ? config as Record<string, unknown> : {};
    const directAction = normalized.directAction && typeof normalized.directAction === 'object'
      ? normalized.directAction as Record<string, unknown>
      : {};
    const conversationMode = directAction.conversationMode && typeof directAction.conversationMode === 'object'
      ? directAction.conversationMode as Record<string, unknown>
      : {};

    return {
      enabled: conversationMode.enabled !== false,
      preambleThreshold: typeof conversationMode.preambleThreshold === 'number' && Number.isFinite(conversationMode.preambleThreshold)
        ? conversationMode.preambleThreshold
        : 2,
    };
  }
}

export function createDirectActionRouter(options: DirectActionRouterOptions): DirectActionRouter {
  return new DirectActionRouter(options);
}