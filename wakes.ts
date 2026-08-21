import { formatActivityId } from './square-core.js';
import { isDeliveryDelivered } from './delivery.js';
import { nameKey, type NotifyLease, type WakeRouteKind, type WatchLease, type WatchOptions } from './model.js';
import type { OpenSquare } from './open-square.js';
import { resolveKnownName } from './decisions.js';
import { WATCH_STALE_MS, currentHold, freshWatchLease, removeWatchLease, touchPresenceCursor, watchTerminalStatus, writeWatchLease } from './runtime.js';

export type WatchLeaseStart = { readonly type: 'started'; readonly leaseId: string; readonly replaced: boolean; readonly heartbeatAt: number } | { readonly type: 'active'; readonly lease: WatchLease };
export type WatchLeasePulse = { readonly type: 'replaced' } | { readonly type: 'held' } | { readonly type: 'terminal'; readonly status: 'capped' | 'quorum' } | { readonly type: 'sleep'; readonly heartbeatAt?: number };
export type NotifyLeaseClaim = { readonly type: 'delivered' } | { readonly type: 'busy' } | { readonly type: 'ambiguous'; readonly lease: NotifyLease } | { readonly type: 'acquired'; readonly leaseId: string };

function filter(options: WatchOptions): { participants?: string[]; mention?: string } {
  return { ...(options.participants === undefined ? {} : { participants: [...options.participants] }), ...(options.mention === undefined ? {} : { mention: options.mention }) };
}
function notificationKey(recipient: string, index: number): string { return JSON.stringify([formatActivityId(index), nameKey(recipient)]); }

export async function acquireWatchLease(square: OpenSquare, name: string, leaseId: string, options: WatchOptions, ownerId?: string): Promise<WatchLeaseStart> {
  const at = square.clock();
  return square.cell.transact<WatchLeaseStart>((state) => {
    const known = resolveKnownName(state, name); const existing = freshWatchLease(state, known, at);
    if (existing !== undefined && !options.replace) return { result: { type: 'active' as const, lease: existing } };
    writeWatchLease(state, known, { leaseId, ...(ownerId === undefined ? {} : { ownerId }), heartbeatAt: at, expiresAt: at + WATCH_STALE_MS, ...(Object.keys(filter(options)).length === 0 ? {} : { filter: filter(options) }) });
    touchPresenceCursor(state, known, at);
    return { state, result: { type: 'started' as const, leaseId, replaced: existing !== undefined, heartbeatAt: at } };
  });
}

export async function pulseWatchLease(square: OpenSquare, name: string, leaseId: string, options: WatchOptions, heartbeatDue: boolean): Promise<WatchLeasePulse> {
  const at = square.clock();
  return square.cell.transact<WatchLeasePulse>((state) => {
    const known = resolveKnownName(state, name); const lease = freshWatchLease(state, known, at);
    if (lease?.leaseId !== leaseId) return { result: { type: 'replaced' as const } };
    if (currentHold(state.acts).active) return { result: { type: 'held' as const } };
    const terminal = watchTerminalStatus(state, known);
    if (terminal !== undefined) return { result: { type: 'terminal' as const, status: terminal } };
    if (!heartbeatDue) return { result: { type: 'sleep' as const } };
    writeWatchLease(state, known, { leaseId, ...(lease.ownerId === undefined ? {} : { ownerId: lease.ownerId }), heartbeatAt: at, expiresAt: at + WATCH_STALE_MS, ...(Object.keys(filter(options)).length === 0 ? {} : { filter: filter(options) }) });
    touchPresenceCursor(state, known, at);
    return { state, result: { type: 'sleep' as const, heartbeatAt: at } };
  });
}

export async function releaseWatchLease(square: OpenSquare, name: string, leaseId: string | undefined): Promise<void> {
  if (leaseId === undefined) return;
  await square.cell.transact((state) => { const known = resolveKnownName(state, name); return removeWatchLease(state, known, leaseId) ? { state, result: undefined } : { result: undefined }; });
}
export async function ownsWatchLease(square: OpenSquare, name: string, leaseId: string): Promise<boolean> { const { state } = await square.cell.read(); return freshWatchLease(state, resolveKnownName(state, name), square.clock())?.leaseId === leaseId; }
export async function claimNotificationLease(square: OpenSquare, recipient: string, actIndex: number, leaseId: string, leaseMs: number): Promise<NotifyLeaseClaim> {
  const at = square.clock(); const key = notificationKey(recipient, actIndex);
  return square.cell.transact<NotifyLeaseClaim>((state) => { const known = resolveKnownName(state, recipient); if (isDeliveryDelivered(state, known, actIndex)) return { result: { type: 'delivered' as const } }; const existing = state.runtime.notifyLeases[key]; if (existing !== undefined && existing.expiresAt > at) return { result: { type: 'busy' as const } }; if (existing?.phase === 'dispatching') return { result: { type: 'ambiguous' as const, lease: existing } }; state.runtime.notifyLeases[key] = { leaseId, expiresAt: at + leaseMs, phase: 'claimed' }; return { state, result: { type: 'acquired' as const, leaseId } }; });
}
export async function transitionNotificationLease(square: OpenSquare, recipient: string, actIndex: number, leaseId: string, phase: NotifyLease['phase'], leaseMs: number, routeKind?: WakeRouteKind, attemptN?: number): Promise<boolean> {
  const at = square.clock(); const key = notificationKey(recipient, actIndex);
  return square.cell.transact((state) => { if (state.runtime.notifyLeases[key]?.leaseId !== leaseId) return { result: false }; state.runtime.notifyLeases[key] = { leaseId, expiresAt: at + leaseMs, phase, ...(routeKind === undefined ? {} : { routeKind }), ...(attemptN === undefined ? {} : { attemptN }) }; return { state, result: true }; });
}
export async function releaseNotificationLease(square: OpenSquare, recipient: string, actIndex: number, leaseId: string): Promise<void> { const key = notificationKey(recipient, actIndex); await square.cell.transact((state) => { if (state.runtime.notifyLeases[key]?.leaseId !== leaseId) return { result: undefined }; delete state.runtime.notifyLeases[key]; return { state, result: undefined }; }); }
