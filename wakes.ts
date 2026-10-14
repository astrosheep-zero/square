import { type WatchLease, type WatchOptions } from './model.js';
import type { OpenSquare } from './open-square.js';
import { resolveKnownName } from './decisions.js';
import { WATCH_STALE_MS, freshWatchLease, watchTerminalStatus } from './runtime.js';

export type WatchLeaseStart = { readonly type: 'started'; readonly leaseId: string; readonly replaced: boolean; readonly heartbeatAt: number } | { readonly type: 'active'; readonly lease: WatchLease };
export type WatchLeasePulse = { readonly type: 'replaced' } | { readonly type: 'held'; readonly heartbeatAt?: number } | { readonly type: 'terminal'; readonly status: 'capped' | 'quorum' } | { readonly type: 'sleep'; readonly heartbeatAt?: number };

function newLease(leaseId: string, at: number, options: WatchOptions): WatchLease {
  const filter = { ...(options.participants === undefined ? {} : { participants: [...options.participants] }), ...(options.mention === undefined ? {} : { mention: options.mention }) };
  return { leaseId, heartbeatAt: at, expiresAt: at + WATCH_STALE_MS, ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

export async function acquireWatchLease(square: OpenSquare, name: string, leaseId: string, options: WatchOptions): Promise<WatchLeaseStart> {
  const at = square.clock();
  const { value } = await square.artifact.transact<WatchLeaseStart>((facts) => {
    const known = resolveKnownName(facts, name); const existing = freshWatchLease(facts, known, at);
    if (existing !== undefined && !options.replace) return { type: 'active', lease: existing };
    facts.putLease(known, newLease(leaseId, at, options));
    return { type: 'started', leaseId, replaced: existing !== undefined, heartbeatAt: at };
  });
  return value;
}

export async function pulseWatchLease(square: OpenSquare, name: string, leaseId: string, options: WatchOptions, heartbeatDue: boolean): Promise<WatchLeasePulse> {
  const at = square.clock();
  const { value } = await square.artifact.transact<WatchLeasePulse>((facts) => {
    const known = resolveKnownName(facts, name); const lease = freshWatchLease(facts, known, at);
    if (lease?.leaseId !== leaseId) return { type: 'replaced' };
    const held = facts.hold().active;
    const terminal = held ? undefined : watchTerminalStatus(facts, known);
    if (terminal !== undefined) return { type: 'terminal', status: terminal };
    const type = held ? 'held' : 'sleep';
    if (!heartbeatDue) return { type };
    facts.putLease(known, newLease(leaseId, at, options));
    return { type, heartbeatAt: at };
  });
  return value;
}

export async function releaseWatchLease(square: OpenSquare, name: string, leaseId: string | undefined): Promise<void> {
  if (leaseId !== undefined) await square.artifact.transact((facts) => facts.removeLease(resolveKnownName(facts, name), leaseId));
}
export async function ownsWatchLease(square: OpenSquare, name: string, leaseId: string): Promise<boolean> {
  return (await square.artifact.read((facts) => freshWatchLease(facts, resolveKnownName(facts, name), square.clock())?.leaseId === leaseId)).value;
}
