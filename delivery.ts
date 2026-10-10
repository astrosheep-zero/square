import {
  type DirectedNotificationRoute,
  type SquareState,
  type StoredAct,
  type WatchLease,
  type WakeRoute,
  type WakeRouteKind,
  findParticipantName,
  sameName,
} from './model.js';
import { activityAuthors, audienceOf, replayLandedAudiences, type Perception } from './square-core.js';
import { derivePerceptionProjection } from './perception-projection.js';
import { matchesMentionTarget, recordObservation } from './runtime.js';
import { matchesCatchSelection } from './catch-selection.js';
import type { WakeOutcome } from './ports.js';

export type { DirectedNotificationRoute } from './model.js';
export type SayItem = StoredAct & { kind: 'say' };

export interface PlannedNotification {
  item: SayItem;
  recipient: string;
  route: DirectedNotificationRoute;
}

/**
 * What one adapter reports about a wake it was handed.
 * `gate-rejected` means exactly one thing: the supplied beforeSend gate returned false and nothing was sent.
 * It is not a bin for other not-sent reasons; those stay `failed` with `unavailable: true`.
 */
export type WakeAdapterResult =
  | Exclude<WakeOutcome, { outcome: 'not-capable' }>
  | { outcome: 'gate-rejected' };

/**
 * The coordinates of one wake attempt. An adapter that must hand the receiver a
 * stable dedup key derives it from these, so a retry of the same attempt reuses
 * the same key and a later attempt gets a new one.
 */
export interface WakeDispatchContext {
  readonly location: string;
  readonly participant: string;
  readonly activity: string;
  readonly attemptN?: number;
}

export interface WakeAdapter {
  readonly kind: WakeRouteKind;
  dispatch(
    address: Readonly<Record<string, string>>,
    payload: string,
    beforeSend: () => Promise<boolean>,
    timeoutMs?: number,
    context?: WakeDispatchContext,
  ): Promise<WakeAdapterResult>;
}

export interface RoutedNotification {
  actor: string;
  route: DirectedNotificationRoute;
  recipient: string;
}

export interface DeliveryModel {
  plan(item: StoredAct): PlannedNotification[];
  pendingFor(recipient: string): PlannedNotification[];
  directedTo(item: StoredAct, recipient: string): boolean;
  perceive(item: StoredAct, viewer: string): Perception;
  cursorFor(recipient: string): number;
  isSeen(recipient: string, actOrIndex: StoredAct | number): boolean;
  knownParticipant(name: string): string | undefined;
  participants(): readonly string[];
  joinedRecipients(): readonly string[];
  readonly replayedActivityCount: number;
}

export function isActivitySeen(squareState: SquareState, name: string, actOrIndex: StoredAct | number): boolean {
  return deriveDeliveryModel(squareState).isSeen(name, actOrIndex);
}

/**
 * Derive delivery behavior once from the decoded Square state.
 * All consumers share these targets instead of reinterpreting artifact text or cursor state.
 */
export function deriveDeliveryModel(squareState: SquareState): DeliveryModel {
  const landed = replayLandedAudiences(squareState.acts);
  const authors = activityAuthors(squareState.acts);
  const perception = derivePerceptionProjection(squareState, landed);
  const roster = [...landed.joined];
  const plannedByIndex = new Map<number, PlannedNotification[]>();
  let pendingByRecipient: Map<string, PlannedNotification[]> | undefined;

  function isSeen(requestedRecipient: string, actOrIndex: StoredAct | number): boolean {
    const index = typeof actOrIndex === 'number' ? actOrIndex : actOrIndex.index;
    return perception.isSeen(requestedRecipient, index);
  }

  function plan(item: StoredAct): PlannedNotification[] {
    if (item.kind !== 'say') return [];
    const cached = plannedByIndex.get(item.index);
    if (cached !== undefined) return [...cached];
    const sayItem = item as SayItem;
    const audience = audienceOf(sayItem);
    const recipients = landed.recipientsFor(sayItem);
    const replyAuthor = sayItem.reply === undefined ? undefined : authors.get(sayItem.reply);
    const planned = recipients.map((recipient) => {
      const route: DirectedNotificationRoute = audience.kind === 'bell'
        ? 'bell'
        : matchesMentionTarget(sayItem, recipient) ? 'mention'
          : replyAuthor !== undefined && sameName(replyAuthor, recipient) ? 'reply'
            : 'attention';
      return { item: sayItem, recipient, route };
    });
    plannedByIndex.set(item.index, planned);
    return [...planned];
  }

  function pendingFor(requestedRecipient: string): PlannedNotification[] {
    const recipient = findParticipantName(roster, requestedRecipient);
    if (recipient === undefined) return [];
    if (pendingByRecipient === undefined) {
      pendingByRecipient = new Map(roster.map((name) => [name, []]));
      const joinedAfter = new Map(roster.map((name) => [name, landed.lastJoinIndex(name)]));

      for (const act of squareState.acts) {
        if (act.kind !== 'say') continue;
        for (const planned of plan(act)) {
          const joinedAt = joinedAfter.get(planned.recipient);
          if (joinedAt === undefined || act.index <= joinedAt) continue;
          if (isSeen(planned.recipient, act.index)) continue;
          pendingByRecipient.get(planned.recipient)?.push(planned);
        }
      }
    }
    return [...(pendingByRecipient.get(recipient) ?? [])];
  }

  return {
    plan,
    pendingFor,
    directedTo: perception.directedTo,
    perceive: perception.perceive,
    cursorFor: perception.cursorFor,
    isSeen,
    knownParticipant: (name) => landed.resolveParticipant(name),
    participants: () => landed.participants,
    joinedRecipients: () => roster,
    replayedActivityCount: perception.replayedActivityCount,
  };
}

export function perceiveActivity(squareState: SquareState, item: StoredAct, viewer: string, delivery = deriveDeliveryModel(squareState)): Perception {
  return delivery.perceive(item, viewer);
}

/** Mark only the notifications selected by the canonical catch projection as fully seen. */
export function markSeenNotifications(squareState: SquareState, recipient: string, delivered: StoredAct[], at = Date.now(), delivery = deriveDeliveryModel(squareState)): boolean {
  const deliveredIndexes = new Set(delivered.map((item) => item.index));
  let changed = false;
  for (const notification of delivery.pendingFor(recipient)) {
    if (!deliveredIndexes.has(notification.item.index)) continue;
    changed = recordObservation(squareState, notification.recipient, notification.item.index, 'seen', at) || changed;
  }
  return changed;
}

/** True only when the live catch's own filters would deliver this unread notification, independent of page size. */
export function leaseOwnsNotification(lease: WatchLease, notification: RoutedNotification): boolean {
  return matchesCatchSelection(
    notification.actor,
    notification.route === 'bell'
      ? { kind: 'bell' }
      : { kind: 'mentions', names: notification.route === 'mention' ? [notification.recipient] : [] },
    lease.filter ?? {},
    // A reply reaches the recipient as the author of the activity it answers.
    notification.route === 'reply' ? notification.recipient : undefined,
  );
}
