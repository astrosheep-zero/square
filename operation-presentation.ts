// Human-facing text for one settled operation. The CLI and the MCP transport both
// render through these functions, so a person sees the same square either way.
import { sameName, type RoomChangeAct } from './model.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import type {
  CatchOptions, CatchResult, ExpressResult, HistoryObservation, HistoryQuery, HistoryResult,
  JoinResult, LifecycleResult, ListenerChangeResult, ListeningResult, OperationFailureDetail,
  ParticipantsResult, StatusResult,
} from './square-facade.js';
import {
  commandPrefix, joinRecoveryCommand, participantCommandPrefix, participantIdentity,
  participantsRecoveryCommand, quoteShell, renderAmbientEvent, renderAmbientEventFacts,
  renderEventCli, renderGrepActivitiesView, renderPendingFeed, renderPresenceAnchor,
  renderRoomChangeText, renderWatchAlreadyActive, renderWatchReplaced, renderWatchStatus,
  takeoverRecoveryLines, withPathOutput,
} from './presentation.js';
import { formatRelativeTime, formatTimestamp } from './time.js';
import { style } from './tty-style.js';

export const PARTICIPANTS_DEFAULT_LIMIT = 20;
export const PARTICIPANTS_MAX_LIMIT = 100;
const STATUS_PARTICIPANT_PREVIEW_LIMIT = 10;

/** A join receipt whose participant is already reduced to its serializable name. */
export type JoinPresentation = Omit<JoinResult, 'participant'> & {
  readonly participant: { readonly name: string } | string;
};

export function renderJoinResult(data: JoinPresentation): string | undefined {
  const after = data.observation;
  if (after === undefined) return undefined;
  const entry = after.entry;
  const name = typeof data.participant === 'string' ? data.participant : data.participant.name;
  const activities = (entry?.recentActivities ?? []).map((event) => renderAmbientEvent(event, name, {
    now: after.now, preview: 200,
    actNumber: event.kind === 'say' ? entry!.sayNumbers[event.index] : undefined,
    perception: entry!.perceptions[event.index],
  })).filter(Boolean).join('\n\n');
  const fallback = after.automaticDeliveryAvailable ? ['', '· when someone calls you, you’ll hear them here'] : [
    '', `${participantCommandPrefix(after.location, name)} catch --idle 30m`,
    '  · stay within earshot — keep this catch open for new activity',
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
  ].join('\n'), { participantCount: after.standingCount, held: after.held });
}

function isGestureOnly(body: string): boolean {
  return /\*[^*]*\*/.test(body) && body.replace(/\*[^*]*\*/g, '').trim() === '';
}

export function renderExpression(squarePath: string, data: ExpressResult): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const name = projection.participant;
  const pendingSpeaker = projection.pendingPublic[0]?.actor;
  const pendingLead = pendingSpeaker === undefined ? ''
    : `▲ while you spoke, ${participantIdentity(pendingSpeaker)} said something behind you\n\n`;
  const pending = projection.pendingPublic.length === 0 ? ''
    : `\n\n${pendingLead}${renderPendingFeed(projection.pendingPublic, projection.sayNumbers, projection.perceptions, name)}`;
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
    { participantCount: projection.standingCount, held: projection.held });
}

function continuationCommand(squarePath: string, name: string, options: CatchOptions): string {
  const args = ['--now'];
  if (options.from?.length) args.push('--from', options.from.join(','));
  if (options.mention) args.push('--mention');
  if (options.limit !== undefined) args.push('--limit', String(options.limit));
  return `${participantCommandPrefix(squarePath, name)} catch ${args.join(' ')}`;
}

/** Render settled catch facts; no selection, terminal decisions, receipts or wait machinery. */
export function renderCatchOutcome(
  squarePath: string,
  data: CatchResult,
  options: CatchOptions = {},
): { stdout: string; exitCode: number } {
  const projection = data.observation;
  if (projection === undefined) return { stdout: '', exitCode: 0 };
  const location = projection.location ?? squarePath;
  const name = projection.participant;
  const stop = projection.stop ?? data.status;
  const header = { participantCount: projection.standingCount, held: projection.held };
  const statusOptions = {
    squarePath: location, name, presence: projection.presence,
    showCatchHint: !projection.automaticDeliveryAvailable,
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
    now: projection.now, actNumber: projection.sayNumbers[parseActivityId(activity.id)!],
    perception: activity.perception, mention: options.mention ? name : undefined,
  })).filter(Boolean).join('\n\n');
  const remaining = data.remaining === 0 ? ''
    : `· ${data.remaining} matching ${data.remaining === 1 ? 'activity remains' : 'activities remain'}\n${continuationCommand(location, name, options)}`;
  const terminal = stop === undefined ? '' : renderWatchStatus({
    ...statusOptions, status: stop,
    ...(stop === 'stale' && options.idle !== undefined ? { idleMs: options.idle } : {}),
  });
  const fallback = stop === undefined && !projection.automaticDeliveryAvailable && data.remaining === 0
    ? `${participantCommandPrefix(location, name)} catch --idle 30m\n  stay available for new activity` : '';
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
): string {
  const shown = visible;
  const preview = noTruncate || shown.length <= 1 ? undefined : 200;
  const chunks: string[] = [];
  // Presence anchors collect into one closing line instead of interrupting the page.
  const anchored: string[] = [];
  for (const activity of shown) {
    const options = {
      preview,
      actNumber: activity.kind === 'say' ? projection.sayNumbers[activity.index] : undefined,
    };
    const rendered = renderEventCli(activity, options);
    if (rendered !== '') chunks.push(rendered);
    for (const participant of projection.presenceAnchors[activity.index] ?? []) {
      if (!anchored.some((existing) => sameName(existing, participant))) anchored.push(participant);
    }
  }
  if (chunks.length === 0) return '○ no activity matches this history query';
  if (preview !== undefined && shown.some((activity) => activity.kind === 'say' && (activity.body?.length ?? 0) > preview)) {
    chunks.push(`${commandPrefix(squarePath)} history --at ${shown.map((activity) => formatActivityId(activity.index)).join(',')} --no-truncate`);
  }
  if (anchored.length > 0) chunks.push(renderPresenceAnchor(anchored));
  return chunks.join('\n\n');
}

function historyContinuationCommand(squarePath: string, args: readonly string[]): string {
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
  if (query.grep !== undefined) args.push('--grep', query.grep);
  if (query.fixed !== undefined) args.push('--fixed', query.fixed);
  if (query.order !== undefined) args.push('--order', query.order);
  return args;
}

export function renderHistoryResult(
  squarePath: string,
  data: HistoryResult,
  options: { query?: HistoryQuery; noTruncate?: boolean; continuationArgs?: readonly string[] } = {},
): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const query = options.query ?? {};
  const noTruncate = options.noTruncate === true;
  const pattern = query.grep ?? query.fixed;
  const output = pattern === undefined || pattern === ''
    ? renderHistoryProjection(projection, projection.visibleActivities, noTruncate, squarePath)
    : renderGrepActivitiesView(projection.visibleActivities, projection.totalMatches, noTruncate, squarePath, pattern, query.fixed !== undefined, () => 'full');
  const next = projection.continuation;
  const base = options.continuationArgs ?? historyQueryArgs(query);
  const continuation = next === undefined ? '' : `\n\n${historyContinuationCommand(squarePath, [...base, `--${next.direction}`, next.cursor, '--limit', String(next.limit)])}`;
  return withPathOutput(squarePath, output + continuation, { participantCount: projection.standingCount });
}

function participantsLimitCommand(squarePath: string, limit: number): string {
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
    const glyph = participant.state === 'done' ? '○' : participant.presence === 'watching' ? '◎' : participant.activityCount > 0 && projection.classificationByName[participant.name] === 'here' ? '●' : '○';
    const state = participant.state === 'done' ? 'done' : participant.presence === 'watching' ? 'catching' : participant.state;
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

export function renderStatusResult(squarePath: string, data: StatusResult): string | undefined {
  const presentation = data.observation;
  if (presentation === undefined) return undefined;
  const participantsByName = new Map(data.participants.map((participant) => [participant.name, participant]));
  const orderedHere = presentation.orderedHereNames.map((name) => participantsByName.get(name)!);
  const lingering = presentation.lingeringCount;
  const people: string[] = [];
  if (data.activeCount === 0) {
    people.push('  ○ nobody in the square');
  } else {
    if (orderedHere.length === 0) people.push('  ○ nobody here right now');
    people.push(...orderedHere.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map((participant) => {
      const glyph = participant.presence === 'watching'
        ? '◎'
        : participant.activityCount > 0 ? '●' : '○';
      const summary = participant.presence === 'watching'
        ? 'is nearby · catching'
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
            : 'caught up';
      return `  ${glyph} ${participantIdentity(participant.name)}${style('dim', ` ${summary}${attention === '' ? '' : ` · ${attention}`}`)}`;
    }));
    const unshown = Math.max(0, orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT) + lingering;
    if (orderedHere.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) {
      people.push(`  ○ … ${orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more here`);
    }
    if (lingering > 0) people.push(`  ○ … ${lingering} lingering`);
    if (unshown > 0) {
      people.push(`${presentation.knownParticipantCount <= PARTICIPANTS_MAX_LIMIT
        ? participantsLimitCommand(squarePath, presentation.knownParticipantCount)
        : `${commandPrefix(squarePath)} participants`}`);
    }
  }
  const cap = data.hardCap === null ? 'unlimited' : `${data.hardCap} each`;
  const holdTime = data.hold?.at === undefined ? 'just now' : formatRelativeTime(data.hold.at, data.now);
  const hold = data.hold !== null
    ? `· ${data.hold.by === undefined ? 'someone' : participantIdentity(data.hold.by)} raised a hand${data.hold.reason ? ` — ${data.hold.reason}` : ''}${style('dim', ` · ${holdTime}`)}`
    : undefined;
  const visible = data.latestActivity === undefined
    ? { text: '', bodyClipped: false }
    : renderAmbientEventFacts(data.latestActivity, presentation.viewer, {
        now: data.now,
        preview: 200,
        actNumber: presentation.latestActNumber,
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
    latest.push(style('dim', `  → ${participantIdentity(activity.actor!)} ${rejoined ? 'stepped back in' : 'stepped in'} · ${formatRelativeTime(activity.at, data.now)}`));
  }
  if (presentation.joinCount > 3) latest.push(style('dim', `  → … ${presentation.joinCount - 3} more stepped in`));
  if (visible.bodyClipped && data.latestActivity !== undefined) {
    latest.push(`${commandPrefix(squarePath)} history --at ${data.latestActivity.id} -C 2 --no-truncate`);
  }
  const counts = [
    `${orderedHere.length} here`,
    ...(lingering > 0 ? [`${lingering} lingering`] : []),
    `${data.doneCount} done`,
    `cap ${cap}`,
    `throttle ${data.throttlePerMinute === undefined ? 'none' : `${data.throttlePerMinute}/min`}`,
  ].join(' · ');
  const output = [
    style('dim', counts),
    ...(hold === undefined ? [] : ['', hold]), '', style('dim', 'around the square'), ...people, '', style('dim', 'latest'), ...latest,
  ].join('\n');
  return withPathOutput(squarePath, output, { participantCount: presentation.standingCount, held: presentation.held });
}

export function renderListeningResult(squarePath: string, data: ListeningResult): string | undefined {
  const projection = data.observation;
  if (projection?.participant === undefined) return undefined;
  const body = data.listening.length === 0
    ? `○ ${participantIdentity(projection.participant)} is not turned toward anyone`
    : ['listening', ...data.listening.map((target) => `  · ${participantIdentity(target)}`)].join('\n');
  return withPathOutput(squarePath, body, { participantCount: projection.standingCount, held: projection.held });
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
    participantCount: projection.standingCount, held: projection.held,
  });
}

export type LifecycleVerb = 'hold' | 'resume' | 'done';

export function renderLifecycleResult(squarePath: string, verb: LifecycleVerb, data: LifecycleResult): string | undefined {
  const projection = data.observation;
  if (projection === undefined) return undefined;
  const header = { participantCount: projection.standingCount, held: projection.held };
  if (verb === 'done') {
    return withPathOutput(projection.location ?? squarePath, `○ you stepped out — your footsteps fade · ${data.activity.id}`, header);
  }
  const line = `${renderRoomChangeText(projection.activity as RoomChangeAct)} · ${formatActivityId(projection.activity.index)} · just now`;
  return withPathOutput(projection.location ?? squarePath, verb === 'hold' ? `· ${line}` : `✓ ${line}`, header);
}

/** The refusal facts a transport has after normalizing a failure, without the live error. */
export interface FailureReport {
  readonly code: string;
  readonly message: string;
  readonly facts?: {
    readonly reason?: 'never_joined' | 'not_standing' | 'bell_mention_conflict' | 'not_addressed' | 'migration_required' | 'invalid_reply' | 'invalid_done_body';
    readonly activityId?: string;
    readonly ledgerRoot?: string;
    readonly activityExists?: boolean;
  };
  readonly operation?: OperationFailureDetail;
}

/** Refusal lines with the same recovery commands the CLI prints. */
export function renderFailureLines(failure: FailureReport, options: { squarePath?: string; name?: string } = {}): string[] {
  const { squarePath, name } = options;
  const facts = failure.facts;
  const reason = facts?.reason;
  const marked = reason === 'never_joined' || reason === 'not_standing';
  const lines = marked ? failure.message.split('\n').map((line) => `✕ ${line}`) : [failure.message];
  if (reason === 'migration_required') {
    if (facts?.ledgerRoot !== undefined) lines.push('square ledger migrate', 'square ledger verify');
    else if (squarePath !== undefined) lines.push(`${commandPrefix(squarePath)} migrate`);
  } else if (squarePath !== undefined && name !== undefined && failure.code === 'already_joined') {
    lines.splice(0, 1, `✕ ${participantIdentity(name)} shoos you out of the square`,
      `  · ${participantIdentity(name)} already stands here — another session holds the name`);
    lines.push(...takeoverRecoveryLines(squarePath, name));
  } else if (squarePath !== undefined && reason === 'never_joined') {
    lines.push(failure.operation?.subject !== 'filter' && name !== undefined
      ? joinRecoveryCommand(squarePath, name) : participantsRecoveryCommand(squarePath));
  } else if (squarePath !== undefined && reason === 'not_standing') {
    lines.push(participantsRecoveryCommand(squarePath));
  } else if (squarePath !== undefined && reason === 'not_addressed' && facts?.activityId !== undefined) {
    lines.push(facts.activityExists === true
      ? `${commandPrefix(squarePath)} history --at ${facts.activityId} -C 2`
      : `${commandPrefix(squarePath)} history --limit 10`);
  }
  if (reason === 'invalid_done_body') lines.push('square done --help');
  return lines;
}
