import type { EvidenceRecord, WakeAttention } from './host-ledger.js';
import type { WakeRouteKind } from './model.js';
import { parseActivityId } from './square-core.js';

export interface WakeAttempt {
  readonly at: number;
  readonly attention: WakeAttention;
  readonly routeKind: WakeRouteKind;
  readonly outcome: 'accepted' | 'unknown' | 'failed';
  readonly signature?: string;
  readonly attemptN: number;
  readonly session?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}

export interface WakeReleaseDiagnostic {
  readonly at: number;
  readonly attention: WakeAttention;
  readonly routeKind?: WakeRouteKind;
  readonly attemptN?: number;
  readonly session?: string;
  readonly signature?: string;
  readonly message?: string;
  readonly diagnostic?: unknown;
}

export type DecodedWakeEvidence =
  | { readonly kind: 'attempt'; readonly value: WakeAttempt }
  | { readonly kind: 'release'; readonly value: WakeReleaseDiagnostic };

/** Decode primary attempts and diagnostic-only releases without mixing their evidence. */
export function decodeWakeEvidence(record: EvidenceRecord, now: number): DecodedWakeEvidence | undefined {
  if (record.kind !== 'wake') return undefined;
  const actIndex = parseActivityId(record.activity);
  if (actIndex === undefined) return undefined;
  const value = {
    at: record.at ?? now,
    attention: { squarePath: record.location, recipient: record.participant, actIndex },
    ...(record.session === undefined ? {} : { session: record.session }),
    ...(record.signature === undefined ? {} : { signature: record.signature }),
    ...(record.message === undefined ? {} : { message: record.message }),
    ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
  };
  if (record.outcome === 'released') {
    if (record.at === undefined) return undefined;
    return { kind: 'release', value: {
      ...value,
      ...(record.routeKind === undefined ? {} : { routeKind: record.routeKind }),
      ...(record.attemptN === undefined ? {} : { attemptN: record.attemptN }),
    } };
  }
  if (record.outcome !== 'accepted' && record.outcome !== 'unknown' && record.outcome !== 'failed') return undefined;
  if (record.routeKind === undefined || typeof record.attemptN !== 'number') return undefined;
  return { kind: 'attempt', value: { ...value, routeKind: record.routeKind, attemptN: record.attemptN, outcome: record.outcome } };
}
