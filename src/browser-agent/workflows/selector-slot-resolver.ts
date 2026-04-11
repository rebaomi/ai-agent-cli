export function isSelectorSlotReference(value?: string): boolean {
  return typeof value === 'string' && value.trim().startsWith('$') && value.trim().length > 1;
}

export function getSelectorSlotName(value?: string): string | undefined {
  if (!isSelectorSlotReference(value)) {
    return undefined;
  }

  return value!.trim().slice(1).trim() || undefined;
}

export function resolveSelectorSlotValues(value: string | undefined, namedSelectors?: Record<string, string[]>): string[] {
  const slotName = getSelectorSlotName(value);
  if (!slotName) {
    return typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : [];
  }

  return (namedSelectors?.[slotName] || []).map(item => item.trim()).filter(Boolean);
}

export function uniqueSelectorValues(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim())));
}