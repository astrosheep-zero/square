import type { DirectedNotificationRoute, StoredAct, WatchLease, WakeRouteKind } from './model.js';
import type { DirectedHead, ParticipantFact, SquareArtifactPort, SquareRead, WakeOutcome } from './ports.js';
import { matchesCatchSelection } from './catch-selection.js';

export type { DirectedNotificationRoute } from './model.js';
export type SayItem = StoredAct & { kind: 'say' };
export interface PlannedNotification {
  item: SayItem;
  recipient: string;
  route: DirectedNotificationRoute;
}
/** gate-rejected means the supplied beforeSend returned false and nothing was sent. */
export type WakeAdapterResult = Exclude<WakeOutcome, { outcome: 'not-capable' }> | { outcome: 'gate-rejected' };
/** One attempt's stable coordinates; retries reuse its dedup key. */
export interface WakeDispatchContext {
  readonly location: string;
  readonly participant: string;
  readonly activity: string;
  readonly attemptN?: number;
}
export interface WakeAdapter {
  readonly kind: WakeRouteKind;
  dispatch(address: Readonly<Record<string, string>>, payload: string, beforeSend: () => Promise<boolean>, timeoutMs?: number, context?: WakeDispatchContext): Promise<WakeAdapterResult>;
}
export interface RoutedNotification {
  actor: string;
  route: DirectedNotificationRoute;
  recipient: string;
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
