import type { SquareRead } from './ports.js';
import type { ExpressContext } from './square-facade.js';
import { formatActivityId } from './square-core.js';

const CONTEXT_LIMIT = 5;
const PREVIEW_CHARS = 400;

/** A bounded, nonconsuming glimpse; seen rows beyond a cursor hole must not reappear. */
export function expressionContext(facts: SquareRead, name: string): ExpressContext {
  const filter = { afterIndex: facts.participant(name)?.lastJoinIndex ?? -1, unseenOnly: true as const };
  const page = facts.directed(name, filter, { edge: 'newest', limit: CONTEXT_LIMIT });
  const activities = facts.activities(page.items.map(head => head.index)).filter(act => act.kind === 'say')
    .sort((a, b) => a.index - b.index).map(act => {
      const body = act.body ?? '(structured activity)';
      // Keep the boundary between Unicode code points, including non-BMP characters.
      const chars = Array.from(body.slice(0, PREVIEW_CHARS * 2));
      const preview = chars.slice(0, PREVIEW_CHARS).join('');
      return { id: formatActivityId(act.index), actor: act.actor, preview, truncated: preview.length < body.length };
    });
  return { activities, remaining: Math.max(0, facts.directedCount(name, filter) - activities.length) };
}
