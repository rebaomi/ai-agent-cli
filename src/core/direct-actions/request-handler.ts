import type { DirectActionResult } from '../direct-action-router.js';

export interface DirectActionHandler {
  readonly name: string;
  canHandle(input: string): Promise<boolean> | boolean;
  handle(input: string): Promise<DirectActionResult | null>;
}