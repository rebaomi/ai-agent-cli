import type { DirectActionResult } from './direct-action-router.js';
import type { DirectActionHandler } from './direct-actions/request-handler.js';
import type { ResolvedIntent } from './intent-resolver.js';

export interface DirectActionDispatchServiceOptions {
  handlers: () => DirectActionHandler[];
  tryLegacyFallbacks: (input: string) => Promise<DirectActionResult | null>;
  resolveIntent?: (input: string) => Promise<ResolvedIntent | null>;
}

export class DirectActionDispatchService {
  constructor(private readonly options: DirectActionDispatchServiceOptions) {}

  async tryHandle(input: string): Promise<DirectActionResult | null> {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    const intent = await this.options.resolveIntent?.(trimmed) ?? undefined;

    for (const handler of this.options.handlers()) {
      if (!(await handler.canHandle(trimmed, intent))) {
        continue;
      }

      const result = await handler.handle(trimmed, intent);
      if (result) {
        return result;
      }
    }

    return this.options.tryLegacyFallbacks(trimmed);
  }
}