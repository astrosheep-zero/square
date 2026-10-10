import { hostLedgerRoot } from './host-ledger-root.js';
import path from 'node:path';
import fs from 'node:fs';

import {
  type WakeAdapter,
} from './delivery.js';
import { SquareError, type SquareState } from './model.js';
import { displayAttentionPath } from './attention-presentation.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import type { OpenSquare } from './open-square.js';
import { deliverPending, sweepPending, sweepPendingFromState } from './delivery-operations.js';
import { projectWakeEvidenceFromState } from './square-projections.js';
import type { WakeCurrentness } from './wake-eligibility.js';
import { canonicalPath } from './canonical-path.js';
import type { WakeTransportPort, WakeOutcome, WakeRequest } from './ports.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';

export type { PlannedNotification } from './delivery.js';

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
    `attention: ${request.activity} for ${request.participant} from ${request.actor}`,
    '</system-reminder>',
  ].join('\n');
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
  suppliedAdapters?: readonly WakeAdapter[],
): Promise<WakeTransportPort> {
  const adapters = suppliedAdapters ?? await defaultWakeAdapters();
  const { createClaudeWakeTransport } = await import('./claude-delivery.js');
  return createWakeTransport(
    suppliedAdapters === undefined && env.SQUARE_DISABLE_PASEO_WAKE === '1' ? adapters.filter((adapter) => adapter.kind !== 'paseo') : adapters,
    hostLedger,
    clock,
    { 'claude-native': createClaudeWakeTransport(hostLedger, env) },
  );
}

async function observeWakeRequest(request: WakeRequest, hostLedger: import('./host-ledger.js').HostLedgerPort, now: number): Promise<WakeCurrentness & { readonly observationAvailable: boolean }> {
  let square: OpenSquare | undefined;
  try {
    const location = await canonicalPath(request.location);
    square = await openSquare(location, { hostLedger });
    const { state } = await square.artifact.read();
    const eligibility = await projectWakeEvidenceFromState({ state, hostLedger, location, now });
    return { ...eligibility.currentness({ ...request, location }), observationAvailable: true };
  } catch {
    return { current: false, activityPending: false, sessionBound: false, routePublished: false,
      selectedOwner: false, cancelled: false, presented: false, observationAvailable: false };
  } finally {
    if (square !== undefined) await closeOpenSquare(square);
  }
}


export function createWakeTransport(
  adapters: readonly WakeAdapter[],
  hostLedger: import('./host-ledger.js').HostLedgerPort,
  clock: () => number,
  nativePorts: Readonly<Partial<Record<import('./model.js').WakeRouteKind, WakeTransportPort>>> = {},
): WakeTransportPort {
  return {
    probe: async (route) => {
      const native = nativePorts[route.kind];
      if (native !== undefined) return native.probe?.(route) ?? true;
      const adapter = adapters.find((candidate) => candidate.kind === route.kind);
      if (adapter === undefined) return { outcome: 'not-capable', diagnostic: `no adapter for ${route.kind}` };
      const probe = (adapter as WakeAdapter & { probe?: (address: Readonly<Record<string, string>>) => Promise<boolean> }).probe;
      if (probe === undefined) return true;
      try { return await probe.call(adapter, route.address); } catch (error) {
        return { outcome: 'not-capable', diagnostic: error instanceof Error ? error.message : String(error) };
      }
    },
    attempt: async (request, timeoutMs, beforeSend): Promise<WakeOutcome> => {
      let revalidation: Awaited<ReturnType<typeof observeWakeRequest>> | undefined;
      const finalGate = beforeSend ?? (async () => {
        revalidation = await observeWakeRequest(request, hostLedger, clock());
        return revalidation.current;
      });
      const native = nativePorts[request.route.kind];
      if (native !== undefined) return native.attempt(request, timeoutMs, finalGate);
      const adapter = adapters.find((candidate) => candidate.kind === request.route.kind);
      if (adapter === undefined) return { outcome: 'not-capable', diagnostic: `no adapter for ${request.route.kind}` };
      try {
        const result = await adapter.dispatch(request.route.address, renderWakePayload(request), finalGate, timeoutMs, request);
        if (result.outcome !== 'gate-rejected') return result;
        if (revalidation !== undefined && !revalidation.current) {
          return {
            outcome: 'failed',
            signature: 'pre_send_revalidation_failed',
            message: revalidation.observationAvailable
              ? 'Wake was not sent because current attention, session binding, or route no longer matches.'
              : 'Wake was not sent because current Square delivery state could not be verified.',
            diagnostic: revalidation,
            unavailable: true,
          };
        }
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
  const ledgerRoot = hostLedgerRoot(env);
  const hostLedger = createHostLedgerPort({
    rootPath: ledgerRoot,
  });
  const square = await openSquare(squarePath, { clock: now, hostLedger, env });
  try {
    const transport = await createDefaultWakeTransport(hostLedger, now, env, opts.adapters);
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
  signal?: AbortSignal,
): Promise<void> {
  const remainingMs = () => Math.max(0, deadline - Date.now());
  if (remainingMs() === 0 || signal?.aborted) return;
  const root = hostLedgerRoot(env);
  const hostLedger = createHostLedgerPort({ rootPath: root });
  let indexed: readonly import('./host-ledger.js').PresenceRecord[] = [];
  try { indexed = await hostLedger.listPresence({ now: Date.now() }); } catch { /* capability is best effort */ }
  const paths = new Set(indexed.map((binding) => binding.location));
  try {
    for (const entry of await fs.promises.readdir(path.join(cwd, '.square'))) {
      if (entry.endsWith('.square')) paths.add(path.join(cwd, '.square', entry));
    }
  } catch { /* no local square directory */ }
  if (remainingMs() === 0 || signal?.aborted) return;
  const transport = await createDefaultWakeTransport(hostLedger, Date.now, env, suppliedAdapters);
  for (const squarePath of paths) {
    if (remainingMs() === 0 || signal?.aborted) break;
    try {
      const square = await openSquare(squarePath, { hostLedger, env, signal });
      try {
        if (remainingMs() === 0 || signal?.aborted) break;
        const limit = Number.parseInt(env.SQUARE_NOTIFY_SWEEP_LIMIT ?? '8', 10);
        const graceMs = 0;
        const selected = await sweepPending({ artifact: square.artifact, hostLedger, location: squarePath, now: Date.now(), graceMs, limit: Number.isFinite(limit) && limit > 0 ? limit : 8 }).catch(() => []);
        for (const actIndex of selected) {
          const remaining = remainingMs();
          if (remaining === 0 || signal?.aborted) break;
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
  const ledger = createHostLedgerPort({ rootPath: hostLedgerRoot(env) });
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
  const hostLedger = createHostLedgerPort({ rootPath: hostLedgerRoot(env) });
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
