import type { Act, ActivityId, Owner, HardCap, Seat, StoredAct, WakeAddress, WakeRoute, WatchLease } from './model.js';
import type { MetadataMatch, DeliveryDeferralFact } from './delivery-deferral.js';

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
  readonly actor?: string;
  readonly reach?: 'bell';
  readonly reply?: ActivityIndex;
}
export interface ActivityFilter {
  readonly afterIndex?: number;
  readonly beforeIndex?: number;
  readonly throughIndex?: number;
  readonly indexes?: readonly ActivityIndex[];
  readonly kinds?: readonly StoredAct['kind'][];
  readonly actors?: readonly string[];
  readonly actorMatch?: 'identity' | 'exact';
  readonly actorRequired?: true;
  readonly afterAt?: number;
}
export interface IndexPage { readonly edge: 'oldest' | 'newest'; readonly limit: number }
export interface FactPage<T> { readonly items: readonly T[]; readonly hasMore: boolean }
export interface DirectedFilter {
  readonly afterIndex?: number;
  readonly beforeIndex?: number;
  readonly throughIndex?: number;
  readonly unseenOnly?: true;
  readonly senders?: readonly string[];
  readonly attentionOnly?: true;
}
export interface DirectedHead {
  readonly index: ActivityIndex;
  readonly at: number;
  readonly actor: string;
  readonly recipient: string;
  readonly route: 'mention' | 'reply' | 'attention' | 'bell';
}
export interface LandedRecipient { readonly recipient: string; readonly route: DirectedHead['route'] }
export interface ReceiptFacts { readonly latestAt?: number; readonly latestActorActivityIndex?: number }
export interface ReceiptAssignment { readonly owner: string; readonly index: ActivityIndex }
export type SeatRef = Pick<Seat, 'participant' | 'owner' | 'generation'>;
export type ArtifactWriteAuthority =
  | { readonly kind: 'participant'; readonly seat: SeatRef }
  | { readonly kind: 'host-cleanup'; readonly seat: SeatRef }
  | { readonly kind: 'join'; readonly participant: string; readonly owner: Owner; readonly wakeAddress?: WakeAddress }
  | { readonly kind: 'takeover'; readonly participant: string; readonly owner: Owner; readonly expectedGeneration: ActivityId; readonly wakeAddress?: WakeAddress };
export interface DeliveryEvidence {
  readonly participant: string;
  readonly generation: ActivityId;
  readonly activity: ActivityId;
  readonly kind: 'wake' | 'presentation';
  readonly outcome: 'dispatching' | 'accepted' | 'failed' | 'unknown' | 'released' | 'presented' | 'clipped';
  readonly attemptN: number;
  readonly at: number;
  readonly expiresAt?: number;
  readonly claimToken?: string;
  readonly route?: WakeAddress;
  readonly signature?: string;
  readonly message?: string;
  readonly diagnostic?: import('./model.js').JsonValue;
  readonly correlation?: { readonly harness: 'claude' | 'opencode' | 'pi'; readonly token?: string; readonly messageId?: string; readonly payloadHash?: string };
  readonly nativeObservations?: readonly { readonly eventId: string; readonly messageId: string; readonly state: 'held' | 'released' | 'dropped'; readonly reason?: string; readonly observedAt: number }[];
}
export interface DeliveryClaimInput {
  readonly seat: SeatRef;
  readonly activity: ActivityId;
  readonly kind: 'wake' | 'presentation';
  readonly route?: WakeAddress;
  readonly at: number;
  readonly leaseMs: number;
  readonly claimToken: string;
}
export type DeliveryClaimResult =
  | { readonly status: 'acquired'; readonly claimToken: string; readonly attemptN: number }
  | { readonly status: 'busy' | 'terminal' | 'stale' | 'deferred'; readonly evidence?: DeliveryEvidence };
export interface DeliveryPreparation {
  readonly seat: SeatRef;
  readonly claimToken: string;
  readonly correlation: NonNullable<DeliveryEvidence['correlation']>;
}
export interface DeliveryCompletion {
  readonly seat: SeatRef;
  readonly activity: ActivityId;
  readonly claimToken: string;
  readonly outcome: Exclude<DeliveryEvidence['outcome'], 'dispatching'>;
  readonly at: number;
  readonly signature?: string;
  readonly message?: string;
  readonly diagnostic?: import('./model.js').JsonValue;
  readonly correlation?: DeliveryEvidence['correlation'];
}
/** Domain facts exist only during a synchronous artifact callback. Values are detached. */
export interface SquareRead {
  seat(requestedName: string): Seat | undefined;
  seatsForOwner(owner: Owner): readonly Seat[];
  deliveryEvidence(participant: string, generation: ActivityId, activity?: ActivityId): readonly DeliveryEvidence[];
  deliveryByToken(claimToken: string): DeliveryEvidence | undefined;
  cancelledThrough(participant: string, generation: ActivityId): number | undefined;
  header(): SquareHeader;
  participant(requestedName: string): ParticipantFact | undefined;
  participantCounts(): ParticipantCounts;
  roster(): readonly ParticipantFact[];
  attention(listener: string): readonly AttentionFact[];
  incomingAttention(sender: string): readonly AttentionFact[];
  hold(): { readonly active: boolean; readonly at?: number; readonly reason?: string; readonly actor?: string };
  activity(index: ActivityIndex): StoredAct | undefined;
  activityHeads(filter: ActivityFilter, page: IndexPage): FactPage<ActivityHead>;
  activities(indexes: readonly ActivityIndex[]): readonly StoredAct[];
  activityCount(filter: ActivityFilter): number;
  contextIndexes(centers: readonly ActivityIndex[], before: number, after: number): readonly ActivityIndex[];
  sayOrdinals(indexes: readonly ActivityIndex[]): Readonly<Record<number, number>>;
  recentSayTimes(afterExclusive: number, takeLatest: number, actor?: string, bellOnly?: true): readonly number[];
  audience(index: ActivityIndex): readonly LandedRecipient[];
  directed(recipient: string, filter: DirectedFilter, page: IndexPage): FactPage<DirectedHead>;
  directedAt(recipient: string, index: ActivityIndex): DirectedHead | undefined;
  directedCount(recipient: string, filter: DirectedFilter): number;
  pendingAudience(afterExclusive: number, throughInclusive: number, activityLimit: number): {
    readonly groups: readonly { readonly index: ActivityIndex; readonly at: number; readonly actor: string; readonly recipients: readonly LandedRecipient[] }[];
    readonly hasMore: boolean;
  };
  receipt(requestedName: string, index: ActivityIndex): { readonly at: number } | undefined;
  receiptFacts(requestedName: string, afterIndex: number): ReceiptFacts;
  receiptAssignments(): readonly ReceiptAssignment[];
  lease(requestedName: string): WatchLease | undefined;
  deliveryDeferrals(participant: string, generation: ActivityId): readonly DeliveryDeferralFact[];
}
export interface SquareWrite extends SquareRead {
  land(activity: Act & { readonly at: number }): StoredAct;
  updateWakeAddress(seat: SeatRef, wakeAddress?: WakeAddress): boolean;
  /** Join authority only; preserves membership and its establishing generation. */
  reattachSeat(seat: SeatRef, wakeAddress?: WakeAddress): boolean;
  /** Host-cleanup authority only; stale/already-detached coordinates are a no-op. */
  detachSeat(seat: SeatRef): boolean;
  cancelThrough(seat: SeatRef, through: ActivityIndex): boolean;
  claimDelivery(input: DeliveryClaimInput): DeliveryClaimResult;
  prepareDelivery(input: DeliveryPreparation): boolean;
  completeDelivery(input: DeliveryCompletion): boolean;
  observeNativeDelivery(input: { readonly seat: SeatRef; readonly claimToken: string; readonly observation: NonNullable<DeliveryEvidence['nativeObservations']>[number] }): boolean;
  markSeen(requestedName: string, indexes: readonly ActivityIndex[], at: number): number;
  putLease(requestedName: string, lease: WatchLease, generation?: ActivityId): boolean;
  removeLease(requestedName: string, expectedLeaseId: string, generation?: ActivityId): boolean;
  putDeliveryDeferral(seat: SeatRef, id: string, match: MetadataMatch, expiresAt: number, now: number): boolean;
  renewDeliveryDeferral(seat: SeatRef, id: string, expiresAt: number, now: number): boolean;
  releaseDeliveryDeferral(seat: SeatRef, id: string, now: number): boolean;
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
  /** Persist suppression through a fixed index, or atomically capture the current artifact head. */
  cancelDeliveries(seat: SeatRef, through?: ActivityIndex, signal?: AbortSignal): Promise<boolean>;
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

/** Sole wake executor protocol; implementations own only transport readiness and sending. */
export interface WakeTransportPort {
  /** Capability check that performs no external wake and writes no evidence. */
  probe?(route: WakeRoute): Promise<boolean | { readonly outcome: 'not-capable'; readonly diagnostic?: string }>;
  attempt(request: WakeRequest, timeoutMs: number, beforeSend: () => Promise<boolean>): Promise<WakeOutcome>;
}

export interface WakeRequest {
  readonly location: string;
  readonly participant: string;
  readonly activity: string;
  readonly actor: string;
  readonly seat: SeatRef;
  readonly claimToken?: string;
  readonly attemptN?: number;
  readonly route: WakeRoute;
  /** Artifact context for native adapters that must persist correlation before I/O. */
  readonly artifact?: SquareArtifactPort;
}

/** Executor-neutral presentation capability; intentionally separate from wake transport. */
export interface PresentationSinkPort {
  present(activity: StoredAct): void | Promise<void>;
}

export type WakeOutcome =
  | { readonly outcome: 'accepted'; readonly signature?: string }
  | { readonly outcome: 'failed'; readonly message?: string; readonly signature?: string; readonly diagnostic?: unknown }
  | { readonly outcome: 'not-capable'; readonly diagnostic?: string }
  | { readonly outcome: 'unknown'; readonly signature?: string; readonly message?: string; readonly diagnostic?: unknown };

export interface DeliverPendingInput {
  readonly artifact: SquareArtifactPort;
  readonly transport: WakeTransportPort;
  readonly location: string;
  readonly timeoutMs?: number;
  readonly now?: number;
  readonly activity?: string | number;
}

export interface PresentationResult {
  readonly presented: boolean;
  readonly activity?: StoredAct;
}

export interface PresentPendingInput {
  readonly artifact: SquareArtifactPort;
  readonly location: string;
  readonly participant: string;
  readonly activity: string | number;
  readonly sink: PresentationSinkPort;
  /** Captured artifact seat; used to fence both presentation and consumption. */
  readonly seat?: SeatRef;
  readonly generation?: ActivityId;
  readonly now?: number;
  readonly timeoutMs?: number;
  /** Pre-effect work control only; successful sink evidence settles independently, with a bounded lifetime. */
  readonly signal?: AbortSignal;
  /** Boundary previews that were clipped remain pending for a later full presentation. */
  readonly markSeen?: boolean;
  /** Receiver-specific pre-effect eligibility, never a veto of an already successful sink. */
  readonly current?: (facts: SquareRead) => boolean;
}
