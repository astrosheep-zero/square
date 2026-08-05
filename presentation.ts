import { type StoredAct, type SquareDoc, type PublicAct, type RoomChangeAct, sameName } from './model.js';
import fs from 'node:fs';
import path from 'node:path';
import { fold, perceive, type Perception } from './square-core.js';
import { actId, actStableIndex, extractMentions, publicActs, readCursor, rosterNames, sayNumberFor } from './runtime.js';
import { formatDuration, formatRelativeTime, formatTimestamp } from './time.js';
import type { UnreadActivitySummary, ParticipantStatus } from './decisions.js';
import { grepSnippet } from './search.js';

export type WatchStatus = 'stale' | 'empty-now' | 'quorum' | 'capped';

interface HeaderOptions {
  participantCount?: number;
  held?: boolean;
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
  forceCommand: string;
  activitySummaries: UnreadActivitySummary[];
  unreadRoomChanges: RoomChangeAct[];
  draftPath?: string;
}

interface ExpressWaitingOptions {
  reason: 'throttled' | 'held';
  delayMs?: number;
}

interface ExpressNoWaitOptions extends ParticipantOutputOptions {
  reason: 'throttled' | 'held';
  delayMs?: number;
  holdReason?: string;
  draftPath?: string;
}

interface WatchStatusOptions extends ParticipantOutputOptions {
  status: WatchStatus;
  idleMs?: number;
  presence?: { participants: ParticipantStatus[]; now: number };
  showCatchHint?: boolean;
}

function headerLine(squarePath: string, opts: HeaderOptions = {}): string {
  const count = opts.participantCount ?? 0;
  const heldSuffix = opts.held ? ' — a hand is raised' : '';
  return `· the square at ${displayPath(squarePath)} — ${count} in the square${heldSuffix}`;
}

export function displayPath(squarePath: string, cwd = process.cwd()): string {
  if (!path.isAbsolute(squarePath)) return squarePath;
  const comparableCwd = fs.realpathSync.native(cwd);
  let comparableSquarePath = squarePath;
  try {
    comparableSquarePath = fs.realpathSync.native(squarePath);
  } catch {
    // Some error outputs name a path before it exists; lexical comparison remains useful there.
  }
  const relative = path.relative(comparableCwd, comparableSquarePath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? relative : squarePath;
}

export function withPathOutput(squarePath: string, body = '', opts: HeaderOptions = {}): string {
  return [headerLine(squarePath, opts), ...(body === '' ? [] : ['', body])].join('\n') + '\n';
}

export function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function commandPrefix(squarePath: string): string {
  return `square --square-path ${quoteShell(squarePath)}`;
}

export function participantCommandPrefix(squarePath: string, name: string): string {
  return `square --square-path ${quoteShell(path.resolve(squarePath))} --as ${quoteShell(name)}`;
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
  if (participant.state === 'done') return '×';
  if (participant.presence === 'watching') return '◎';
  if (participant.presenceAt !== undefined) return '●';
  return '○';
}

function presenceText(participant: ParticipantStatus, now: number): string {
  if (participant.state === 'done') {
    return participant.lastActiveAt === undefined ? 'stepped out of the square' : `stepped out of the square · ${formatRelativeTime(participant.lastActiveAt, now)}`;
  }
  if (participant.presence === 'watching') {
    const at = participant.presenceAt ?? participant.lastActiveAt;
    return at === undefined ? 'catching' : `catching · ${formatRelativeTime(at, now)}`;
  }
  if (participant.presenceAt === undefined) return 'quiet';
  return participant.activityCount > 0 ? `${formatRelativeTime(participant.presenceAt, now)}` : `quiet · ${formatRelativeTime(participant.presenceAt, now)}`;
}

export function renderPresenceLines(participants: ParticipantStatus[], now: number, limit = 5): string[] {
  const recent = participants
    .map((p) => ({ p, at: p.presenceAt ?? p.lastActiveAt ?? -Infinity }))
    .filter(({ p, at }) => p.state === 'done' || p.presence === 'watching' || (at !== -Infinity && now - at <= PRESENCE_WINDOW_MS))
    .sort((a, b) => b.at - a.at || a.p.name.localeCompare(b.p.name))
    .map(({ p }) => p);

  const shown = recent.slice(0, limit);
  if (shown.length === 0) return ['  ○ nobody nearby'];

  const lines = shown.map((p) => `  ${presenceGlyph(p)} ${p.name} · ${presenceText(p, now)}`);
  const remaining = recent.length - shown.length;
  if (remaining > 0) lines.push(`  ○ …and ${remaining} more`);
  return lines;
}

const EXPRESS_HINTS = [
  '*asterisks* are your body — *slams table*, *sketches in the air*, *shrugs*',
  "you're standing in a square — words and gestures both land",
  'half-shaped is welcome — a sketch, an objection, a joke, a fragment',
  '@ only who you need — step back with catch --mention',
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

function previewBody(body: string, maxLen = BODY_PREVIEW_LENGTH): string {
  const preview = truncateChars(body, maxLen);
  return preview.remaining === 0 ? preview.text : `${preview.text}\n… ${preview.remaining} more chars`;
}

const UNREAD_PREVIEW_CHARS = 120;

export function previewActivityBody(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact === '') return '(empty)';
  const preview = truncateChars(compact, UNREAD_PREVIEW_CHARS);
  return preview.remaining === 0 ? preview.text : `${preview.text}… (+${preview.remaining} chars)`;
}

export function renderRoomChangeText(event: RoomChangeAct): string {
  const actor = event.actor ?? 'someone';
  switch (event.kind) {
    case 'join':
      return `${actor} stepped into the square`;
    case 'done':
      return `${actor} stepped out of the square`;
    case 'hold':
      return `${actor} raised a hand${event.body ? ` — ${event.body}` : ''}`;
    case 'resume':
      return `${actor} lowered the hand`;
  }
}

function renderedBody(body: string | undefined, maxChars: number | undefined): string {
  if (!body) return '';
  return maxChars === undefined ? body : previewBody(body, maxChars);
}

function bodySuffix(body: string): string {
  if (body === '') return '';
  return `\n${body.split('\n').map((line) => `  ${line}`).join('\n')}`;
}

export function renderEventCli(
  event: StoredAct,
  opts: { now?: number; preview?: number; actNumber?: number; mention?: string } = {}
): string {
  const now = opts.now;
  const maxBody = opts.preview;
  switch (event.kind) {
    case 'join':
      return `· ${renderRoomChangeText(event)}`;
    case 'hold':
      return `· ${renderRoomChangeText(event)}`;
    case 'resume':
      return `✓ ${renderRoomChangeText(event)}`;
    case 'say': {
      const body = renderedBody(event.body, maxBody);
      const mention = opts.mention;
      const mentionSuffix =
        mention !== undefined && extractMentions(event.body).some((name) => sameName(name, mention))
          ? ` · calls your name across the square — @${mention}`
          : '';
      return `● ${event.actor} #${opts.actNumber ?? 1} · ${actId(event)} · ${formatRelativeTime(event.at, now)}${mentionSuffix}${bodySuffix(body)}`;
    }
    case 'done': {
      const body = renderedBody(event.body, maxBody);
      return `× ${event.actor} stepped out of the square — done · ${actId(event)} · ${formatRelativeTime(event.at, now)}${bodySuffix(body)}`;
    }
    case 'read':
      return '';
  }
}

function renderPresenceOnlySay(event: StoredAct): string {
  if (event.kind !== 'say' || event.reach === undefined || event.reach === 'bell') return '';
  return `*walks over to @${event.reach.beside}*`;
}

function perceptionFor(history: StoredAct[], event: StoredAct, viewer: string): Perception {
  const cutoff = history.findIndex((item) => actStableIndex(item) === actStableIndex(event));
  const acts = cutoff >= 0 ? history.slice(0, cutoff) : history;
  return perceive(fold(acts), event, viewer);
}

export function renderVisibleEvent(
  history: StoredAct[],
  event: StoredAct,
  viewer: string,
  opts: { now?: number; preview?: number; actNumber?: number; mention?: string } = {}
): string {
  if (event.kind !== 'say') return renderEventCli(event, opts);
  const seen = perceptionFor(history, event, viewer);
  if (seen === 'none') return '';
  if (seen === 'presence') return renderPresenceOnlySay(event);
  return renderEventCli(event, opts);
}

function draftSavedLines(draftPath: string | undefined): string[] {
  return draftPath === undefined ? [] : [`· draft kept: ${draftPath}`];
}

function withDraftInput(command: string, draftPath: string | undefined): string {
  return draftPath === undefined ? command : `${command} < ${quoteShell(draftPath)}`;
}

function renderUnreadSummary(opts: { activitySummaries: UnreadActivitySummary[]; roomChanges: RoomChangeAct[]; viewer: string }): string[] {
  return [
    ...opts.activitySummaries.flatMap((item) => [
      ...item.previews.slice(-1).map((preview) => {
        const rendered = renderVisibleEvent([preview.act], preview.act, opts.viewer, { actNumber: preview.number });
        if (rendered === '') return `  · ${item.name} spoke — ${formatAge(item.latestActivityAgeMs)} ago`;
        if (rendered.startsWith('*')) return `  · ${item.name} spoke — ${formatAge(item.latestActivityAgeMs)} ago · ${rendered}`;
        return `  · ${item.name} spoke — ${formatAge(item.latestActivityAgeMs)} ago · "${previewActivityBody(preview.act.body)}"`;
      }),
    ]),
    ...opts.roomChanges.map((act) => `  · ${renderRoomChangeText(act)}`),
  ];
}

export function renderPendingFeed(
  history: StoredAct[],
  publicItems: PublicAct[],
  roomChanges: RoomChangeAct[],
  viewer = ''
): string {
  const lines: string[] = [];
  for (const act of publicItems) {
    const rendered = renderVisibleEvent(history, act, viewer, {
      actNumber: act.kind === 'say' ? sayNumberFor(history, act) : undefined,
    });
    if (rendered !== '') lines.push(rendered);
  }
  const publicIndexes = new Set(publicItems.map((item) => item.index));
  for (const act of roomChanges) {
    if (publicIndexes.has(act.index)) continue;
    lines.push(`· ${renderRoomChangeText(act)}`);
  }
  return lines.join('\n\n');
}

export function renderActivityBlocked(opts: ActivityBlockedOptions): string {
  const readNowCommand = `${participantCommandPrefix(opts.squarePath, opts.name)} catch --now`;
  return withPathOutput(
    opts.squarePath,
    [
      "✕ your activity doesn't land — the square moved behind your back",
      ...renderUnreadSummary({ activitySummaries: opts.activitySummaries, roomChanges: opts.unreadRoomChanges, viewer: opts.name }),
      ...draftSavedLines(opts.draftPath),
      `» ${readNowCommand}`,
      '  take it in, then express again',
      `» ${withDraftInput(opts.forceCommand, opts.draftPath)}`,
      '  only if you truly mean to express over unread activity',
    ].join('\n'),
    { participantCount: opts.participantCount, held: opts.held }
  );
}

export function renderExpressWaiting(opts: ExpressWaitingOptions): string {
  if (opts.reason === 'throttled') {
    return ['✕ the square is packed', `  · your activity is waiting · next opening in ${formatDuration(opts.delayMs)}`].join('\n');
  }
  return ["✕ your activity doesn't land — a hand is raised", '  · your activity is waiting'].join('\n');
}

export function renderExpressNoWait(opts: ExpressNoWaitOptions): string {
  const retryCommand = `${participantCommandPrefix(opts.squarePath, opts.name)} express -`;
  const lines =
    opts.reason === 'throttled'
      ? [
          '✕ the square is packed',
          `  · next opening in ${formatDuration(opts.delayMs)}`,
          ...draftSavedLines(opts.draftPath),
          `» ${withDraftInput(retryCommand, opts.draftPath)}`,
        ]
      : [
          "✕ your activity doesn't land — a hand is raised",
          `  · ${opts.holdReason ?? 'the square holds its breath'}`,
          ...draftSavedLines(opts.draftPath),
          `» ${withDraftInput(retryCommand, opts.draftPath)}`,
        ];
  return withPathOutput(opts.squarePath, lines.join('\n'), { participantCount: opts.participantCount, held: opts.held });
}

export function renderPublicTail(events: StoredAct[], lastN: number | null | undefined, now?: number, viewer = ''): string {
  const publicItems = publicActs(events);
  const selected = lastN == null ? publicItems : publicItems.slice(-lastN);
  const preview = lastN == null ? undefined : BODY_PREVIEW_LENGTH;
  return selected
    .map((event) => renderVisibleEvent(events, event, viewer, { now, preview, actNumber: event.kind === 'say' ? sayNumberFor(events, event) : undefined }))
    .filter(Boolean)
    .join('\n\n');
}

function lastPresenceAnchor(doc: SquareDoc, name: string): number {
  const cursor = readCursor(doc, name);
  for (let i = doc.acts.length - 1; i >= 0; i--) {
    const event = doc.acts[i];
    const index = actStableIndex(event);
    if (index > cursor) continue;
    if (event.kind === 'say' || event.kind === 'done') return index;
  }
  return -1;
}

function renderLastPresenceMarker(name: string): string {
  return `· ${name}'s footprints reach here`;
}

export function renderActivitiesView(
  doc: SquareDoc,
  visible: StoredAct[],
  lastN: number | null | undefined,
  full: boolean | undefined,
  squarePath: string,
  viewer = ''
): string {
  const publicVisible = visible.filter((act): act is PublicAct => act.kind === 'say' || act.kind === 'done');
  const shown = lastN == null ? publicVisible : publicVisible.slice(-lastN);
  const previewLen = full ? undefined : BODY_PREVIEW_LENGTH;

  const markers = new Map<number, string[]>();
  for (const participant of rosterNames(doc)) {
    const anchor = lastPresenceAnchor(doc, participant);
    if (anchor >= 0) markers.set(anchor, [...(markers.get(anchor) ?? []), participant]);
  }

  const chunks: string[] = [];
  for (const act of shown) {
    const rendered = renderVisibleEvent(doc.acts, act, viewer, {
      preview: previewLen,
      actNumber: act.kind === 'say' ? sayNumberFor(doc.acts, act) : undefined,
    });
    if (rendered !== '') chunks.push(rendered);
    for (const participant of markers.get(act.index) ?? []) {
      chunks.push(renderLastPresenceMarker(participant));
    }
  }

  if (chunks.length === 0) return 'latest\n  ○ no public activity in this view';

  if (previewLen !== undefined) {
    const truncated = shown.some((act) => act.kind === 'say' && act.body.length > previewLen);
    if (truncated) chunks.push(`» ${commandPrefix(squarePath)} history --full`);
  }

  return chunks.join('\n\n');
}

const GREP_PREVIEW_CHARS = 160;

function highlightGrepMatch(text: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR !== undefined || text === '') return text;
  return `\x1b[38;5;222m\x1b[1m${text}\x1b[0m`;
}

export function renderGrepActivitiesView(
  visible: StoredAct[],
  totalMatches: number,
  full: boolean | undefined,
  squarePath: string,
  pattern: string,
  fixed = false
): string {
  const publicVisible = visible.filter((act): act is PublicAct => act.kind === 'say' || act.kind === 'done');
  if (totalMatches === 0) return `○ no activity matched ${quoteShell(pattern)}`;
  const matchLabel = totalMatches === 1 ? 'match' : 'matches';
  const chunks = [publicVisible.length === totalMatches ? `${totalMatches} ${matchLabel}` : `${publicVisible.length} of ${totalMatches} ${matchLabel}`];
  let truncated = false;

  for (const act of publicVisible) {
    const rawBody = act.body ?? '';
    if (full === true) {
      const body = rawBody.split('\n').map((line) => `  ${line}`).join('\n');
      chunks.push(`${actId(act.index)} · ${act.actor ?? 'unknown'} · ${formatTimestamp(act.at)}\n${body}`);
      continue;
    }

    const snippet = grepSnippet(rawBody, pattern, GREP_PREVIEW_CHARS, fixed);
    if (snippet === undefined) {
      const preview = previewBody(rawBody, GREP_PREVIEW_CHARS);
      chunks.push(`${actId(act.index)} · ${act.actor ?? 'unknown'} · ${formatTimestamp(act.at)}${preview === '' ? '' : `\n  ${preview}`}`);
      continue;
    }
    const clippedBefore = snippet.beforeOmitted > 0;
    const clippedAfter = snippet.afterOmitted > 0;
    truncated ||= clippedBefore || clippedAfter;
    const text = `${clippedBefore ? '… ' : ''}${snippet.before}${highlightGrepMatch(snippet.match)}${snippet.after}${clippedAfter ? ' …' : ''}`;
    const omitted = clippedBefore || clippedAfter
      ? `\n  · ${snippet.beforeOmitted} chars before · ${snippet.afterOmitted} chars after`
      : '';
    chunks.push(`${actId(act.index)} · ${act.actor ?? 'unknown'} · ${formatTimestamp(act.at)}\n  ${text.trim()}${omitted}`);
  }

  if (publicVisible.length === 1) {
    chunks.push(`» ${commandPrefix(squarePath)} history --at ${actId(publicVisible[0].index)} -C 2${truncated ? ' --full' : ''}`);
  } else if (truncated && publicVisible.length > 1) {
    chunks.push(`» ${commandPrefix(squarePath)} history --at ${actId(publicVisible[0].index)} -C 2 --full`);
  }
  return chunks.join('\n\n');
}

function renderActivityLimitBody(opts: ActivityLimitOptions): string {
  const countText = opts.count !== undefined && opts.hardCap !== undefined ? ` (${opts.count}/${opts.hardCap})` : '';
  const doneCommand = `${participantCommandPrefix(opts.squarePath, opts.name)} done -`;
  return [
    `✕ your activity doesn't land — the cap is reached${countText}`,
    ...draftSavedLines(opts.draftPath),
    `» ${withDraftInput(doneCommand, opts.draftPath)}`,
  ].join('\n');
}

export function renderActivityLimit(opts: ActivityLimitOptions): string {
  return withPathOutput(opts.squarePath, renderActivityLimitBody(opts), { participantCount: opts.participantCount, held: opts.held });
}

export function renderWatchAlreadyActive(opts: ParticipantOutputOptions): string {
  return ['✕ you are already catching', `» ${participantCommandPrefix(opts.squarePath, opts.name)} catch --idle 30m --replace`].join('\n');
}

export function renderWatchForceTakeover(_opts: ParticipantOutputOptions): string {
  return '✓ your new catch takes over';
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
      const quiet = opts.status === 'stale' && opts.idleMs !== undefined
        ? `○ ${formatDuration(opts.idleMs)} of quiet — nothing new for you`
        : '○ only footsteps in the square — nothing new for you';
      return [
        quiet,
        ...(opts.showCatchHint === false
          ? []
          : [`» ${prefix} catch --idle 30m`, `  glance: ${prefix} catch --now`]),
        ...presenceLines,
      ].join('\n');
    }
    case 'quorum':
      return ['✓ everyone else has left — the square is yours alone', `» ${participantCommandPrefix(opts.squarePath, opts.name)} done -`].join('\n');
    case 'capped':
      return ['✕ nothing left in you — the cap is reached', `» ${participantCommandPrefix(opts.squarePath, opts.name)} done -`].join('\n');
  }
}

function renderRoomChanges(changes: RoomChangeAct[]): string {
  if (changes.length === 0) return '';
  return ['▲ while your back was turned', ...changes.map((act) => `  · ${renderRoomChangeText(act)}`)].join('\n');
}

export function renderDoctorClean(): string {
  return '✓ no problems found';
}

export function renderDoctorProblems(problems: { kind: string; message: string }[]): string {
  return [`✕ ${problems.length} ${pluralize(problems.length, 'problem')} found`, ...problems.map((problem) => `  · ${problem.kind}: ${problem.message}`)].join('\n');
}

export function renderDoctorUnfixable(reason: string): string {
  return ['✕ cannot repair', `  · ${reason}`].join('\n');
}

export function renderDoctorRepaired(actions: { message: string }[], quarantinedCount: number, sidecarPath: string | undefined): string {
  if (actions.length === 0) return '✓ no problems found';
  return [
    '✓ repaired',
    ...actions.map((action) => `  · ${action.message}`),
    ...(quarantinedCount > 0 && sidecarPath !== undefined ? [`  · quarantined ${quarantinedCount} act block(s)`, `  · sidecar ${sidecarPath}`] : []),
  ].join('\n');
}

export function renderWatchOutput(
  history: StoredAct[],
  publicItems: PublicAct[],
  roomChanges: RoomChangeAct[],
  opts: { squarePath: string; stalePartial?: boolean; idleMs?: number; mention?: string; viewer: string; showCatchHint?: boolean }
): string {
  const sections: string[] = [];
  if (opts.stalePartial) {
    const prefix = participantCommandPrefix(opts.squarePath, opts.viewer);
    const quiet = opts.idleMs === undefined
      ? '○ only footsteps in the square — nothing new for you'
      : `○ ${formatDuration(opts.idleMs)} of quiet — nothing else for you`;
    sections.push(
      [
        quiet,
        ...(opts.showCatchHint === false
          ? []
          : [`» ${prefix} catch --idle 30m`, `  glance: ${prefix} catch --now`]),
      ].join('\n')
    );
  }

  const publicIndexes = new Set(publicItems.map((item) => item.index));
  const presenceChanges = roomChanges.filter(({ index }) => !publicIndexes.has(index));
  const room = renderRoomChanges(presenceChanges);
  if (room !== '') sections.push(room);

  if (publicItems.length > 0) {
    const rendered = publicItems
      .map((act) =>
        renderVisibleEvent(history, act, opts.viewer, {
          actNumber: act.kind === 'say' ? sayNumberFor(history, act) : undefined,
          mention: opts.mention,
        })
      )
      .filter(Boolean)
      .join('\n\n');
    if (rendered !== '') sections.push(rendered);
  }

  return sections.join('\n\n') + '\n';
}
