import { NAME_GRAPHEME_SOURCE, sameName } from './model.js';

/**
 * Roster-free scan for `@name` candidates in an activity body. Resolution against the
 * standing roster happens at landing time in decideAct; this scanner only knows the
 * name grammar and Markdown code spans.
 *
 * Guard rails:
 * - Backtick code spans never yield candidates (also the escape hatch: `` `@name` `` stays literal).
 * - A `@` glued to a handle-like prefix does not start a candidate, so emails
 *   (`user@host`), URLs (`x.com/@user`), and `snake_@case` stay literal. Only ASCII
 *   word characters, `_`, `-`, `/`, and `@` block a boundary: CJK adjacency like
 *   `告诉@rei` stays mentionable because CJK text has no spaces to lean on.
 * - The token must be a complete name (slash-separated segments allowed); resolution
 *   never backs off to a shorter prefix, so `@rei2` does not mention `rei`.
 */

const MENTION_TOKEN = new RegExp(`@((?:${NAME_GRAPHEME_SOURCE})+(?:/(?:${NAME_GRAPHEME_SOURCE})+)*)`, 'vg');
const BOUNDARY_BLOCKER = /[A-Za-z0-9_\-/@]/;

/** Ranges [from, to) covered by Markdown code spans (backtick runs close at a run of equal length). */
function codeSpanRanges(body: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  let index = 0;
  while (index < body.length) {
    if (body[index] !== '`') { index += 1; continue; }
    let runEnd = index;
    while (runEnd < body.length && body[runEnd] === '`') runEnd += 1;
    const runLength = runEnd - index;
    let scan = runEnd;
    let closedEnd = -1;
    while (scan < body.length) {
      if (body[scan] !== '`') { scan += 1; continue; }
      let closeEnd = scan;
      while (closeEnd < body.length && body[closeEnd] === '`') closeEnd += 1;
      if (closeEnd - scan === runLength) { closedEnd = closeEnd; break; }
      scan = closeEnd;
    }
    if (closedEnd === -1) {
      // Unmatched backticks are literal text; scanning continues after the run.
      index = runEnd;
      continue;
    }
    ranges.push([index, closedEnd]);
    index = closedEnd;
  }
  return ranges;
}

function codePointBefore(body: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const unit = body.charCodeAt(index - 1);
  if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2) return String.fromCodePoint(body.codePointAt(index - 2)!);
  return String.fromCodePoint(unit);
}

export interface MentionCandidate {
  /** The maximal name-grammar token after `@` (roster-free; resolution may shorten it). */
  readonly token: string;
  /** UTF-16 index of the `@` in the body. */
  readonly index: number;
}

export function scanMentionCandidates(body: string): MentionCandidate[] {
  const spans = codeSpanRanges(body);
  const found: MentionCandidate[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const start = match.index;
    if (spans.some(([from, to]) => start >= from && start < to)) continue;
    const previous = codePointBefore(body, start);
    if (previous !== undefined && BOUNDARY_BLOCKER.test(previous)) continue;
    const token = match[1];
    const key = token.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ token, index: start });
    }
  }
  return found;
}

/**
 * Resolve the longest standing name starting at one candidate's position. A partial
 * match is only accepted when the character right after it is not handle-continuation
 * (ASCII word char, `_`, `-`, `/`): `@rei2` never degrades into mentioning `rei`, while
 * CJK-fluent text like `告诉@rei这个` still mentions `rei`.
 */
const TRAILING_BLOCKER = /[A-Za-z0-9_\-/]/;

export function resolveNameAt(body: string, candidate: MentionCandidate, names: readonly string[]): string | undefined {
  const text = body.slice(candidate.index + 1, candidate.index + 1 + candidate.token.length);
  let best: string | undefined;
  for (const name of names) {
    if (name.length > text.length) continue;
    if (!sameName(text.slice(0, name.length), name)) continue;
    const after = text[name.length];
    if (after !== undefined && TRAILING_BLOCKER.test(after)) continue;
    if (best === undefined || name.length > best.length) best = name;
  }
  return best;
}
