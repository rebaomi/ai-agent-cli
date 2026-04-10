import { BuiltInTools } from '../tools/builtin.js';
import { SkillManager } from './skills.js';
import { PermissionManager } from './permission-manager.js';
import type { MemoryProvider } from './memory-provider.js';
import type { Message } from '../types/index.js';
import { LarkDeliveryWorkflow } from './workflows/lark-delivery.js';
import { createDirectActionRuntimeComponents } from './direct-action-runtime-factory.js';
import { DirectActionDispatchService } from './direct-action-dispatch-service.js';
import type { IntentResolver } from './intent-resolver.js';

export interface DirectActionResult {
  handled: boolean;
  title?: string;
  output?: string;
  isError?: boolean;
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
    });
  }

  async tryHandle(input: string): Promise<DirectActionResult | null> {
    return this.dispatchService.tryHandle(input);
  }
}

export function createDirectActionRouter(options: DirectActionRouterOptions): DirectActionRouter {
  return new DirectActionRouter(options);
}