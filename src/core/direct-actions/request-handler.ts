import type { DirectActionResult } from '../direct-action-router.js';
import type { DirectActionDispatchContext } from '../direct-action-dispatch-service.js';
import type { ResolvedIntent } from '../intent-resolver.js';

export interface DirectActionHandler {
  readonly name: string;
  canHandle(input: string, intent?: ResolvedIntent, context?: DirectActionDispatchContext): Promise<boolean> | boolean;
  handle(input: string, intent?: ResolvedIntent, context?: DirectActionDispatchContext): Promise<DirectActionResult | null>;
}