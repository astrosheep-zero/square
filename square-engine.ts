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
import { ackPeerDelta, deliveryDelta, filteredRoomChanges, matchesFeedFilter, peerPublicActs } from './activity-feed.js';
import { coreActivities, coreDone, coreHold, coreResume, coreStatus, decideAct, decideJoin, resolveKnownName } from './decisions.js';
import { deriveDeliveryModel, isDeliveryDelivered, markDeliveredNotifications } from './delivery.js';
import { SquareError, type ActivitiesOptions, type SquareDoc, type StoredAct } from './model.js';
import { foldedState, readCursor, touchPresenceCursor } from './runtime.js';

/** Private synchronous transaction seam owned by the application engine. */
export interface StateCell {
  transact<R>(fn: (state: SquareDoc, version: number) => { state?: SquareDoc; result: R }): Promise<R>;
  read(): Promise<{ state: SquareDoc; version: number }>;
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

export interface WakeNotifier {
  wake(recipients: readonly string[], activity: Activity): void;
}

export interface ApplicationOptions {
  cell: StateCell;
  clock?: () => number;
  notifier?: WakeNotifier;
}

function storeActs(doc: SquareDoc, acts: readonly Act[]): StoredAct[] {
  const stored: StoredAct[] = [];
  for (const act of acts) {
    const item = { ...act, index: doc.runtime.nextActIndex } as StoredAct;
    doc.runtime.nextActIndex += 1;
    doc.acts.push(item);
    if (item.actor !== undefined) touchPresenceCursor(doc, item.actor, item.at, item.index);
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

function participantStatuses(state: SquareDoc, now: number): ParticipantStatus[] {
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
    const committed = await this.cell.transact<{ name: string; stored: StoredAct | null }>((doc) => {
      const decision = decideJoin(doc, name, now);
      if (decision.joinAct === undefined) return { result: { name: decision.joinedName, stored: null } };
      const stored = committedActivity(storeActs(doc, [decision.joinAct]), 'join');
      return { state: doc, result: { name: decision.joinedName, stored } };
    });
    return { name: committed.name, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
  }

  async express(name: string, body: string, options: ExpressOptions = {}): Promise<ExpressResult> {
    const now = this.clock();
    const reply = options.reply === undefined ? undefined : parseRequiredActivityId(options.reply);
    const committed = await this.cell.transact((doc) => {
      const decision = decideAct(doc, {
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
        const holder = foldedState(doc).hold.actor;
        throw new SquareError('held', 'The square is held', holder === undefined ? undefined : { holder });
      }
      if (decision.type === 'capped') throw new SquareError('capped', `${name} reached the activity cap`);
      if (decision.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: decision.delayMs });
      if (decision.type === 'bell_quota') {
        throw new SquareError('bell_quota', `${name} cannot ring the bell yet`, { retryAfterMs: Math.max(1, decision.nextAt - now) });
      }
      const stored = committedActivity(storeActs(doc, [decision.act]), 'express');
      const recipients = deriveDeliveryModel(doc).plan(stored).map((notification) => notification.recipient);
      return { state: doc, result: { stored, recipients } };
    });
    const activity = exposeActivity(committed.stored);
    await wakeAfterCommit(this.notifier, committed.recipients, activity);
    return { activity };
  }

  async done(name: string, body = ''): Promise<ExpressResult> {
    const now = this.clock();
    const stored = await this.cell.transact((doc) => {
      const activity = committedActivity(storeActs(doc, [coreDone(doc, name, body, now)]), 'done');
      return { state: doc, result: activity };
    });
    return { activity: exposeActivity(stored) };
  }

  async hold(actor: string, reason = ''): Promise<ExpressResult> {
    const now = this.clock();
    const stored = await this.cell.transact((doc) => {
      const activity = committedActivity(storeActs(doc, [coreHold(doc, actor, reason, now)]), 'hold');
      return { state: doc, result: activity };
    });
    return { activity: exposeActivity(stored) };
  }

  async resume(actor: string): Promise<ExpressResult> {
    const now = this.clock();
    const stored = await this.cell.transact((doc) => {
      const activity = committedActivity(storeActs(doc, [coreResume(doc, actor, now)]), 'resume');
      return { state: doc, result: activity };
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
      const attempt = await this.cell.transact((doc, version) => {
        const at = this.clock();
        const viewer = resolveKnownName(doc, name);
        const delta = deliveryDelta(doc, viewer);
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
        const cursorChanged = ackPeerDelta(doc, viewer, delta, at);
        const receiptsChanged = markDeliveredNotifications(doc, viewer, delivered, at);
        const cursor = readCursor(doc, viewer);
        return {
          ...(cursorChanged || receiptsChanged ? { state: doc } : {}),
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
