import {
  InternalSquareError,
  SquareError,
  type ActivitiesOptions,
  type Act,
  type StoredAct,
  type SquareState,
  type Reach,
  type HardCap,
  sameName,
  validateName,
} from './model.js';
import {
  UNREAD_BLOCK_GRACE_MS,
  actId,
  actStableIndex,
  foldedState,
  freshWatchLease,
  getReadState,
  publicActs,
  readCursor,
  resolveRosterName,
  rosterNames,
  matchesMentionTarget,
  THROTTLE_WINDOW_MS,
} from './runtime.js';
import { actDelta, peerPublicActs, peerRoomChanges } from './activity-feed.js';
import { extractMentions, formatActivityId, validate, type FoldedSquareState } from './square-core.js';
import { deriveDeliveryModel } from './delivery.js';
import { compileSearchPattern } from './search.js';

export interface UnreadActivitySummary {
  name: string;
  count: number;
  latestActivityAgeMs: number;
  previews: UnreadActivityPreview[];
}

export interface UnreadActivityPreview {
  number: number;
  act: Extract<StoredAct, { kind: 'say' }>;
}

export function resolveKnownName(squareState: SquareState, name: string): string {
  validateName(name);
  const known = resolveRosterName(squareState, name);
  if (known === undefined) {
    const roster = rosterNames(squareState);
    throw new SquareError('invalid_args', `Unknown participant "${name}". Expected one of: ${roster.join(', ')}.`);
  }
  return known;
}

function participantState(state: FoldedSquareState, name: string): FoldedSquareState['participants'][number] | undefined {
  return state.participants.find((participant) => sameName(participant.name, name));
}

export interface DecideJoinResult {
  joinedName: string;
  addParticipant: boolean;
  joinAct?: Extract<Act, { kind: 'join' }>;
}

export function decideJoin(squareState: SquareState, name: string, now: number): DecideJoinResult {
  validateName(name);
  const knownName = resolveRosterName(squareState, name);
  const joinedName = knownName ?? name;
  const state = foldedState(squareState);
  const result = validate(state, { kind: 'join', actor: joinedName, at: now });
  if (!result.ok && result.reason === 'already_joined') {
    return { joinedName, addParticipant: false };
  }
  return {
    joinedName,
    addParticipant: knownName === undefined,
    joinAct: { kind: 'join', actor: joinedName, at: now },
  };
}

function resolveStandingName(squareState: SquareState, requestedName: string): string {
  validateName(requestedName);
  const name = resolveRosterName(squareState, requestedName);
  if (name === undefined) throw new SquareError('not_joined', `${requestedName} has not joined this square`);
  return name;
}

function requireStanding(squareState: SquareState, act: Act): void {
  const result = validate(foldedState(squareState), act);
  if (result.ok) return;
  if (result.reason === 'done') throw new SquareError('already_done', `${act.actor ?? 'participant'} is already done`);
  if (result.reason === 'not_joined') throw new SquareError('not_joined', `${act.actor ?? 'participant'} has not joined this square`);
  throw new Error(`Unexpected standing validation result: ${result.reason}`);
}

export type ActDecision =
  | {
      type: 'sent';
      act: Act;
      confirmation: string;
      ownActCount: number;
      pendingPublic: ReturnType<typeof peerPublicActs>;
      pendingRoomChanges: ReturnType<typeof peerRoomChanges>;
    }
  | { type: 'blocked'; activitySummaries: UnreadActivitySummary[]; unreadRoomChanges: ReturnType<typeof peerRoomChanges> }
  | { type: 'capped'; count: number; hardCap: number }
  | { type: 'throttled'; delayMs: number }
  | { type: 'held'; reason: string | undefined }
  | { type: 'bell_quota'; nextAt: number };

const UNREAD_PREVIEW_LIMIT = 3;

export function decideAct(
  squareState: SquareState,
  input: { name: string; body: string; force: boolean; now: number; reach?: Reach; reply?: number }
): ActDecision {
  const { now, force } = input;
  const name = resolveStandingName(squareState, input.name);
  const body = input.body;
  if (body.trim() === '') throw new SquareError('invalid_args', 'express body cannot be empty');
  const reach = input.reach;
  const reply = input.reply;
  if (reply !== undefined) {
    if (!Number.isSafeInteger(reply) || reply < 0 || reply >= squareState.runtime.nextActIndex) {
      const label = Number.isSafeInteger(reply) && reply >= 0 ? formatActivityId(reply) : String(reply);
      throw new SquareError('invalid_args', `Unknown reply activity: ${label}`);
    }
  }

  const state = foldedState(squareState);
  if (
    reach !== 'bell'
    && extractMentions(body).length === 0
  ) {
    throw new SquareError(
      'invalid_args',
      'express requires an @mention unless using --bell'
    );
  }
  const current = participantState(state, name);
  const result = validate(
    state,
    {
      kind: 'say', actor: name, at: now, body,
      ...(reach !== undefined ? { reach } : {}),
      ...(reply !== undefined ? { reply } : {}),
    },
    { hardCap: squareState.hardCap, throttlePerMinute: squareState.throttlePerMinute, throttleWindowMs: THROTTLE_WINDOW_MS }
  );
  if (!result.ok) {
    if (result.reason === 'done') throw new SquareError('already_done', `${name} is already done`);
    if (result.reason === 'held') return { type: 'held', reason: result.hold.reason };
    if (result.reason === 'hard_cap') return { type: 'capped', count: result.count, hardCap: result.hardCap };
    if (result.reason === 'throttled') return { type: 'throttled', delayMs: result.delayMs };
    if (result.reason === 'bell_quota') return { type: 'bell_quota', nextAt: result.nextAt };
    if (result.reason === 'not_joined') throw new SquareError('not_joined', `${name} has not joined this square`);
  }

  const delta = actDelta(squareState.acts, readCursor(squareState, name));
  const unreadPublic = peerPublicActs(delta, name);
  const unreadRoomChanges = peerRoomChanges(delta, name);

  const sayCountByActor = new Map<string, number>();
  const unreadByParticipant = new Map<string, { count: number; latestAt: number; previews: UnreadActivityPreview[] }>();
  for (const item of delta) {
    if (item.kind === 'say') {
      const key = item.actor.toLocaleLowerCase();
      sayCountByActor.set(key, (sayCountByActor.get(key) ?? 0) + 1);
    }
    if (item.kind !== 'say' || sameName(item.actor, name)) continue;
    const actorKey = item.actor.toLocaleLowerCase();
    const currentSummary = unreadByParticipant.get(item.actor);
    unreadByParticipant.set(item.actor, {
      count: (currentSummary?.count ?? 0) + 1,
      latestAt: currentSummary === undefined ? item.at : Math.max(currentSummary.latestAt, item.at),
      previews: [
        ...(currentSummary?.previews ?? []),
        { number: sayCountByActor.get(actorKey) ?? 1, act: item },
      ].slice(-UNREAD_PREVIEW_LIMIT),
    });
  }

  const activitySummaries = [...unreadByParticipant.entries()]
    .map(([participant, summary]) => ({
      name: participant,
      count: summary.count,
      latestActivityAgeMs: Math.max(0, now - summary.latestAt),
      previews: summary.previews,
    }))
    .sort((a, b) => a.latestActivityAgeMs - b.latestActivityAgeMs || a.name.localeCompare(b.name));

  const latestActivityAgeMs = activitySummaries[0]?.latestActivityAgeMs;
  const hasUnreadBlockingChange = unreadRoomChanges.some((act) => act.kind !== 'join');
  const hasUnread = unreadPublic.length > 0 || hasUnreadBlockingChange;
  const hasFreshUnreadActivity = latestActivityAgeMs !== undefined && latestActivityAgeMs <= UNREAD_BLOCK_GRACE_MS;

  if (!force && hasUnread && !hasFreshUnreadActivity) {
    return { type: 'blocked', activitySummaries, unreadRoomChanges };
  }

  const ownActCount = (current?.activityCount ?? 0) + 1;
  return {
    type: 'sent',
    act: {
      kind: 'say', actor: name, at: now, body,
      ...(reach !== undefined ? { reach } : {}),
      ...(reply !== undefined ? { reply } : {}),
    },
    confirmation: `● heads turn your way — #${ownActCount}`,
    ownActCount,
    pendingPublic: unreadPublic,
    pendingRoomChanges: unreadRoomChanges,
  };
}

export function coreDone(squareState: SquareState, name: string, body: string, now: number): Extract<Act, { kind: 'done' }> {
  const resolvedName = resolveStandingName(squareState, name);
  const act = { kind: 'done' as const, actor: resolvedName, at: now, body: body.replace(/\r\n/g, '\n').trim() };
  requireStanding(squareState, act);
  return act;
}

export function coreHold(squareState: SquareState, actor: string, body: string, now: number): Extract<Act, { kind: 'hold' }> {
  const resolvedName = resolveStandingName(squareState, actor);
  const act = { kind: 'hold' as const, actor: resolvedName, at: now, body: body.replace(/\r\n/g, '\n').trim() };
  requireStanding(squareState, act);
  return act;
}

export function coreResume(squareState: SquareState, actor: string, now: number): Extract<Act, { kind: 'resume' }> {
  const resolvedName = resolveStandingName(squareState, actor);
  const act = { kind: 'resume' as const, actor: resolvedName, at: now };
  requireStanding(squareState, act);
  return act;
}

export interface ParticipantStatus {
  name: string;
  state: 'active' | 'done' | 'not joined';
  activityCount: number;
  lastActiveAt: number | undefined;
  presence: CorePresenceState;
  presenceAt: number | undefined;
  unreadActivityCount: number;
  pendingMentionCount: number;
}

export type CorePresenceState = 'never-joined' | 'active' | 'watching' | 'done';

function presenceFor(squareState: SquareState, snapshot: FoldedSquareState['participants'][number] | undefined, name: string, now: number): {
  state: CorePresenceState;
  lastAt: number | undefined;
} {
  if (snapshot?.done) return { state: 'done', lastAt: snapshot.lastActiveAt };
  const cursor = getReadState(squareState, name);
  const lease = freshWatchLease(squareState, name, now);
  if (lease !== undefined) return { state: 'watching', lastAt: cursor?.updatedAt ?? lease.heartbeatAt };
  const lastAt = cursor?.updatedAt ?? (snapshot?.joined ? snapshot.lastActiveAt : undefined);
  return lastAt === undefined
    ? { state: 'never-joined', lastAt: undefined }
    : { state: 'active', lastAt };
}

export interface StatusResult {
  hardCap: HardCap;
  throttlePerMinute: number | undefined;
  activeCount: number;
  doneCount: number;
  holdActive: boolean;
  holdReason: string | undefined;
  holdActor: string | undefined;
  holdAt: number | undefined;
  participants: ParticipantStatus[];
  latestAct: StoredAct | undefined;
  now: number;
}

function buildParticipantStatuses(squareState: SquareState, now: number, state = foldedState(squareState)): ParticipantStatus[] {
  const delivery = deriveDeliveryModel(squareState);
  return state.participants.map((snapshot) => {
    const participant = snapshot.name;
    const presence = presenceFor(squareState, snapshot, participant, now);
    const participantStatus = snapshot?.done ? 'done' : snapshot?.joined ? 'active' : 'not joined';
    const consumedThrough = readCursor(squareState, participant);
    let unreadActivityCount = 0;
    if (snapshot?.joined) {
      for (const act of squareState.acts) {
        if (actStableIndex(act) <= consumedThrough || act.actor === undefined || sameName(act.actor, participant)) continue;
        if (act.kind !== 'read') unreadActivityCount++;
      }
    }
    return {
      name: participant,
      state: participantStatus,
      activityCount: snapshot?.activityCount ?? 0,
      lastActiveAt: snapshot?.lastActiveAt,
      presence: presence.state,
      presenceAt: presence.lastAt,
      unreadActivityCount,
      pendingMentionCount: snapshot?.joined ? delivery.pendingFor(participant).length : 0,
    };
  });
}

export function coreStatus(squareState: SquareState, now: number): StatusResult {
  const state = foldedState(squareState);
  const latestAct = publicActs(squareState.acts).at(-1);
  return {
    hardCap: squareState.hardCap,
    throttlePerMinute: squareState.throttlePerMinute,
    activeCount: state.joined.length,
    doneCount: state.done.length,
    holdActive: state.hold.active,
    holdReason: state.hold.reason,
    holdActor: state.hold.actor,
    holdAt: state.hold.at,
    participants: buildParticipantStatuses(squareState, now, state),
    latestAct,
    now,
  };
}

export function coreParticipants(squareState: SquareState, now: number): ParticipantStatus[] {
  return buildParticipantStatuses(squareState, now);
}

export function coreActivities(squareState: SquareState, opts: ActivitiesOptions): StoredAct[] {
  const participants = opts.participants ?? [];
  const canonicalParticipants = participants.map((participant) => resolveKnownName(squareState, participant));
  const viewer = opts.viewer !== undefined ? resolveKnownName(squareState, opts.viewer) : undefined;
  let acts = [...squareState.acts];

  // --at establishes one or more context windows first; other filters AND inside their union.
  if (opts.atIndexes !== undefined && opts.atIndexes.length > 0) {
    const before = opts.beforeContext ?? 0;
    const after = opts.afterContext ?? 0;
    const selected = new Set<number>();
    for (const atIndex of opts.atIndexes) {
      const centerPos = acts.findIndex((act) => act.index === atIndex);
      if (centerPos < 0) continue;
      for (const act of acts.slice(Math.max(0, centerPos - before), centerPos + after + 1)) selected.add(act.index);
    }
    acts = acts.filter((act) => selected.has(act.index));
  }
  if (opts.afterIndex != null) acts = acts.filter((act) => act.index > opts.afterIndex!);
  if (canonicalParticipants.length > 0) {
    acts = acts.filter(
      (act) =>
        act.actor !== undefined && canonicalParticipants.some((participant) => sameName(participant, act.actor!))
    );
  }
  if (opts.before != null) acts = acts.filter((act) => act.at < opts.before!);
  if (opts.after != null) acts = acts.filter((act) => act.at > opts.after!);
  if (opts.mention != null) {
    const mention = resolveKnownName(squareState, opts.mention);
    acts = acts.filter((act) => act.kind === 'say' && (act.reach === 'bell' || matchesMentionTarget(act, mention)));
  }
  if (opts.pending) {
    if (viewer === undefined) return [];
    const pendingIndexes = new Set(deriveDeliveryModel(squareState).pendingFor(viewer).map((notification) => notification.item.index));
    acts = acts.filter((act) => pendingIndexes.has(act.index));
  }
  const search = opts.grep !== undefined ? { pattern: opts.grep, fixed: false } : opts.fixed !== undefined ? { pattern: opts.fixed, fixed: true } : undefined;
  if (search !== undefined && search.pattern !== '') {
    // Search only the public activity model rendered by history, but include all
    // of its user-facing fields rather than coupling matching to rendered text.
    acts = acts.filter((act) => act.kind === 'say' || act.kind === 'done');
    const re = compileSearchPattern(search.pattern, search.fixed);
    acts = acts.filter((act) => [
      actId(act.index),
      act.actor ?? '',
      'body' in act && typeof act.body === 'string' ? act.body : '',
    ].some((field) => re.test(field)));
  }

  if (opts.order === 'desc') {
    acts = [...acts].sort((a, b) => b.index - a.index || b.at - a.at);
  } else {
    acts = [...acts].sort((a, b) => a.index - b.index || a.at - b.at);
  }
  return acts;
}
