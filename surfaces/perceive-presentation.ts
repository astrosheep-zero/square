import { sameName } from '../core/model.js';
import { participantIdentity } from '../core/square-values.js';
import { formatDuration } from '../core/time.js';
import type { ParticipantSummary, PerceiveOptions, PerceiveResult } from '../api/types.js';
import { style } from './tty-style.js';
import { type PresentationSurface, participantAction, participantCommandPrefix, renderPresenceLines, renderAmbientEventFacts, displayPath, formatToolAction, withPathOutput } from './presentation.js';

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

export function renderWatchAlreadyActive(opts: ParticipantOutputOptions): string {
  return [
    `${style('blocked', '✕')} you are already perceiving`,
    `  · an active perceive is already running for ${participantIdentity(opts.name)}`,
    `  · ${opts.surface === 'tool' ? 'takeover' : '--takeover'} lets a new perceive take over`,
    participantAction(opts.surface, opts.squarePath, opts.name, opts.owner, 'perceive', { idle: '30m', takeover: true }),
  ].join('\n');
}

export function renderWatchForceTakeover(_opts: ParticipantOutputOptions): string {
  return '✓ your new perceive takes over';
}

export function renderWatchReplaceMissing(_opts: ParticipantOutputOptions): string {
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
      participantCommandPrefix(opts.squarePath, opts.name, opts.owner);
      // Quiet graduates with the idle length; an empty perceive has no idle budget to report.
      const idleMs = opts.idleMs;
      const quiet = idleMs !== undefined && idleMs >= 60 * 60 * 1000
        ? style('dim', `○ dust lies thick — ${formatDuration(idleMs)} of quiet`)
        : idleMs !== undefined && idleMs >= 60 * 1000
          ? style('dim', `○ dust settles on the flagstones — ${formatDuration(idleMs)} of quiet`)
          : style('dim', '○ only footsteps in the square — nothing new for you');
      // The quiet report never repeats the perceive just run.
      const hints = [participantAction(opts.surface, opts.squarePath, opts.name, opts.owner, 'perceive', { idle: '30m' })];
      return [
        quiet,
        ...(opts.showPerceiveHint === false ? [] : hints),
        ...presenceLines,
      ].join('\n');
    }
    case 'quorum':
      return [`${style('release', '✓')} everyone else has left — the square is yours alone`, participantAction(opts.surface, opts.squarePath, opts.name, opts.owner, 'done')].join('\n');
    case 'capped': {
      const spoken = opts.hardCap === undefined || opts.hardCap === null
        ? ''
        : ` — ${opts.ownActivityCount ?? 0}/${opts.hardCap} spoken`;
      return [`${style('blocked', '✕')} you’ve reached your speaking cap${spoken}`, participantAction(opts.surface, opts.squarePath, opts.name, opts.owner, 'done')].join('\n');
    }
  }
}

function continuationCommand(squarePath: string, name: string, options: PerceiveOptions, owner?: string): string {
  const args: string[] = [];
  if (options.from?.length) args.push('--from', options.from.join(','));
  if (options.mention) args.push('--mention');
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  return [participantCommandPrefix(squarePath, name, owner), 'perceive', ...args].join(' ');
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
    : `· ${data.remaining} matching ${data.remaining === 1 ? 'activity remains' : 'activities remain'}\n${surface === 'tool' ? formatToolAction('perceive', { location: displayPath(location), as: name, ...(options.from?.length ? { from: options.from } : {}), ...(options.mention ? { mention: true } : {}), ...(options.limit !== undefined ? { limit: options.limit } : {}) }) : continuationCommand(location, name, options, owner)}`;
  const terminal = stop === undefined ? '' : renderWatchStatus({
    ...statusOptions, status: stop,
    ...(stop === 'idle' && options.idle !== undefined ? { idleMs: options.idle } : {}),
  });
  const fallback = stop === undefined && !projection.deliveryAvailable && data.remaining === 0
    ? `${participantAction(surface, location, name, owner, 'perceive', { idle: '30m' })}\n  stay available for new activity` : '';
  const hint = data.hint === undefined ? '' : style('dim', `· ${data.hint}`);
  return withPathOutput(location, [terminal, rendered, hint, remaining, fallback].filter(Boolean).join('\n\n'), header);
}
