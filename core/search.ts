// Case-insensitive archive search.
// Regex mode intentionally uses JavaScript's built-in engine, without a ReDoS
// timeout. Callers should use literal mode for plain text and avoid untrusted regexes.

import { SquareError } from './neutral.js';

export function compileSearchPattern(pattern: string, fixed: boolean): RegExp {
  if (fixed) return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^Invalid regular expression:\s*/i, '') : 'invalid expression';
    throw new SquareError('invalid_args', `Invalid search regex: ${detail}`);
  }
}

export function historySearch(search: string) {
  return search.length > 1 && search.startsWith('/') && search.endsWith('/')
    ? { text: search.slice(1, -1), mode: 'regex' as const } : { text: search, mode: 'literal' as const };
}
