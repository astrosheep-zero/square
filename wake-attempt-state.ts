import type { EvidenceRecord, NativeDeliveryEvidence, WakeAttemptClaim } from './host-ledger.js';
import { nameKey } from './model.js';

/** Storage may contain older records; new active attempts always carry a token and lease. */
type WakeIdentity = Omit<EvidenceRecord, 'kind' | 'outcome' | 'expiresAt' | 'ownerPid' | 'unknownSource'> & { readonly kind: 'wake' };
export type WakeAttempt = WakeIdentity & (
  | { readonly outcome: 'claimed'; readonly claimToken: string; readonly expiresAt: number; readonly ownerPid?: number }
  | { readonly outcome: 'dispatching'; readonly claimToken: string; readonly expiresAt: number; readonly ownerPid?: number }
  | { readonly outcome: 'unknown'; readonly unknownSource: 'interrupted' | 'transport' }
  | { readonly outcome: 'accepted' | 'failed' | 'released' }
);
export type ClaimedWakeAttempt = Extract<WakeAttempt, { outcome: 'claimed' }> & { readonly at: number };
export type WakeChange =
  | { readonly type: 'dispatch'; readonly expiresAt: number }
  | { readonly type: 'interrupt' }
  | { readonly type: 'prepare'; readonly nativeDelivery: NativeDeliveryEvidence; readonly routeKind: EvidenceRecord['routeKind']; readonly attemptN: number | undefined }
  | { readonly type: 'admit' }
  | { readonly type: 'release'; readonly details: Pick<EvidenceRecord, 'at' | 'routeKind' | 'attemptN' | 'signature' | 'message' | 'diagnostic'> }
  | { readonly type: 'finish'; readonly result: EvidenceRecord };

/** Decode the previous format here only. Diagnostic signatures never govern transitions. */
export function wakeAttempt(record: EvidenceRecord): WakeAttempt | undefined {
  if (record.kind !== 'wake') return undefined;
  switch (record.outcome) {
    case 'claimed': case 'dispatching':
      return { ...record, kind: 'wake', outcome: record.outcome, claimToken: record.claimToken ?? '', expiresAt: record.expiresAt ?? 0 };
    case 'unknown':
      return { ...record, kind: 'wake', outcome: 'unknown', unknownSource: record.unknownSource ?? (record.signature === 'worker_interrupted_during_dispatch' ? 'interrupted' : 'transport') };
    case 'accepted': case 'failed': case 'released':
      return { ...record, kind: 'wake', outcome: record.outcome };
    default: return undefined;
  }
}

export function durableWake(record: object): boolean {
  const row = record as { kind?: string; outcome?: string };
  return row.kind === 'wake' && (row.outcome === 'accepted' || row.outcome === 'unknown' || row.outcome === 'dispatching');
}

/** Attention-wide admission and crash recovery, decided from one locked snapshot. */
export function claimWakeAttempt(rows: readonly EvidenceRecord[], proposed: ClaimedWakeAttempt, ownerAlive: (pid: number | undefined) => boolean | undefined): { result: WakeAttemptClaim; rows?: readonly EvidenceRecord[] } {
  const attention = rows.filter((row) => row.kind === 'wake' && row.location === proposed.location && nameKey(row.participant) === nameKey(proposed.participant) && row.activity === proposed.activity);
  const terminal = attention.findLast((row) => row.outcome === 'accepted') ?? attention.findLast((row) => row.outcome === 'unknown');
  if (terminal) return { result: { status: 'terminal', record: terminal } };
  const active = attention.filter((row) => row.outcome === 'claimed' || row.outcome === 'dispatching');
  const busy = active.find((row) => (row.expiresAt ?? 0) > proposed.at && ownerAlive(row.ownerPid) !== false);
  if (busy) return { result: { status: 'busy', record: busy } };
  const nextNumber = (session: string) => attention.filter((row) => row.session === session).reduce((highest, row) => Math.max(highest, row.attemptN ?? 0), 0) + 1;
  // A possibly-sent attempt blocks every route; only an unsent claim can be replaced.
  const interrupted = active.filter((row) => row.outcome === 'dispatching');
  if (interrupted.length) {
    const recovered = new Map(interrupted.map((row) => [row, {
      ...changeWakeAttempt(wakeAttempt(row)!, '', { type: 'interrupt' })!,
      routeKind: row.routeKind ?? proposed.routeKind, attemptN: row.attemptN ?? nextNumber(row.session),
    }]));
    return { result: { status: 'terminal', record: recovered.get(interrupted[0])! }, rows: rows.map((row) => recovered.get(row) ?? row) };
  }
  const attemptN = nextNumber(proposed.session), claimed = { ...proposed, attemptN };
  return { result: { status: 'acquired', claimToken: proposed.claimToken, attemptN }, rows: [...rows.filter((row) => !active.includes(row)), claimed] };
}

/** All per-attempt transitions. Undefined means the caller cannot change this attempt. */
export function changeWakeAttempt(current: WakeAttempt, token: string, change: WakeChange): WakeAttempt | undefined {
  if (change.type !== 'interrupt' && (!token || current.claimToken !== token)) return undefined;
  const active = current.outcome === 'claimed' || current.outcome === 'dispatching';
  const terminal = (outcome: 'accepted' | 'failed' | 'released' | 'unknown', details: Partial<EvidenceRecord> = {}): WakeAttempt => {
    const { expiresAt: _expiresAt, ownerPid: _ownerPid, unknownSource: _unknownSource, ...rest } = current as EvidenceRecord;
    return outcome === 'unknown'
      ? { ...rest, ...details, kind: 'wake', outcome, unknownSource: details.unknownSource ?? 'transport' }
      : { ...rest, ...details, kind: 'wake', outcome };
  };
  switch (change.type) {
    case 'dispatch':
      return current.outcome === 'claimed' ? { ...current, outcome: 'dispatching', expiresAt: change.expiresAt } : undefined;
    case 'interrupt':
      return current.outcome === 'dispatching' ? terminal('unknown', { unknownSource: 'interrupted', signature: 'worker_interrupted_during_dispatch', message: 'The notification worker ended after dispatch began; transport acceptance is unknown.' }) : undefined;
    case 'prepare':
      return current.outcome === 'dispatching' ? { ...current, routeKind: change.routeKind, attemptN: change.attemptN, nativeDelivery: change.nativeDelivery } : undefined;
    case 'admit':
      if (current.nativeDelivery === undefined || !['dispatching', 'unknown', 'accepted'].includes(current.outcome)) return undefined;
      return current.outcome === 'accepted' ? current : terminal('accepted', { signature: 'native_queue_confirmed', message: undefined, diagnostic: undefined });
    case 'release':
      return active ? terminal('released', change.details) : undefined;
    case 'finish': {
      const result = change.result;
      if (result.outcome !== 'accepted' && result.outcome !== 'failed' && result.outcome !== 'unknown') return undefined;
      if (current.outcome !== 'dispatching' && !(current.outcome === 'unknown' && current.unknownSource === 'interrupted' && result.outcome === 'accepted')) return undefined;
      const details = { at: result.at, routeKind: result.routeKind, attemptN: result.attemptN, signature: result.signature, message: result.message, diagnostic: result.diagnostic };
      return terminal(result.outcome, { ...details, unknownSource: result.outcome === 'unknown' ? 'transport' : undefined });
    }
  }
}
