import { type WatchLease, type WatchOptions } from './model.js';
import { resolveKnownName } from './decisions.js';
import { WATCH_STALE_MS, freshWatchLease, watchTerminalStatus } from './runtime.js';
import type { SquareArtifactPort } from './ports.js';
import type { Seat } from './model.js';

export type WatchLeaseStart = { readonly type: 'started'; readonly leaseId: string; readonly replaced: boolean; readonly heartbeatAt: number } | { readonly type: 'active'; readonly lease: WatchLease };
export type WatchLeasePulse = { readonly type: 'replaced' } | { readonly type: 'held'; readonly heartbeatAt?: number } | { readonly type: 'terminal'; readonly status: 'capped' | 'quorum' } | { readonly type: 'sleep'; readonly heartbeatAt?: number };

function newLease(leaseId: string, at: number, options: WatchOptions): WatchLease {
  const filter = { ...(options.participants === undefined ? {} : { participants: [...options.participants] }), ...(options.mention === undefined ? {} : { mention: options.mention }) };
  return { leaseId, heartbeatAt: at, expiresAt: at + WATCH_STALE_MS, ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

export async function acquireWatchLease(artifact: SquareArtifactPort, seat: Seat, at: number, leaseId: string, options: WatchOptions, signal?: AbortSignal): Promise<WatchLeaseStart> {
  const name = seat.participant;
  const { value } = await artifact.transactAs({ kind: 'participant', seat }, facts => {
    const known = resolveKnownName(facts, name), existing = freshWatchLease(facts, known, at);
    if (existing !== undefined && !options.replace) return { type: 'active', lease: existing } as const;
    facts.putLease(known, newLease(leaseId, at, options), seat.generation);
    return { type: 'started', leaseId, replaced: existing !== undefined, heartbeatAt: at } as const;
  }, signal);
  return value;
}

export async function pulseWatchLease(artifact: SquareArtifactPort, seat: Seat, at: number, leaseId: string, options: WatchOptions, heartbeatDue: boolean, signal?: AbortSignal): Promise<WatchLeasePulse> {
  const name = seat.participant;
  const { value } = await artifact.transactAs({ kind: 'participant', seat }, facts => {
    const known = resolveKnownName(facts, name), lease = freshWatchLease(facts, known, at);
    if (lease?.leaseId !== leaseId) return { type: 'replaced' } as const;
    const held = facts.hold().active;
    const terminal = held ? undefined : watchTerminalStatus(facts, known);
    if (terminal !== undefined) return { type: 'terminal', status: terminal } as const;
    const type = held ? 'held' as const : 'sleep' as const;
    if (!heartbeatDue) return { type };
    facts.putLease(known, newLease(leaseId, at, options), seat.generation);
    return { type, heartbeatAt: at };
  }, signal);
  return value;
}

export async function releaseWatchLease(artifact: SquareArtifactPort, seat: Seat, leaseId: string): Promise<void> {
  await artifact.transactAs({ kind: 'participant', seat }, facts => facts.removeLease(seat.participant, leaseId, seat.generation));
}

export async function ownsWatchLease(artifact: SquareArtifactPort, seat: Seat, at: number, leaseId: string, signal?: AbortSignal): Promise<boolean> {
  const name = seat.participant;
  return (await artifact.read(facts => {
    const current = facts.seat(name);
    if (current === undefined || current.generation !== seat.generation) return false;
    return freshWatchLease(facts, resolveKnownName(facts, name), at)?.leaseId === leaseId;
  }, signal)).value;
}
