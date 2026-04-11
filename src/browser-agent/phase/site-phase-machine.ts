import type { BrowserAgentPhase, BrowserInteractiveElement, BrowserPageDigest, BrowserPhaseSnapshot } from '../domain/types.js';

export class SitePhaseMachine {
  private previous?: BrowserPhaseSnapshot;

  advance(digest: BrowserPageDigest): BrowserPhaseSnapshot {
    const detected = detectPhase(digest, this.previous);
    const transition = this.previous && this.previous.phase !== detected.phase
      ? `${this.previous.phase} -> ${detected.phase}`
      : undefined;

    const snapshot: BrowserPhaseSnapshot = {
      ...detected,
      transition,
    };

    this.previous = snapshot;
    return snapshot;
  }
}

function detectPhase(digest: BrowserPageDigest, previous?: BrowserPhaseSnapshot): Omit<BrowserPhaseSnapshot, 'transition'> {
  const scores = new Map<BrowserAgentPhase, number>([
    ['unknown', 0],
    ['landing', 0],
    ['search-input', 0],
    ['search-results', 0],
    ['detail', 0],
    ['form', 0],
  ]);
  const signals: string[] = [];

  const url = digest.url.toLowerCase();
  const title = digest.title.toLowerCase();
  const text = (digest.visibleText || '').toLowerCase();
  const elements = digest.interactiveElements || [];
  const searchInputs = elements.filter(element => isSearchInput(element));
  const formInputs = elements.filter(element => isFormInput(element));
  const likelyLinks = elements.filter(element => /link|a/i.test(element.role));

  if (searchInputs.length > 0) {
    addScore(scores, 'search-input', 3);
    signals.push(`search-inputs=${searchInputs.length}`);
  }

  if (/(search|query|q=|wd=|keyword=|searchword=)/i.test(url) || /(搜索结果|search results|results for)/i.test(`${title} ${text}`)) {
    addScore(scores, 'search-results', 4);
    signals.push('search-result-pattern');
  }

  if (likelyLinks.length >= 5 && text.length > 120) {
    addScore(scores, 'search-results', 2);
    signals.push(`result-links=${likelyLinks.length}`);
  }

  if (/detail|article|job|product|view|item|content/i.test(url) || text.length > 500) {
    addScore(scores, 'detail', 3);
    signals.push('detail-content');
  }

  if (formInputs.length >= 2) {
    addScore(scores, 'form', 3);
    signals.push(`form-inputs=${formInputs.length}`);
  }

  if (text.length < 220 && likelyLinks.length >= 4 && searchInputs.length === 0) {
    addScore(scores, 'landing', 2);
    signals.push('landing-navigation');
  }

  if (previous?.phase === 'search-input' && /(search|q=|wd=)/i.test(url)) {
    addScore(scores, 'search-results', 2);
  }

  if (previous?.phase === 'search-results' && text.length > 350) {
    addScore(scores, 'detail', 1);
  }

  const sorted = [...scores.entries()].sort((left, right) => right[1] - left[1]);
  const [phase, score] = sorted[0] || ['unknown', 0];
  const confidence = Math.max(0.2, Math.min(0.95, score / 6));

  return {
    phase,
    confidence,
    signals: signals.slice(0, 5),
  };
}

function addScore(scores: Map<BrowserAgentPhase, number>, phase: BrowserAgentPhase, delta: number): void {
  scores.set(phase, (scores.get(phase) || 0) + delta);
}

function isSearchInput(element: BrowserInteractiveElement): boolean {
  return /input|textarea/i.test(element.role)
    && /search|查询|搜索|查找|q|wd/i.test(`${element.placeholder || ''} ${element.text || ''} ${element.type || ''}`);
}

function isFormInput(element: BrowserInteractiveElement): boolean {
  return /input|textarea|select/i.test(element.role);
}