import { extractMentions, formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { deliveryDelta, directedPeerSays } from './activity-feed.js';
import { coreActivities, coreParticipants, coreStatus, resolveKnownName } from './decisions.js';
import { deriveDeliveryModel, isActivitySeen, type DeliveryModel, type PlannedNotification } from './delivery.js';
import { SquareError, nameKey, type ActivitiesOptions, type ActivityObservation, type InboxNotification, type PublicAct, type RoomChangeAct, type SquareState, type StoredAct } from './model.js';
import type { OpenSquare } from './open-square.js';
import { countSays, currentHold, foldedState, freshWatchLease, inSquareCount, isCurrentlyJoined, resolveRosterName, rosterNames, watchTerminalStatus } from './runtime.js';
import type { Activity, HistoryQuery, ParticipantStatus, PerceivedActivity, SquareSnapshot } from './square-facade.js';

export interface ActivityPresentation { readonly name: string; readonly roster: readonly string[]; readonly pendingPublic: readonly PublicAct[]; readonly pendingRoomChanges: readonly RoomChangeAct[]; readonly activities: readonly StoredAct[]; readonly state: SquareState; readonly participantCount: number; readonly held: boolean; readonly holdReason?: string; readonly ownActivityCount: number; readonly hardCap: number | null; }
export interface EntryPresentation { readonly joined: boolean; readonly scene: string; readonly context: string; readonly joinContext: string; readonly recentActivities: readonly StoredAct[]; readonly state: SquareState; readonly sayNumbers: Readonly<Record<number, number>>; readonly participantCount: number; }
export interface HistoryPresentation { readonly activities: readonly (StoredAct & { readonly perception: 'full' | 'presence' })[]; readonly sayNumbers: Readonly<Record<number, number>>; readonly presenceAnchors: Readonly<Record<number, readonly string[]>>; readonly participantCount: number; }
export interface ListPresentation { readonly context: readonly string[]; readonly participants: readonly string[]; readonly activities: number; }
export interface StatusPresentation { readonly state: SquareState; readonly status: ReturnType<typeof coreStatus>; readonly latestActNumber?: number; }
export interface WatchPresentation { readonly activities: readonly StoredAct[]; readonly state: SquareState; readonly participantCount: number; readonly presence: { readonly participants: ReturnType<typeof coreParticipants>; readonly now: number }; readonly terminalStatus?: 'capped' | 'quorum'; }
export interface InboxProjection { readonly name: string; readonly joined: boolean; readonly notifications: readonly InboxNotification[]; readonly catchLease?: import('./model.js').WatchLease; }
export interface StreamProjection { readonly activities: readonly { readonly activity: StoredAct; readonly route?: string }[]; readonly cursor: number; }
export interface PendingDeliveryProjection { readonly recipient: string; readonly notifications: readonly PlannedNotification[]; }

function expose(stored: StoredAct): Activity {
  if (stored.kind === 'read' || stored.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  return { id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor, ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}), mentions: stored.kind === 'say' ? extractMentions(stored.body) : [], ...('target' in stored ? { target: stored.target } : {}), ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}) };
}

function exposePerceived(stored: StoredAct, viewer: string, delivery: DeliveryModel): PerceivedActivity {
  const perception = delivery.perceive(stored, viewer);
  const activity = expose(stored);
  if (perception === 'full' || activity.body === undefined) return { ...activity, perception };
  const { body: _body, ...withoutBody } = activity;
  return { ...withoutBody, perception };
}

function parseRequiredActivityId(id: ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

function historyOptions(query: HistoryQuery, viewer?: string): ActivitiesOptions {
  return { ...(query.from === undefined ? {} : { participants: [...query.from] }), ...(query.grep === undefined ? {} : { grep: query.grep }), ...(query.mention === true && viewer !== undefined ? { mention: viewer } : {}), order: 'asc' };
}

function selectHistory(stored: StoredAct[], query: HistoryQuery): StoredAct[] {
  let selected = stored.filter((activity) => activity.kind !== 'read');
  if (query.all !== true && query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) throw new SquareError('invalid_args', 'History limit must be a positive integer');
    selected = selected.slice(-query.limit);
  }
  return query.order === 'desc' ? selected.reverse() : selected;
}

function statuses(square: OpenSquare, state: Parameters<typeof coreStatus>[0]): ParticipantStatus[] {
  const delivery = deriveDeliveryModel(state);
  return coreStatus(state, square.clock(), delivery).participants.filter((participant) => participant.state !== 'not joined').map((participant) => {
    const cursor = delivery.cursorFor(participant.name);
    return { name: participant.name, state: participant.state === 'done' ? 'done' : 'joined', consumedThrough: cursor < 0 ? null : formatActivityId(cursor), watching: participant.presence === 'watching', listening: participant.listening };
  });
}

function anchors(state: Parameters<typeof coreStatus>[0], delivery: DeliveryModel): Record<number, string[]> {
  const result: Record<number, string[]> = {};
  for (const name of delivery.participants()) {
    const activity = state.acts.findLast((candidate) => candidate.index <= delivery.cursorFor(name) && (candidate.kind === 'say' || candidate.kind === 'done'));
    if (activity !== undefined) result[activity.index] = [...(result[activity.index] ?? []), name];
  }
  return result;
}

function sayNumbers(state: Parameters<typeof coreStatus>[0]): Record<number, number> {
  const counts = new Map<string, number>(); const result: Record<number, number> = {};
  for (const activity of state.acts) if (activity.kind === 'say') { const next = (counts.get(nameKey(activity.actor)) ?? 0) + 1; counts.set(nameKey(activity.actor), next); result[activity.index] = next; }
  return result;
}

export async function history(square: OpenSquare, query: HistoryQuery = {}): Promise<Activity[]> { const { state } = await square.artifact.read(); return selectHistory(coreActivities(state, historyOptions(query)), query).map(expose); }
export async function participantHistory(square: OpenSquare, name: string, query: HistoryQuery = {}): Promise<PerceivedActivity[]> { const { state } = await square.artifact.read(); const viewer = resolveKnownName(state, name); const delivery = deriveDeliveryModel(state); const effective = query.all === true || query.limit !== undefined ? query : { ...query, limit: 10 }; return selectHistory(coreActivities(state, historyOptions(effective, viewer), delivery), effective).map((activity) => exposePerceived(activity, viewer, delivery)); }
export async function resolveParticipant(square: OpenSquare, name: string): Promise<{ readonly name: string; readonly roster: readonly string[] }> { const { state } = await square.artifact.read(); return { name: resolveKnownName(state, name), roster: rosterNames(state) }; }
export async function currentParticipant(square: OpenSquare, name: string): Promise<string | undefined> { const { state } = await square.artifact.read(); const known = resolveRosterName(state, name); return known !== undefined && isCurrentlyJoined(state.acts, known) ? known : undefined; }
export async function participants(square: OpenSquare): Promise<ParticipantStatus[]> { const { state } = await square.artifact.read(); return statuses(square, state); }
export async function snapshot(square: OpenSquare): Promise<SquareSnapshot> { const { state } = await square.artifact.read(); const folded = foldedState(state); return { context: [...state.preamble, ...state.warmup].join('\n'), actCount: state.acts.filter((activity) => activity.kind !== 'read').length, hardCap: state.hardCap, ...(state.throttlePerMinute === undefined ? {} : { throttlePerMinute: state.throttlePerMinute }), held: folded.hold.active && folded.hold.actor !== undefined ? { by: folded.hold.actor, ...(folded.hold.reason === undefined ? {} : { reason: folded.hold.reason }) } : null, participants: statuses(square, state), delivered(name, id) { return isActivitySeen(state, name, parseRequiredActivityId(id)); } }; }
export async function activityPresentation(square: OpenSquare, name: string): Promise<ActivityPresentation> { const { state } = await square.artifact.read(); const known = resolveKnownName(state, name); const delivery = deriveDeliveryModel(state); const delta = deliveryDelta(state, known, delivery); const hold = currentHold(state.acts); return { name: known, roster: rosterNames(state), pendingPublic: directedPeerSays(state, delta, known, delivery), pendingRoomChanges: [], activities: state.acts, state, participantCount: inSquareCount(state), held: hold.active, ...(hold.reason === undefined ? {} : { holdReason: hold.reason }), ownActivityCount: countSays(state.acts, known), hardCap: state.hardCap }; }
export async function entryPresentation(square: OpenSquare, name: string, lastN: number | null = 10): Promise<EntryPresentation> { const { state } = await square.artifact.read(); const known = resolveRosterName(state, name) ?? name; const publicActivities = state.acts.filter((activity) => activity.kind === 'say' || activity.kind === 'done'); return { joined: isCurrentlyJoined(state.acts, known), scene: state.warmup.join('\n').trim(), context: state.preamble.join('\n').trim(), joinContext: (state.preamble.at(-1) === '---' ? state.preamble.slice(0, -1) : state.preamble).join('\n').trim(), recentActivities: lastN === null ? publicActivities : publicActivities.slice(-lastN), state, sayNumbers: sayNumbers(state), participantCount: inSquareCount(state) }; }
export async function historyPresentation(square: OpenSquare, options: ActivitiesOptions): Promise<HistoryPresentation> { const { state } = await square.artifact.read(); const delivery = deriveDeliveryModel(state); return { activities: coreActivities(state, options, delivery).map((activity) => ({ ...activity, perception: options.viewer === undefined ? 'full' as const : delivery.perceive(activity, options.viewer) })), sayNumbers: sayNumbers(state), presenceAnchors: anchors(state, delivery), participantCount: inSquareCount(state) }; }
export async function participantsPresentation(square: OpenSquare): Promise<ReturnType<typeof coreParticipants>> { const { state } = await square.artifact.read(); const delivery = deriveDeliveryModel(state); return coreParticipants(state, square.clock(), delivery); }
export async function listPresentation(square: OpenSquare): Promise<ListPresentation> { const { state } = await square.artifact.read(); return { context: state.preamble, participants: foldedState(state).participants.filter((participant) => participant.joined).sort((left, right) => (right.lastActiveAt ?? -Infinity) - (left.lastActiveAt ?? -Infinity) || left.name.localeCompare(right.name)).map((participant) => participant.name), activities: state.acts.filter((activity) => activity.kind === 'say').length }; }
export async function statusPresentation(square: OpenSquare): Promise<StatusPresentation> { const { state } = await square.artifact.read(); const delivery = deriveDeliveryModel(state); const status = coreStatus(state, square.clock(), delivery); return { state, status, ...(status.latestAct?.kind === 'say' ? { latestActNumber: countSays(state.acts, status.latestAct.actor) } : {}) }; }
export async function eventPresentation(square: OpenSquare, id: ActivityId): Promise<{ readonly activity: StoredAct; readonly participantCount: number; readonly held: boolean }> { const { state } = await square.artifact.read(); const activity = state.acts.find((candidate) => candidate.index === parseRequiredActivityId(id)); if (activity === undefined) throw new SquareError('invalid_args', `Unknown activity id: ${id}`); return { activity, participantCount: inSquareCount(state), held: currentHold(state.acts).active }; }
export async function watchPresentation(square: OpenSquare, name: string): Promise<WatchPresentation> { const { state } = await square.artifact.read(); const known = resolveKnownName(state, name); const now = square.clock(); const terminal = watchTerminalStatus(state, known); const delivery = deriveDeliveryModel(state); return { activities: state.acts, state, participantCount: inSquareCount(state), presence: { participants: coreParticipants(state, now, delivery), now }, ...(terminal === undefined ? {} : { terminalStatus: terminal }) }; }
export async function inboxProjection(square: OpenSquare, name: string, _sessionId?: string): Promise<InboxProjection> { const { state } = await square.artifact.read(); const delivery = deriveDeliveryModel(state); const known = delivery.knownParticipant(name); if (known === undefined || !delivery.joinedRecipients().some((recipient) => nameKey(recipient) === nameKey(known))) return { name, joined: false, notifications: [] }; const lease = freshWatchLease(state, known, square.clock()); return { name: known, joined: true, notifications: delivery.pendingFor(known).map(({ item, route }) => ({ actIndex: item.index, actor: item.actor, at: item.at, route, body: item.body })), ...(lease === undefined ? {} : { catchLease: lease }) }; }
export async function streamProjection(square: OpenSquare | { readonly cell: { read(): Promise<{ state: SquareState }> } }, cursor: number, recipient?: string): Promise<StreamProjection> { const artifact = 'artifact' in square ? square.artifact : square.cell; const { state } = await artifact.read(); const delivery = recipient === undefined ? undefined : deriveDeliveryModel(state); return { activities: state.acts.filter((activity) => activity.index > cursor).flatMap((activity) => { if (delivery === undefined || recipient === undefined) return [{ activity }]; const notification = delivery.plan(activity).find((candidate) => nameKey(candidate.recipient) === nameKey(recipient)); return notification === undefined ? [] : [{ activity, route: notification.route }]; }), cursor: Math.max(cursor, ...state.acts.map((activity) => activity.index)) }; }
export async function notificationForAct(square: OpenSquare, actIndex: number): Promise<readonly PlannedNotification[]> { const { state } = await square.artifact.read(); const activity = state.acts.find((candidate) => candidate.index === actIndex); return activity === undefined ? [] : deriveDeliveryModel(state).plan(activity); }
export function pendingDeliveriesFromState(state: SquareState, delivery = deriveDeliveryModel(state)): readonly PendingDeliveryProjection[] { return delivery.joinedRecipients().map((recipient) => ({ recipient, notifications: delivery.pendingFor(recipient) })); }
export async function pendingDeliveries(square: OpenSquare): Promise<readonly PendingDeliveryProjection[]> { const { state } = await square.artifact.read(); return pendingDeliveriesFromState(state); }
export async function notificationEvidence(square: OpenSquare, recipient: string, actIndex: number): Promise<{ readonly delivered: boolean; readonly observation: ActivityObservation | undefined }> { const { state } = await square.artifact.read(); const delivery = deriveDeliveryModel(state); const known = delivery.knownParticipant(recipient) ?? recipient; return { delivered: delivery.isSeen(known, actIndex), observation: state.runtime.observations?.[known]?.[formatActivityId(actIndex)] }; }
export async function notificationDelivered(square: OpenSquare, recipient: string, actIndex: number): Promise<boolean> { const { state } = await square.artifact.read(); return deriveDeliveryModel(state).isSeen(recipient, actIndex); }
