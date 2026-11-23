import { sameName } from '../core/model.js';
import { participantIdentity } from '../core/square-values.js';
import { formatDuration, parseDurationMs } from '../core/time.js';
import type { ParticipantSummary, PerceiveOptions, PerceiveResult } from '../api/types.js';
import { style } from './tty-style.js';
import { type PresentationSurface, spellAction, spellField, renderPresenceLines, renderAmbientEventFacts, withPathOutput } from './presentation.js';

type WatchStatus = 'idle' | 'drained' | 'quorum' | 'capped';

interface ParticipantOutputOptions {
  surface?: PresentationSurface;
  owner?: string;
  squarePath: string;
  name: string;
  participantCount?: number;
}



interface WatchStatusOptions extends ParticipantOutputOptions {
  status: WatchStatus;
  idleMs?: number;
  presence?: { participants: readonly ParticipantSummary[]; now: number };
  showPerceiveHint?: boolean;
  ownActivityCount?: number;
  hardCap?: number | null;
}

function watchAction({ squarePath, name, owner, surface }: ParticipantOutputOptions, operation: 'done' | 'perceive', options: { wait?: string; replace?: true } = {}): string {
  return spellAction({ operation, owner, args: { location: squarePath, as: name, ...options } }, surface);
}

export function renderWatchAlreadyActive(opts: ParticipantOutputOptions): string {
  return [
    `${style('blocked', '✕')} you are already perceiving`,
    `  · an active perceive is already running for ${participantIdentity(opts.name)}`,
    `  · ${spellField('perceive', 'replace', opts.surface)} lets a new perceive take over`,
    watchAction(opts, 'perceive', { wait: '30m', replace: true }),
  ].join('\n');
}

export function renderWatchForceTakeover(): string {
  return '✓ your new perceive takes over';
}

export function renderWatchReplaceMissing(): string {
  return '· no perceive stood here — yours takes the spot';
}

export function renderWatchReplaced(_opts: ParticipantOutputOptions): string {
  return '✕ a newer perceive took over';
}

export function renderWatchStatus(opts: WatchStatusOptions): string {
  const others =
    opts.presence === undefined
      ? undefined
      : opts.presence.participants.filter((participant) => !sameName(participant.name, opts.name));
  const presenceLines =
    opts.presence !== undefined && others !== undefined
      ? ['', 'around the square', ...renderPresenceLines(others, opts.presence.now)]
      : [];
  switch (opts.status) {
    case 'idle':
    case 'drained': {
      // Quiet graduates with the idle length; an empty perceive has no idle budget to report.
      const idleMs = opts.idleMs;
      const quiet = idleMs !== undefined && idleMs >= 60 * 60 * 1000
        ? style('dim', `○ dust lies thick — ${formatDuration(idleMs)} of quiet`)
        : idleMs !== undefined && idleMs >= 60 * 1000
          ? style('dim', `○ dust settles on the flagstones — ${formatDuration(idleMs)} of quiet`)
          : style('dim', '○ only footsteps in the square — nothing new for you');
      // The quiet report never repeats the perceive just run.
      const hints = [watchAction(opts, 'perceive', { wait: '30m' })];
      return [
        quiet,
        ...(opts.showPerceiveHint === false ? [] : hints),
        ...presenceLines,
      ].join('\n');
    }
    case 'quorum':
      return [`${style('release', '✓')} everyone else has left — the square is yours alone`, watchAction(opts, 'done')].join('\n');
    case 'capped': {
      const spoken = opts.hardCap === undefined || opts.hardCap === null
        ? ''
        : ` — ${opts.ownActivityCount ?? 0}/${opts.hardCap} spoken`;
      return [`${style('blocked', '✕')} you’ve reached your speaking cap${spoken}`, watchAction(opts, 'done')].join('\n');
    }
  }
}

/** Render settled perceive facts; no selection, terminal decisions, receipts or wait machinery. */
export function renderPerceiveOutcome(
  squarePath: string,
  data: PerceiveResult,
  options: PerceiveOptions = {},
  owner?: string,
  surface: PresentationSurface = 'cli',
): string {
  const projection = data.observation;
  if (projection === undefined) return '';
  const location = projection.location ?? squarePath;
  const name = projection.participant;
  const stop = data.reason === 'drained' && data.activities.length > 0 ? undefined : data.reason;
  const header = { participantCount: projection.standingCount };
  const statusOptions = {
    squarePath: location, name, owner, surface, presence: projection.presence,
    showPerceiveHint: !projection.deliveryAvailable,
    ownActivityCount: projection.ownActivityCount, hardCap: projection.hardCap,
  };
  if (stop === 'already-active' || stop === 'replaced') {
    return withPathOutput(location, stop === 'already-active'
      ? renderWatchAlreadyActive(statusOptions) : renderWatchReplaced(statusOptions), header);
  }
  const rendered = data.activities.map((activity) => renderAmbientEventFacts(activity, {
    now: projection.now, perception: activity.perception, mention: options.mention ? name : undefined,
  }).text).filter(Boolean).join('\n\n');
  const remaining = data.remaining === 0 ? ''
    : `· ${data.remaining} matching ${data.remaining === 1 ? 'activity remains' : 'activities remain'}\n${spellAction({ operation: 'perceive', owner,
      args: { location, as: name, ids: options.ids, from: options.from, mention: options.mention || undefined, limit: options.limit } }, surface)}`;
  const terminal = stop === undefined ? '' : renderWatchStatus({
    ...statusOptions, status: stop,
    ...(stop === 'idle' && options.wait !== undefined ? { idleMs: parseDurationMs(options.wait) } : {}),
  });
  const fallback = stop === undefined && !projection.deliveryAvailable && data.remaining === 0
    ? `${watchAction(statusOptions, 'perceive', { wait: '30m' })}\n  stay available for new activity` : '';
  const hint = data.hint === undefined ? '' : style('dim', `· ${data.hint}`);
  return withPathOutput(location, [terminal, rendered, hint, remaining, fallback].filter(Boolean).join('\n\n'), header);
}
