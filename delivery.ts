import {
  type DirectedNotificationRoute,
  type SquareState,
  type StoredAct,
  type WatchLease,
  type WatchLeaseFilter,
  type WakeRoute,
  type WakeRouteKind,
  type Reach,
  findParticipantName,
  sameName,
} from './model.js';
import { audienceBefore, audienceOf, formatActivityId, type Perception } from './square-core.js';
import { isCurrentlyJoined, lastJoinIndex, matchesMentionTarget, observationFor, recordObservation, resolveRosterName, rosterNames } from './runtime.js';

export type { DirectedNotificationRoute } from './model.js';
export type SayItem = StoredAct & { kind: 'say' };

export function notificationMessageId(squarePath: string, actIndex: number): string {
  return `square:${squarePath}#${formatActivityId(actIndex)}`;
}

export interface PlannedNotification {
  item: SayItem;
  recipient: string;
  route: DirectedNotificationRoute;
}

export interface WakeRequest {
  squarePath: string;
  actIndex: number;
  recipient: string;
  actor: string;
  route: DirectedNotificationRoute;
}

export type WakeDispatchResult =
  | { outcome: 'accepted' }
  | { outcome: 'unknown'; signature: string; message: string; diagnostic?: unknown }
  | { outcome: 'failed'; signature: string; message: string; diagnostic?: unknown }
  | { outcome: 'unavailable'; signature: string; message: string; diagnostic?: unknown; retainRoute?: boolean }
  | { outcome: 'cancelled' };

export interface WakeAdapter {
  readonly kind: WakeRouteKind;
  dispatch(
    address: Readonly<Record<string, string>>,
    payload: string,
    beforeSend: () => Promise<boolean>,
  ): Promise<WakeDispatchResult>;
}

export interface RoutedNotification {
  actor: string;
  body: string;
  route: DirectedNotificationRoute;
  recipient?: string;
}

export interface CatchFilterShape {
  actor: string;
  body: string;
  reach?: Reach;
  recipients?: readonly string[];
}

export interface DeliveryModel {
  plan(item: StoredAct): PlannedNotification[];
  pendingFor(recipient: string): PlannedNotification[];
}

function canonicalRecipient(squareState: SquareState, name: string): string {
  return resolveRosterName(squareState, name) ?? name;
}

export function isActivitySeen(squareState: SquareState, name: string, actOrIndex: StoredAct | number): boolean {
  const index = typeof actOrIndex === 'number' ? actOrIndex : actOrIndex.index;
  return observationFor(squareState, canonicalRecipient(squareState, name), index)?.state === 'seen';
}

/**
 * Derive delivery behavior once from the decoded Square state.
 * All consumers share these targets instead of reinterpreting artifact text or cursor state.
 */
export function deriveDeliveryModel(squareState: SquareState): DeliveryModel {
  const roster = rosterNames(squareState).filter((name) => isCurrentlyJoined(squareState.acts, name));
  const plannedByIndex = new Map<number, PlannedNotification[]>();
  let pendingByRecipient: Map<string, PlannedNotification[]> | undefined;

  function plan(item: StoredAct): PlannedNotification[] {
    if (item.kind !== 'say') return [];
    const cached = plannedByIndex.get(item.index);
    if (cached !== undefined) return [...cached];
    const sayItem = item as SayItem;
    const audience = audienceOf(sayItem);
    const recipients = audienceBefore(squareState.acts, sayItem);
    const planned = recipients.map((recipient) => {
      const route: DirectedNotificationRoute = audience.kind === 'bell'
        ? 'bell'
        : matchesMentionTarget(sayItem, recipient) ? 'mention' : 'attention';
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
      const joinedAfter = new Map(roster.map((name) => [name, lastJoinIndex(squareState.acts, name)]));

      for (const act of squareState.acts) {
        if (act.kind !== 'say') continue;
        for (const planned of plan(act)) {
          const joinedAt = joinedAfter.get(planned.recipient);
          if (joinedAt === undefined || act.index <= joinedAt) continue;
          if (isActivitySeen(squareState, planned.recipient, act.index)) continue;
          pendingByRecipient.get(planned.recipient)?.push(planned);
        }
      }
    }
    return [...(pendingByRecipient.get(recipient) ?? [])];
  }

  return { plan, pendingFor };
}

export function planActNotifications(squareState: SquareState, item: StoredAct): PlannedNotification[] {
  return deriveDeliveryModel(squareState).plan(item);
}

export function perceiveActivity(squareState: SquareState, item: StoredAct, viewer: string): Perception {
  if (item.kind !== 'say' || sameName(item.actor, viewer)) return 'full';
  return deriveDeliveryModel(squareState).plan(item).some((planned) => sameName(planned.recipient, viewer))
    ? 'full'
    : 'presence';
}

/** Mark only the notifications selected by the canonical catch projection as fully seen. */
export function markSeenNotifications(squareState: SquareState, recipient: string, delivered: StoredAct[], at = Date.now()): boolean {
  const deliveredIndexes = new Set(delivered.map((item) => item.index));
  let changed = false;
  for (const notification of deriveDeliveryModel(squareState).pendingFor(recipient)) {
    if (!deliveredIndexes.has(notification.item.index)) continue;
    changed = recordObservation(squareState, notification.recipient, notification.item.index, 'seen', at) || changed;
  }
  return changed;
}

/** Canonical say-activity filter shared by catch selection and hook ownership. */
export function matchesCatchFilter(activity: CatchFilterShape, filter: WatchLeaseFilter): boolean {
  if (
    filter.participants !== undefined &&
    !filter.participants.some((participant) => sameName(participant, activity.actor))
  ) {
    return false;
  }
  if (audienceOf(activity).kind === 'bell') return true;
  if (filter.mention === undefined) return true;
  return activity.recipients?.some((recipient) => sameName(recipient, filter.mention!)) === true
    || matchesMentionTarget(activity, filter.mention);
}

/** True only when the live catch's own filters would deliver this notification. */
export function leaseOwnsNotification(lease: WatchLease, notification: RoutedNotification): boolean {
  if (
    lease.filter?.mention !== undefined
    && notification.route !== 'bell'
    && notification.recipient !== undefined
    && !sameName(lease.filter.mention, notification.recipient)
  ) return false;
  return matchesCatchFilter(
    {
      actor: notification.actor,
      body: notification.body,
      ...(notification.recipient === undefined ? {} : { recipients: [notification.recipient] }),
      ...(notification.route === 'bell' ? { reach: 'bell' as const } : {}),
    },
    lease.filter ?? {}
  );
}
