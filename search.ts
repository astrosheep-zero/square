// Shared activity-body search semantics for filtering and presentation.
// Regex mode intentionally uses JavaScript's built-in engine: patterns come from
// the local CLI user and are not treated as a hostile multi-tenant input. Use
// --fixed for literal text; do not claim regex mode has ReDoS protection.

import { SquareError } from './model.js';

function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileGrepPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i');
  } catch (err) {
    const detail = err instanceof Error ? err.message.replace(/^Invalid regular expression:\s*/i, '') : 'invalid expression';
    throw new SquareError('invalid_args', `Invalid --grep regex: ${detail}`);
  }
}

export function compileFixedPattern(pattern: string): RegExp {
  return new RegExp(escapeRegex(pattern), 'i');
}

export function compileSearchPattern(pattern: string, fixed: boolean): RegExp {
  return fixed ? compileFixedPattern(pattern) : compileGrepPattern(pattern);
}

export interface GrepSnippet {
  before: string;
  match: string;
  after: string;
  beforeOmitted: number;
  afterOmitted: number;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

export function grepSnippet(body: string, pattern: string, maxChars: number, fixed = false): GrepSnippet | undefined {
  const found = compileSearchPattern(pattern, fixed).exec(body);
  if (found === null) return undefined;

  const beforeAll = [...body.slice(0, found.index)];
  const matchAll = [...found[0]];
  const afterAll = [...body.slice(found.index + found[0].length)];
  const shownMatch = matchAll.slice(0, maxChars);
  let remaining = Math.max(0, maxChars - shownMatch.length);
  let beforeTake = Math.min(beforeAll.length, Math.floor(remaining / 2));
  let afterTake = Math.min(afterAll.length, remaining - beforeTake);

  // Give unused context budget to whichever side still has text.
  remaining -= beforeTake + afterTake;
  if (remaining > 0) {
    const extraBefore = Math.min(remaining, beforeAll.length - beforeTake);
    beforeTake += extraBefore;
    remaining -= extraBefore;
  }
  if (remaining > 0) afterTake += Math.min(remaining, afterAll.length - afterTake);

  return {
    before: compactWhitespace(beforeAll.slice(-beforeTake).join('')),
    match: compactWhitespace(shownMatch.join('')),
    after: compactWhitespace(afterAll.slice(0, afterTake).join('')),
    beforeOmitted: beforeAll.length - beforeTake,
    afterOmitted: afterAll.length - afterTake + Math.max(0, matchAll.length - shownMatch.length),
  };
}
