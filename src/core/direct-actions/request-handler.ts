import type { DirectActionResult } from '../direct-action-router.js';
import type { ResolvedIntent } from '../intent-resolver.js';

export interface DirectActionHandler {
  readonly name: string;
  canHandle(input: string, intent?: ResolvedIntent): Promise<boolean> | boolean;
  handle(input: string, intent?: ResolvedIntent): Promise<DirectActionResult | null>;
}