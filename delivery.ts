import {
  type DeliveryReceipt,
  type SquareDoc,
  type SquareRuntimeState,
  type StoredAct,
  type WatchLease,
  type WatchLeaseFilter,
  type Reach,
  findParticipantName,
  sameName,
} from './model.js';
import { actId, extractMentions, isCurrentlyJoined, lastJoinIndex, matchesMentionTarget, resolveRosterName, rosterNames } from './runtime.js';

export type NotificationRoute = 'mention' | 'beside' | 'broadcast' | 'bell';
export type DirectedNotificationRoute = Exclude<NotificationRoute, 'broadcast'>;
export type SayItem = StoredAct & { kind: 'say' };

export function notificationMessageId(squarePath: string, actIndex: number): string {
  return `square:${squarePath}#act_${actIndex}`;
}

export interface PlannedNotification {
  item: SayItem;
  recipient: string;
  route: NotificationRoute;
}

export interface PendingNotification extends PlannedNotification {
  route: DirectedNotificationRoute;
}

export interface WakeSinkContext { squarePath: string; }
export interface NotificationSink {
  name: string;
  dispatch(notification: PendingNotification, ctx: WakeSinkContext): Promise<void>;
}

export function isPendingNotification(notification: PlannedNotification): notification is PendingNotification {
  return notification.route !== 'broadcast';
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
}

export interface DeliveryModel {
  plan(item: StoredAct): PlannedNotification[];
  pendingFor(recipient: string): PendingNotification[];
}

function canonicalRecipient(doc: SquareDoc, name: string): string {
  return resolveRosterName(doc, name) ?? name;
}

/** Delivery receipts are the only durable acknowledgement of directed attention. */
export function deliveryReceipt(doc: SquareDoc, name: string, actOrIndex: StoredAct | number): DeliveryReceipt | undefined {
  return deliveryReceiptFromRuntime(doc.runtime, canonicalRecipient(doc, name), actOrIndex);
}

export function deliveryReceiptFromRuntime(runtime: SquareRuntimeState, recipient: string, actOrIndex: StoredAct | number): DeliveryReceipt | undefined {
  return runtime.deliveryReceipts[recipient]?.[actId(actOrIndex)];
}

export function isDeliveryDelivered(doc: SquareDoc, name: string, actOrIndex: StoredAct | number): boolean {
  return deliveryReceipt(doc, name, actOrIndex)?.status === 'delivered';
}

export function recordDeliveredDelivery(doc: SquareDoc, name: string, actOrIndex: StoredAct | number, receipt: Omit<DeliveryReceipt, 'status'>): boolean {
  return recordDeliveredRuntime(doc.runtime, canonicalRecipient(doc, name), actOrIndex, receipt);
}

export function recordDeliveredRuntime(runtime: SquareRuntimeState, recipient: string, actOrIndex: StoredAct | number, receipt: Omit<DeliveryReceipt, 'status'>): boolean {
  const id = actId(actOrIndex);
  if (deliveryReceiptFromRuntime(runtime, recipient, actOrIndex)?.status === 'delivered') return false;
  (runtime.deliveryReceipts[recipient] ??= {})[id] = { status: 'delivered', ...receipt };
  return true;
}

export function markDeliveredDelivery(doc: SquareDoc, name: string, actOrIndex: StoredAct | number, at = Date.now()): boolean {
  return recordDeliveredDelivery(doc, name, actOrIndex, { at });
}

function uniqueKnownMentions(body: string, roster: string[]): string[] {
  const recipients: string[] = [];
  for (const mention of extractMentions(body)) {
    const known = findParticipantName(roster, mention);
    if (known !== undefined && !recipients.some((recipient) => sameName(recipient, known))) {
      recipients.push(known);
    }
  }
  return recipients;
}

/**
 * Derive delivery behavior once from the parsed Square document.
 * All consumers share these targets instead of reinterpreting artifact text or cursor state.
 */
export function deriveDeliveryModel(doc: SquareDoc): DeliveryModel {
  const roster = rosterNames(doc).filter((name) => isCurrentlyJoined(doc.acts, name));
  let pendingByRecipient: Map<string, PendingNotification[]> | undefined;

  function plan(item: StoredAct): PlannedNotification[] {
    if (item.kind !== 'say') return [];
    const sayItem = item as SayItem;
    const actor = sayItem.actor;
    if (sayItem.reach === 'bell') {
      return roster
        .filter((recipient) => !sameName(recipient, actor))
        .map((recipient) => ({ item: sayItem, recipient, route: 'bell' }));
    }
    if (sayItem.reach !== undefined) {
      const recipient = findParticipantName(roster, sayItem.reach.beside);
      return recipient === undefined || sameName(recipient, actor)
        ? []
        : [{ item: sayItem, recipient, route: 'beside' }];
    }
    const mentions = uniqueKnownMentions(sayItem.body, roster).filter(
      (recipient) => !sameName(recipient, actor)
    );
    const recipients = mentions.length > 0
      ? mentions
      : roster.filter((recipient) => !sameName(recipient, actor));
    const route: NotificationRoute = mentions.length > 0 ? 'mention' : 'broadcast';
    return recipients.map((recipient) => ({ item: sayItem, recipient, route }));
  }

  function pendingFor(requestedRecipient: string): PendingNotification[] {
    const recipient = findParticipantName(roster, requestedRecipient);
    if (recipient === undefined) return [];
    if (pendingByRecipient === undefined) {
      pendingByRecipient = new Map(roster.map((name) => [name, []]));
      const joinedAfter = new Map(roster.map((name) => [name, lastJoinIndex(doc.acts, name)]));

      for (const act of doc.acts) {
        if (act.kind !== 'say') continue;
        // Broadcasts can never be pending directed notifications. Skipping them here
        // avoids allocating one planned notification per participant per activity.
        if (act.reach === undefined && extractMentions(act.body).length === 0) continue;
        for (const planned of plan(act)) {
          if (planned.route === 'broadcast') continue;
          const joinedAt = joinedAfter.get(planned.recipient);
          if (joinedAt === undefined || act.index <= joinedAt) continue;
          if (isDeliveryDelivered(doc, planned.recipient, act.index)) continue;
          pendingByRecipient.get(planned.recipient)?.push({ ...planned, route: planned.route });
        }
      }
    }
    return [...(pendingByRecipient.get(recipient) ?? [])];
  }

  return { plan, pendingFor };
}

export function planActNotifications(doc: SquareDoc, item: StoredAct): PlannedNotification[] {
  return deriveDeliveryModel(doc).plan(item);
}

/** Mark only the directed notifications selected by the canonical pending projection. */
export function markDeliveredNotifications(doc: SquareDoc, recipient: string, delivered: StoredAct[], at = Date.now()): boolean {
  const deliveredIndexes = new Set(delivered.map((item) => item.index));
  let changed = false;
  for (const notification of deriveDeliveryModel(doc).pendingFor(recipient)) {
    if (!deliveredIndexes.has(notification.item.index)) continue;
    changed = recordDeliveredDelivery(doc, notification.recipient, notification.item.index, { at }) || changed;
  }
  return changed;
}

/** Canonical say-activity filter shared by catch selection and hook ownership. */
export function matchesCatchFilter(activity: CatchFilterShape, filter: WatchLeaseFilter): boolean {
  if (activity.reach === 'bell') return true;
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
  const recipient = notification.recipient;
  if (notification.route === 'beside' && recipient === undefined) return false;
  return matchesCatchFilter(
    {
      actor: notification.actor,
      body: notification.body,
      reach: notification.route === 'bell'
        ? 'bell'
        : notification.route === 'beside'
          ? { beside: recipient! }
          : undefined,
    },
    lease.filter ?? {}
  );
}
