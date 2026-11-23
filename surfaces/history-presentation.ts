import { parseActivityId } from '../core/square-core.js';
import { nameKey } from '../core/model.js';
import type { HistoryQuery, HistoryResult } from '../api/types.js';
import { type PresentationSurface, spellAction, renderEventCli, renderPresenceAnchor, withPathOutput } from './presentation.js';

export function renderHistoryResult(
  location: string, data: HistoryResult, { query, surface }: { query: HistoryQuery; surface?: PresentationSurface },
): string | undefined {
  const observed = data.observation;
  if (observed === undefined) return undefined;
  const chunks = data.activities.map(activity => renderEventCli(activity, { now: observed.now }));
  if (chunks.length === 0) chunks.push('○ no activity matches this history query');
  const names = new Map<string, string>();
  for (const activity of data.activities) {
    for (const name of observed.presenceAnchors[parseActivityId(activity.id)!] ?? []) names.set(nameKey(name), name);
  }
  if (names.size > 0) chunks.push(renderPresenceAnchor([...names.values()]));
  const next = observed.continuation;
  if (next !== undefined) chunks.push(spellAction({ operation: 'history',
    args: { location, ...query, [next.direction]: next.cursor, limit: next.limit } }, surface));
  return withPathOutput(location, chunks.join('\n\n'), { participantCount: observed.standingCount });
}
