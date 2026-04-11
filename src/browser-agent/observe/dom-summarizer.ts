import type { BrowserInteractiveElement, BrowserPageDigest } from '../domain/types.js';

export class DOMSummarizer {
  summarize(params: {
    url: string;
    title: string;
    visibleText?: string;
    interactiveSummary?: string[];
    interactiveElements?: BrowserInteractiveElement[];
    screenshotPath?: string;
  }): BrowserPageDigest {
    const trimmedText = params.visibleText?.trim();
    return {
      url: params.url,
      title: params.title,
      visibleText: trimmedText ? trimmedText.slice(0, 4000) : undefined,
      interactiveSummary: params.interactiveSummary?.slice(0, 20),
      interactiveElements: params.interactiveElements?.slice(0, 50),
      screenshotPath: params.screenshotPath,
      fingerprint: `${params.url}::${params.title}::${params.interactiveSummary?.slice(0, 5).join('|') || ''}`,
    };
  }
}
