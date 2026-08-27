import { type WatchLease, type WatchOptions } from './model.js';
import type { OpenSquare } from './open-square.js';
import { resolveKnownName } from './decisions.js';
import { WATCH_STALE_MS, currentHold, freshWatchLease, removeWatchLease, watchTerminalStatus, writeWatchLease } from './runtime.js';

export type WatchLeaseStart = { readonly type: 'started'; readonly leaseId: string; readonly replaced: boolean; readonly heartbeatAt: number } | { readonly type: 'active'; readonly lease: WatchLease };
export type WatchLeasePulse = { readonly type: 'replaced' } | { readonly type: 'held' } | { readonly type: 'terminal'; readonly status: 'capped' | 'quorum' } | { readonly type: 'sleep'; readonly heartbeatAt?: number };

function filter(options: WatchOptions): { participants?: string[]; mention?: string } {
  return { ...(options.participants === undefined ? {} : { participants: [...options.participants] }), ...(options.mention === undefined ? {} : { mention: options.mention }) };
}


export async function acquireWatchLease(square: OpenSquare, name: string, leaseId: string, options: WatchOptions, ownerId?: string): Promise<WatchLeaseStart> {
  const at = square.clock();
  return square.artifact.transact<WatchLeaseStart>((state) => {
    const known = resolveKnownName(state, name); const existing = freshWatchLease(state, known, at);
    if (existing !== undefined && !options.replace) return { result: { type: 'active' as const, lease: existing } };
    writeWatchLease(state, known, { leaseId, ...(ownerId === undefined ? {} : { ownerId }), heartbeatAt: at, expiresAt: at + WATCH_STALE_MS, ...(Object.keys(filter(options)).length === 0 ? {} : { filter: filter(options) }) });
    return { state, result: { type: 'started' as const, leaseId, replaced: existing !== undefined, heartbeatAt: at } };
  });
}

export async function pulseWatchLease(square: OpenSquare, name: string, leaseId: string, options: WatchOptions, heartbeatDue: boolean): Promise<WatchLeasePulse> {
  const at = square.clock();
  return square.artifact.transact<WatchLeasePulse>((state) => {
    const known = resolveKnownName(state, name); const lease = freshWatchLease(state, known, at);
    if (lease?.leaseId !== leaseId) return { result: { type: 'replaced' as const } };
    if (currentHold(state.acts).active) return { result: { type: 'held' as const } };
    const terminal = watchTerminalStatus(state, known);
    if (terminal !== undefined) return { result: { type: 'terminal' as const, status: terminal } };
    if (!heartbeatDue) return { result: { type: 'sleep' as const } };
    writeWatchLease(state, known, { leaseId, ...(lease.ownerId === undefined ? {} : { ownerId: lease.ownerId }), heartbeatAt: at, expiresAt: at + WATCH_STALE_MS, ...(Object.keys(filter(options)).length === 0 ? {} : { filter: filter(options) }) });
    return { state, result: { type: 'sleep' as const, heartbeatAt: at } };
  });
}

export async function releaseWatchLease(square: OpenSquare, name: string, leaseId: string | undefined): Promise<void> {
  if (leaseId === undefined) return;
  await square.artifact.transact((state) => { const known = resolveKnownName(state, name); return removeWatchLease(state, known, leaseId) ? { state, result: undefined } : { result: undefined }; });
}
export async function ownsWatchLease(square: OpenSquare, name: string, leaseId: string): Promise<boolean> { const { state } = await square.artifact.read(); return freshWatchLease(state, resolveKnownName(state, name), square.clock())?.leaseId === leaseId; }
