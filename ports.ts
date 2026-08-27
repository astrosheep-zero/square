import type { SquareState } from './model.js';
export type {
  ClaimResult,
  EvidenceClaim,
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
  ReconcileBindingInput,
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
}

export interface WakeRequest {
  readonly location: string;
  readonly participant: string;
  readonly activity: string;
}

export type WakeOutcome =
  | { readonly outcome: 'accepted'; readonly signature?: string }
  | { readonly outcome: 'failed'; readonly message?: string }
  | { readonly outcome: 'unknown'; readonly diagnostic?: string };
