export function sanitizeUtf8String(value: string): string {
  let result = '';

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        result += value.charAt(index) + value.charAt(index + 1);
        index += 1;
      } else {
        result += '\uFFFD';
      }
      continue;
    }

    if (code >= 0xDC00 && code <= 0xDFFF) {
      result += '\uFFFD';
      continue;
    }

    result += value.charAt(index);
  }

  return result;
}

export function sanitizeForUtf8<T>(value: T): T {
  return sanitizeForUtf8Internal(value, new WeakMap<object, unknown>());
}

function sanitizeForUtf8Internal<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (typeof value === 'string') {
    return sanitizeUtf8String(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeForUtf8Internal(item, seen)) as T;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }

  if (seen.has(value as object)) {
    return seen.get(value as object) as T;
  }

  const clone: Record<string, unknown> = {};
  seen.set(value as object, clone);

  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    clone[sanitizeUtf8String(key)] = sanitizeForUtf8Internal(entryValue, seen);
  }

  return clone as T;
}

export function safeJsonStringify(value: unknown, space?: number): string {
  return JSON.stringify(sanitizeForUtf8(value), null, space);
}