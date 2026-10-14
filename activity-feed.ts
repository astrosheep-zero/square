import type { SquareRead } from './ports.js';
import type { StoredAct } from './model.js';
import { readCursor } from './runtime.js';

/** Directed suffix includes seen rows beyond an earlier hole, unlike notification pending. */
export function directedSuffix(facts: SquareRead, name: string): Extract<StoredAct, { kind: 'say' }>[] {
  const result: Extract<StoredAct, { kind: 'say' }>[] = [];
  let afterIndex = readCursor(facts, name);
  while (true) {
    const page = facts.directed(name, { afterIndex }, { edge: 'oldest', limit: 100 });
    for (const act of facts.activities(page.items.map((head) => head.index))) if (act.kind === 'say') result.push(act);
    if (!page.hasMore) return result;
    afterIndex = page.items.at(-1)!.index;
  }
}
