import type { DirectedNotificationRoute, StoredAct, WatchLease } from './model.js';
import type { DeliveryEvidence, DirectedHead, ParticipantFact, SquareArtifactPort, SquareRead, WakeRequest } from './ports.js';
import { renderAttentionPreview, renderSquareReminder } from './attention-presentation.js';
import { parseActivityId } from './square-core.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { matchesCatchSelection } from './catch-selection.js';

export type { DirectedNotificationRoute } from './model.js';
export type SayItem = StoredAct & { kind: 'say' };
export interface PlannedNotification {
  item: SayItem;
  recipient: string;
  route: DirectedNotificationRoute;
}
/** Exact stored activity projection for transports that send an awareness reminder. */
export function wakePreview(facts: SquareRead, request: WakeRequest): string | undefined {
  const index = parseActivityId(request.activity);
  const head = index === undefined ? undefined : pendingHead(facts, request.participant, index);
  const item = index === undefined ? undefined : facts.activity(index);
  const seat = facts.seat(request.participant);
  if (head === undefined || item?.kind !== 'say' || seat === undefined || seat.attachment !== 'attached'
    || deliveryDeferralExpiry(facts, request.seat, item.index, Date.now()) !== undefined) return undefined;
  return renderSquareReminder([renderAttentionPreview({
    squarePath: request.location, recipient: request.participant, actIndex: item.index,
    actor: item.actor, route: head.route, body: item.body ?? '(structured activity)',
  })]);
}
export interface RoutedNotification {
  actor: string;
  route: DirectedNotificationRoute;
  recipient: string;
}

/** Presentation custody blocks a wake, independently of native wake acceptance. */
export function presentationBlocksWake(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return evidence.some((row) => row.kind === 'presentation'
    && (row.outcome === 'presented' || row.outcome === 'clipped' || row.outcome === 'unknown'
      || row.outcome === 'dispatching' && (row.expiresAt === undefined || row.expiresAt > now)));
}

/** Preselection only: an expired wake dispatch is uncertain, never safe automatic replay. */
export function automaticWakeEligible(evidence: readonly DeliveryEvidence[], now: number): boolean {
  return !presentationBlocksWake(evidence, now) && !evidence.some((row) => row.kind === 'wake'
    && (row.outcome === 'accepted' || row.outcome === 'unknown' || row.outcome === 'dispatching'));
}

/** Notification pending is not cursor suffix or historical catch membership. */
export function pendingHead(facts: SquareRead, name: string, index: number): DirectedHead | undefined {
  const participant = facts.participant(name);
  if (!participant?.joined || index <= (participant.lastJoinIndex ?? -1) || facts.receipt(participant.name, index)) return undefined;
  return facts.directedAt(participant.name, index);
}

/** One activity's landed recipients that still owe a wake; the rest of the roster is untouched. */
export function pendingRecipients(facts: SquareRead, index: number): DirectedHead[] {
  return facts.audience(index).flatMap(({ recipient }) => {
    const head = pendingHead(facts, recipient, index);
    return head === undefined ? [] : [head];
  });
}

/** Still-pending directed heads for one recipient, oldest first. Bodies belong to presentation. */
export function pendingHeads(facts: SquareRead, name: string): DirectedHead[] {
  const participant = facts.participant(name);
  if (!participant?.joined) return [];
  const heads: DirectedHead[] = [];
  let afterIndex = participant.lastJoinIndex ?? -1;
  for (;;) {
    const page = facts.directed(participant.name, { afterIndex, unseenOnly: true }, { edge: 'oldest', limit: 100 });
    heads.push(...page.items);
    if (!page.hasMore) break;
    afterIndex = page.items.at(-1)!.index;
  }
  return heads;
}

/** Complete recipient projection, assembled inside its one transaction. */
export function pendingNotifications(facts: SquareRead, name: string): PlannedNotification[] {
  const heads = pendingHeads(facts, name), recipient = heads[0]?.recipient ?? name;
  const routes = new Map(heads.map((head) => [head.index, head.route]));
  return facts.activities(heads.map((head) => head.index)).flatMap((item) => item.kind === 'say'
    ? [{ item, recipient, route: routes.get(item.index)! }] : []);
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
  return matchesCatchSelection(notification.actor, notification.route === 'bell' ? { kind: 'bell' }
    : { kind: 'mentions', names: notification.route === 'mention' ? [notification.recipient] : [] }, lease.filter ?? {},
  notification.route === 'reply' ? notification.recipient : undefined);
}
