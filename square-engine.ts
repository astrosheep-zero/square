import {
  extractMentions,
  formatActivityId,
  parseActivityId,
  perceive,
  type Act,
  type ActivityId,
  type Perception,
  type Reach,
} from './square-core.js';
import { ackPeerDelta, deliveryDelta, filteredRoomChanges, matchesFeedFilter, peerPublicActs, peerRoomChanges } from './activity-feed.js';
import { coreActivities, coreDone, coreHold, coreParticipants, coreResume, coreStatus, decideAct, decideJoin, resolveKnownName } from './decisions.js';
import { deriveDeliveryModel, isDeliveryDelivered, markDeliveredNotifications, planActNotifications, type PlannedNotification } from './delivery.js';
import {
  SquareError,
  nameKey,
  type ActivitiesOptions,
  type InboxNotification,
  type NotifyLease,
  type PublicAct,
  type RoomChangeAct,
  type SquareState,
  type StoredAct,
  type WakeRouteKind,
  type WatchLease,
  type WatchOptions,
} from './model.js';
import {
  WATCH_STALE_MS,
  countSays,
  currentHold,
  doneNames,
  foldedState,
  freshWatchLease,
  hasQuorum,
  inSquareCount,
  isCurrentlyJoined,
  readCursor,
  removeWatchLease,
  resolveRosterName,
  rosterNames,
  touchPresenceCursor,
  writeWatchLease,
} from './runtime.js';

/** Private synchronous transaction seam owned by the application engine. */
export interface StateCell {
  transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }): Promise<R>;
  read(): Promise<{ state: SquareState; version: number }>;
  changed(sinceVersion: number, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface Activity {
  readonly id: ActivityId;
  readonly at: number;
  readonly kind: 'join' | 'say' | 'done' | 'hold' | 'resume';
  readonly actor: string;
  readonly body?: string;
  readonly mentions: readonly string[];
  readonly reply?: ActivityId;
}

export interface PerceivedActivity extends Activity {
  readonly perception: Perception;
}

export interface ExpressOptions {
  readonly force?: boolean;
  readonly reach?: Reach;
  readonly reply?: ActivityId;
}

export interface ExpressResult { readonly activity: Activity }

export interface CatchOptions {
  readonly idle?: number;
  readonly from?: readonly string[];
  readonly mention?: boolean;
}

export interface CatchResult {
  readonly activities: readonly PerceivedActivity[];
  readonly consumedThrough: ActivityId | null;
  readonly idleExpired: boolean;
}

export interface HistoryQuery {
  readonly limit?: number;
  readonly order?: 'asc' | 'desc';
  readonly all?: boolean;
  readonly full?: boolean;
  readonly grep?: string;
  readonly from?: readonly string[];
  readonly mention?: boolean;
}

export interface ParticipantStatus {
  readonly name: string;
  readonly state: 'joined' | 'done';
  readonly consumedThrough: ActivityId | null;
  readonly watching: boolean;
}

export interface SquareSnapshot {
  readonly context: string;
  readonly actCount: number;
  readonly hardCap: number | null;
  readonly throttlePerMinute?: number;
  readonly held: { readonly by: string; readonly reason?: string } | null;
  readonly participants: readonly ParticipantStatus[];
  delivered(name: string, id: ActivityId): boolean;
}

export interface ActivityPresentation {
  readonly name: string;
  readonly roster: readonly string[];
  readonly pendingPublic: readonly PublicAct[];
  readonly pendingRoomChanges: readonly RoomChangeAct[];
  readonly activities: readonly StoredAct[];
  readonly participantCount: number;
  readonly held: boolean;
  readonly holdReason?: string;
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
}

export interface EntryPresentation {
  readonly joined: boolean;
  readonly scene: string;
  readonly context: string;
  readonly joinContext: string;
  readonly recentActivities: readonly StoredAct[];
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly participantCount: number;
}

export interface HistoryPresentation {
  readonly activities: readonly (StoredAct & { readonly perception: Perception })[];
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly presenceAnchors: Readonly<Record<number, readonly string[]>>;
  readonly participantCount: number;
}

export interface ListPresentation {
  readonly context: readonly string[];
  readonly participants: readonly string[];
  readonly activities: number;
}

export interface StatusPresentation {
  readonly status: ReturnType<typeof coreStatus>;
  readonly latestActNumber?: number;
}

export interface WatchPresentation {
  readonly activities: readonly StoredAct[];
  readonly participantCount: number;
  readonly presence: { readonly participants: ReturnType<typeof coreParticipants>; readonly now: number };
  readonly terminalStatus?: 'capped' | 'quorum';
}

export type WatchLeaseStart =
  | { readonly type: 'started'; readonly leaseId: string; readonly replaced: boolean; readonly heartbeatAt: number }
  | { readonly type: 'active'; readonly lease: WatchLease };

export type WatchLeasePulse =
  | { readonly type: 'replaced' }
  | { readonly type: 'held' }
  | { readonly type: 'terminal'; readonly status: 'capped' | 'quorum' }
  | { readonly type: 'sleep'; readonly heartbeatAt?: number };

export interface InboxProjection {
  readonly name: string;
  readonly joined: boolean;
  readonly notifications: readonly InboxNotification[];
  readonly catchLease?: WatchLease;
}

export interface StreamProjection {
  readonly activities: readonly { readonly activity: StoredAct; readonly route?: string }[];
  readonly cursor: number;
}

export interface PendingDeliveryProjection {
  readonly recipient: string;
  readonly notifications: readonly PlannedNotification[];
}

export type NotifyLeaseClaim =
  | { readonly type: 'delivered' }
  | { readonly type: 'busy' }
  | { readonly type: 'ambiguous'; readonly lease: NotifyLease }
  | { readonly type: 'acquired'; readonly leaseId: string };

export interface WakeNotifier {
  wake(recipients: readonly string[], activity: Activity): void;
}

export interface ApplicationOptions {
  cell: StateCell;
  clock?: () => number;
  notifier?: WakeNotifier;
}

function storeActs(squareState: SquareState, acts: readonly Act[]): StoredAct[] {
  const stored: StoredAct[] = [];
  for (const act of acts) {
    const item = { ...act, index: squareState.runtime.nextActIndex } as StoredAct;
    squareState.runtime.nextActIndex += 1;
    squareState.acts.push(item);
    if (item.actor !== undefined) touchPresenceCursor(squareState, item.actor, item.at, item.index);
    stored.push(item);
  }
  return stored;
}

function committedActivity(stored: readonly StoredAct[], verb: string): StoredAct {
  const activity = stored[0];
  if (activity === undefined) throw new Error(`${verb} activity did not commit`);
  return activity;
}

function exposeActivity(stored: StoredAct): Activity {
  if (stored.kind === 'read' || stored.actor === undefined) {
    throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  }
  return {
    id: formatActivityId(stored.index),
    at: stored.at,
    kind: stored.kind,
    actor: stored.actor,
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    mentions: stored.kind === 'say' ? extractMentions(stored.body) : [],
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}),
  };
}

function exposePerceivedActivity(stored: StoredAct, viewer: string): PerceivedActivity {
  const perception = perceive(stored, viewer);
  const activity = exposeActivity(stored);
  if (perception === 'full' || activity.body === undefined) return { ...activity, perception };
  const { body: _body, ...presence } = activity;
  return { ...presence, perception };
}

function parseRequiredActivityId(id: ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

function historyOptions(query: HistoryQuery, viewer?: string): ActivitiesOptions {
  return {
    ...(query.from === undefined ? {} : { participants: [...query.from] }),
    ...(query.grep === undefined ? {} : { grep: query.grep }),
    ...(query.mention === true && viewer !== undefined ? { mention: viewer } : {}),
    order: 'asc',
  };
}

function selectHistory(stored: StoredAct[], query: HistoryQuery): StoredAct[] {
  let selected = stored.filter((activity) => activity.kind !== 'read');
  if (query.all !== true && query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new SquareError('invalid_args', 'History limit must be a positive integer');
    }
    selected = selected.slice(-query.limit);
  }
  return query.order === 'desc' ? selected.reverse() : selected;
}

function participantStatuses(state: SquareState, now: number): ParticipantStatus[] {
  return coreStatus(state, now).participants
    .filter((participant) => participant.state !== 'not joined')
    .map((participant) => {
      const cursor = readCursor(state, participant.name);
      return {
        name: participant.name,
        state: participant.state === 'done' ? 'done' : 'joined',
        consumedThrough: cursor < 0 ? null : formatActivityId(cursor),
        watching: participant.presence === 'watching',
      };
    });
}

function watchTerminalStatus(state: SquareState, name: string): 'capped' | 'quorum' | undefined {
  if (state.hardCap !== null && countSays(state.acts, name) >= state.hardCap) return 'capped';
  const done = doneNames(state.acts);
  done.delete(nameKey(name));
  return hasQuorum(state, name, done) ? 'quorum' : undefined;
}

function historyPresenceAnchors(state: SquareState): Record<number, string[]> {
  const anchors: Record<number, string[]> = {};
  for (const name of rosterNames(state)) {
    const cursor = readCursor(state, name);
    const anchor = state.acts.findLast((activity) =>
      activity.index <= cursor && (activity.kind === 'say' || activity.kind === 'done')
    );
    if (anchor === undefined) continue;
    anchors[anchor.index] = [...(anchors[anchor.index] ?? []), name];
  }
  return anchors;
}

function sayNumbers(state: SquareState): Record<number, number> {
  const counts = new Map<string, number>();
  const numbers: Record<number, number> = {};
  for (const activity of state.acts) {
    if (activity.kind !== 'say') continue;
    const key = nameKey(activity.actor);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    numbers[activity.index] = next;
  }
  return numbers;
}

function notifyLeaseKey(recipient: string, actIndex: number): string {
  return JSON.stringify([formatActivityId(actIndex), nameKey(recipient)]);
}

async function wakeAfterCommit(notifier: WakeNotifier | undefined, recipients: readonly string[], activity: Activity): Promise<void> {
  if (recipients.length === 0) return;
  try {
    notifier?.wake(recipients, activity);
  } catch {
    // Wake is a post-commit effect and cannot undo the activity.
  }
}

/** Storage-neutral domain operations composed directly over StateCell transactions. */
export class SquareApplication {
  private readonly clock: () => number;
  private readonly notifier?: WakeNotifier;

  constructor(private readonly cell: StateCell, options: Omit<ApplicationOptions, 'cell'> = {}) {
    this.clock = options.clock ?? Date.now;
    this.notifier = options.notifier;
  }

  async join(name: string): Promise<{ readonly name: string; readonly activity: Activity | null }> {
    const now = this.clock();
    const committed = await this.cell.transact<{ name: string; stored: StoredAct | null }>((squareState) => {
      const decision = decideJoin(squareState, name, now);
      if (decision.joinAct === undefined) return { result: { name: decision.joinedName, stored: null } };
      const stored = committedActivity(storeActs(squareState, [decision.joinAct]), 'join');
      return { state: squareState, result: { name: decision.joinedName, stored } };
    });
    return { name: committed.name, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
  }

  async express(name: string, body: string, options: ExpressOptions = {}): Promise<ExpressResult> {
    const now = this.clock();
    const reply = options.reply === undefined ? undefined : parseRequiredActivityId(options.reply);
    const committed = await this.cell.transact((squareState) => {
      const decision = decideAct(squareState, {
        name, body, force: options.force ?? false, now,
        ...(options.reach === undefined ? {} : { reach: options.reach }),
        ...(reply === undefined ? {} : { reply }),
      });
      if (decision.type === 'blocked') {
        const pending = decision.activitySummaries.reduce((count, summary) => count + summary.count, 0)
          + decision.unreadRoomChanges.length;
        throw new SquareError('behind', `${name} has pending activity`, { pending });
      }
      if (decision.type === 'held') {
        const holder = foldedState(squareState).hold.actor;
        throw new SquareError('held', 'The square is held', holder === undefined ? undefined : { holder });
      }
      if (decision.type === 'capped') throw new SquareError('capped', `${name} reached the activity cap`);
      if (decision.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: decision.delayMs });
      if (decision.type === 'bell_quota') {
        throw new SquareError('bell_quota', `${name} cannot ring the bell yet`, { retryAfterMs: Math.max(1, decision.nextAt - now) });
      }
      const stored = committedActivity(storeActs(squareState, [decision.act]), 'express');
      const recipients = deriveDeliveryModel(squareState).plan(stored).map((notification) => notification.recipient);
      return { state: squareState, result: { stored, recipients } };
    });
    const activity = exposeActivity(committed.stored);
    await wakeAfterCommit(this.notifier, committed.recipients, activity);
    return { activity };
  }

  async done(name: string, body = ''): Promise<ExpressResult> {
    const now = this.clock();
    const stored = await this.cell.transact((squareState) => {
      const activity = committedActivity(storeActs(squareState, [coreDone(squareState, name, body, now)]), 'done');
      return { state: squareState, result: activity };
    });
    return { activity: exposeActivity(stored) };
  }

  async hold(actor: string, reason = ''): Promise<ExpressResult> {
    const now = this.clock();
    const stored = await this.cell.transact((squareState) => {
      const activity = committedActivity(storeActs(squareState, [coreHold(squareState, actor, reason, now)]), 'hold');
      return { state: squareState, result: activity };
    });
    return { activity: exposeActivity(stored) };
  }

  async resume(actor: string): Promise<ExpressResult> {
    const now = this.clock();
    const stored = await this.cell.transact((squareState) => {
      const activity = committedActivity(storeActs(squareState, [coreResume(squareState, actor, now)]), 'resume');
      return { state: squareState, result: activity };
    });
    return { activity: exposeActivity(stored) };
  }

  async catch(name: string, options: CatchOptions = {}): Promise<CatchResult> {
    const idle = options.idle ?? 0;
    if (!Number.isFinite(idle) || idle < 0) {
      throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
    }
    const deadline = Date.now() + idle;

    while (true) {
      const attempt = await this.cell.transact((squareState, version) => {
        const at = this.clock();
        const viewer = resolveKnownName(squareState, name);
        const delta = deliveryDelta(squareState, viewer);
        const filter = {
          ...(options.from === undefined ? {} : { participants: [...options.from] }),
          ...(options.mention === true ? { mention: viewer } : {}),
        };
        const delivered = [
          ...peerPublicActs(delta, viewer).filter((activity) => matchesFeedFilter(activity, filter)),
          ...filteredRoomChanges(delta, viewer, filter),
        ].filter((activity, index, activities) =>
          activities.findIndex((candidate) => candidate.index === activity.index) === index
        ).sort((left, right) => left.index - right.index);
        const cursorChanged = ackPeerDelta(squareState, viewer, delta, at);
        const receiptsChanged = markDeliveredNotifications(squareState, viewer, delivered, at);
        const cursor = readCursor(squareState, viewer);
        return {
          ...(cursorChanged || receiptsChanged ? { state: squareState } : {}),
          result: {
            version,
            caught: {
              activities: delivered.map((activity) => exposePerceivedActivity(activity, viewer)),
              consumedThrough: cursor < 0 ? null : formatActivityId(cursor),
              idleExpired: false,
            } satisfies CatchResult,
          },
        };
      });
      if (attempt.caught.activities.length > 0 || idle === 0) return attempt.caught;

      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...attempt.caught, idleExpired: true };
      if (!await this.cell.changed(attempt.version, remaining)) {
        return { ...attempt.caught, idleExpired: true };
      }
    }
  }

  async history(query: HistoryQuery = {}): Promise<Activity[]> {
    const { state } = await this.cell.read();
    return selectHistory(coreActivities(state, historyOptions(query)), query).map(exposeActivity);
  }

  async resolveParticipant(name: string): Promise<{ readonly name: string; readonly roster: readonly string[] }> {
    const { state } = await this.cell.read();
    return { name: resolveKnownName(state, name), roster: rosterNames(state) };
  }

  async activityPresentation(name: string): Promise<ActivityPresentation> {
    const { state } = await this.cell.read();
    const known = resolveKnownName(state, name);
    const delta = deliveryDelta(state, known);
    const hold = currentHold(state.acts);
    return {
      name: known,
      roster: rosterNames(state),
      pendingPublic: peerPublicActs(delta, known),
      pendingRoomChanges: peerRoomChanges(delta, known),
      activities: state.acts,
      participantCount: inSquareCount(state),
      held: hold.active,
      ...(hold.reason === undefined ? {} : { holdReason: hold.reason }),
      ownActivityCount: countSays(state.acts, known),
      hardCap: state.hardCap,
    };
  }

  async entryPresentation(name: string, lastN: number | null = 10): Promise<EntryPresentation> {
    const { state } = await this.cell.read();
    const known = resolveRosterName(state, name) ?? name;
    const publicActivities = state.acts.filter((activity) => activity.kind === 'say' || activity.kind === 'done');
    return {
      joined: isCurrentlyJoined(state.acts, known),
      scene: state.warmup.join('\n').trim(),
      context: state.preamble.join('\n').trim(),
      joinContext: (state.preamble.at(-1) === '---' ? state.preamble.slice(0, -1) : state.preamble).join('\n').trim(),
      recentActivities: lastN === null ? publicActivities : publicActivities.slice(-lastN),
      sayNumbers: sayNumbers(state),
      participantCount: inSquareCount(state),
    };
  }

  async historyPresentation(options: ActivitiesOptions): Promise<HistoryPresentation> {
    const { state } = await this.cell.read();
    const activities = coreActivities(state, options);
    return {
      activities: activities.map((activity) => ({
        ...activity,
        perception: options.viewer === undefined ? 'full' : perceive(activity, options.viewer),
      })),
      sayNumbers: sayNumbers(state),
      presenceAnchors: historyPresenceAnchors(state),
      participantCount: inSquareCount(state),
    };
  }

  async participantsPresentation(): Promise<ReturnType<typeof coreParticipants>> {
    const { state } = await this.cell.read();
    return coreParticipants(state, this.clock());
  }

  async listPresentation(): Promise<ListPresentation> {
    const { state } = await this.cell.read();
    const participants = foldedState(state).participants
      .filter((participant) => participant.joined)
      .sort((left, right) =>
        (right.lastActiveAt ?? -Infinity) - (left.lastActiveAt ?? -Infinity)
        || left.name.localeCompare(right.name)
      )
      .map((participant) => participant.name);
    return {
      context: state.preamble,
      participants,
      activities: state.acts.filter((activity) => activity.kind === 'say').length,
    };
  }

  async statusPresentation(): Promise<StatusPresentation> {
    const { state } = await this.cell.read();
    const status = coreStatus(state, this.clock());
    return {
      status,
      ...(status.latestAct?.kind === 'say' ? { latestActNumber: countSays(state.acts, status.latestAct.actor) } : {}),
    };
  }

  async eventPresentation(id: ActivityId): Promise<{ readonly activity: StoredAct; readonly participantCount: number; readonly held: boolean }> {
    const index = parseRequiredActivityId(id);
    const { state } = await this.cell.read();
    const activity = state.acts.find((candidate) => candidate.index === index);
    if (activity === undefined) throw new SquareError('invalid_args', `Unknown activity id: ${id}`);
    return { activity, participantCount: inSquareCount(state), held: currentHold(state.acts).active };
  }

  async watchPresentation(name: string): Promise<WatchPresentation> {
    const { state } = await this.cell.read();
    const known = resolveKnownName(state, name);
    const now = this.clock();
    const terminalStatus = watchTerminalStatus(state, known);
    return {
      activities: state.acts,
      participantCount: inSquareCount(state),
      presence: { participants: coreParticipants(state, now), now },
      ...(terminalStatus === undefined ? {} : { terminalStatus }),
    };
  }

  async acquireWatchLease(name: string, leaseId: string, options: WatchOptions, ownerId?: string): Promise<WatchLeaseStart> {
    const at = this.clock();
    return this.cell.transact<WatchLeaseStart>((state) => {
      const known = resolveKnownName(state, name);
      const existing = freshWatchLease(state, known, at);
      if (existing !== undefined && !options.replace) return { result: { type: 'active' as const, lease: existing } };
      const filter = {
        ...(options.participants === undefined ? {} : { participants: options.participants }),
        ...(options.mention === undefined ? {} : { mention: options.mention }),
      };
      writeWatchLease(state, known, {
        leaseId,
        ...(ownerId === undefined ? {} : { ownerId }),
        heartbeatAt: at,
        expiresAt: at + WATCH_STALE_MS,
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
      });
      touchPresenceCursor(state, known, at);
      return { state, result: { type: 'started' as const, leaseId, replaced: existing !== undefined, heartbeatAt: at } };
    });
  }

  async pulseWatchLease(name: string, leaseId: string, options: WatchOptions, heartbeatDue: boolean): Promise<WatchLeasePulse> {
    const at = this.clock();
    return this.cell.transact<WatchLeasePulse>((state) => {
      const known = resolveKnownName(state, name);
      const lease = freshWatchLease(state, known, at);
      if (lease?.leaseId !== leaseId) return { result: { type: 'replaced' as const } };
      if (currentHold(state.acts).active) return { result: { type: 'held' as const } };
      const terminal = watchTerminalStatus(state, known);
      if (terminal !== undefined) return { result: { type: 'terminal' as const, status: terminal } };
      if (!heartbeatDue) return { result: { type: 'sleep' as const } };
      const filter = {
        ...(options.participants === undefined ? {} : { participants: options.participants }),
        ...(options.mention === undefined ? {} : { mention: options.mention }),
      };
      writeWatchLease(state, known, {
        leaseId,
        ...(lease.ownerId === undefined ? {} : { ownerId: lease.ownerId }),
        heartbeatAt: at,
        expiresAt: at + WATCH_STALE_MS,
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
      });
      touchPresenceCursor(state, known, at);
      return { state, result: { type: 'sleep' as const, heartbeatAt: at } };
    });
  }

  async releaseWatchLease(name: string, leaseId: string | undefined): Promise<void> {
    if (leaseId === undefined) return;
    await this.cell.transact((state) => {
      const known = resolveKnownName(state, name);
      return removeWatchLease(state, known, leaseId)
        ? { state, result: undefined }
        : { result: undefined };
    });
  }

  async ownsWatchLease(name: string, leaseId: string): Promise<boolean> {
    const { state } = await this.cell.read();
    return freshWatchLease(state, resolveKnownName(state, name), this.clock())?.leaseId === leaseId;
  }

  async inboxProjection(name: string, ownerId: string): Promise<InboxProjection> {
    const { state } = await this.cell.read();
    const known = resolveRosterName(state, name);
    if (known === undefined || !isCurrentlyJoined(state.acts, known)) {
      return { name, joined: false, notifications: [] };
    }
    const notifications = deriveDeliveryModel(state).pendingFor(known).map(({ item, route }) => ({
      actIndex: item.index, actor: item.actor, at: item.at, route, body: item.body,
    }));
    const lease = freshWatchLease(state, known, this.clock());
    return {
      name: known,
      joined: true,
      notifications,
      ...(lease?.ownerId === ownerId ? { catchLease: lease } : {}),
    };
  }

  async streamProjection(cursor: number, recipient?: string): Promise<StreamProjection> {
    const { state } = await this.cell.read();
    const activities = state.acts.filter((activity) => activity.index > cursor).flatMap((activity) => {
      if (recipient === undefined) return [{ activity }];
      const notification = planActNotifications(state, activity).find((candidate) => nameKey(candidate.recipient) === nameKey(recipient));
      return notification === undefined ? [] : [{ activity, route: notification.route }];
    });
    return { activities, cursor: Math.max(cursor, ...state.acts.map((activity) => activity.index)) };
  }

  async notificationForAct(actIndex: number): Promise<readonly PlannedNotification[]> {
    const { state } = await this.cell.read();
    const activity = state.acts.find((candidate) => candidate.index === actIndex);
    return activity === undefined ? [] : planActNotifications(state, activity);
  }

  async pendingDeliveries(): Promise<readonly PendingDeliveryProjection[]> {
    const { state } = await this.cell.read();
    return [...new Set(state.acts.filter((activity) => activity.kind === 'join').map((activity) => activity.actor))]
      .filter((name) => isCurrentlyJoined(state.acts, name))
      .map((recipient) => ({ recipient, notifications: deriveDeliveryModel(state).pendingFor(recipient) }));
  }

  async notificationDelivered(recipient: string, actIndex: number): Promise<boolean> {
    const { state } = await this.cell.read();
    return isDeliveryDelivered(state, recipient, actIndex);
  }

  async claimNotificationLease(recipient: string, actIndex: number, leaseId: string, leaseMs: number): Promise<NotifyLeaseClaim> {
    const at = this.clock();
    const key = notifyLeaseKey(recipient, actIndex);
    return this.cell.transact<NotifyLeaseClaim>((state) => {
      const known = resolveKnownName(state, recipient);
      if (isDeliveryDelivered(state, known, actIndex)) return { result: { type: 'delivered' as const } };
      const existing = state.runtime.notifyLeases[key];
      if (existing !== undefined && existing.expiresAt > at) return { result: { type: 'busy' as const } };
      if (existing?.phase === 'dispatching') return { result: { type: 'ambiguous' as const, lease: existing } };
      state.runtime.notifyLeases[key] = { leaseId, expiresAt: at + leaseMs, phase: 'claimed' };
      return { state, result: { type: 'acquired' as const, leaseId } };
    });
  }

  async transitionNotificationLease(
    recipient: string,
    actIndex: number,
    leaseId: string,
    phase: NotifyLease['phase'],
    leaseMs: number,
    routeKind?: WakeRouteKind,
    attemptN?: number,
  ): Promise<boolean> {
    const at = this.clock();
    const key = notifyLeaseKey(recipient, actIndex);
    return this.cell.transact((state) => {
      if (state.runtime.notifyLeases[key]?.leaseId !== leaseId) return { result: false };
      state.runtime.notifyLeases[key] = {
        leaseId, expiresAt: at + leaseMs, phase,
        ...(routeKind === undefined ? {} : { routeKind }),
        ...(attemptN === undefined ? {} : { attemptN }),
      };
      return { state, result: true };
    });
  }

  async releaseNotificationLease(recipient: string, actIndex: number, leaseId: string): Promise<void> {
    const key = notifyLeaseKey(recipient, actIndex);
    await this.cell.transact((state) => {
      if (state.runtime.notifyLeases[key]?.leaseId !== leaseId) return { result: undefined };
      delete state.runtime.notifyLeases[key];
      return { state, result: undefined };
    });
  }

  async participantHistory(name: string, query: HistoryQuery = {}): Promise<PerceivedActivity[]> {
    const { state } = await this.cell.read();
    const viewer = resolveKnownName(state, name);
    const effective = query.all === true || query.limit !== undefined ? query : { ...query, limit: 10 };
    return selectHistory(coreActivities(state, historyOptions(effective, viewer)), effective)
      .map((activity) => exposePerceivedActivity(activity, viewer));
  }

  async participants(): Promise<ParticipantStatus[]> {
    const { state } = await this.cell.read();
    return participantStatuses(state, this.clock());
  }

  async snapshot(): Promise<SquareSnapshot> {
    const { state } = await this.cell.read();
    const folded = foldedState(state);
    return {
      context: [...state.preamble, ...state.warmup].join('\n'),
      actCount: state.acts.filter((activity) => activity.kind !== 'read').length,
      hardCap: state.hardCap,
      ...(state.throttlePerMinute === undefined ? {} : { throttlePerMinute: state.throttlePerMinute }),
      held: folded.hold.active && folded.hold.actor !== undefined
        ? { by: folded.hold.actor, ...(folded.hold.reason === undefined ? {} : { reason: folded.hold.reason }) }
        : null,
      participants: participantStatuses(state, this.clock()),
      delivered(name, id) { return isDeliveryDelivered(state, name, parseRequiredActivityId(id)); },
    };
  }

  close(): Promise<void> { return this.cell.close(); }
}

export function createApplication(options: ApplicationOptions): SquareApplication {
  return new SquareApplication(options.cell, options);
}
