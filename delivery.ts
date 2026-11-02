import type { DirectedNotificationRoute, Owner, WakeAddress } from './model.js';
import type { MessageHead, SquareArtifactPort, SquareRead, EndpointGeneration } from './ports.js';
import { formatMessageId } from './message.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';

export type { DirectedNotificationRoute } from './model.js';

/** One lower pending message plus its upper reason when an Agora say created it. */
export interface PendingMessage {
  readonly index: number;
  readonly at: number;
  readonly actor: string;
  readonly recipient: string;
  readonly generation?: EndpointGeneration;
  /** Agora activity that shares this message, when one exists. */
  readonly activityIndex?: number;
  readonly route?: DirectedNotificationRoute;
}

export { pendingHeadAt, pendingMessageHeads, pendingAddresses, presentationBlocksWake, automaticWakeEligible } from './channel-delivery.js';
import { pendingHeadAt, pendingMessageHeads } from './channel-delivery.js';

/** Upper enrichment: the reason this recipient was reached, when an Agora say owns the message. */
function enriched(facts: SquareRead, head: MessageHead): PendingMessage {
  const relation = facts.activityByMessage(head.index);
  return { index: head.index, at: head.at, actor: head.from, recipient: head.recipient,
    ...(head.generation === undefined ? {} : { generation: head.generation }),
    ...(relation === undefined ? {} : { activityIndex: relation.index, route: facts.directedAt(head.recipient, relation.index)?.route }) };
}

/** Notification pending is not cursor suffix or historical catch membership. */
export function pendingHead(facts: SquareRead, name: string, index: number, now = Date.now()): PendingMessage | undefined {
  const head = pendingHeadAt(facts.channel, name, index, now);
  return head === undefined ? undefined : enriched(facts, head);
}

/** Current native eligibility shared by wake selection, preview and ACK. */
export interface NativePendingInput {
  readonly location: string;
  readonly participant: string;
  readonly generation: EndpointGeneration;
  readonly owner?: Owner;
  readonly index: number;
  readonly route: WakeAddress;
  readonly now: number;
  readonly cancelledThrough?: number;
}

export function nativePendingHead(facts: SquareRead, input: NativePendingInput): PendingMessage | undefined {
  const seat = facts.channel.endpoint(input.participant);
  if (seat === undefined || seat.attachment !== 'attached' || seat.generation !== input.generation
    || input.owner !== undefined && seat.owner !== input.owner
    || !sameWakeAddress(seat.wakeAddress, input.route)) return undefined;
  const cancelledThrough = facts.channel.cancelledThrough(seat.participant, seat.generation);
  if (input.index <= Math.max(input.cancelledThrough ?? -1, cancelledThrough ?? -1)) return undefined;
  if (deliveryDeferralExpiry(facts.channel, seat, input.index, input.now) !== undefined) return undefined;
  return pendingHead(facts, seat.participant, input.index, input.now);
}

/** Still-pending directed messages for one recipient, oldest first. Bodies belong to presentation. */
export function pendingHeads(facts: SquareRead, name: string, now = Date.now(), suppress = true): PendingMessage[] {
  return pendingMessageHeads(facts.channel, name, now, suppress).map(head => enriched(facts, head));
}

export interface PendingScan {
  readonly roster: readonly { readonly name: string; readonly generation?: string }[];
  readonly throughIndex: number;
}
export function capturePendingScan(facts: SquareRead): PendingScan {
  return { roster: facts.channel.endpoints().filter(endpoint => endpoint.attachment === 'attached').map(endpoint => ({ name: endpoint.participant, generation: endpoint.generation })),
    throughIndex: facts.channel.header().lastMessageIndex };
}
export function sameJoin(facts: SquareRead, captured: { readonly name: string; readonly generation?: string }): boolean {
  const current = facts.channel.endpoint(captured.name);
  return current?.attachment === 'attached' && current.generation === captured.generation;
}

/** Finite bodyless pass: unrelated revisions never rewind the last examined message. */
export async function* pendingPages(artifact: SquareArtifactPort, scan: PendingScan, afterIndex = -1) {
  const captured = new Map(scan.roster.map((participant) => [participant.name, participant]));
  let cursor = afterIndex;
  while (cursor < scan.throughIndex) {
    const { value: page } = await artifact.read((facts) => {
      const items = facts.channel.endpoints().filter(endpoint => endpoint.attachment === 'attached' && captured.has(endpoint.participant)).flatMap(endpoint =>
        facts.channel.directed(endpoint.participant, { afterIndex: cursor, throughIndex: scan.throughIndex, unseenOnly: true, currentGeneration: true }, { edge: 'oldest', limit: 100 }).items
          .filter(() => sameJoin(facts, captured.get(endpoint.participant)!))
          .map(head => enriched(facts, head)));
      return { items, next: items.at(-1)?.index, done: items.length === 0 };
    });
    yield page.items;
    if (page.done || page.next === undefined) break;
    cursor = page.next;
  }
}

/** A pass retains only its captured joins; routes and individual receipts are fresh. */
export function pendingFacts(facts: SquareRead, scan: PendingScan, heads: readonly PendingMessage[]) {
  const joined = new Set(scan.roster.filter((participant) => sameJoin(facts, participant)).map((participant) => participant.name));
  return { pending: heads.filter((head) => joined.has(head.recipient)
    && pendingHeadAt(facts.channel, head.recipient, head.index) !== undefined) };
}

/** Global discovery alone sweeps every endpoint; exact dispatch uses pendingAddresses. */
export async function collectPending(artifact: SquareArtifactPort) {
  const { value: scan } = await artifact.read(capturePendingScan);
  const pending: PendingMessage[] = [];
  for await (const page of pendingPages(artifact, scan)) pending.push(...page);
  const { value } = await artifact.read((facts) => ({ scan, ...pendingFacts(facts, scan, pending) }));
  return value;
}

function sameWakeAddress(left: WakeAddress | undefined, right: WakeAddress | undefined): boolean {
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  const keys = Object.keys(left.address);
  return keys.length === Object.keys(right.address).length && keys.every(key => left.address[key] === right.address[key]);
}
export { formatMessageId };
