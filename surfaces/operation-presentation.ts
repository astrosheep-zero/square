// Human-facing scenes for settled operations, with surface-specific next actions.
import { sameName } from '../core/model.js';
import { truncateChars } from '../core/neutral.js';
import { participantIdentity } from '../core/square-values.js';
import type {
  ExpressResult,
  JoinResult, LifecycleResult, ListenerChangeResult, OperationFailureDetail, SquareErrorFacts,
  StatusResult, DiscoveryResult, MuteResult,
} from '../api/types.js';
import {
  type PresentationSurface, spellAction, spellField, renderAmbientEventFacts,
  renderUnreadSummary, withPathOutput,
} from './presentation.js';
import { formatDuration, formatRelativeTime, formatTimestamp } from '../core/time.js';
import { style } from './tty-style.js';
import type { AttentionInput, OperationBinding } from './operations.js';
import { renderHistoryResult } from './history-presentation.js';
import { renderPerceiveOutcome, renderWatchForceTakeover, renderWatchReplaceMissing } from './perceive-presentation.js';

function listDisplay(value: string): string {
  const truncated = truncateChars(value, 159);
  return truncated.remaining === 0 ? truncated.text : `${truncated.text}…`;
}

export function renderSquareList(data: DiscoveryResult, projection: { now: number; depth: number; limit: number; surface?: PresentationSurface }): string {
  const { items, stopped, remaining, next } = data;
  if (data.total === 0) {
    return ['(no squares found)',
      ...(data.ledgerMutedUntil === undefined ? [] : [style('dim', `  · notifications paused until ${formatTimestamp(data.ledgerMutedUntil)}`)]),
      ...(stopped ? [style('dim', '○ the walk stopped early — deeper squares may still be hiding')] : [])].join('\n') + '\n';
  }
  const lines = ['squares'];
  if (data.ledgerMutedUntil !== undefined)
    lines.push(style('dim', `  · notifications paused until ${formatTimestamp(data.ledgerMutedUntil)}`));
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
    if (item.joined?.length) lines.push(`  ${style('dim', 'joined')} · ${item.joined.map(seat => {
      const state = [seat.pending > 0 ? `${seat.pending} waiting` : undefined,
        seat.mutedUntil === undefined ? undefined : `muted until ${formatTimestamp(seat.mutedUntil)}`].filter(Boolean).join(' · ');
      return `${participantIdentity(listDisplay(seat.name))}${state === '' ? '' : style('dim', ` (${state})`)}`;
    }).join(' · ')}`);
  }
  if (remaining > 0) {
    lines.push(style('dim', stopped ? '  … more squares' : `  … ${remaining} more ${remaining === 1 ? 'square' : 'squares'}`));
    if (next !== undefined) lines.push(spellAction({ operation: 'list', args: { depth: projection.depth, limit: projection.limit, after: next } }, projection.surface));
  }
  if (stopped) lines.push(style('dim', '○ the walk stopped early — deeper squares may still be hiding'));
  return lines.join('\n') + '\n';
}

const STATUS_PARTICIPANT_PREVIEW_LIMIT = 10;

/** A join receipt, rendered from the observer's own participant name. */
export function renderJoinResult(data: JoinResult, owner?: string, surface: PresentationSurface = 'cli'): string | undefined {
  const after = data.observation;
  if (after === undefined) return undefined;
  const entry = after.entry;
  const name = data.participant.name;
  const activities = (entry?.recentActivities ?? []).map((event) => renderAmbientEventFacts(event, {
    now: after.now, preview: 200, perception: event.perception,
  }).text).filter(Boolean).join('\n\n');
  const fallback = after.deliveryAvailable ? ['', '· when someone calls you, you’ll hear them here'] : [
    '', spellAction({ operation: 'perceive', owner, args: { location: after.location, as: name, wait: '30m' } }, surface),
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
    spellAction({ operation: 'perceive', owner, args: { location: projection.location, as: name } }, surface),
  ].join('\n');
  const ownCount = projection.ownActivityCount;
  const capCount = projection.hardCap === null ? '' : ` · ${ownCount}/${projection.hardCap}`;
  const activity = data.activity;
  const confirmation = `● ${activity.mentions.length > 0
    ? `you walk over to ${activity.mentions.map((target) => participantIdentity(target)).join(', ')}`
    : activity.metadata !== undefined && (activity.body ?? '').trim() === '' ? 'structured activity lands' : isGestureOnly(activity.body ?? '') ? 'your gesture lands' : 'your words land'} — ${activity.id}${style('dim', capCount)}`;
  const notReached = [...(data.unmatchedMentions ?? []), ...(data.replyAuthorNotHere === undefined ? [] : [data.replyAuthorNotHere])]
    .filter((name, index, names) => names.findIndex((other) => sameName(name, other)) === index);
  const reachNotice = notReached.map(name => `\n⚠ ${participantIdentity(name)} is not in this square.`).join('');
  const awayNotice = (data.awayRecipients ?? []).map(name => `\n⚠ ${participantIdentity(name)} is away.`).join('');
  return withPathOutput(projection.location ?? squarePath,
    confirmation + (data.hint ? `\n${style('dim', `· ${data.hint}`)}` : '') + reachNotice + awayNotice + pending,
    { participantCount: projection.standingCount });
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
      const muted = participant.mutedUntil === undefined ? '' : ` · muted until ${formatTimestamp(participant.mutedUntil)}`;
      return `  ${glyph} ${participantIdentity(participant.name)}${style('dim', ` ${summary}${muted}${attention === '' ? '' : ` · ${attention}`}`)}`;
    }));
    people.push(...away.slice(0, STATUS_PARTICIPANT_PREVIEW_LIMIT).map(participant => `  ○ ${participantIdentity(participant.name)}${style('dim', ' · away')}`));
    if (away.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) people.push(`  ○ … ${away.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more away`);
    if (orderedHere.length > STATUS_PARTICIPANT_PREVIEW_LIMIT) {
      people.push(`  ○ … ${orderedHere.length - STATUS_PARTICIPANT_PREVIEW_LIMIT} more here`);
    }
    if (lingering > 0) people.push(`  ○ … ${lingering} lingering`);
  }
  const cap = data.hardCap === null ? 'unlimited' : `${data.hardCap} each`;
  const visible = data.latestActivity === undefined
    ? { text: '', bodyClipped: false }
    : renderAmbientEventFacts(data.latestActivity, {
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
    latest.push(spellAction({ operation: 'history', args: { location: squarePath, ids: [data.latestActivity.id], context: 2, maxChars: [...(data.latestActivity.body ?? '')].length } }, options.surface));
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
    ...(data.ledgerMutedUntil === undefined ? [] : [style('dim', `  · notifications paused until ${formatTimestamp(data.ledgerMutedUntil)}`)]),
    '', style('dim', 'around the square'), ...people, '', style('dim', 'latest'), ...latest,
    ...(data.listening === undefined ? [] : [
      '', style('dim', 'you listen to'),
      ...(data.listening.length === 0 ? ['  ○ not turned toward anyone'] : data.listening.map((name) => `  · ${participantIdentity(name)}`)),
    ]),
  ].join('\n');
  return withPathOutput(squarePath, output, { participantCount: presentation.standingCount });
}

export function renderListenerChange(squarePath: string, state: AttentionInput['state'], data: ListenerChangeResult): string | undefined {
  const projection = data.observation;
  if (projection?.participant === undefined) return undefined;
  const actor = participantIdentity(projection.participant);
  const target = participantIdentity(projection.target);
  const action = data.activity !== null
    ? state === 'listen' ? `${actor} turns an ear toward ${target}`
      : state === 'ignore' ? `${actor} turns away from ${target}`
        : `${actor} returns to direct mentions and replies from ${target}`
    : state === 'listen' ? `${actor} already turns an ear toward ${target}`
      : state === 'ignore' ? `${actor} already ignores ${target}`
        : `${actor} already hears only direct attention from ${target}`;
  return withPathOutput(squarePath, `${data.activity === null ? '○' : '·'} ${action}`, {
    participantCount: projection.standingCount,
  });
}

export function renderMuteResult(squarePath: string | undefined, data: MuteResult): string {
  const name = data.observation?.participant;
  const until = data.mutedUntil === null ? '' : ` until ${formatTimestamp(data.mutedUntil)}`;
  const line = data.mutedUntil !== null
    ? name === undefined ? `○ notifications pause${until}` : `○ ${participantIdentity(name)} steps back from notifications${until}`
    : name === undefined ? '● the notification hold ends' : `● ${participantIdentity(name)} ends their notification hold`;
  return squarePath === undefined ? `${line}\n`
    : withPathOutput(squarePath, line, { participantCount: data.observation?.standingCount });
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
  readonly facts?: SquareErrorFacts;
  readonly operation?: OperationFailureDetail;
}

interface FailureOptions {
  readonly squarePath?: string;
  readonly name?: string;
  readonly owner?: string;
  readonly surface?: PresentationSurface;
  readonly reply?: string;
  /** CLI only: the saved draft and the full command that resends it. */
  readonly draftPath?: string;
  readonly retry?: string;
}

/** Express gates are physics, not mistakes: one scene for every surface, then that surface's next action. */
export function isExpressGate(code: string): boolean {
  return code === 'behind' || code === 'capped' || code === 'throttled';
}

function expressGateLines(failure: FailureReport, options: FailureOptions): string[] | undefined {
  if (!isExpressGate(failure.code)) return undefined;
  const { squarePath, name, owner } = options;
  const facts = failure.facts;
  const tool = options.surface === 'tool';
  const scene = failure.code === 'behind'
    ? ['✕ your words stay unsent — someone spoke while you were away', ...renderUnreadSummary(facts?.activitySummaries ?? [])]
    : failure.code === 'capped'
      ? [`✕ you’ve reached your speaking cap${facts?.spoken !== undefined && facts.hardCap !== undefined ? ` — ${facts.spoken}/${facts.hardCap} spoken` : ''}`]
      : ['✕ the square is packed — shoulder to shoulder', `  · a lull opens in ${formatDuration(facts?.retryAfterMs ?? 1)}`];
  const lines = [...scene, ...(options.draftPath === undefined ? [] : [style('dim', `· draft kept: ${options.draftPath}`)])];
  if (squarePath === undefined || name === undefined) return lines;
  const action = (operation: 'perceive' | 'done') => spellAction({ operation, owner, args: { location: squarePath, as: name } }, options.surface);
  if (failure.code === 'behind') lines.push(...(tool ? ['Take it in, then express again:', action('perceive')] : [action('perceive'), '  · take it in, then retry:']));
  if (failure.code === 'capped') lines.push('  · your words stay unsent; done only steps out', action('done'));
  if (failure.code !== 'capped' && options.retry !== undefined) lines.push(options.retry);
  return lines;
}

/** Refusal lines with surface-specific recovery actions. */
export function renderFailureLines(failure: FailureReport, options: FailureOptions = {}): string[] {
  const { squarePath, name, owner } = options;
  const facts = failure.facts;
  const reason = facts?.reason;
  const gate = expressGateLines(failure, options);
  if (gate !== undefined) return gate;
  const marked = reason === 'never_joined' || reason === 'not_standing';
  const lines = marked ? failure.message.split('\n').map((line) => `✕ ${line}`) : [failure.message];
  const { surface } = options;
  const join = (takeover?: true) => spellAction({ operation: 'join', owner, args: { location: squarePath, as: name, takeover } }, surface);
  const status = () => spellAction({ operation: 'status', args: { location: squarePath } }, surface);
  const history = () => spellAction({ operation: 'history', args: { location: squarePath, limit: 10 } }, surface);
  if (reason === 'invalid_reply') {
    lines[0] = `Invalid ${spellField('express', 'reply', surface)}: ${facts?.activityExists === false ? `${facts.activityId ?? options.reply ?? 'that activity'} is not in this square's history` : 'expected an activity id like act/12'}`;
    if (squarePath !== undefined) lines.push(history());
  } else if (reason === 'needs_seat' && squarePath !== undefined && name !== undefined) {
    lines.splice(0, 1, `✕ ${failure.message}`);
    lines.push(join());
  } else if (squarePath !== undefined && name !== undefined && failure.code === 'already_joined') {
    lines.splice(0, 1, `✕ ${participantIdentity(name)} shoos you out of the square`,
      `  · ${participantIdentity(name)} already stands here — another session holds the name`);
    lines.push(`If this is your name to reclaim, ${spellField('join', 'takeover', surface)} banishes the one standing here so you can step in:`, join(true));
  } else if (squarePath !== undefined && name !== undefined && (failure.code === 'unknown_participant' || failure.code === 'not_joined') && reason !== 'not_standing') {
    lines.push(join());
  } else if (squarePath !== undefined && reason === 'never_joined') {
    lines.push(failure.operation?.subject !== 'filter' && name !== undefined ? join() : status());
  } else if (squarePath !== undefined && reason === 'not_standing') {
    lines.push(status());

  }
  if (reason === 'invalid_done_body') {
    const help = spellAction({ operation: 'done', help: true }, surface);
    if (help !== '') lines.push(help);
  }
  return lines;
}

export const operationText: OperationBinding['text'] = {
  list: renderSquareList, join: renderJoinResult, express: renderExpression, perceive: renderPerceiveOutcome,
  history: renderHistoryResult, attention: renderListenerChange, done: renderLifecycleResult, status: renderStatusResult,
  mute: renderMuteResult,
  perceiveProgress: replaced => replaced ? renderWatchForceTakeover() : renderWatchReplaceMissing(),
  perceiveStopped: location => withPathOutput(location, '○ you step back — perceive stopped'),
};
