import { notificationFacts, type DirectedNotificationRoute, type Owner, type WakeAddress, type WatchLease } from './model.js';
import type { DeliveryEvidence, DirectedHead, ParticipantFact, SquareArtifactPort, SquareRead, WakeRequest } from './ports.js';
import { renderAttentionPreview, renderSquareReminder } from './attention-presentation.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { automaticDispatchEligible, presentationBlocksDispatch } from './delivery-attempts.js';
import type { Attempt } from './delivery-attempts.js';
import { matchesCatchSelection } from './catch-selection.js';
import { freshWatchLease } from './runtime.js';
import { asSeatRef } from './seats.js';

export type { DirectedNotificationRoute } from './model.js';
/** Exact stored activity projection for transports that send an awareness reminder. */
export function wakePreview(facts: SquareRead, request: WakeRequest): string | undefined {
  const index = parseActivityId(request.activity);
  const head = index === undefined ? undefined : pendingHead(facts, request.participant, index);
  const item = index === undefined ? undefined : facts.activity(index);
  const seat = facts.seat(request.participant);
  if (head === undefined || (item?.kind !== 'say' && item?.kind !== 'message') || seat === undefined || seat.attachment !== 'attached'
    || deliveryDeferralExpiry(facts, request.seat, item.index, Date.now()) !== undefined) return undefined;
  return renderSquareReminder([renderAttentionPreview({ squarePath: request.location, recipient: request.participant,
    ...notificationFacts(item, head.route) })]);
}
export interface RoutedNotification {
  actor: string;
  route: DirectedNotificationRoute;
  recipient: string;
}

function custody(evidence: readonly DeliveryEvidence[]): Pick<Attempt<unknown>, 'purpose' | 'outcome' | 'expiresAt'>[] {
  return evidence.map(row => ({ purpose: row.kind === 'wake' ? 'dispatch' : 'presentation', outcome: row.outcome, expiresAt: row.expiresAt }));
}

/** Presentation custody blocks a wake, independently of native wake acceptance. */
export function presentationBlocksWake(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return presentationBlocksDispatch(custody(evidence), now);
}

/** Preselection only: an expired wake dispatch is uncertain, never safe automatic replay. */
export function automaticWakeEligible(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return automaticDispatchEligible(custody(evidence), now);
}

/** Notification pending is not cursor suffix or historical catch membership. */
export function pendingHead(facts: SquareRead, name: string, index: number): DirectedHead | undefined {
  const participant = facts.participant(name);
  if (!participant?.joined || facts.receipt(participant.name, index)) return undefined;
  return facts.directed(participant.name, { afterIndex: index - 1, throughIndex: index, currentGeneration: true }, { edge: 'oldest', limit: 1 }).items[0];
}

function sameWakeAddress(left: WakeAddress | undefined, right: WakeAddress | undefined): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  const keys = Object.keys(left.address);
  return keys.length === Object.keys(right.address).length && keys.every(key => left.address[key] === right.address[key]);
}

/** Current native eligibility shared by wake selection, preview and ACK. */
export interface NativePendingInput {
  readonly location: string;
  readonly participant: string; readonly generation: import('./model.js').ActivityId;
  readonly owner?: Owner; readonly index: number; readonly route: WakeAddress;
  readonly now: number; readonly cancelledThrough?: number;
}

export function nativePendingHead(facts: SquareRead, input: NativePendingInput): DirectedHead | undefined {
  const seat = facts.seat(input.participant);
  if (seat === undefined || seat.attachment !== 'attached' || seat.generation !== input.generation
    || input.owner !== undefined && seat.owner !== input.owner
    || !sameWakeAddress(seat.wakeAddress, input.route)) return undefined;
  const cancelledThrough = facts.cancelledThrough(seat.participant, seat.generation);
  if (input.index <= Math.max(input.cancelledThrough ?? -1, cancelledThrough ?? -1)) return undefined;
  if (deliveryDeferralExpiry(facts, asSeatRef(seat), input.index, input.now) !== undefined) return undefined;
  const head = pendingHead(facts, seat.participant, input.index);
  if (head === undefined) return undefined;
  const lease = freshWatchLease(facts, seat.participant, input.now);
  return lease !== undefined && leaseOwnsNotification(lease, { actor: head.actor, route: head.route, recipient: seat.participant })
    ? undefined : head;
}

/** One activity's landed recipients that still owe a wake; the rest of the roster is untouched. */
export function pendingRecipients(facts: SquareRead, index: number): DirectedHead[] {
  return facts.audience(index).flatMap(({ recipient, generation }) => {
    // A fenced address to an earlier generation cannot be pending; skip its exact lookup.
    const participant = facts.participant(recipient);
    if (!participant?.joined || generation !== undefined && generation !== formatActivityId(participant.lastJoinIndex!)) return [];
    const head = pendingHead(facts, recipient, index);
    return head === undefined ? [] : [head];
  });
}

/** Still-pending directed heads for one recipient, oldest first. Bodies belong to presentation. */
export function pendingHeads(facts: SquareRead, name: string): DirectedHead[] {
  const participant = facts.participant(name);
  if (!participant?.joined) return [];
  const heads: DirectedHead[] = [];
  let afterIndex = -1;
  for (;;) {
    const page = facts.directed(participant.name, { afterIndex, unseenOnly: true, currentGeneration: true }, { edge: 'oldest', limit: 100 });
    heads.push(...page.items);
    if (!page.hasMore) break;
    afterIndex = page.items.at(-1)!.index;
  }
  return heads;
}

export interface PendingScan {
  readonly roster: readonly ParticipantFact[];
  readonly throughIndex: number;
}
export function capturePendingScan(facts: SquareRead): PendingScan {
  return { roster: facts.roster().filter((participant) => participant.joined), throughIndex: facts.header().lastActIndex };
}
export function sameJoin(facts: SquareRead, captured: ParticipantFact): boolean {
  const current = facts.participant(captured.name);
  return current?.joined === captured.joined && current?.lastJoinIndex === captured.lastJoinIndex;
}

/** Finite bodyless pass: unrelated revisions never rewind the last examined group. */
export async function* pendingPages(artifact: SquareArtifactPort, scan: PendingScan, afterIndex = -1) {
  const captured = new Map(scan.roster.map((participant) => [participant.name, participant]));
  while (afterIndex < scan.throughIndex) {
    const { value: page } = await artifact.read((facts) => {
      const page = facts.pendingAudience(afterIndex, scan.throughIndex, 100);
      return { ...page, groups: page.groups.map((group) => ({ ...group, recipients: group.recipients.filter((recipient) => {
        const participant = captured.get(recipient.recipient);
        return participant !== undefined && sameJoin(facts, participant);
      }) })) };
    });
    yield page.groups.flatMap((group) => group.recipients.map(({ recipient, route }) => ({
      index: group.index, at: group.at, actor: group.actor, recipient, route,
    })));
    if (!page.hasMore) break;
    afterIndex = page.groups.at(-1)!.index;
  }
}

/** A pass retains only its captured joins; routes and individual receipts are fresh. */
export function pendingFacts(facts: SquareRead, scan: PendingScan, heads: readonly DirectedHead[]) {
  const joined = new Set(scan.roster.filter((participant) => sameJoin(facts, participant)).map((participant) => participant.name));
  return { pending: heads.filter((head) => joined.has(head.recipient)
    && pendingHead(facts, head.recipient, head.index) !== undefined) };
}

/** Global discovery alone sweeps pendingAudience; exact dispatch uses pendingRecipients. */
export async function collectPending(artifact: SquareArtifactPort) {
  const { value: scan } = await artifact.read(capturePendingScan);
  const pending: DirectedHead[] = [];
  for await (const page of pendingPages(artifact, scan)) pending.push(...page);
  const { value } = await artifact.read((facts) => ({ scan, ...pendingFacts(facts, scan, pending) }));
  return value;
}

/** A live catch owns every matching notification, independent of its page size. */
export function leaseOwnsNotification(lease: WatchLease, notification: RoutedNotification): boolean {
  // Agora catch selects say only; it must never hold a native message it cannot consume.
  if (notification.route === 'message') return false;
  return matchesCatchSelection(notification.actor, notification.route === 'bell' ? { kind: 'bell' }
    : { kind: 'mentions', names: notification.route === 'mention' ? [notification.recipient] : [] }, lease.filter ?? {},
  notification.route === 'reply' ? notification.recipient : undefined);
}
