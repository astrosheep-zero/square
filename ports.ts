import type { Act, HardCap, InboxNotification, StoredAct, WakeRoute, WakeRouteKind, WatchLease } from './model.js';
export type {
  ClaimResult,
  EvidenceClaim,
  EvidenceRelease,
  EvidenceLookup,
  EvidenceRecord,
  NativeTokenLookup,
  NativeTokenResult,
  HostLedgerPort,
  PresenceKey,
  PresenceLookup,
  PresenceRecord,
  PresenceClaimResult,
  PresenceChannel,
  PresenceResult,
} from './host-ledger.js';
import type { HostLedgerPort } from './host-ledger.js';

export type ActivityIndex = number;
export interface SquareHeader {
  readonly revision: number;
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
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface RouteFact {
  readonly location: string;
  readonly participant: string;
  readonly sessionId: string;
  readonly channel: string;
  readonly kind: WakeRouteKind;
  readonly address: Readonly<Record<string, string>>;
  readonly updatedAt: number;
  readonly epoch?: JsonValue;
  readonly extra: Readonly<Record<string, JsonValue>>;
}
/** Domain facts exist only during a synchronous artifact callback. Values are detached. */
export interface SquareRead {
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
  routes(): readonly RouteFact[];
}
export interface SquareWrite extends SquareRead {
  land(activity: Act & { readonly at: number }): StoredAct;
  markSeen(requestedName: string, indexes: readonly ActivityIndex[], at: number): number;
  putLease(requestedName: string, lease: WatchLease): boolean;
  removeLease(requestedName: string, expectedLeaseId: string): boolean;
  replaceRoutes(routes: readonly RouteFact[]): boolean;
}
export interface SquareReadResult<R> { readonly value: R; readonly version: number }
export interface SquareCommitResult<R> extends SquareReadResult<R> { readonly changed: boolean }
/** Atomic artifact access; no framing, SQL or lazy transaction capability escapes. */
export interface SquareArtifactPort {
  read<R>(select: (facts: SquareRead) => R, signal?: AbortSignal): Promise<SquareReadResult<R>>;
  transact<R>(change: (facts: SquareWrite) => R, signal?: AbortSignal): Promise<SquareCommitResult<R>>;
  revision(signal?: AbortSignal): Promise<number>;
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

/** Capability-neutral wake transport. Unused by this Contract's activity operations. */
export interface WakeTransportPort {
  /** Capability check that performs no external wake and writes no evidence. */
  probe?(route: WakeRoute): Promise<boolean | { readonly outcome: 'not-capable'; readonly diagnostic?: string }>;
  attempt(request: WakeRequest, timeoutMs: number, beforeSend?: () => Promise<boolean>): Promise<WakeOutcome>;
}

export interface WakeRequest {
  readonly location: string;
  readonly participant: string;
  readonly activity: string;
  readonly actor: string;
  /** Wake attempt token, also the opaque native correlation. */
  readonly claimToken?: string;
  readonly attemptN?: number;
  readonly route: WakeRoute;
}

/** Executor-neutral presentation capability; intentionally separate from wake transport. */
export interface PresentationSinkPort {
  present(activity: StoredAct): void | Promise<void>;
}

/** Stable projection of a host binding; storage rows never cross this boundary. */
export interface SessionBindingProjection {
  readonly epoch?: number;
  readonly cancelledThrough?: number;
  readonly location: string;
  readonly participant: string;
  readonly sessionId: string;
  readonly channel: import('./host-ledger.js').PresenceChannel;
  readonly updatedAt: number;
}

/** Pending boundary presentation projected for one bound session. */
export interface PresentationProjection {
  readonly binding: SessionBindingProjection;
  readonly joined: boolean;
  readonly notifications: readonly InboxNotification[];
  readonly catchLease?: WatchLease;
}

/** Read-only presentation evidence projection for diagnostics and migration callers. */
export interface PresentationEvidenceProjection {
  readonly location: string;
  readonly participant: string;
  readonly sessionId: string;
  readonly activity: string;
  readonly outcome: string;
  readonly at?: number;
}

export type WakeOutcome =
  | { readonly outcome: 'accepted'; readonly signature?: string; readonly attemptN?: number }
  | { readonly outcome: 'failed'; readonly message?: string; readonly signature?: string; readonly diagnostic?: unknown; readonly attemptN?: number; readonly unavailable?: boolean; readonly retainRoute?: boolean; readonly routeStale?: boolean }
  | { readonly outcome: 'not-capable'; readonly diagnostic?: string }
  | { readonly outcome: 'unknown'; readonly signature?: string; readonly message?: string; readonly diagnostic?: unknown; readonly attemptN?: number };

export interface DeliveryResult {
  readonly attempted: number;
  readonly accepted: number;
  readonly failed: number;
  readonly unknown: number;
  readonly notCapable: number;
}

export interface DeliverPendingInput {
  readonly artifact: SquareArtifactPort;
  readonly hostLedger: HostLedgerPort;
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
  readonly hostLedger?: HostLedgerPort;
  readonly session?: string;
  readonly now?: number;
  readonly timeoutMs?: number;
  /** One hook deadline propagated into artifact reads/transitions so busy retries stay bounded. */
  readonly signal?: AbortSignal;
  /** Boundary previews that were clipped remain pending for a later full presentation. */
  readonly markSeen?: boolean;
  /** Receiver-specific fences checked inside the artifact observation transaction. */
  readonly current?: (facts: SquareRead) => boolean;
}
