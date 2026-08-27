import type { InboxNotification, SquareState, StoredAct, WakeRoute, WatchLease } from './model.js';
import type { PlannedNotification } from './delivery.js';
export type {
  ClaimResult,
  EvidenceClaim,
  EvidenceRelease,
  EvidenceGc,
  EvidenceLookup,
  EvidenceRecord,
  HostLedgerPort,
  HostLedgerScope,
  PresenceKey,
  PresenceLookup,
  PresenceRecord,
  PresenceChannel,
  PresenceResult,
  ReconcileBindingInput as HostLedgerReconcileBindingInput,
  ReconcileBindingResult,
} from './host-ledger.js';
import type { HostLedgerPort } from './host-ledger.js';

/** Atomic artifact access. Never exposes framing, compression, locks, or storage schema. */
export interface SquareArtifactPort {
  read(): Promise<{ state: SquareState; version: number }>;
  transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }): Promise<R>;
  changed(sinceVersion: number, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Capability-neutral wake transport. Unused by this Contract's activity operations. */
export interface WakeTransportPort {
  attempt(request: WakeRequest, timeoutMs: number): Promise<WakeOutcome>;
  /** Optional route retirement supplied by the concrete executor adapter. */
  invalidate?(request: WakeRequest): Promise<void>;
}

export interface WakeRequest {
  readonly location: string;
  readonly participant: string;
  readonly activity: string;
  readonly route: WakeRoute;
}

/** Executor-neutral presentation capability; intentionally separate from wake transport. */
export interface PresentationSinkPort {
  present(activity: StoredAct): void | Promise<void>;
}

/** Stable application projection of a host binding; storage rows never cross this boundary. */
export interface SessionBindingProjection {
  readonly location: string;
  readonly participant: string;
  readonly sessionId: string;
  readonly channel: import('./host-ledger.js').PresenceChannel;
  readonly route?: WakeRoute;
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
  | { readonly outcome: 'failed'; readonly message?: string; readonly attemptN?: number; readonly unavailable?: boolean }
  | { readonly outcome: 'unknown'; readonly diagnostic?: string; readonly attemptN?: number };

export interface SquareObservation {
  readonly location?: string;
  readonly version: number;
  readonly state: SquareState;
  readonly pending: readonly { readonly recipient: string; readonly notifications: readonly PlannedNotification[] }[];
  readonly bindings: readonly SessionBindingProjection[];
}

export interface ObserveSquareInput {
  readonly artifact: SquareArtifactPort;
  readonly hostLedger?: HostLedgerPort;
  readonly location?: string;
  readonly now?: number;
}

export interface ReconcileBindingInput {
  readonly artifact: SquareArtifactPort;
  readonly hostLedger: HostLedgerPort;
  readonly location?: string;
  readonly scopes?: readonly import('./host-ledger.js').HostLedgerScope[];
  readonly now?: number;
}

export interface DeliveryResult {
  readonly attempted: number;
  readonly accepted: number;
  readonly failed: number;
  readonly unknown: number;
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
  /** Boundary previews that were clipped remain pending for a later full presentation. */
  readonly markSeen?: boolean;
}
