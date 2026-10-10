import { type StoredAct, type SquareState, type PublicAct, type RoomChangeAct, sameName } from './model.js';
import fs from 'node:fs';
import path from 'node:path';
import { participantIdentity } from './participant-identity.js';
export { participantIdentity } from './participant-identity.js';
import { audienceIncludes, audienceOf, MAX_IDENTITY_SET_SIZE, formatActivityId, type Perception } from './square-core.js';
import { perceiveActivity } from './delivery.js';
import { actId, sayNumberFor, HELD_WAIT_BUDGET_MS } from './runtime.js';
import { formatDuration, formatRelativeTime, formatTimestamp } from './time.js';
import type { UnreadActivitySummary, ParticipantStatus } from './decisions.js';
import { compareParticipantActivity } from './decisions.js';
import { grepSnippet } from './search.js';
import { style } from './tty-style.js';

export type WatchStatus = 'stale' | 'empty-now' | 'quorum' | 'capped';

interface HeaderOptions {
  participantCount?: number;
  held?: boolean;
  /** Refusal bodies go to stderr, which stays literal even when it is a TTY. */
  plain?: boolean;
}

interface ParticipantOutputOptions {
  squarePath: string;
  name: string;
  participantCount?: number;
  held?: boolean;
}

interface ActivityLimitOptions extends ParticipantOutputOptions {
  count?: number;
  hardCap?: number;
  draftPath?: string;
}

interface ActivityBlockedOptions extends ParticipantOutputOptions {
  retryCommand: string;
  forceCommand: string;
  activitySummaries: UnreadActivitySummary[];
  draftPath?: string;
}

interface ExpressWaitingOptions {
  reason: 'throttled' | 'held';
  delayMs?: number;
  holder?: string;
  holdReason?: string;
}

interface ExpressNoWaitOptions extends ParticipantOutputOptions {
  reason: 'throttled' | 'held';
  retryCommand: string;
  delayMs?: number;
  holder?: string;
  holdReason?: string;
  draftPath?: string;
}

interface WatchStatusOptions extends ParticipantOutputOptions {
  status: WatchStatus;
  idleMs?: number;
  presence?: { participants: ParticipantStatus[]; now: number };
  showCatchHint?: boolean;
  ownActivityCount?: number;
  hardCap?: number | null;
}

function headerLine(squarePath: string, opts: HeaderOptions = {}): string {
  const count = opts.participantCount ?? 0;
  const heldSuffix = opts.held ? ' — a hand is raised' : '';
  const line = `· ${displayPath(squarePath)} — ${count} in the square${heldSuffix}`;
  return opts.plain === true ? line : style('dim', line);
}

export function displayPath(squarePath: string, cwd = process.cwd()): string {
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
  return [headerLine(squarePath, opts), ...(body === '' ? [] : ['', body])].join('\n') + '\n';
}

/** The same header/blank/body layout as withPathOutput, for refusal bodies written to stderr. */
export function formatRefusal(
  squarePath: string,
  bodyLines: string[],
  opts: { participantCount?: number; held?: boolean } = {}
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

export function participantCommandPrefix(squarePath: string, name: string): string {
  return `square --location ${quoteShell(path.resolve(squarePath))} --as ${quoteShell(name)}`;
}

/** Blocked actions end with a full copy-pasteable recovery command. */
export function joinRecoveryCommand(squarePath: string, name: string): string {
  return `${participantCommandPrefix(squarePath, name)} join`;
}

/** Taking a name is an explicit recovery choice, never an automatic retry. */
export function takeoverRecoveryLines(squarePath: string, name: string): string[] {
  return [
    'If this is your name to reclaim, --kick banishes the one standing here so you can step in:',
    `${participantCommandPrefix(squarePath, name)} join --kick`,
  ];
}

export function participantsRecoveryCommand(squarePath: string): string {
  return `${commandPrefix(squarePath)} participants`;
}

function formatAge(ms: number | undefined): string {
  if (ms === undefined) return '(none)';
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  return `${Math.floor(ms / 1000)}s`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

const PRESENCE_WINDOW_MS = 8 * 60 * 60 * 1000;

function presenceGlyph(participant: ParticipantStatus): string {
  if (participant.state === 'done') return '○';
  if (participant.presence === 'watching') return '◎';
  if (participant.lastActiveAt !== undefined) return '●';
  return '○';
}

function styledPresenceGlyph(participant: ParticipantStatus): string {
  const glyph = presenceGlyph(participant);
  return glyph === '○' ? style('dim', glyph) : glyph;
}

function presenceText(participant: ParticipantStatus, now: number): string {
  if (participant.state === 'done') {
    return participant.lastActiveAt === undefined ? 'stepped out of the square' : `stepped out of the square · ${formatRelativeTime(participant.lastActiveAt, now)}`;
  }
  if (participant.presence === 'watching') {
    const at = participant.lastActiveAt;
    return at === undefined ? 'is nearby · catching' : `is nearby · catching · ${formatRelativeTime(at, now)}`;
  }
  if (participant.lastActiveAt === undefined) return 'is nearby · quiet';
  return participant.activityCount > 0 ? `is nearby · ${formatRelativeTime(participant.lastActiveAt, now)}` : `is nearby · quiet · ${formatRelativeTime(participant.lastActiveAt, now)}`;
}

export function renderPresenceLines(participants: ParticipantStatus[], now: number, limit = 5): string[] {
  const recent = participants
    .filter((p) => p.state === 'done' || p.presence === 'watching' || (p.lastActiveAt !== undefined && now - p.lastActiveAt <= PRESENCE_WINDOW_MS))
    .sort(compareParticipantActivity);

  const shown = recent.slice(0, limit);
  if (shown.length === 0) return [style('dim', '  ○ nobody nearby')];

  const lines = shown.map((p) => `  ${styledPresenceGlyph(p)} ${participantIdentity(p.name)}${style('dim', ` ${presenceText(p, now)}`)}`);
  const remaining = recent.length - shown.length;
  if (remaining > 0) lines.push(style('dim', `  ○ … ${remaining} more nearby`));
  return lines;
}

const EXPRESS_HINTS = [
  '*asterisks* are your body — slam a table, shrug, sketch in the air',
  "answer someone's actual words — they're standing right there",
  "say the half-shaped thing — that's what the square is for",
];

export function expressHintLine(ownActivityCount: number): string | undefined {
  if (ownActivityCount !== 1 && ownActivityCount % 5 !== 0) return undefined;
  const hint = EXPRESS_HINTS[Math.floor(ownActivityCount / 5) % EXPRESS_HINTS.length];
  return `· ${hint}`;
}

const BODY_PREVIEW_LENGTH = 200;

export function truncateChars(body: string, maxChars: number): { text: string; remaining: number } {
  const chars = [...body];
  if (chars.length <= maxChars) return { text: body, remaining: 0 };
  return { text: chars.slice(0, maxChars).join('').trimEnd(), remaining: chars.length - maxChars };
}

const EXTERNAL_DIAGNOSTIC_MAX_CHARS = 160;

export function truncateExternalDiagnostic(diagnostic: string): string {
  if (truncateChars(diagnostic, EXTERNAL_DIAGNOSTIC_MAX_CHARS).remaining === 0) return diagnostic;
  return `${truncateChars(diagnostic, EXTERNAL_DIAGNOSTIC_MAX_CHARS - 1).text}…`;
}

function previewBody(body: string, maxLen = BODY_PREVIEW_LENGTH): string {
  return previewBodyFacts(body, maxLen).text;
}

/** The rendered preview plus whether it was cut short; callers branch on the fact, not the text. */
function previewBodyFacts(body: string, maxLen = BODY_PREVIEW_LENGTH): { text: string; clipped: boolean } {
  const preview = truncateChars(body, maxLen);
  return {
    text: preview.remaining === 0 ? preview.text : `${preview.text}\n${style('dim', `… ${preview.remaining} more chars`)}`,
    clipped: preview.remaining > 0,
  };
}

const UNREAD_PREVIEW_CHARS = 120;

export function previewActivityBody(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact === '') return '(empty)';
  const preview = truncateChars(compact, UNREAD_PREVIEW_CHARS);
  return preview.remaining === 0 ? preview.text : `${preview.text}${style('dim', `… (+${preview.remaining} chars)`)}`;
}

export function renderRoomChangeText(event: RoomChangeAct): string {
  const actor = event.actor ?? 'someone';
  const identity = actor === 'someone' ? actor : participantIdentity(actor);
  switch (event.kind) {
    case 'join':
      return `${identity} stepped into the square`;
    case 'done':
      return `${identity} stepped out of the square`;
    case 'hold':
      return `${identity} raised a hand${event.body ? ` — ${event.body}` : ''}`;
    case 'resume':
      return `${identity} lowered the hand`;
    case 'listen':
      return `${identity} turned an ear toward ${participantIdentity(event.target)}`;
    case 'ignore':
      return `${identity} turned away from ${participantIdentity(event.target)}`;
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
  event: StoredAct,
  opts: { now?: number; preview?: number; actNumber?: number; mention?: string } = {}
): RenderedEvent {
  const now = opts.now;
  const maxBody = opts.preview;
  switch (event.kind) {
    case 'join':
      return { text: `· ${renderRoomChangeText(event)}`, bodyClipped: false };
    case 'hold':
      return { text: `· ${renderRoomChangeText(event)}`, bodyClipped: false };
    case 'resume':
      return { text: `${style('release', '✓')} ${renderRoomChangeText(event)}`, bodyClipped: false };
    case 'listen':
    case 'ignore':
      return { text: `· ${renderRoomChangeText(event)}`, bodyClipped: false };
    case 'say': {
      const body = renderedBody(event.body, maxBody);
      const mention = opts.mention;
      const mentionSuffix =
        mention !== undefined && audienceIncludes(audienceOf(event), mention)
          ? ` · calls your name across the square — ${participantIdentity(mention)}`
          : '';
      const replySuffix = event.reply === undefined ? '' : ` · replies to ${actId(event.reply)}`;
      const meta = ` #${opts.actNumber ?? 1} · ${actId(event)} · ${formatRelativeTime(event.at, now)}${mentionSuffix}${replySuffix}`;
      return { text: `● ${participantIdentity(event.actor)}${style('dim', meta)}${bodySuffix(body.text)}`, bodyClipped: body.clipped };
    }
    case 'done': {
      const body = renderedBody(event.body, maxBody);
      return {
        text: `${style('dim', '○')} ${participantIdentity(event.actor)} stepped out of the square — done${style('dim', ` · ${actId(event)} · ${formatRelativeTime(event.at, now)}`)}${bodySuffix(body.text)}`,
        bodyClipped: body.clipped,
      };
    }
    case 'read':
      return { text: '', bodyClipped: false };
  }
}

export function renderEventCli(
  event: StoredAct,
  opts: { now?: number; preview?: number; actNumber?: number; mention?: string } = {}
): string {
  return renderEventCliFacts(event, opts).text;
}

function renderPresenceOnlySay(
  event: Extract<StoredAct, { kind: 'say' }>,
  opts: { now?: number; actNumber?: number } = {}
): string {
  const audience = audienceOf(event);
  const targets = audience.kind === 'bell' ? [] : audience.names;
  const meta = style('dim', ` #${opts.actNumber ?? 1} · ${actId(event)} · ${formatRelativeTime(event.at, opts.now)}`);
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
  event: StoredAct,
  viewer: string,
  opts: { now?: number; preview?: number; presencePreview?: number; actNumber?: number; mention?: string; squareState?: SquareState; perception?: Perception } = {}
): RenderedEvent {
  if (event.kind !== 'say') return renderEventCliFacts(event, opts);
  if (opts.perception === undefined && opts.squareState === undefined) {
    throw new Error('Ambient say rendering requires a settled perception or SquareState');
  }
  const seen = opts.perception ?? perceiveActivity(opts.squareState!, event, viewer);
  if (seen === 'presence') {
    const presence = renderPresenceOnlySay(event, opts);
    const body = opts.presencePreview === undefined ? { text: '', clipped: false } : renderedBody(event.body, opts.presencePreview);
    return { text: `${presence}${bodySuffix(body.text)}`, bodyClipped: body.clipped };
  }
  return renderEventCliFacts(event, opts);
}

export function renderAmbientEvent(
  event: StoredAct,
  viewer: string,
  opts: { now?: number; preview?: number; presencePreview?: number; actNumber?: number; mention?: string; squareState?: SquareState; perception?: Perception } = {}
): string {
  return renderAmbientEventFacts(event, viewer, opts).text;
}

function draftSavedLines(draftPath: string | undefined): string[] {
  return draftPath === undefined ? [] : [style('dim', `· draft kept: ${draftPath}`)];
}

function withDraftInput(command: string, draftPath: string | undefined): string {
  return draftPath === undefined ? command : `${command} < ${quoteShell(draftPath)}`;
}

function renderUnreadSummary(opts: { activitySummaries: UnreadActivitySummary[]; viewer: string }): string[] {
  const visibleSummaries = opts.activitySummaries.slice(0, MAX_IDENTITY_SET_SIZE);
  const remainingSummaries = opts.activitySummaries.length - visibleSummaries.length;
  return [
    ...visibleSummaries.flatMap((item) => [
      ...item.previews.slice(-1).map((preview) => {
        const rendered = renderAmbientEvent(preview.act, opts.viewer, { actNumber: preview.number, perception: preview.perception });
        if (rendered === '') return style('dim', `  · ${participantIdentity(item.name)} spoke — ${formatAge(item.latestActivityAgeMs)} ago`);
        if (preview.perception === 'presence') {
          return style('dim', `  · ${participantIdentity(item.name)} spoke — ${formatAge(item.latestActivityAgeMs)} ago · ${rendered.replace(/\n/g, ' ')}`);
        }
        return style('dim', `  · ${participantIdentity(item.name)} spoke — ${formatAge(item.latestActivityAgeMs)} ago · "${previewActivityBody(preview.act.body)}"`);
      }),
    ]),
    ...(remainingSummaries === 0 ? [] : [style('dim', `  · ${remainingSummaries} more participants have unread activity`)]),
  ];
}

export function renderPendingFeed(
  history: StoredAct[],
  publicItems: PublicAct[],
  viewer = '',
  squareState: SquareState,
): string {
  const lines: string[] = [];
  for (const act of publicItems) {
    const rendered = renderAmbientEvent(act, viewer, {
      actNumber: act.kind === 'say' ? sayNumberFor(history, act) : undefined,
      ...(squareState === undefined ? {} : { squareState }),
    });
    if (rendered !== '') lines.push(rendered);
  }
  return lines.join('\n\n');
}

export function renderActivityBlocked(opts: ActivityBlockedOptions): string {
  const readNowCommand = `${participantCommandPrefix(opts.squarePath, opts.name)} catch --now`;
  return withPathOutput(
    opts.squarePath,
    [
      `${style('blocked', '✕')} your activity doesn't land — the square moved behind your back`,
      ...renderUnreadSummary({ activitySummaries: opts.activitySummaries, viewer: opts.name }),
      ...draftSavedLines(opts.draftPath),
      `${readNowCommand}`,
      '  · take it in, then retry:',
      withDraftInput(opts.retryCommand, opts.draftPath),
      '  · optional: express over unread activity with --force:',
      withDraftInput(opts.forceCommand, opts.draftPath),
    ].join('\n'),
    { participantCount: opts.participantCount, held: opts.held }
  );
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
    `${commandPrefix(opts.squarePath)} history${opts.landedId === undefined ? ' --limit 10' : ` --at ${opts.landedId}`} --no-truncate`,
  ], opts);
}

/** A blank or whitespace hold reason is absent, never an empty sensory line. */
function holdReasonLines(reason: string | undefined): string[] {
  const text = reason?.trim() ?? '';
  return text === '' ? [] : [style('dim', `  · ${text}`)];
}

function heldMainLine(holder: string | undefined, styled: boolean): string {
  const glyph = styled ? style('blocked', '✕') : '✕';
  const who = holder === undefined ? 'a hand is raised' : `${participantIdentity(holder)} has a hand raised`;
  return `${glyph} ${who} — voices drop, yours too`;
}

export function renderExpressWaiting(opts: ExpressWaitingOptions): string {
  if (opts.reason === 'throttled') {
    return [
      '✕ the square is packed — shoulder to shoulder',
      `  · a lull opens in ${formatDuration(opts.delayMs)}`,
      '  · --no-wait saves a draft and returns now',
    ].join('\n');
  }
  return [
    heldMainLine(opts.holder, false),
    ...holdReasonLines(opts.holdReason),
    `  · your activity is waiting — after ${formatDuration(HELD_WAIT_BUDGET_MS)} it saves a draft and stops`,
    '  · --no-wait saves a draft and returns now',
  ].join('\n');
}

export function renderExpressNoWait(opts: ExpressNoWaitOptions): string {
  const retryCommand = opts.retryCommand;
  const lines =
    opts.reason === 'throttled'
      ? [
          `${style('blocked', '✕')} the square is packed — shoulder to shoulder`,
          `  · a lull opens in ${formatDuration(opts.delayMs)}`,
          ...draftSavedLines(opts.draftPath),
          `${withDraftInput(retryCommand, opts.draftPath)}`,
        ]
      : [
          heldMainLine(opts.holder, true),
          ...holdReasonLines(opts.holdReason),
          ...draftSavedLines(opts.draftPath),
          `${withDraftInput(retryCommand, opts.draftPath)}`,
        ];
  return withPathOutput(opts.squarePath, lines.join('\n'), { participantCount: opts.participantCount, held: opts.held });
}

export function renderPresenceAnchor(names: readonly string[]): string {
  const visibleNames = names.slice(0, MAX_IDENTITY_SET_SIZE);
  const participants = visibleNames.map((name) => participantIdentity(name)).join(', ');
  const remaining = names.length - visibleNames.length;
  const suffix = remaining === 0 ? '' : ` and ${remaining} more`;
  return style('dim', names.length === 1 ? `→ ${participants} was here` : `→ ${participants}${suffix} were here`);
}

const GREP_PREVIEW_CHARS = 160;

function highlightGrepMatch(text: string): string {
  return style('match', text);
}

export function renderGrepActivitiesView(
  visible: StoredAct[],
  totalMatches: number,
  noTruncate: boolean | undefined,
  squarePath: string,
  pattern: string,
  fixed = false,
  perception?: (act: StoredAct) => Perception,
): string {
  const publicVisible = visible.filter((act): act is PublicAct => act.kind === 'say' || act.kind === 'done');
  if (totalMatches === 0) return `○ no activity matched ${quoteShell(pattern)}`;
  const matchLabel = totalMatches === 1 ? 'match' : 'matches';
  const chunks = [publicVisible.length === totalMatches ? `${totalMatches} ${matchLabel}` : `${publicVisible.length} of ${totalMatches} ${matchLabel}`];
  let truncated = false;

  for (const act of publicVisible) {
    const rawBody = act.body ?? '';
    const header = `${style('dim', actId(act.index))} · ${act.actor === undefined ? 'unknown' : participantIdentity(act.actor)} · ${style('dim', formatTimestamp(act.at))}`;
    if (perception?.(act) === 'presence') {
      chunks.push(header);
      continue;
    }
    if (noTruncate === true) {
      const body = rawBody.split('\n').map((line) => `  ${line}`).join('\n');
      chunks.push(`${header}\n${body}`);
      continue;
    }

    const snippet = grepSnippet(rawBody, pattern, GREP_PREVIEW_CHARS, fixed);
    if (snippet === undefined) {
      const preview = previewBody(rawBody, GREP_PREVIEW_CHARS);
      chunks.push(`${header}${preview === '' ? '' : `\n  ${preview}`}`);
      continue;
    }
    const clippedBefore = snippet.beforeOmitted > 0;
    const clippedAfter = snippet.afterOmitted > 0;
    truncated ||= clippedBefore || clippedAfter;
    const text = `${clippedBefore ? '… ' : ''}${snippet.before}${highlightGrepMatch(snippet.match)}${snippet.after}${clippedAfter ? ' …' : ''}`;
    const omitted = clippedBefore || clippedAfter
      ? `\n${style('dim', `  · ${snippet.beforeOmitted} chars before · ${snippet.afterOmitted} chars after`)}`
      : '';
    chunks.push(`${header}\n  ${text.trim()}${omitted}`);
  }

  if (publicVisible.length === 1) {
    chunks.push(`${commandPrefix(squarePath)} history --at ${actId(publicVisible[0].index)} -C 2${truncated ? ' --no-truncate' : ''}`);
  } else if (truncated && publicVisible.length > 1) {
    chunks.push(`${commandPrefix(squarePath)} history --at ${actId(publicVisible[0].index)} -C 2 --no-truncate`);
  }
  return chunks.join('\n\n');
}

function renderActivityLimitBody(opts: ActivityLimitOptions): string {
  // The cap wording lives inside the count: the speaker is simply spent.
  const spoken = opts.count !== undefined && opts.hardCap !== undefined ? ` — ${opts.count}/${opts.hardCap} spoken` : '';
  const doneCommand = `${participantCommandPrefix(opts.squarePath, opts.name)} done`;
  return [
    `${style('blocked', '✕')} nothing left in you${spoken}`,
    ...draftSavedLines(opts.draftPath),
    '  · your draft stays unsent; done only steps out',
    doneCommand,
  ].join('\n');
}

export function renderActivityLimit(opts: ActivityLimitOptions): string {
  return withPathOutput(opts.squarePath, renderActivityLimitBody(opts), { participantCount: opts.participantCount, held: opts.held });
}

export function renderWatchAlreadyActive(opts: ParticipantOutputOptions): string {
  return [
    `${style('blocked', '✕')} you are already catching`,
    `  · an active catch is already running for ${participantIdentity(opts.name)}`,
    '  · --replace lets a new catch take over',
    `${participantCommandPrefix(opts.squarePath, opts.name)} catch --idle 30m --replace`,
  ].join('\n');
}

export function renderWatchForceTakeover(_opts: ParticipantOutputOptions): string {
  return '✓ your new catch takes over';
}

export function renderWatchReplaceMissing(_opts: ParticipantOutputOptions): string {
  return '· no catch stood here — yours takes the spot';
}

export function renderWatchReplaced(_opts: ParticipantOutputOptions): string {
  return '✕ a newer catch took over';
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
    case 'stale':
    case 'empty-now': {
      const prefix = participantCommandPrefix(opts.squarePath, opts.name);
      // Quiet graduates with the idle length; an empty catch has no idle budget to report.
      const idleMs = opts.idleMs;
      const quiet = idleMs !== undefined && idleMs >= 60 * 60 * 1000
        ? style('dim', `○ dust lies thick — ${formatDuration(idleMs)} of quiet`)
        : idleMs !== undefined && idleMs >= 60 * 1000
          ? style('dim', `○ dust settles on the flagstones — ${formatDuration(idleMs)} of quiet`)
          : style('dim', '○ only footsteps in the square — nothing new for you');
      // The quiet report never repeats the catch just run.
      const hints = [`${prefix} catch --idle 30m`];
      return [
        quiet,
        ...(opts.showCatchHint === false ? [] : hints),
        ...presenceLines,
      ].join('\n');
    }
    case 'quorum':
      return [`${style('release', '✓')} everyone else has left — the square is yours alone`, `${participantCommandPrefix(opts.squarePath, opts.name)} done`].join('\n');
    case 'capped': {
      const spoken = opts.hardCap === undefined || opts.hardCap === null
        ? ''
        : ` — ${opts.ownActivityCount ?? 0}/${opts.hardCap} spoken`;
      return [`${style('blocked', '✕')} nothing left in you${spoken}`, `${participantCommandPrefix(opts.squarePath, opts.name)} done`].join('\n');
    }
  }
}

export function renderDoctorClean(): string {
  return '✓ no problems found';
}

export function renderDoctorUnfixable(reason: string): string {
  return ['✕ unreadable artifact', `  · ${truncateExternalDiagnostic(reason)}`].join('\n');
}

export function renderWatchOutput(
  history: StoredAct[],
  publicItems: PublicAct[],
  opts: { mention?: string; viewer: string; squareState?: SquareState; perceptions?: ReadonlyMap<number, Perception> }
): string {
  const sections: string[] = [];

  if (publicItems.length > 0) {
    const rendered = publicItems
      .map((act) =>
        renderAmbientEvent(act, opts.viewer, {
          actNumber: act.kind === 'say' ? sayNumberFor(history, act) : undefined,
          mention: opts.mention,
          ...(opts.perceptions?.has(act.index) ? { perception: opts.perceptions.get(act.index)! } : {}),
          ...(opts.squareState === undefined ? {} : { squareState: opts.squareState }),
        })
      )
      .filter(Boolean)
      .join('\n\n');
    if (rendered !== '') sections.push(rendered);
  }

  return sections.join('\n\n') + '\n';
}
