import { sameName } from '../core/model.js';
import fs from 'node:fs';
import path from 'node:path';
import { truncateExternalDiagnostic } from '../hosts/boundary-presentation.js';
import { truncateChars } from '../core/neutral.js';
import { participantIdentity } from '../core/square-values.js';
import { MAX_IDENTITY_SET_SIZE, type Perception } from '../core/square-core.js';
import { formatDuration, formatRelativeTime, formatTimestamp } from '../core/time.js';
import type { Activity, UnreadActivitySummary, ParticipantSummary } from '../api/types.js';
import { grepSnippet } from '../core/search.js';
import { style } from './tty-style.js';

export type PresentationSurface = 'cli' | 'tool';

export function formatToolAction(tool: string, args: Readonly<Record<string, unknown>> = {}): string {
  const clean = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  return Object.keys(clean).length === 0 ? tool : `${tool} ${JSON.stringify(clean)}`;
}

export type WatchStatus = 'idle' | 'drained' | 'quorum' | 'capped';

interface HeaderOptions {
  participantCount?: number;
  /** Refusal bodies go to stderr, which stays literal even when it is a TTY. */
  plain?: boolean;
}

interface ParticipantOutputOptions {
  surface?: PresentationSurface;
  owner?: string;
  squarePath: string;
  name: string;
  participantCount?: number;
}



interface ExpressWaitingOptions {
  reason: 'throttled';
  delayMs?: number;
}


interface WatchStatusOptions extends ParticipantOutputOptions {
  status: WatchStatus;
  idleMs?: number;
  presence?: { participants: readonly ParticipantSummary[]; now: number };
  showPerceiveHint?: boolean;
  ownActivityCount?: number;
  hardCap?: number | null;
}

export function displayPath(squarePath: string, cwd = process.cwd()): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(squarePath)) return squarePath;
  if (!path.isAbsolute(squarePath)) return squarePath.split(path.sep).join('/');
  const comparableCwd = fs.realpathSync.native(cwd);
  let comparableSquarePath = squarePath;
  try {
    comparableSquarePath = fs.realpathSync.native(squarePath);
  } catch {
    // Some error outputs name a path before it exists; lexical comparison remains useful there.
  }
  const relative = path.relative(comparableCwd, comparableSquarePath);
  const displayed = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative : squarePath;
  return displayed.split(path.sep).join('/');
}

export function withPathOutput(squarePath: string, body = '', opts: HeaderOptions = {}): string {
  const count = opts.participantCount ?? 0;
  const line = `· ${displayPath(squarePath)} — ${count} in the square`;
  return [opts.plain === true ? line : style('dim', line), ...(body === '' ? [] : ['', body])].join('\n') + '\n';
}

/** The same header/blank/body layout as withPathOutput, for refusal bodies written to stderr. */
export function formatRefusal(
  squarePath: string,
  bodyLines: string[],
  opts: { participantCount?: number } = {}
): string {
  const body = bodyLines.join('\n');
  // A refusal with no known count stays bare rather than claiming "0 in the square".
  if (opts.participantCount === undefined) return body === '' ? '' : `${body}\n`;
  return withPathOutput(squarePath, body, { ...opts, plain: true });
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandPrefix(squarePath: string): string {
  return `square --location ${quoteShell(squarePath)}`;
}

export function participantCommandPrefix(squarePath: string, name: string, owner?: string): string {
  return `square --location ${quoteShell(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(squarePath) ? squarePath : path.resolve(squarePath))} --as ${quoteShell(name)}${owner === undefined ? '' : ` --owner ${quoteShell(owner)}`}`;
}

/** Blocked actions end with a full copy-pasteable recovery command. */
export function joinRecoveryCommand(squarePath: string, name: string, owner?: string): string {
  return `${participantCommandPrefix(squarePath, name, owner)} join`;
}

/** Taking a name is an explicit recovery choice, never an automatic retry. */
export function takeoverRecoveryLines(squarePath: string, name: string, owner?: string): string[] {
  return [
    'If this is your name to reclaim, --takeover banishes the one standing here so you can step in:',
    `${participantCommandPrefix(squarePath, name, owner)} join --takeover`,
  ];
}

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return '(none)';
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  return `${Math.floor(ms / 1000)}s`;
}

export function renderPresenceLines(recent: readonly ParticipantSummary[], now: number, limit = 5): string[] {

  const shown = recent.slice(0, limit);
  if (shown.length === 0) return [style('dim', '  ○ nobody nearby')];

  const lines = shown.map((p) => {
    const glyph = p.presence === 'done' || p.presence === 'away' ? '○' : p.presence === 'watching' ? '◎' : p.lastActiveAt !== undefined ? '●' : '○';
    const text = p.presence === 'done'
      ? (p.lastActiveAt === undefined ? 'stepped out of the square' : `stepped out of the square · ${formatRelativeTime(p.lastActiveAt, now)}`)
      : p.presence === 'away' ? 'is away'
      : p.presence === 'watching'
        ? (p.lastActiveAt === undefined ? 'is nearby · perceiving' : `is nearby · perceiving · ${formatRelativeTime(p.lastActiveAt, now)}`)
        : p.lastActiveAt === undefined ? 'is nearby · quiet'
          : p.activityCount > 0 ? `is nearby · ${formatRelativeTime(p.lastActiveAt, now)}` : `is nearby · quiet · ${formatRelativeTime(p.lastActiveAt, now)}`;
    return `  ${glyph === '○' ? style('dim', glyph) : glyph} ${participantIdentity(p.name)}${style('dim', ` ${text}`)}`;
  });
  const remaining = recent.length - shown.length;
  if (remaining > 0) lines.push(style('dim', `  ○ … ${remaining} more nearby`));
  return lines;
}

const BODY_PREVIEW_LENGTH = 200;

function previewBodyFacts(body: string, maxLen = BODY_PREVIEW_LENGTH): { text: string; clipped: boolean } {
  const preview = truncateChars(body, maxLen);
  return {
    text: preview.remaining === 0 ? preview.text : `${preview.text}\n${style('dim', `… ${preview.remaining} more chars`)}`,
    clipped: preview.remaining > 0,
  };
}

const UNREAD_PREVIEW_CHARS = 120;

function renderRoomChangeText(event: Activity): string {
  const actor = event.actor ?? 'someone';
  const identity = actor === 'someone' ? actor : participantIdentity(actor);
  switch (event.kind) {
    case 'join':
      return `${identity} stepped into the square`;
    case 'done':
      return `${identity} stepped out of the square`;
    case 'listen':
      return `${identity} turned an ear toward ${participantIdentity(event.target ?? 'someone')}`;
    case 'ignore':
      return `${identity} turned away from ${participantIdentity(event.target ?? 'someone')}`;
    case 'unlisten':
      return `${identity} stopped listening to ${participantIdentity(event.target ?? 'someone')}`;
    default:
      throw new Error('Expected a lifecycle activity');
  }
}

function renderedBody(body: string | undefined, maxChars: number | undefined): { text: string; clipped: boolean } {
  if (!body) return { text: '', clipped: false };
  return maxChars === undefined ? { text: body, clipped: false } : previewBodyFacts(body, maxChars);
}

function bodySuffix(body: string): string {
  if (body === '') return '';
  return `\n${body.split('\n').map((line) => `  ${line}`).join('\n')}`;
}

interface RenderedEvent {
  text: string;
  /** The rendered body was cut short by `preview`. */
  bodyClipped: boolean;
}

function renderEventCliFacts(
  event: Activity,
  opts: { now?: number; preview?: number; mention?: string } = {}
): RenderedEvent {
  const now = opts.now;
  const maxBody = opts.preview;
  switch (event.kind) {
    case 'join':
    case 'listen':
    case 'ignore':
    case 'unlisten':
      return { text: `· ${renderRoomChangeText(event)}`, bodyClipped: false };
    case 'say': {
      const body = renderedBody(event.body, maxBody);
      const visibleBody = body.text === '' && event.metadata !== undefined
        ? { text: '(structured activity)', clipped: false }
        : body;
      const mention = opts.mention;
      const mentionSuffix =
        mention !== undefined && (event.reach === 'bell' || event.mentions.some((name) => sameName(name, mention)))
          ? ` · calls your name across the square — ${participantIdentity(mention)}`
          : '';
      const replySuffix = event.reply === undefined ? '' : ` · replies to ${event.reply}`;
      const meta = ` · ${event.id} · ${formatRelativeTime(event.at, now)}${mentionSuffix}${replySuffix}`;
      return { text: `● ${participantIdentity(event.actor)}${style('dim', meta)}${bodySuffix(visibleBody.text)}`, bodyClipped: visibleBody.clipped };
    }
    case 'done': {
      const body = renderedBody(event.body, maxBody);
      return {
        text: `${style('dim', '○')} ${participantIdentity(event.actor)} stepped out of the square — done${style('dim', ` · ${event.id} · ${formatRelativeTime(event.at, now)}`)}${bodySuffix(body.text)}`,
        bodyClipped: body.clipped,
      };
    }
  }
}

export function renderEventCli(
  event: Activity,
  opts: { now?: number; preview?: number; mention?: string } = {}
): string {
  return renderEventCliFacts(event, opts).text;
}

function renderPresenceOnlySay(
  event: Activity,
  opts: { now?: number } = {}
): string {
  const targets = event.reach === 'bell' ? [] : event.mentions;
  const meta = style('dim', ` · ${event.id} · ${formatRelativeTime(event.at, opts.now)}`);
  if (targets.length === 0) {
    return `● ${participantIdentity(event.actor)}${meta}`;
  }
  const visibleTargets = targets.slice(0, MAX_IDENTITY_SET_SIZE).map((name) => participantIdentity(name));
  const remainingTargets = targets.length - visibleTargets.length;
  const dest = ` ${[
    ...visibleTargets,
    ...(remainingTargets === 0 ? [] : [`${remainingTargets} ${remainingTargets === 1 ? 'other' : 'others'}`]),
  ].join(' and ')}`;
  return `● ${participantIdentity(event.actor)}${meta}\n${style('dim', `  talked to${dest}`)}`;
}

export function renderAmbientEventFacts(
  event: Activity,
  opts: { now?: number; preview?: number; mention?: string; perception?: Perception } = {}
): RenderedEvent {
  if (event.kind !== 'say') return renderEventCliFacts(event, opts);
  if (opts.perception === undefined) throw new Error('Ambient say rendering requires a settled perception');
  if (opts.perception === 'presence') return { text: renderPresenceOnlySay(event, opts), bodyClipped: false };
  return renderEventCliFacts(event, opts);
}

function draftSavedLines(draftPath: string | undefined): string[] {
  return draftPath === undefined ? [] : [style('dim', `· draft kept: ${draftPath}`)];
}

export function renderUnreadSummary(activitySummaries: readonly UnreadActivitySummary[]): string[] {
  const visibleSummaries = activitySummaries.slice(0, MAX_IDENTITY_SET_SIZE);
  const remainingSummaries = activitySummaries.length - visibleSummaries.length;
  return [
    ...visibleSummaries.map((item) => {
      const compact = (item.preview.body ?? '').replace(/\s+/g, ' ').trim();
      const bodyPreview = compact === ''
        ? { text: item.preview.structured ? '(structured activity)' : '(empty)', remaining: 0 }
        : truncateChars(compact, UNREAD_PREVIEW_CHARS);
      const bodyText = bodyPreview.remaining === 0 ? bodyPreview.text : `${bodyPreview.text}${style('dim', `… (+${bodyPreview.remaining} chars)`)}`;
      return style('dim', `  · ${participantIdentity(item.name)} spoke — ${formatAge(item.latestActivityAgeMs)} ago · "${bodyText}"`);
    }),
    ...(remainingSummaries === 0 ? [] : [style('dim', `  · ${remainingSummaries} more participants have unread activity`)]),
  ];
}


/** An indeterminate or already-committed send only points to inspection, never resend. */
export function renderActivityUncertain(opts: ParticipantOutputOptions & { draftPath: string; landedId?: string; detail?: string }): string {
  return formatRefusal(opts.squarePath, [
    opts.landedId === undefined
      ? '✕ your activity may have landed — check history before sending again'
      : `✕ your activity landed · ${opts.landedId} — the confirmation could not finish`,
    ...(opts.detail === undefined ? [] : [`  · ${truncateExternalDiagnostic(opts.detail)}`]),
    ...draftSavedLines(opts.draftPath),
    '  · the draft is a saved copy; sending it again could repeat your activity',
    `${commandPrefix(opts.squarePath)} history${opts.landedId === undefined ? ' --limit 10' : ` --at ${opts.landedId}`} --full`,
  ], opts);
}

export function renderExpressWaiting(opts: ExpressWaitingOptions): string {
  return [
    '· the square is packed — your activity is waiting',
    `  · a lull opens in ${formatDuration(opts.delayMs)}`,
    '  · --no-wait saves a draft and returns now',
  ].join('\n');
}


export function renderPresenceAnchor(names: readonly string[]): string {
  const visibleNames = names.slice(0, MAX_IDENTITY_SET_SIZE);
  const participants = visibleNames.map((name) => participantIdentity(name)).join(', ');
  const remaining = names.length - visibleNames.length;
  const suffix = remaining === 0 ? '' : ` and ${remaining} more`;
  return style('dim', names.length === 1 ? `→ ${participants} was here` : `→ ${participants}${suffix} were here`);
}

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
    chunks.push(surface === 'tool'
      ? formatToolAction('history', { location: displayPath(squarePath), at: [publicVisible[0].id], context: 2, ...(truncated ? { full: true } : {}) })
      : `${commandPrefix(squarePath)} history --at ${publicVisible[0].id} -C 2${truncated ? ' --full' : ''}`);
  }
  return chunks.join('\n\n');
}


export function renderWatchAlreadyActive(opts: ParticipantOutputOptions): string {
  return [
    `${style('blocked', '✕')} you are already perceiving`,
    `  · an active perceive is already running for ${participantIdentity(opts.name)}`,
    `  · ${opts.surface === 'tool' ? 'takeover' : '--takeover'} lets a new perceive take over`,
    opts.surface === 'tool'
      ? formatToolAction('perceive', { location: displayPath(opts.squarePath), as: opts.name, idle: '30m', takeover: true })
      : `${participantCommandPrefix(opts.squarePath, opts.name, opts.owner)} perceive --idle 30m --takeover`,
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
      const prefix = participantCommandPrefix(opts.squarePath, opts.name, opts.owner);
      // Quiet graduates with the idle length; an empty perceive has no idle budget to report.
      const idleMs = opts.idleMs;
      const quiet = idleMs !== undefined && idleMs >= 60 * 60 * 1000
        ? style('dim', `○ dust lies thick — ${formatDuration(idleMs)} of quiet`)
        : idleMs !== undefined && idleMs >= 60 * 1000
          ? style('dim', `○ dust settles on the flagstones — ${formatDuration(idleMs)} of quiet`)
          : style('dim', '○ only footsteps in the square — nothing new for you');
      // The quiet report never repeats the perceive just run.
      const hints = [opts.surface === 'tool' ? formatToolAction('perceive', { location: displayPath(opts.squarePath), as: opts.name, idle: '30m' }) : `${prefix} perceive --idle 30m`];
      return [
        quiet,
        ...(opts.showPerceiveHint === false ? [] : hints),
        ...presenceLines,
      ].join('\n');
    }
    case 'quorum':
      return [`${style('release', '✓')} everyone else has left — the square is yours alone`, opts.surface === 'tool' ? formatToolAction('done', { location: displayPath(opts.squarePath), as: opts.name }) : `${participantCommandPrefix(opts.squarePath, opts.name, opts.owner)} done`].join('\n');
    case 'capped': {
      const spoken = opts.hardCap === undefined || opts.hardCap === null
        ? ''
        : ` — ${opts.ownActivityCount ?? 0}/${opts.hardCap} spoken`;
      return [`${style('blocked', '✕')} you’ve reached your speaking cap${spoken}`, opts.surface === 'tool' ? formatToolAction('done', { location: displayPath(opts.squarePath), as: opts.name }) : `${participantCommandPrefix(opts.squarePath, opts.name, opts.owner)} done`].join('\n');
    }
  }
}

export function renderDoctorClean(): string {
  return '✓ no problems found';
}

export function renderDoctorUnfixable(reason: string): string {
  return ['✕ unreadable artifact', `  · ${truncateExternalDiagnostic(reason)}`].join('\n');
}
