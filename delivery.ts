import path from 'node:path';

import {
  SquareError,
  type DeliveryReceipt,
  type DirectedNotificationRoute,
  type SquareState,
  type SquareRuntimeState,
  type StoredAct,
  type WatchLease,
  type WatchLeaseFilter,
  type WakeRoute,
  type WakeRouteKind,
  type Reach,
  findParticipantName,
  sameName,
} from './model.js';
import { canonicalSquarePath, localParticipantName } from './registry.js';
import { audienceOf, formatActivityId, resolveAudience } from './square-core.js';
import { actId, isCurrentlyJoined, lastJoinIndex, matchesMentionTarget, resolveRosterName, rosterNames } from './runtime.js';

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
}

export interface CatchFilterShape {
  actor: string;
  body: string;
  reach?: Reach;
}

export interface DeliveryModel {
  plan(item: StoredAct): PlannedNotification[];
  pendingFor(recipient: string): PlannedNotification[];
}

function canonicalRecipient(squareState: SquareState, name: string): string {
  return resolveRosterName(squareState, name) ?? name;
}

/** Delivery receipts are the only durable acknowledgement of directed attention. */
export function deliveryReceipt(squareState: SquareState, name: string, actOrIndex: StoredAct | number): DeliveryReceipt | undefined {
  return deliveryReceiptFromRuntime(squareState.runtime, canonicalRecipient(squareState, name), actOrIndex);
}

export function deliveryReceiptFromRuntime(runtime: SquareRuntimeState, recipient: string, actOrIndex: StoredAct | number): DeliveryReceipt | undefined {
  return runtime.deliveryReceipts[recipient]?.[actId(actOrIndex)];
}

export function isDeliveryDelivered(squareState: SquareState, name: string, actOrIndex: StoredAct | number): boolean {
  return deliveryReceipt(squareState, name, actOrIndex)?.status === 'delivered';
}

export function recordDeliveredDelivery(squareState: SquareState, name: string, actOrIndex: StoredAct | number, receipt: Omit<DeliveryReceipt, 'status'>): boolean {
  return recordDeliveredRuntime(squareState.runtime, canonicalRecipient(squareState, name), actOrIndex, receipt);
}

export function recordDeliveredRuntime(runtime: SquareRuntimeState, recipient: string, actOrIndex: StoredAct | number, receipt: Omit<DeliveryReceipt, 'status'>): boolean {
  const id = actId(actOrIndex);
  if (deliveryReceiptFromRuntime(runtime, recipient, actOrIndex)?.status === 'delivered') return false;
  (runtime.deliveryReceipts[recipient] ??= {})[id] = { status: 'delivered', ...receipt };
  return true;
}

export function markDeliveredDelivery(squareState: SquareState, name: string, actOrIndex: StoredAct | number, at = Date.now()): boolean {
  return recordDeliveredDelivery(squareState, name, actOrIndex, { at });
}

/**
 * Derive delivery behavior once from the decoded Square state.
 * All consumers share these targets instead of reinterpreting artifact text or cursor state.
 */
export function deriveDeliveryModel(squareState: SquareState): DeliveryModel {
  const roster = rosterNames(squareState).filter((name) => isCurrentlyJoined(squareState.acts, name));
  let pendingByRecipient: Map<string, PlannedNotification[]> | undefined;

  function plan(item: StoredAct): PlannedNotification[] {
    if (item.kind !== 'say') return [];
    const sayItem = item as SayItem;
    const audience = audienceOf(sayItem);
    const recipients = resolveAudience(audience, roster).filter((recipient) => !sameName(recipient, sayItem.actor));
    const route = audience.kind === 'bell' ? 'bell' : 'mention';
    return recipients.map((recipient) => ({ item: sayItem, recipient, route }));
  }

  function pendingFor(requestedRecipient: string): PlannedNotification[] {
    const recipient = findParticipantName(roster, requestedRecipient);
    if (recipient === undefined) return [];
    if (pendingByRecipient === undefined) {
      pendingByRecipient = new Map(roster.map((name) => [name, []]));
      const joinedAfter = new Map(roster.map((name) => [name, lastJoinIndex(squareState.acts, name)]));

      for (const act of squareState.acts) {
        if (act.kind !== 'say') continue;
        const audience = audienceOf(act);
        if (audience.kind === 'mentions' && audience.names.length === 0) continue;
        for (const planned of plan(act)) {
          const joinedAt = joinedAfter.get(planned.recipient);
          if (joinedAt === undefined || act.index <= joinedAt) continue;
          if (isDeliveryDelivered(squareState, planned.recipient, act.index)) continue;
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

/** Mark only the directed notifications selected by the canonical pending projection. */
export function markDeliveredNotifications(squareState: SquareState, recipient: string, delivered: StoredAct[], at = Date.now()): boolean {
  const deliveredIndexes = new Set(delivered.map((item) => item.index));
  let changed = false;
  for (const notification of deriveDeliveryModel(squareState).pendingFor(recipient)) {
    if (!deliveredIndexes.has(notification.item.index)) continue;
    changed = recordDeliveredDelivery(squareState, notification.recipient, notification.item.index, { at }) || changed;
  }
  return changed;
}

/** Canonical say-activity filter shared by catch selection and hook ownership. */
export function matchesCatchFilter(activity: CatchFilterShape, filter: WatchLeaseFilter): boolean {
  if (audienceOf(activity).kind === 'bell') return true;
  if (
    filter.participants !== undefined &&
    !filter.participants.some((participant) => sameName(participant, activity.actor))
  ) {
    return false;
  }
  return filter.mention === undefined || matchesMentionTarget(activity, filter.mention);
}

/** True only when the live catch's own filters would deliver this notification. */
export function leaseOwnsNotification(lease: WatchLease, notification: RoutedNotification): boolean {
  return matchesCatchFilter(
    {
      actor: notification.actor,
      body: notification.body,
      ...(notification.route === 'bell' ? { reach: 'bell' as const } : {}),
    },
    lease.filter ?? {}
  );
}

export type SquareRoute = Readonly<unknown>;

const SQUARE_ROUTE_KEYS = ['name', 'squarePath', 'v'] as const;

interface ParsedSquareRoute {
  readonly v: 1;
  readonly squarePath: string;
  readonly name: string;
}

function publicSquareFromCwd(cwd: string): string {
  return path.resolve(cwd, '.square', 'PUBLIC.square');
}

export function parseSquareRoute(value: unknown): ParsedSquareRoute {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SquareError('invalid_args', 'Malformed Square route');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== SQUARE_ROUTE_KEYS.length || keys.some((key, index) => key !== SQUARE_ROUTE_KEYS[index])) {
    throw new SquareError('invalid_args', 'Malformed Square route');
  }
  if (
    record.v !== 1 ||
    typeof record.squarePath !== 'string' || record.squarePath === '' ||
    typeof record.name !== 'string' || record.name === ''
  ) {
    throw new SquareError('invalid_args', 'Malformed Square route');
  }
  return {
    v: 1,
    squarePath: record.squarePath,
    name: record.name,
  };
}

export function captureRoute(input: { cwd: string; env?: NodeJS.ProcessEnv }): SquareRoute | null {
  const env = input.env ?? process.env;
  const squarePath = canonicalSquarePath(publicSquareFromCwd(input.cwd));
  const name = localParticipantName(squarePath, env);
  if (name === undefined) return null;
  return Object.freeze({
    v: 1,
    squarePath,
    name,
  });
}
