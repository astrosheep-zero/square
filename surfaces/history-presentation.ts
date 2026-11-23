import { sameName } from '../core/model.js';
import { isNarratedActivity, parseActivityId } from '../core/square-core.js';
import type { HistoryObservation, HistoryQuery, HistoryResult, Activity } from '../api/types.js';
import { grepSnippet } from '../core/search.js';
import { participantIdentity } from '../core/square-values.js';
import { formatTimestamp } from '../core/time.js';
import { style } from './tty-style.js';
import { type PresentationSurface, spellAction, previewBodyFacts, quoteShell, renderEventCli, renderPresenceAnchor, withPathOutput } from './presentation.js';

const GREP_PREVIEW_CHARS = 160;

export function renderGrepActivitiesView(
  visible: readonly Activity[],
  totalMatches: number,
  full: boolean | undefined,
  squarePath: string,
  pattern: string,
  fixed = false,
  surface: PresentationSurface = 'cli',
): string {
  const publicVisible = visible.filter((act) => act.kind === 'say' || act.kind === 'done');
  if (totalMatches === 0) return `○ no activity matched ${quoteShell(pattern)}`;
  const matchLabel = totalMatches === 1 ? 'match' : 'matches';
  const chunks = [publicVisible.length === totalMatches ? `${totalMatches} ${matchLabel}` : `${publicVisible.length} of ${totalMatches} ${matchLabel}`];
  let truncated = false;

  for (const act of publicVisible) {
    const rawBody = act.body ?? '';
    const header = `${style('dim', act.id)} · ${participantIdentity(act.actor)} · ${style('dim', formatTimestamp(act.at))}`;
    if (full === true) {
      const body = rawBody.split('\n').map((line) => `  ${line}`).join('\n');
      chunks.push(`${header}\n${body}`);
      continue;
    }

    const snippet = grepSnippet(rawBody, pattern, GREP_PREVIEW_CHARS, fixed);
    if (snippet === undefined) {
      const preview = previewBodyFacts(rawBody, GREP_PREVIEW_CHARS).text;
      chunks.push(`${header}${preview === '' ? '' : `\n  ${preview}`}`);
      continue;
    }
    const clippedBefore = snippet.beforeOmitted > 0;
    const clippedAfter = snippet.afterOmitted > 0;
    truncated ||= clippedBefore || clippedAfter;
    const text = `${clippedBefore ? '… ' : ''}${snippet.before}${style('match', snippet.match)}${snippet.after}${clippedAfter ? ' …' : ''}`;
    const omitted = clippedBefore || clippedAfter
      ? `\n${style('dim', `  · ${snippet.beforeOmitted} chars before · ${snippet.afterOmitted} chars after`)}`
      : '';
    chunks.push(`${header}\n  ${text.trim()}${omitted}`);
  }

  if (publicVisible.length === 1 || truncated) {
    chunks.push(spellAction({ operation: 'history', args: { location: squarePath, at: [publicVisible[0].id], context: 2, full: truncated || undefined } }, surface));
  }
  return chunks.join('\n\n');
}

function renderHistoryProjection(
  projection: HistoryObservation,
  visible: readonly Activity[],
  full: boolean,
  squarePath: string,
  surface: PresentationSurface,
): string {
  const shown = visible;
  const preview = full || shown.length <= 1 ? undefined : 200;
  const chunks: string[] = [];
  // Presence anchors collect into one closing line instead of interrupting the page.
  const anchored: string[] = [];
  for (const activity of shown) {
    const rendered = renderEventCli(activity, { now: projection.now, preview });
    if (rendered !== '') chunks.push(rendered);
    for (const participant of projection.presenceAnchors[parseActivityId(activity.id)!] ?? []) {
      if (!anchored.some((existing) => sameName(existing, participant))) anchored.push(participant);
    }
  }
  if (chunks.length === 0) return '○ no activity matches this history query';
  if (preview !== undefined && shown.some((activity) => activity.kind === 'say' && (activity.body?.length ?? 0) > preview)) {
    const ids = shown.map((activity) => activity.id);
    chunks.push(spellAction({ operation: 'history', args: { location: squarePath, at: ids, full: true } }, surface));
  }
  if (anchored.length > 0) chunks.push(renderPresenceAnchor(anchored));
  return chunks.join('\n\n');
}

export function renderHistoryResult(
  squarePath: string,
  data: HistoryResult,
  options: { query?: HistoryQuery; full?: boolean; filters?: Record<string, unknown>; surface?: PresentationSurface } = {},
): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const query = options.query ?? {};
  const full = options.full === true;
  const search = query.search;
  const shown = data.activities.filter((activity) => isNarratedActivity(activity.kind));
  const output = search === undefined
    ? renderHistoryProjection(projection, shown, full, squarePath, options.surface ?? 'cli')
    : renderGrepActivitiesView(shown, projection.totalMatches, full, squarePath, search.text, search.mode === 'literal', options.surface);
  const next = projection.continuation;
  const continuation = next === undefined ? '' : `\n\n${spellAction({ operation: 'history',
    args: { location: squarePath, ...options.filters, [next.direction]: next.cursor, limit: next.limit } }, options.surface)}`;
  return withPathOutput(squarePath, output + continuation, { participantCount: projection.standingCount });
}
