const MAX_STRING_LENGTH = 1_000;
const MAX_COLLECTION_ITEMS = 32;
const MAX_NESTING = 8;

function redactText(value: string, secret: string | undefined): string {
  const withoutSecret = secret?.trim() ? value.split(secret.trim()).join('[redacted]') : value;
  const withoutUrlPassword = withoutSecret.replace(/([?&]password=)[^&\s]+/gi, '$1[redacted]');
  return [...withoutUrlPassword].length <= MAX_STRING_LENGTH
    ? withoutUrlPassword
    : `${[...withoutUrlPassword].slice(0, MAX_STRING_LENGTH - 1).join('')}…`;
}

function redactValue(value: unknown, secret: string | undefined, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactText(value, secret);
  if (depth >= MAX_NESTING) return '[truncated]';
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => redactValue(item, secret, seen, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).slice(0, MAX_COLLECTION_ITEMS).map(([key, item]) => [
      key,
      /password|secret|api[-_]?key|token/i.test(key) && typeof item !== 'boolean'
        ? '[redacted]'
        : redactValue(item, secret, seen, depth + 1),
    ]));
  }
  return value;
}

export function redactDiagnostic(value: unknown, secret: string | undefined): unknown {
  return redactValue(value, secret, new WeakSet(), 0);
}

export function redactCurrentDiagnostic(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  return redactDiagnostic(value, env.PASEO_PASSWORD);
}
