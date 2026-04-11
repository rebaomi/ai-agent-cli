export function repairHighBitAsciiMojibake(value: string): string {
  if (!value || !/[\u00C0-\u00FF]/.test(value)) {
    return value;
  }

  let replacedCount = 0;
  let suspiciousCount = 0;
  let candidate = '';

  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code >= 0xC0 && code <= 0xFF) {
      suspiciousCount += 1;
      const lowered = code - 0x80;
      if (lowered >= 0x20 && lowered <= 0x7E) {
        candidate += String.fromCharCode(lowered);
        replacedCount += 1;
        continue;
      }
    }

    candidate += char;
  }

  if (replacedCount < 4 || suspiciousCount < 4) {
    return value;
  }

  const looksMoreReadable = /[A-Za-z]{4,}|\[[A-Za-z ]+\]|---|[A-Za-z]:\\/.test(candidate)
    && !/[\u00C0-\u00FF]{4,}/.test(candidate);

  return looksMoreReadable ? candidate : value;
}

export function normalizeDisplayText(value: string): string {
  return repairHighBitAsciiMojibake(value);
}