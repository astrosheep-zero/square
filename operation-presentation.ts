// Human-facing scenes for settled operations, with surface-specific next actions.
import { sameName } from './model.js';
import { formatActivityId } from './square-core.js';
import type {
  PerceiveOptions, PerceiveResult, ExpressResult, HistoryObservation, HistoryQuery, HistoryResult,
  JoinResult, LifecycleResult, ListenerChangeResult, ListeningResult, OperationFailureDetail,
  ParticipantsResult, StatusResult, DiscoveryResult,
} from './square-facade.js';
import {
  type PresentationSurface, displayPath, formatToolAction, commandPrefix, joinRecoveryCommand, participantCommandPrefix, participantIdentity,
  participantsRecoveryCommand, quoteShell, renderAmbientEvent, renderAmbientEventFacts,
  renderEventCli, renderGrepActivitiesView, renderPresenceAnchor,
  renderRoomChangeText, renderWatchAlreadyActive, renderWatchReplaced, renderWatchStatus,
  takeoverRecoveryLines, withPathOutput, truncateChars,
} from './presentation.js';
import { formatRelativeTime, formatTimestamp } from './time.js';
import { style } from './tty-style.js';

function listDisplay(value: string): string {
  const truncated = truncateChars(value, 159);
  return truncated.remaining === 0 ? truncated.text : `${truncated.text}…`;
}

export function renderSquareList(data: DiscoveryResult, projection: { now: number; depth: number; limit: number; surface?: PresentationSurface }): string {
  const { items, stopped, remaining, next } = data;
  if (data.total === 0) {
    return ['(no squares found)', ...(stopped ? [style('dim', '○ the walk stopped early — deeper squares may still be hiding')] : [])].join('\n') + '\n';
  }
  const lines = ['squares'];
  for (const item of items) {
    const glyph = item.activities > 0 ? '●' : style('dim', '○');
    lines.push(`${glyph} ${listDisplay(item.path)}${style('dim', ` · ${formatRelativeTime(item.lastActiveAt, projection.now)} · ${item.participants.length} in the square · ${item.activities} ${item.activities === 1 ? 'activity' : 'activities'}`)}`);
    const context = item.context.slice(0, 2);
    if (context.length === 0) lines.push(`  ${style('dim', 'context')} · (none)`);
    else {
      context.forEach((line, index) => lines.push(`  ${index === 0 ? style('dim', 'context') : '       '} · ${listDisplay(line)}`));
      const hidden = item.context.length - context.length;
      if (hidden > 0) lines.push(style('dim', `          · … ${hidden} more ${hidden === 1 ? 'line' : 'lines'}`));
    }
    const participants = item.participants.slice(0, 3);
    const hidden = item.participants.length - participants.length;
    const names = participants.length === 0 ? 'nobody' : participants.map((name) => participantIdentity(listDisplay(name))).join(' · ');
    lines.push(`  ${style('dim', 'participants')} · ${names}${hidden > 0 ? style('dim', ` · … ${hidden} more`) : ''}`);
    if (item.joined?.length) lines.push(`  ${style('dim', 'joined')} · ${item.joined.map(seat => `${participantIdentity(listDisplay(seat.name))}${seat.pending > 0 ? style('dim', ` (${seat.pending} waiting)`) : ''}`).join(' · ')}`);
  }
  if (remaining > 0) {
    lines.push(style('dim', stopped ? '  … more squares' : `  … ${remaining} more ${remaining === 1 ? 'square' : 'squares'}`));
    if (next !== undefined) lines.push(projection.surface === 'tool' ? formatToolAction('list', { depth: projection.depth, limit: projection.limit, after: next }) : `square list --depth ${projection.depth} --limit ${projection.limit} --after ${quoteShell(next)}`);
  }
  if (stopped) lines.push(style('dim', '○ the walk stopped early — deeper squares may still be hiding'));
  return lines.join('\n') + '\n';
}

export const PARTICIPANTS_DEFAULT_LIMIT = 20;
export const PARTICIPANTS_MAX_LIMIT = 100;
const STATUS_PARTICIPANT_PREVIEW_LIMIT = 10;

/** A join receipt whose participant is already reduced to its serializable name. */
export type JoinPresentation = Omit<JoinResult, 'participant'> & {
  readonly participant: { readonly name: string } | string;
};

export function renderJoinResult(data: JoinPresentation, owner?: string, surface: PresentationSurface = 'cli'): string | undefined {
  const after = data.observation;
  if (after === undefined) return undefined;
  const entry = after.entry;
  const name = typeof data.participant === 'string' ? data.participant : data.participant.name;
  const activities = (entry?.recentActivities ?? []).map((event) => renderAmbientEvent(event, name, {
    now: after.now, preview: 200, perception: event.perception,
  })).filter(Boolean).join('\n\n');
  const fallback = after.deliveryAvailable ? ['', '· when someone calls you, you’ll hear them here'] : [
    '', surface === 'tool' ? formatToolAction('perceive', { location: displayPath(after.location), as: name, idle: 1800000 }) : `${participantCommandPrefix(after.location, name, owner)} perceive --idle 30m`,
    '  · stay within earshot — keep this perceive open for new activity',
  ];
  const entryLine = data.kind === 'joined' ? '● you stepped into the square'
    : data.kind === 'reconnected' ? '● you are already in the square'
      : `✓ you banished the original ${participantIdentity(name)} — the name is yours`;
  const isRejoin = data.kind !== 'joined';
  const entryScene = isRejoin || entry === undefined ? '' : entry.joinedBefore
    ? '*the flagstones are where you left them. so is your shadow.*' : entry.scene;
  return withPathOutput(after.location, [
    entryLine, '',
    ...(entryScene === '' ? [] : ['', entryScene]),
    ...(isRejoin || !entry?.joinContext ? [] : ['', style('dim', 'context'), entry.joinContext]),
    ...(after.enrichmentUnavailable ? ['  · joined; recent activity and context are unavailable right now'] : []),
    ...(isRejoin || activities === '' ? [] : ['', style('dim', 'recent activity'), activities]),
    ...fallback,
  ].join('\n'), { participantCount: after.standingCount });
}

function isGestureOnly(body: string): boolean {
  return /\*[^*]*\*/.test(body) && body.replace(/\*[^*]*\*/g, '').trim() === '';
}

export function renderExpression(squarePath: string, data: ExpressResult, owner?: string, surface: PresentationSurface = 'cli'): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const name = projection.participant;
  const context = projection.context;
  const pending = context.activities.length === 0 ? '' : '\n\n' + [
    'Unread context · preview only, not consumed',
    ...context.activities.map(item => `· ${participantIdentity(item.actor)} · ${item.id}\n  ${item.preview}${item.truncated ? '… (truncated)' : ''}`),
    ...(context.remaining === 0 ? [] : [`· ${context.remaining} more unread activities`]),
    surface === 'tool' ? formatToolAction('perceive', { location: displayPath(projection.location), as: name }) : `${participantCommandPrefix(projection.location, name, owner)} perceive`,
  ].join('\n');
  const ownCount = projection.ownActivityCount;
  const capCount = projection.hardCap === null ? '' : ` · ${ownCount}/${projection.hardCap}`;
  const activity = data.activity;
  const confirmation = activity.reach === 'bell'
    ? `● you ring the bell — everyone turns · ${activity.id}${style('dim', capCount)}`
    : `● ${activity.mentions.length > 0
      ? `you walk over to ${activity.mentions.map((target) => participantIdentity(target)).join(', ')}`
      : activity.metadata !== undefined && (activity.body ?? '').trim() === '' ? 'structured activity lands' : isGestureOnly(activity.body ?? '') ? 'your gesture lands' : 'your words land'} — ${activity.id}${style('dim', capCount)}`;
  const replyNotice = data.replyAuthorNotHere === undefined ? ''
    : `\n○ ${participantIdentity(data.replyAuthorNotHere)} isn't in the square right now — the reply landed without reaching them`;
  const unmatchedNotice = data.unmatchedMentions?.length
    ? `\n  · ${data.unmatchedMentions.map((token) => `@${token} isn't standing here`).join('; ')} — ${activity.mentions.length === 0 && activity.reply === undefined ? 'activity landed bare' : 'left as literal text'}` : '';
  return withPathOutput(projection.location ?? squarePath,
    confirmation + (data.hint ? `\n${style('dim', `· ${data.hint}`)}` : '') + replyNotice + unmatchedNotice + pending,
    { participantCount: projection.standingCount });
}

function continuationCommand(squarePath: string, name: string, options: PerceiveOptions, owner?: string): string {
  const args = ['--now'];
  if (options.from?.length) args.push('--from', options.from.join(','));
  if (options.mention) args.push('--mention');
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  return `${participantCommandPrefix(squarePath, name, owner)} perceive ${args.join(' ')}`;
}

/** Render settled perceive facts; no selection, terminal decisions, receipts or wait machinery. */
export function renderPerceiveOutcome(
  squarePath: string,
  data: PerceiveResult,
  options: PerceiveOptions = {},
  owner?: string,
  surface: PresentationSurface = 'cli',
): { stdout: string; exitCode: number } {
  const projection = data.observation;
  if (projection === undefined) return { stdout: '', exitCode: 0 };
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
    return {
      stdout: withPathOutput(location, stop === 'already-active'
        ? renderWatchAlreadyActive(statusOptions) : renderWatchReplaced(statusOptions), header),
      exitCode: stop === 'already-active' ? 1 : 0,
    };
  }
  const rendered = data.activities.map((activity) => renderAmbientEvent(activity, name, {
    now: projection.now, perception: activity.perception, mention: options.mention ? name : undefined,
  })).filter(Boolean).join('\n\n');
  const remaining = data.remaining === 0 ? ''
    : `· ${data.remaining} matching ${data.remaining === 1 ? 'activity remains' : 'activities remain'}\n${surface === 'tool' ? formatToolAction('perceive', { location: displayPath(location), as: name, ...(options.from?.length ? { from: options.from } : {}), ...(options.mention ? { mention: true } : {}), ...(options.limit !== undefined ? { limit: options.limit } : {}) }) : continuationCommand(location, name, options, owner)}`;
  const terminal = stop === undefined ? '' : renderWatchStatus({
    ...statusOptions, status: stop,
    ...(stop === 'idle' && options.idle !== undefined ? { idleMs: options.idle } : {}),
  });
  const fallback = stop === undefined && !projection.deliveryAvailable && data.remaining === 0
    ? `${surface === 'tool' ? formatToolAction('perceive', { location: displayPath(location), as: name, idle: 1800000 }) : `${participantCommandPrefix(location, name, owner)} perceive --idle 30m`}\n  stay available for new activity` : '';
  const hint = data.hint === undefined ? '' : style('dim', `· ${data.hint}`);
  return {
    stdout: withPathOutput(location, [terminal, rendered, hint, remaining, fallback].filter(Boolean).join('\n\n'), header),
    exitCode: stop === 'capped' ? 1 : 0,
  };
}

function renderHistoryProjection(
  projection: HistoryObservation,
  visible: HistoryObservation['visibleActivities'],
  noTruncate: boolean,
  squarePath: string,
  surface: PresentationSurface,
): string {
  const shown = visible;
  const preview = noTruncate || shown.length <= 1 ? undefined : 200;
  const chunks: string[] = [];
  // Presence anchors collect into one closing line instead of interrupting the page.
  const anchored: string[] = [];
  for (const activity of shown) {
    const rendered = renderEventCli(activity, { preview });
    if (rendered !== '') chunks.push(rendered);
    for (const participant of projection.presenceAnchors[activity.index] ?? []) {
      if (!anchored.some((existing) => sameName(existing, participant))) anchored.push(participant);
    }
  }
  if (chunks.length === 0) return '○ no activity matches this history query';
  if (preview !== undefined && shown.some((activity) => activity.kind === 'say' && (activity.body?.length ?? 0) > preview)) {
    chunks.push(surface === 'tool' ? formatToolAction('perceive', { location: displayPath(squarePath), id: formatActivityId(shown.find(a => a.kind === 'say' && (a.body?.length ?? 0) > preview)!.index) }) : `${commandPrefix(squarePath)} history --at ${shown.map((activity) => formatActivityId(activity.index)).join(',')} --no-truncate`);
  }
  if (anchored.length > 0) chunks.push(renderPresenceAnchor(anchored));
  return chunks.join('\n\n');
}

export function historyContinuationCommand(squarePath: string, args: readonly string[]): string {
  return `${commandPrefix(squarePath)} history ${args.map((arg) => arg.startsWith('-') || /^act\/\d+$/.test(arg) || /^\d+$/.test(arg) ? arg : quoteShell(arg)).join(' ')}`;
}

/** The same query spelled as CLI arguments, for a continuation someone can actually run. */
function historyQueryArgs(query: HistoryQuery): string[] {
  const args: string[] = [];
  if (query.from?.length) args.push('--from', query.from.join(','));
  if (query.since !== undefined) args.push('--since', formatTimestamp(query.since));
  if (query.at?.length) args.push('--at', query.at.join(','));
  if (query.contextBefore !== undefined) args.push('-B', String(query.contextBefore));
  if (query.contextAfter !== undefined) args.push('-A', String(query.contextAfter));
  if (query.mention !== undefined) args.push('--mention', query.mention);
  if (query.search !== undefined) args.push(query.search.mode === 'regex' ? '--grep' : '--fixed', query.search.text);
  if (query.order !== undefined) args.push('--order', query.order);
  return args;
}

export function renderHistoryResult(
  squarePath: string,
  data: HistoryResult,
  options: { query?: HistoryQuery; noTruncate?: boolean; continuationArgs?: readonly string[]; surface?: PresentationSurface } = {},
): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const query = options.query ?? {};
  const noTruncate = options.noTruncate === true;
  const search = query.search;
  const output = search === undefined
    ? renderHistoryProjection(projection, projection.visibleActivities, noTruncate, squarePath, options.surface ?? 'cli')
    : renderGrepActivitiesView(projection.visibleActivities, projection.totalMatches, noTruncate, squarePath, search.text, search.mode === 'literal', () => 'full', options.surface);
  const next = projection.continuation;
  const base = options.continuationArgs ?? historyQueryArgs(query);
  const continuation = next === undefined ? '' : `\n\n${options.surface === 'tool' ? formatToolAction('history', { location: displayPath(squarePath), ...(query.from?.length ? { from: query.from } : {}), ...(query.mention !== undefined ? { mention: query.mention } : {}), ...(query.search !== undefined ? (query.search.mode === 'regex' ? { grep: query.search.text } : { fixed: query.search.text }) : {}), ...(query.order !== undefined ? { order: query.order } : {}), [next.direction]: next.cursor, limit: next.limit }) : historyContinuationCommand(squarePath, [...base, `--${next.direction}`, next.cursor, '--limit', String(next.limit)])}`;
  return withPathOutput(squarePath, output + continuation, { participantCount: projection.standingCount });
}

export function participantsLimitCommand(squarePath: string, limit: number): string {
  return `${commandPrefix(squarePath)} participants --limit ${limit}`;
}

export function renderParticipantsResult(
  squarePath: string,
  data: ParticipantsResult,
  limit = PARTICIPANTS_DEFAULT_LIMIT,
): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const now = projection.now;
  const participants = data.participants;
  const lines = participants.slice(0, limit).map((participant) => {
    const glyph = participant.presence === 'done' ? '○' : participant.presence === 'watching' ? '◎' : participant.activityCount > 0 && projection.classificationByName[participant.name] === 'here' ? '●' : '○';
    const state = participant.presence === 'watching' ? 'perceiving' : participant.presence === 'never-joined' ? 'not joined' : participant.presence;
    const last = participant.lastActiveAt === undefined ? '—' : formatRelativeTime(participant.lastActiveAt, now);
    return `  ${glyph} ${participant.name}${style('dim', ` · ${state} · ${participant.activityCount} ${participant.activityCount === 1 ? 'activity' : 'activities'} · ${last}`)}`;
  });
  const tail = participants.length <= limit
    ? []
    : [
        style('dim', `  · ${lines.length} of ${participants.length} participants shown`),
        ...(participants.length <= PARTICIPANTS_MAX_LIMIT ? [
          `${participantsLimitCommand(squarePath, participants.length)}`,
        ] : []),
      ];
  return withPathOutput(squarePath, ['participants', ...lines, ...tail].join('\n'), {
    participantCount: projection.standingCount,
  });
}

export function renderStatusResult(squarePath: string, data: StatusResult, options: { surface?: PresentationSurface } = {}): string | undefined {
  const presentation = data.observation;
  if (presentation === undefined) return undefined;
  const participantsByName = new Map(data.participants.map((participant) => [participant.name, participant]));
  const orderedHere = presentation.orderedHereNames.map((name) => participantsByName.get(name)!);
  const lingering = presentation.lingeringCount;
  const away = data.participants.filter(participant => participant.presence === 'away');
  const people: string[] = [];
  if (presentation.standingCount === 0) {
    people.push('  ○ nobody in the square');
  } else {
    if (orderedHere.length === 0) people.push('  ○ nobody here right now');
    people.push(...orderedHere.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map((participant) => {
      const glyph = participant.presence === 'watching'
        ? '◎'
        : participant.activityCount > 0 ? '●' : '○';
      const summary = participant.presence === 'watching'
        ? 'is nearby · perceiving'
        : participant.activityCount > 0
          ? `is nearby · ${formatRelativeTime(participant.lastActiveAt ?? data.now, data.now)}`
          : `is nearby · quiet · ${participant.lastActiveAt === undefined ? 'just now' : formatRelativeTime(participant.lastActiveAt, data.now)}`;
      const showAttention = presentation.attentionNames.includes(participant.name);
      const attention = !showAttention
        ? ''
        : participant.pendingMentionCount > 0
          ? `${participant.pendingMentionCount} ${participant.pendingMentionCount === 1 ? 'mention' : 'mentions'} waiting`
          : participant.unreadActivityCount > 0
            ? `${participant.unreadActivityCount} change${participant.unreadActivityCount === 1 ? '' : 's'} waiting`
            : 'up to date';
      return `  ${glyph} ${participantIdentity(participant.name)}${style('dim', ` ${summary}${attention === '' ? '' : ` · ${attention}`}`)}`;
    }));
    people.push(...away.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map(participant => `  ○ ${participantIdentity(participant.name)}${style('dim', ' · away')}`));
    if (away.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) people.push(`  ○ … ${away.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more away`);
    const unshown = Math.max(0, orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT)
      + Math.max(0, away.length - STATUS_PARTICIPANT_PREVIEW_LIMIT) + lingering;
    if (orderedHere.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) {
      people.push(`  ○ … ${orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more here`);
    }
    if (lingering > 0) people.push(`  ○ … ${lingering} lingering`);
    if (unshown > 0 && options.surface !== 'tool') {
      people.push(`${presentation.knownParticipantCount <= PARTICIPANTS_MAX_LIMIT
        ? participantsLimitCommand(squarePath, presentation.knownParticipantCount)
        : `${commandPrefix(squarePath)} participants`}`);
    }
  }
  const cap = data.hardCap === null ? 'unlimited' : `${data.hardCap} each`;
  const visible = data.latestActivity === undefined
    ? { text: '', bodyClipped: false }
    : renderAmbientEventFacts(data.latestActivity, presentation.viewer, {
        now: data.now,
        preview: 200,
        perception: presentation.latestPerception,
      });
  const latest = visible.text === ''
    ? [data.latestActivity === undefined
      ? '  ○ no public activity yet'
      : '  · the latest words were meant for other ears']
    : [`  ${visible.text.replace(/\n/g, '\n  ')}`];
  // Presence events after the latest public act: otherwise the roster can say someone is
  // here while the latest line shows them leaving, with nothing to reconcile the two.
  for (const { activity, rejoined } of presentation.joins) {
    latest.push(style('dim', `  → ${participantIdentity(activity.actor)} ${rejoined ? 'stepped back in' : 'stepped in'} · ${formatRelativeTime(activity.at, data.now)}`));
  }
  if (presentation.joinCount > 3) latest.push(style('dim', `  → … ${presentation.joinCount - 3} more stepped in`));
  if (visible.bodyClipped && data.latestActivity !== undefined) {
    latest.push(options.surface === 'tool' ? formatToolAction('perceive', { location: displayPath(squarePath), id: data.latestActivity.id }) : `${commandPrefix(squarePath)} history --at ${data.latestActivity.id} -C 2 --no-truncate`);
  }
  const counts = [
    `${orderedHere.length} here`,
    ...(away.length > 0 ? [`${away.length} away`] : []),
    ...(lingering > 0 ? [`${lingering} lingering`] : []),
    `${data.participants.filter((participant) => participant.presence === 'done').length} done`,
    `cap ${cap}`,
    `throttle ${data.throttlePerMinute === undefined ? 'none' : `${data.throttlePerMinute}/min`}`,
  ].join(' · ');
  const output = [
    style('dim', counts),
    '', style('dim', 'around the square'), ...people, '', style('dim', 'latest'), ...latest,
    ...(data.listening === undefined ? [] : [
      '', style('dim', 'you listen to'),
      ...(data.listening.length === 0 ? ['  ○ not turned toward anyone'] : data.listening.map((name) => `  · ${participantIdentity(name)}`)),
    ]),
  ].join('\n');
  return withPathOutput(squarePath, output, { participantCount: presentation.standingCount });
}

export function renderListeningResult(squarePath: string, data: ListeningResult): string | undefined {
  const projection = data.observation;
  if (projection?.participant === undefined) return undefined;
  const body = data.listening.length === 0
    ? `○ ${participantIdentity(projection.participant)} is not turned toward anyone`
    : ['listening', ...data.listening.map((target) => `  · ${participantIdentity(target)}`)].join('\n');
  return withPathOutput(squarePath, body, { participantCount: projection.standingCount });
}

export type ListenerVerb = 'listen' | 'ignore' | 'unlisten';

export function renderListenerChange(squarePath: string, verb: ListenerVerb, data: ListenerChangeResult): string | undefined {
  const projection = data.observation;
  if (projection?.participant === undefined) return undefined;
  const actor = participantIdentity(projection.participant);
  const target = participantIdentity(projection.target);
  const action = data.activity !== null
    ? verb === 'listen' ? `${actor} turns an ear toward ${target}`
      : verb === 'ignore' ? `${actor} turns away from ${target} — only bells will reach you from them`
        : `${actor} stops listening to ${target} — direct mentions and replies still reach you unless ignored`
    : verb === 'listen' ? `${actor} already turns an ear toward ${target}`
      : verb === 'ignore' ? `${actor} already ignores ${target} — only bells will reach you from them`
        : `${actor} is not listening to ${target}`;
  return withPathOutput(squarePath, `${data.activity === null ? '○' : '·'} ${action}`, {
    participantCount: projection.standingCount,
  });
}

export function renderLifecycleResult(squarePath: string, data: LifecycleResult): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  return withPathOutput(projection.location ?? squarePath, `○ you stepped out — your footsteps fade · ${data.activity.id}`, {
    participantCount: projection.standingCount,
  });
}

/** The refusal facts a transport has after normalizing a failure, without the live error. */
export interface FailureReport {
  readonly code: string;
  readonly message: string;
  readonly facts?: {
    readonly reason?: 'never_joined' | 'not_standing' | 'bell_mention_conflict' | 'not_addressed' | 'invalid_reply' | 'invalid_done_body' | 'needs_seat';
    readonly activityId?: string;
    readonly activityExists?: boolean;
  };
  readonly operation?: OperationFailureDetail;
}

/** Refusal lines with surface-specific recovery actions. */
export function renderFailureLines(failure: FailureReport, options: { squarePath?: string; name?: string; owner?: string; surface?: PresentationSurface; reply?: string } = {}): string[] {
  const { squarePath, name, owner } = options;
  const facts = failure.facts;
  const reason = facts?.reason;
  const marked = reason === 'never_joined' || reason === 'not_standing';
  const lines = marked ? failure.message.split('\n').map((line) => `✕ ${line}`) : [failure.message];
  if (failure.code === 'behind' && options.surface === 'tool') lines[0] = `✕ your words stay unsent — ${failure.message}`;
  if (reason === 'bell_mention_conflict' || reason === 'invalid_reply') {
    lines[0] = reason === 'bell_mention_conflict' ? '✕ a bell cannot be combined with a mention'
      : `Invalid ${options.surface === 'tool' ? 'reply' : '--reply'}: ${facts?.activityExists === false ? `${facts.activityId ?? options.reply ?? 'that activity'} is not in this square's history` : 'expected an activity id like act/12'}`;
    if (squarePath !== undefined) lines.push(options.surface === 'tool'
      ? formatToolAction(reason === 'invalid_reply' ? 'history' : 'status', { location: displayPath(squarePath), ...(reason === 'invalid_reply' ? { limit: 10 } : {}) })
      : reason === 'invalid_reply' ? `${commandPrefix(squarePath)} history --limit 10` : participantsRecoveryCommand(squarePath));
  } else if (reason === 'needs_seat' && squarePath !== undefined && name !== undefined) {
    lines.splice(0, 1, `✕ ${failure.message}`);
    lines.push(options.surface === 'tool' ? formatToolAction('join', { location: displayPath(squarePath), as: name }) : joinRecoveryCommand(squarePath, name, owner));
  } else if (squarePath !== undefined && name !== undefined && failure.code === 'already_joined') {
    lines.splice(0, 1, `✕ ${participantIdentity(name)} shoos you out of the square`,
      `  · ${participantIdentity(name)} already stands here — another session holds the name`);
    lines.push(...(options.surface === 'tool' ? ['If this is your name to reclaim, takeover banishes the one standing here so you can step in:', formatToolAction('join', { location: displayPath(squarePath), as: name, takeover: true })] : takeoverRecoveryLines(squarePath, name, owner)));
  } else if (squarePath !== undefined && name !== undefined && (failure.code === 'unknown_participant' || failure.code === 'not_joined') && reason !== 'not_standing') {
    lines.push(options.surface === 'tool' ? formatToolAction('join', { location: displayPath(squarePath), as: name }) : joinRecoveryCommand(squarePath, name, owner));
  } else if (squarePath !== undefined && reason === 'never_joined') {
    lines.push(options.surface === 'tool' ? (failure.operation?.subject !== 'filter' && name !== undefined ? formatToolAction('join', { location: displayPath(squarePath), as: name }) : formatToolAction('status', { location: displayPath(squarePath) })) : failure.operation?.subject !== 'filter' && name !== undefined
      ? joinRecoveryCommand(squarePath, name, owner) : participantsRecoveryCommand(squarePath));
  } else if (squarePath !== undefined && reason === 'not_standing') {
    lines.push(options.surface === 'tool' ? formatToolAction('status', { location: displayPath(squarePath) }) : participantsRecoveryCommand(squarePath));
  } else if (squarePath !== undefined && reason === 'not_addressed' && facts?.activityId !== undefined) {
    lines.push(options.surface === 'tool' ? (facts.activityExists === true ? formatToolAction('history', { location: displayPath(squarePath), fixed: facts.activityId }) : formatToolAction('history', { location: displayPath(squarePath), limit: 10 })) : facts.activityExists === true
      ? `${commandPrefix(squarePath)} history --at ${facts.activityId} -C 2`
      : `${commandPrefix(squarePath)} history --limit 10`);
  }
  if (reason === 'invalid_done_body' && options.surface !== 'tool') lines.push('square done --help');
  return lines;
}
