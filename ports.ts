import type { SquareState } from './model.js';

/** Atomic artifact access. Never exposes framing, compression, locks, or storage schema. */
export interface SquareArtifactPort {
  read(): Promise<{ state: SquareState; version: number }>;
  transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }): Promise<R>;
  changed(sinceVersion: number, timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

/** Host presence and delivery evidence. Unused by this Contract's activity operations. */
export interface HostLedgerPort {
  ensurePresence(input: PresenceRecord): Promise<PresenceResult>;
  removePresence(input: PresenceKey): Promise<void>;
  listPresence(input: PresenceLookup): Promise<readonly PresenceRecord[]>;
  claimEvidence(input: EvidenceClaim): Promise<ClaimResult>;
  appendEvidence(input: EvidenceRecord): Promise<void>;
  listEvidence(input: EvidenceLookup): Promise<readonly EvidenceRecord[]>;
  gcEvidence(input: EvidenceGc): Promise<void>;
}

export interface PresenceRecord {
  readonly location: string;
  readonly participant: string;
  readonly session?: string;
  readonly channel?: string;
}

export interface PresenceKey {
  readonly location: string;
  readonly participant: string;
  readonly session?: string;
}

export interface PresenceLookup {
  readonly location?: string;
  readonly participant?: string;
}

export type PresenceResult =
  | { readonly status: 'ok' }
  | { readonly status: 'degraded'; readonly reason?: string };

export interface EvidenceClaim {
  readonly location: string;
  readonly participant: string;
  readonly session?: string;
  readonly activity: string;
  readonly kind: 'wake' | 'presentation';
}

export type ClaimResult =
  | { readonly status: 'acquired' }
  | { readonly status: 'busy' }
  | { readonly status: 'delivered' };

export interface EvidenceRecord {
  readonly location: string;
  readonly participant: string;
  readonly session?: string;
  readonly activity: string;
  readonly kind: 'wake' | 'presentation';
  readonly outcome: string;
}

export interface EvidenceLookup {
  readonly location?: string;
  readonly participant?: string;
  readonly activity?: string;
  readonly kind?: 'wake' | 'presentation';
}

export interface EvidenceGc {
  readonly olderThanMs: number;
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
