import type { ActDraft, HydratedAct, SayRelation, Owner, HardCap, Seat, StoredAct, WakeAddress, WakeRoute, WatchLease } from './model.js';
import type { ActivitySearch } from './square-facade.js';
import type { IndexPage, FactPage } from './neutral.js';
export type { WakeTransportPort, WakePresentation, WakeProjectionContext, WakeProjection, WakeRequest, WakeOutcome } from './channel-transport.js';
export type { IndexPage, FactPage } from './neutral.js';
import type { ChannelArtifact, ChannelRead, ChannelWrite, ChannelWriteAuthority, ChannelDeliveryEvidence, ChannelDeliveryClaimInput, ChannelDeliveryClaimResult,
  ChannelDeliveryPreparation, ChannelDeliveryCompletion, MessageId, EndpointGeneration } from './channel-ports.js';
export type { ChannelArtifact, ChannelRead, ChannelWrite, ChannelWriteAuthority, ChannelHeader, MessageFact, MessageAddressFact, MessageHead, MessageFilter,
  MessageDraft, EndpointFact, EndpointRef, ReceiveClaimFact, ChannelDeliveryEvidence, ChannelDeliveryClaimInput,
  ChannelDeliveryClaimResult, ChannelDeliveryPreparation, ChannelDeliveryCompletion } from './channel-ports.js';

export type ActivityIndex = number;
export interface SquareHeader {
  readonly revision: number;
  readonly deliveryRevision: number;
  readonly nextActIndex: number;
  readonly lastActIndex: number;
  readonly hardCap: HardCap;
  readonly throttlePerMinute?: number;
  readonly preamble: readonly string[];
  readonly warmup: readonly string[];
}
export interface ParticipantFact {
  readonly name: string;
  readonly firstIndex: number;
  readonly joined: boolean;
  readonly done: boolean;
  readonly sayCount: number;
  readonly lastActiveAt?: number;
  readonly lastJoinIndex?: number;
}
export interface ParticipantCounts {
  readonly known: number;
  readonly joined: number;
  readonly done: number;
}
export interface AttentionFact {
  readonly listener: string;
  readonly target: string;
  readonly kind: 'listen' | 'ignore';
  readonly sinceIndex: number;
}
export interface ActivityHead {
  readonly index: ActivityIndex;
  readonly at: number;
  readonly kind: StoredAct['kind'];
  readonly actor: string;
  readonly reach?: 'bell';
  readonly reply?: ActivityIndex;
  readonly messageIndex?: number;
}
export interface ActivityFilter {
  readonly afterIndex?: number;
  readonly beforeIndex?: number;
  readonly throughIndex?: number;
  readonly indexes?: readonly ActivityIndex[];
  readonly kinds?: readonly StoredAct['kind'][];
  readonly actors?: readonly string[];
  readonly actorMatch?: 'identity' | 'exact';
  readonly afterAt?: number;
  /** Shared query predicates, applied before paging or counting. */
  readonly metadataMatch?: import('./delivery-deferral.js').MetadataMatch;
  readonly search?: ActivitySearch;
}
/** Upper attention filter over its own landed reasons and lower message addresses. */
export interface DirectedFilter extends Omit<ActivityFilter, 'actors' | 'actorMatch'> {
  readonly unseenOnly?: true;
  readonly currentGeneration?: true;
  readonly senders?: readonly string[];
  readonly attentionOnly?: true;
}
export interface DirectedHead {
  readonly index: ActivityIndex;
  readonly at: number;
  readonly actor: string;
  readonly recipient: string;
  readonly route: import('./model.js').DirectedNotificationRoute;
  readonly messageIndex: number;
  readonly generation?: EndpointGeneration;
}
export interface LandedRecipient {
  readonly recipient: string;
  readonly route: import('./model.js').DirectedNotificationRoute;
  readonly generation?: EndpointGeneration;
}
export interface ReceiptFacts { readonly latestAt?: number; readonly latestActorActivityIndex?: number }
export type SeatRef = Pick<Seat, 'participant' | 'owner' | 'generation'>;
export type ArtifactWriteAuthority = ChannelWriteAuthority
  | { readonly kind: 'host-cleanup'; readonly seat: SeatRef }
  | { readonly kind: 'join'; readonly participant: string; readonly owner: Owner; readonly wakeAddress?: WakeAddress }
  | { readonly kind: 'takeover'; readonly participant: string; readonly owner: Owner; readonly expectedGeneration: EndpointGeneration; readonly wakeAddress?: WakeAddress };
export type DeliveryEvidence = ChannelDeliveryEvidence;
export type DeliveryClaimInput = ChannelDeliveryClaimInput;
export type DeliveryClaimResult = ChannelDeliveryClaimResult;
export type DeliveryPreparation = ChannelDeliveryPreparation;
export type DeliveryCompletion = ChannelDeliveryCompletion;
export type { MessageId, EndpointGeneration };
/** Domain facts exist only during a synchronous artifact callback. Values are detached. */
export interface SquareRead {
  /** Lower Channel facts. Upper layers may use them; Channel never sees this composite. */
  readonly channel: ChannelRead;
  seat(requestedName: string): Seat | undefined;
  seatsForOwner(owner: Owner): readonly Seat[];
  deliveryEvidence(participant: string, generation: EndpointGeneration, message?: MessageId): readonly DeliveryEvidence[];
  deliveryByToken(claimToken: string): DeliveryEvidence | undefined;
  cancelledThrough(participant: string, generation: EndpointGeneration): number | undefined;
  header(): SquareHeader;
  participant(requestedName: string): ParticipantFact | undefined;
  participantCounts(): ParticipantCounts;
  roster(): readonly ParticipantFact[];
  attention(listener: string): readonly AttentionFact[];
  incomingAttention(sender: string): readonly AttentionFact[];
  activity(index: ActivityIndex): StoredAct | undefined;
  activityByMessage(messageIndex: number): SayRelation | undefined;
  activityHeads(filter: ActivityFilter, page: IndexPage): FactPage<ActivityHead>;
  /** The explicit content projection: each say resolved against its Channel message in one read. */
  activities(indexes: readonly ActivityIndex[]): readonly HydratedAct[];
  activityCount(filter: ActivityFilter): number;
  contextIndexes(centers: readonly ActivityIndex[], before: number, after: number): readonly ActivityIndex[];
  sayOrdinals(indexes: readonly ActivityIndex[]): Readonly<Record<number, number>>;
  recentSayTimes(afterExclusive: number, takeLatest: number, actor?: string, bellOnly?: true): readonly number[];
  audience(index: ActivityIndex): readonly LandedRecipient[];
  directed(recipient: string, filter: DirectedFilter, page: IndexPage): FactPage<DirectedHead>;
  directedAt(recipient: string, index: ActivityIndex): DirectedHead | undefined;
  directedCount(recipient: string, filter: DirectedFilter): number;
  receipt(requestedName: string, index: ActivityIndex): { readonly at: number } | undefined;
  receiptFacts(requestedName: string, afterIndex: number): ReceiptFacts;
  lease(requestedName: string): WatchLease | undefined;
  deliveryDeferrals(participant: string, generation: EndpointGeneration): readonly import('./delivery-deferral.js').DeliveryDeferralFact[];
}
export interface SquareWrite extends SquareRead {
  readonly channel: ChannelWrite;
  land(draft: ActDraft): StoredAct;
  updateWakeAddress(seat: SeatRef, wakeAddress?: WakeAddress): boolean;
  /** Join authority only; preserves membership and its establishing generation. */
  reattachSeat(seat: SeatRef, wakeAddress?: WakeAddress): boolean;
  /** Host-cleanup authority only; stale/already-detached coordinates are a no-op. */
  detachSeat(seat: SeatRef): boolean;
  /** Upper catch claim: the lease plus the message coverage it currently owns. */
  putLease(requestedName: string, lease: WatchLease, generation?: EndpointGeneration, suppressed?: readonly number[]): boolean;
  removeLease(requestedName: string, expectedLeaseId: string, generation?: EndpointGeneration): boolean;
}
export interface SquareReadResult<R> { readonly value: R; readonly version: number }
export interface SquareCommitResult<R> extends SquareReadResult<R> { readonly changed: boolean }
/** Atomic artifact access; no framing, SQL or lazy transaction capability escapes. */
export interface SquareArtifactPort {
  read<R>(select: (facts: SquareRead) => R, signal?: AbortSignal): Promise<SquareReadResult<R>>;
  /** Participant/domain writes must carry an explicit owner; no owner-less mutation path exists. */
  transactAs<R>(authority: ArtifactWriteAuthority, change: (facts: SquareWrite) => R, signal?: AbortSignal): Promise<SquareCommitResult<R>>;
  /** Bounded cleanup/evidence settlement on this same connection after custody was acquired.
   * Independent of request/lifetime cancellation; explicit close and authority fences still apply. */
  settleAs<R>(authority: ArtifactWriteAuthority, change: (facts: SquareWrite) => R): Promise<SquareCommitResult<R>>;
  revision(signal?: AbortSignal): Promise<number>;
  deliveryRevision(signal?: AbortSignal): Promise<number>;
  claimDelivery(input: DeliveryClaimInput, signal?: AbortSignal): Promise<DeliveryClaimResult>;
  prepareDelivery(input: DeliveryPreparation, signal?: AbortSignal): Promise<boolean>;
  completeDelivery(input: DeliveryCompletion, signal?: AbortSignal): Promise<boolean>;
  /** Persist suppression through a fixed message, or atomically capture the current artifact head. */
  cancelDeliveries(seat: SeatRef, through?: number, signal?: AbortSignal): Promise<boolean>;
  changed(sinceVersion: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
}

/** Explicit lifetime for an artifact connection reused by a long-lived caller.
 * Only the connection is shared: every open still derives its own environment,
 * clock, ledger and transport, and no request signal becomes a connection lifetime.
 * The owner holds one location and refuses a second rather than sharing the wrong
 * square; the caller lends the connection and never closes it. */
export interface SquareResourceOwner {
  /** The shared connection for a location. Never close it; the owner does. */
  artifact(location: string): SquareArtifactPort;
  close(): Promise<void>;
}

/** Executor-neutral presentation capability; intentionally separate from wake transport. */
export interface PresentationSinkPort {
  present(message: MessageFact): void | Promise<void>;
}

export interface PresentationResult {
  readonly presented: boolean;
  readonly message?: MessageFact;
}

export interface PresentPendingInput {
  readonly artifact: SquareArtifactPort;
  readonly location: string;
  readonly participant: string;
  readonly message: string | number;
  readonly sink: PresentationSinkPort;
  /** Existing wake observed by a native receiver; the sink must not inject content. */
  readonly observationOf?: string;
  /** Captured artifact seat; used to fence both presentation and consumption. */
  readonly seat?: SeatRef;
  readonly generation?: EndpointGeneration;
  readonly now?: number;
  readonly timeoutMs?: number;
  /** Pre-effect work control only; successful sink evidence settles independently, with a bounded lifetime. */
  readonly signal?: AbortSignal;
  /** Boundary previews that were clipped remain pending for a later full presentation. */
  readonly markSeen?: boolean;
  /** Receiver-specific pre-effect eligibility, never a veto of an already successful sink. */
  readonly current?: (facts: SquareRead) => boolean;
}

import type { MessageFact } from './channel-ports.js';
