import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import fs from 'node:fs';

import {
  planActNotifications,
  type WakeAdapter,
} from './delivery.js';
import { SquareError, type SquareState } from './model.js';
import { SLEEP_MS, matchesMentionTarget } from './runtime.js';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { displayAttentionPath } from './attention-presentation.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import type { OpenSquare } from './open-square.js';
import { notificationDelivered, resolveParticipant } from './views.js';
import { deliverPending, sweepPending, sweepPendingFromState } from './delivery-operations.js';
import { projectPresentationEvidence } from './square-projections.js';
import type { WakeTransportPort, WakeOutcome, WakeRequest, PresenceChannel } from './ports.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';

export type { PlannedNotification } from './delivery.js';
export { planActNotifications, matchesMentionTarget };

export { notificationMessageId } from './delivery.js';

export const PRIVILEGED_HOOK_BUDGET_MS = 3000;

export function wakeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? '5000', 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', 'Invalid SQUARE_NOTIFY_DELIVERY_WAIT_MS: expected a positive integer.');
  }
  return value;
}

function wakeLabel(kind: WakeRequest['route']['kind']): string {
  if (kind === 'paseo') return 'paseo';
  if (kind.startsWith('codex')) return 'codex-queue';
  return kind;
}

function renderWakePayload(request: WakeRequest): string {
  return [
    `<system-reminder source="square" wake="${wakeLabel(request.route.kind)}">`,
    `square: ${displayAttentionPath(request.location)}`,
    `attention: ${request.activity} for ${request.participant}`,
    '</system-reminder>',
  ].join('\n');
}

function notificationIndex(ref: number | ActivityId): number {
  if (typeof ref === 'number') return ref;
  const index = parseActivityId(ref);
  if (index === undefined) throw new Error(`Invalid act ref: ${ref}`);
  return index;
}

export async function hasDeliveredNotification(squarePath: string, name: string, ref: number | ActivityId): Promise<boolean> {
  const square = await openSquare(squarePath);
  try {
    const recipient = (await resolveParticipant(square, name)).name;
    return notificationDelivered(square, recipient, notificationIndex(ref));
  } finally {
    await closeOpenSquare(square);
  }
}

export async function hasAttentionNotification(squarePath: string, name: string, ref: number | ActivityId, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const square = await openSquare(squarePath);
  try {
    const recipient = (await resolveParticipant(square, name)).name;
    const index = notificationIndex(ref);
    if (await notificationDelivered(square, recipient, index)) return true;
    const root = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
    const hostLedger = createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? root, localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? root, readableScopes: ['user'], writableScope: 'user' });
    return (await projectPresentationEvidence({ hostLedger, location: squarePath, participant: recipient, activity: formatActivityId(index), now: Date.now() })).some((row) => row.outcome === 'presented');
  } finally {
    await closeOpenSquare(square);
  }
}

export async function waitForDeliveredNotification(squarePath: string, name: string, ref: number | ActivityId, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  while (Date.now() <= deadline) {
    if (await hasDeliveredNotification(squarePath, name, ref)) return true;
    await sleep(Math.min(SLEEP_MS, Math.max(1, deadline - Date.now())));
  }
  return false;
}

interface ProcessNotificationOptions {
  adapters?: WakeAdapter[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function defaultWakeAdapters(): Promise<WakeAdapter[]> {
  const adapters: WakeAdapter[] = [];
  try {
    const { CodexQueueAdapter } = await import('./codex-queue.js');
    adapters.push(new CodexQueueAdapter());
  } catch {
    // Codex is unavailable only when this build omits its local adapter.
  }
  try {
    const { PaseoAdapter } = await import('./paseo-delivery.js');
    adapters.push(new PaseoAdapter());
  } catch {
    // Paseo is an optional integration; a core-only install simply has no Paseo adapter.
  }
  return adapters;
}

export async function createDefaultWakeTransport(
  hostLedger: import('./host-ledger.js').HostLedgerPort,
  clock: () => number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WakeTransportPort> {
  const adapters = await defaultWakeAdapters();
  return createWakeTransport(
    env.SQUARE_DISABLE_PASEO_WAKE === '1' ? adapters.filter((adapter) => adapter.kind !== 'paseo') : adapters,
    hostLedger,
    clock,
  );
}

export function createWakeTransport(adapters: readonly WakeAdapter[], hostLedger: import('./host-ledger.js').HostLedgerPort, clock: () => number): WakeTransportPort {
  return {
    probe: async (route) => {
      const adapter = adapters.find((candidate) => candidate.kind === route.kind);
      if (adapter === undefined) return { outcome: 'not-capable', diagnostic: `no adapter for ${route.kind}` };
      const probe = (adapter as WakeAdapter & { probe?: (address: Readonly<Record<string, string>>) => Promise<boolean> }).probe;
      if (probe === undefined) return true;
      try { return await probe.call(adapter, route.address); } catch (error) {
        return { outcome: 'not-capable', diagnostic: error instanceof Error ? error.message : String(error) };
      }
    },
    attempt: async (request, timeoutMs): Promise<WakeOutcome> => {
      const adapter = adapters.find((candidate) => candidate.kind === request.route.kind);
      if (adapter === undefined) return { outcome: 'not-capable', diagnostic: `no adapter for ${request.route.kind}` };
      try {
        const result = await adapter.dispatch(request.route.address, renderWakePayload(request), async () => true, timeoutMs);
        if (result.outcome === 'accepted') return { outcome: 'accepted' };
        if (result.outcome === 'failed') return { outcome: 'failed', message: result.message };
        if (result.outcome === 'unavailable') return { outcome: 'failed', message: result.message, unavailable: true, ...(result.retainRoute === true ? { retainRoute: true } : {}), ...(result.routeStale === true ? { routeStale: true } : {}) };
        if (result.outcome === 'unknown') return { outcome: 'unknown', diagnostic: result.message };
        return { outcome: 'unknown', diagnostic: 'wake dispatch cancelled' };
      } catch (error) {
        return { outcome: 'unknown', diagnostic: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export async function processActNotificationsOnce(squarePath: string, actIndex: number, opts: ProcessNotificationOptions = {}) {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const ledgerRoot = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
  const hostLedger = createHostLedgerPort({
    userPath: env.SQUARE_HOST_LEDGER_USER ?? ledgerRoot,
    localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? ledgerRoot,
  });
  const square = await openSquare(squarePath, { clock: now, hostLedger, env });
  try {
    const adapters = opts.adapters ?? await defaultWakeAdapters();
    const transport = createWakeTransport(adapters, hostLedger, now);
    try {
      return await deliverPending({ artifact: square.artifact, hostLedger, transport, location: squarePath, activity: actIndex, timeoutMs: Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000), now: now() });
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
  suppliedAdapters?: WakeAdapter[],
  deadline = Date.now() + PRIVILEGED_HOOK_BUDGET_MS,
): Promise<void> {
  const remainingMs = () => Math.max(0, deadline - Date.now());
  if (remainingMs() === 0) return;
  const root = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
  const hostLedger = createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? root, localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? root, readableScopes: ['user'], writableScope: 'user' });
  let indexed: readonly import('./host-ledger.js').PresenceRecord[] = [];
  try { indexed = await hostLedger.listPresence({ scopes: ['user'], now: Date.now() }); } catch { /* capability is best effort */ }
  const paths = new Set(indexed.map((binding) => binding.location));
  try {
    for (const entry of await fs.promises.readdir(path.join(cwd, '.square'))) {
      if (entry.endsWith('.square')) paths.add(path.join(cwd, '.square', entry));
    }
  } catch { /* no local square directory */ }
  if (remainingMs() === 0) return;
  const adapters = suppliedAdapters ?? await defaultWakeAdapters();
  for (const squarePath of paths) {
    if (remainingMs() === 0) break;
    try {
      const square = await openSquare(squarePath, { hostLedger, env });
      try {
        await hostLedger.reconcileBinding({ artifact: square.artifact, scopes: ['user'], now: Date.now() }).catch(() => undefined);
        if (remainingMs() === 0) break;
        const limit = Number.parseInt(env.SQUARE_NOTIFY_SWEEP_LIMIT ?? '8', 10);
        const graceMs = 0;
        const selected = await sweepPending({ artifact: square.artifact, hostLedger, location: squarePath, now: Date.now(), graceMs, limit: Number.isFinite(limit) && limit > 0 ? limit : 8 }).catch(() => []);
        const transport = createWakeTransport(adapters, hostLedger, Date.now);
        for (const actIndex of selected) {
          const remaining = remainingMs();
          if (remaining === 0) break;
          const configured = Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000);
          const timeoutMs = Math.max(1, Math.min(Number.isFinite(configured) && configured > 0 ? configured : 5000, remaining));
          await deliverPending({ artifact: square.artifact, hostLedger, transport, location: squarePath, activity: actIndex, timeoutMs, now: Date.now() }).catch(() => undefined);
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

/** Select sweep candidates from one frozen snapshot and one delivery replay. */
export async function pendingNotificationSweepFromState(
  squarePath: string,
  state: SquareState,
  now: number,
  env: NodeJS.ProcessEnv,
  limit: number,
  deriveDelivery?: (snapshot: import('./model.js').SquareState) => ReturnType<typeof import('./delivery.js').deriveDeliveryModel>,
): Promise<number[]> {
  const ledger = createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER, writableScope: 'user', readableScopes: ['user'] });
  return sweepPendingFromState({ state, hostLedger: ledger, location: squarePath, now, graceMs: wakeGraceMs(env), limit, deriveDelivery });
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
  const ledgerRoot = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
  const hostLedger = createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? ledgerRoot, localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? ledgerRoot });
  const square = await openSquare(squarePath, { clock: () => now, hostLedger, env });
  let selected: number[];
  try {
    selected = await sweepPending({ artifact: square.artifact, hostLedger, location: squarePath, now, graceMs: wakeGraceMs(env), limit });
  } finally {
    await closeOpenSquare(square);
  }
  if (opts.dispatchCandidate !== undefined) {
    for (const actIndex of selected) await opts.dispatchCandidate(actIndex);
  }
  return selected;
}
