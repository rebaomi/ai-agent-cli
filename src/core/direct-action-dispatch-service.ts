import type { DirectActionResult } from './direct-action-router.js';
import type { DirectActionHandler } from './direct-actions/request-handler.js';

export interface DirectActionDispatchServiceOptions {
  handlers: () => DirectActionHandler[];
  tryLegacyFallbacks: (input: string) => Promise<DirectActionResult | null>;
}

export class DirectActionDispatchService {
  constructor(private readonly options: DirectActionDispatchServiceOptions) {}

  async tryHandle(input: string): Promise<DirectActionResult | null> {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    for (const handler of this.options.handlers()) {
      if (!(await handler.canHandle(trimmed))) {
        continue;
      }

      const result = await handler.handle(trimmed);
      if (result) {
        return result;
      }
    }

    return this.options.tryLegacyFallbacks(trimmed);
  }
}