import path from 'node:path';
import fs from 'node:fs';

import { indexedSquareEntries } from './square-index.js';

import { SquareError, type WakeRouteKind } from './model.js';
import { openSquare, closeOpenSquare } from './open-square.js';
import { deliverPending, sweepPending } from './delivery-operations.js';
import type { WakeTransportPort } from './ports.js';

export type { PlannedNotification } from './delivery.js';

export const PRIVILEGED_HOOK_BUDGET_MS = 3000;

export function wakeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? '5000', 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', 'Invalid SQUARE_NOTIFY_DELIVERY_WAIT_MS: expected a positive integer.');
  }
  return value;
}

export type WakeTransports = Readonly<Partial<Record<WakeRouteKind, WakeTransportPort>>>;

interface ProcessNotificationOptions {
  transports?: WakeTransports;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** Concrete transports use wall time; semantic state time belongs to Square operations. */
export async function createDefaultWakeTransport(
  env: NodeJS.ProcessEnv = process.env,
  suppliedTransports?: WakeTransports,
): Promise<WakeTransportPort> {
  if (suppliedTransports !== undefined) return createWakeTransport(suppliedTransports);
  const transports: Partial<Record<WakeRouteKind, WakeTransportPort>> = {};
  try {
    const { CodexQueueTransport } = await import('./codex-queue.js');
    transports['codex-queue'] = new CodexQueueTransport({ env });
  } catch { /* core-only builds may omit Codex */ }
  if (env.SQUARE_DISABLE_PASEO_WAKE !== '1') {
    try {
      const { PaseoWakeTransport } = await import('./paseo-delivery.js');
      transports.paseo = new PaseoWakeTransport();
    } catch { /* Paseo is optional */ }
  }
  const { createClaudeWakeTransport } = await import('./claude-delivery.js');
  transports['claude-native'] = createClaudeWakeTransport(env);
  return createWakeTransport(transports);
}

/** Route selection only: all implementations receive the same request and final gate. */
export function createWakeTransport(transports: WakeTransports): WakeTransportPort {
  const missing = (kind: WakeRouteKind) => ({ outcome: 'not-capable' as const, diagnostic: `no transport for ${kind}` });
  return {
    async probe(route) {
      const transport = transports[route.kind];
      if (transport === undefined) return missing(route.kind);
      try { return await transport.probe?.(route) ?? true; }
      catch (error) { return { outcome: 'not-capable', diagnostic: error instanceof Error ? error.message : String(error) }; }
    },
    attempt: (request, timeoutMs, beforeSend) => transports[request.route.kind]?.attempt(request, timeoutMs, beforeSend)
      ?? Promise.resolve(missing(request.route.kind)),
  };
}

export async function processActNotificationsOnce(squarePath: string, actIndex: number, opts: ProcessNotificationOptions = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const square = await openSquare(squarePath, { clock: now });
  try {
    const transport = await createDefaultWakeTransport(env, opts.transports);
    try {
      return await deliverPending({ artifact: square.artifact, transport, location: squarePath, activity: actIndex, timeoutMs: Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000), now: now() });
    } catch {
      return { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 };
    }
  } finally {
    await closeOpenSquare(square);
  }
}

/** Privileged hook fallback: sweep indexed squares plus the current cwd's local squares within one boundary budget. */
export async function sweepPrivilegedPending(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  suppliedTransports?: WakeTransports,
  deadline = Date.now() + PRIVILEGED_HOOK_BUDGET_MS,
  signal?: AbortSignal,
): Promise<void> {
  const remainingMs = () => Math.max(0, deadline - Date.now());
  if (remainingMs() === 0 || signal?.aborted) return;
  const indexed = await indexedSquareEntries({}, env).catch(() => []);
  const paths = new Set(indexed.map((binding) => binding.location));
  try {
    for (const entry of await fs.promises.readdir(path.join(cwd, '.square'))) {
      if (entry.endsWith('.square')) paths.add(path.join(cwd, '.square', entry));
    }
  } catch { /* no local square directory */ }
  if (remainingMs() === 0 || signal?.aborted) return;
  const transport = await createDefaultWakeTransport(env, suppliedTransports);
  for (const squarePath of paths) {
    if (remainingMs() === 0 || signal?.aborted) break;
    try {
      const square = await openSquare(squarePath, { signal });
      try {
        if (remainingMs() === 0 || signal?.aborted) break;
        const limit = Number.parseInt(env.SQUARE_NOTIFY_SWEEP_LIMIT ?? '8', 10);
        const graceMs = 0;
        const selected = await sweepPending({ artifact: square.artifact, location: squarePath, now: Date.now(), graceMs, limit: Number.isFinite(limit) && limit > 0 ? limit : 8 }).catch(() => []);
        for (const actIndex of selected) {
          const remaining = remainingMs();
          if (remaining === 0 || signal?.aborted) break;
          const configured = Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000);
          const timeoutMs = Math.max(1, Math.min(Number.isFinite(configured) && configured > 0 ? configured : 5000, remaining));
          await deliverPending({ artifact: square.artifact, transport, location: squarePath, activity: actIndex, timeoutMs, now: Date.now() }).catch(() => undefined);
        }
      } finally { await closeOpenSquare(square); }
    } catch { /* stale index entries are ignored by the hook */ }
  }
}
export interface SweepPendingNotificationsOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  limit?: number;
  dispatchCandidate?: (actIndex: number) => void | Promise<void>;
}

/** Select old pending attention at a bounded action boundary for an explicit executor. */
export async function sweepPendingNotifications(
  squarePath: string,
  opts: SweepPendingNotificationsOptions = {},
): Promise<number[]> {
  const env = opts.env ?? process.env;
  if (env.SQUARE_DISABLE_PASEO_WAKE === '1') return [];
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 8;
  const square = await openSquare(squarePath, { clock: () => now });
  let selected: number[];
  try {
    selected = await sweepPending({ artifact: square.artifact, location: squarePath, now, graceMs: wakeGraceMs(env), limit });
  } finally {
    await closeOpenSquare(square);
  }
  if (opts.dispatchCandidate !== undefined) {
    for (const actIndex of selected) await opts.dispatchCandidate(actIndex);
  }
  return selected;
}
