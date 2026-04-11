import type { BrowserScriptResultContract, BrowserScriptResultMismatchStrategy } from './domain/types.js';

export interface BrowserScriptResultValidation {
  matched: boolean;
  summary?: string;
  expected?: string;
  actual: string;
}

export function validateScriptResultContract(value: unknown, contract?: BrowserScriptResultContract): BrowserScriptResultValidation {
  const actual = detectScriptResultType(value);
  if (!contract) {
    return { matched: true, actual };
  }

  const expected = describeScriptResultContract(contract);
  if (!contract.type) {
    return { matched: true, expected, actual, summary: `返回值契约已记录: ${expected}` };
  }

  const matched = matchesScriptResultType(value, contract.type);
  return {
    matched,
    expected,
    actual,
    summary: matched
      ? `返回值匹配预期 ${expected}`
      : `返回值与预期不匹配，预期 ${expected}，实际 ${actual}`,
  };
}

export function formatScriptActionOutput(value: unknown, validation: BrowserScriptResultValidation): string | undefined {
  if (value === undefined && !validation.summary) {
    return undefined;
  }

  if (!validation.summary) {
    return value === undefined ? undefined : stringifyScriptResult(value);
  }

  return JSON.stringify({
    matched: validation.matched,
    expected: validation.expected,
    actual: validation.actual,
    value,
  }, null, 2);
}

export function formatScriptActionLogText(value: unknown, validation: BrowserScriptResultValidation): string {
  if (!validation.summary) {
    return stringifyScriptResult(value) || '';
  }

  return JSON.stringify({
    matched: validation.matched,
    expected: validation.expected,
    actual: validation.actual,
    value,
  }, null, 2);
}

export function resolveScriptResultValidationHandling(
  validation: BrowserScriptResultValidation,
  strategy: BrowserScriptResultMismatchStrategy | undefined,
  actionLabel: string,
): { displaySummary?: string; recordedValidation?: string } {
  if (!validation.summary) {
    return {};
  }

  if (validation.matched) {
    return {
      displaySummary: validation.summary,
      recordedValidation: validation.summary,
    };
  }

  const effectiveStrategy = strategy || 'warn';
  if (effectiveStrategy === 'record-only') {
    return {
      recordedValidation: validation.summary,
    };
  }

  if (effectiveStrategy === 'hard-fail') {
    throw new Error(`${actionLabel} ${validation.summary}`);
  }

  const warning = `警告：${validation.summary}`;
  return {
    displaySummary: warning,
    recordedValidation: warning,
  };
}

function stringifyScriptResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value === undefined) {
    return '';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function matchesScriptResultType(value: unknown, expectedType: NonNullable<BrowserScriptResultContract['type']>): boolean {
  switch (expectedType) {
    case 'void':
      return value === undefined || value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
    case 'json':
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'string':
    case 'number':
    case 'boolean':
      return typeof value === expectedType;
    default:
      return true;
  }
}

function detectScriptResultType(value: unknown): string {
  if (value === undefined || value === null) {
    return 'void';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return typeof value;
}

function describeScriptResultContract(contract: BrowserScriptResultContract): string {
  const parts = [
    contract.type || '',
    contract.shape ? `<${contract.shape}>` : '',
    contract.description ? ` ${contract.description}` : '',
  ].filter(Boolean);
  return parts.join(' ').trim() || 'unspecified';
}