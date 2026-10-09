import { hostLedgerRoot } from './host-ledger-root.js';
import path from 'node:path';
import fs from 'node:fs';

import {
  planActNotifications,
  type WakeAdapter,
} from './delivery.js';
import { SquareError, type SquareState } from './model.js';
import { matchesMentionTarget } from './runtime.js';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { displayAttentionPath } from './attention-presentation.js';
import { openSquare, observeSquareChanges } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import type { OpenSquare } from './open-square.js';
import { notificationDelivered, resolveParticipant } from './views.js';
import { deliverPending, observeSquare, sweepPending, sweepPendingFromState } from './delivery-operations.js';
import { nameKey } from './model.js';
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
    `attention: ${request.activity} for ${request.participant} from ${request.actor}`,
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
    const root = hostLedgerRoot(env);
    const hostLedger = createHostLedgerPort({ rootPath: root });
    return (await projectPresentationEvidence({ hostLedger, location: squarePath, participant: recipient, activity: formatActivityId(index), now: Date.now() })).some((row) => row.outcome === 'presented');
  } finally {
    await closeOpenSquare(square);
  }
}

export async function waitForDeliveredNotification(squarePath: string, name: string, ref: number | ActivityId, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  const observer = await observeSquareChanges(squarePath);
  try {
    while (Date.now() <= deadline) {
      const baseline = await observer.read(opts.signal);
      if (await hasDeliveredNotification(squarePath, name, ref)) return true;
      if (!await observer.changed(baseline, Math.max(0, deadline - Date.now()), opts.signal)) return false;
    }
    return false;
  } finally { observer.close(); }
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
    env,
  );
}

interface WakeRequestCurrentness {
  readonly current: boolean;
  readonly activityPending: boolean;
  readonly sessionBound: boolean;
  readonly routePublished: boolean;
  readonly observationAvailable: boolean;
}

async function wakeRequestCurrentness(request: WakeRequest, hostLedger: import('./host-ledger.js').HostLedgerPort, now: number): Promise<WakeRequestCurrentness> {
  const activity = parseActivityId(request.activity as ActivityId);
  if (activity === undefined) return { current: false, activityPending: false, sessionBound: false, routePublished: false, observationAvailable: true };
  let square: OpenSquare | undefined;
  try {
    square = await openSquare(request.location, { hostLedger });
    const current = await observeSquare({ artifact: square.artifact, hostLedger, location: request.location, now });
    const activityPending = current.pending.some((entry) => nameKey(entry.recipient) === nameKey(request.participant)
      && entry.notifications.some((notification) => notification.item.index === activity));
    const sessionBound = current.bindings.some((binding) => nameKey(binding.participant) === nameKey(request.route.participant)
      && binding.sessionId === request.route.sessionId
      && binding.location === request.route.location);
    const routePublished = (current.state.routes ?? []).some((route) => route.location === request.route.location
      && nameKey(route.participant) === nameKey(request.route.participant)
      && route.sessionId === request.route.sessionId
      && route.kind === request.route.kind
      && JSON.stringify(route.address) === JSON.stringify(request.route.address));
    return { current: activityPending && sessionBound && routePublished, activityPending, sessionBound, routePublished, observationAvailable: true };
  } catch {
    return { current: false, activityPending: false, sessionBound: false, routePublished: false, observationAvailable: false };
  } finally {
    if (square !== undefined) await closeOpenSquare(square);
  }
}


export function createWakeTransport(adapters: readonly WakeAdapter[], hostLedger: import('./host-ledger.js').HostLedgerPort, clock: () => number, env: NodeJS.ProcessEnv = process.env): WakeTransportPort {
  return {
    probe: async (route) => {
      if (route.kind === 'claude-native') {
        const { nativeSupported } = await import('./claude-delivery.js');
        if (!nativeSupported(route)) return { outcome: 'not-capable', diagnostic: 'Claude native inbox unavailable: macOS 2.1.295 loaded mod required.' };
        try { return (await fs.promises.stat(route.address.endpoint!)).isSocket() || { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint is not a socket.' }; }
        catch { return { outcome: 'not-capable', diagnostic: 'Claude native inbox endpoint unavailable.' }; }
      }
      const adapter = adapters.find((candidate) => candidate.kind === route.kind);
      if (adapter === undefined) return { outcome: 'not-capable', diagnostic: `no adapter for ${route.kind}` };
      const probe = (adapter as WakeAdapter & { probe?: (address: Readonly<Record<string, string>>) => Promise<boolean> }).probe;
      if (probe === undefined) return true;
      try { return await probe.call(adapter, route.address); } catch (error) {
        return { outcome: 'not-capable', diagnostic: error instanceof Error ? error.message : String(error) };
      }
    },
    attempt: async (request, timeoutMs, beforeSend): Promise<WakeOutcome> => {
      if (request.route.kind === 'claude-native') {
        const { dispatchClaude } = await import('./claude-delivery.js');
        return dispatchClaude(request, hostLedger, timeoutMs, beforeSend, env);
      }
      const adapter = adapters.find((candidate) => candidate.kind === request.route.kind);
      if (adapter === undefined) return { outcome: 'not-capable', diagnostic: `no adapter for ${request.route.kind}` };
      try {
        let revalidation: WakeRequestCurrentness | undefined;
        const result = await adapter.dispatch(request.route.address, renderWakePayload(request), async () => {
          if (!(await (beforeSend ?? (async () => true))())) return false;
          revalidation = await wakeRequestCurrentness(request, hostLedger, clock());
          return revalidation.current;
        }, timeoutMs);
        if (result.outcome === 'accepted') return { outcome: 'accepted' };
        if (result.outcome === 'failed') return { outcome: 'failed', ...(result.signature === undefined ? {} : { signature: result.signature }), message: result.message, ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }) };
        if (result.outcome === 'unavailable') return { outcome: 'failed', signature: result.signature, message: result.message, ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }), unavailable: true, ...(result.retainRoute === true ? { retainRoute: true } : {}), ...(result.routeStale === true ? { routeStale: true } : {}) };
        if (result.outcome === 'unknown') return { outcome: 'unknown', ...(result.signature === undefined ? {} : { signature: result.signature }), ...(result.message === undefined ? {} : { message: result.message }), ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }) };
        if (result.outcome === 'cancelled' && revalidation !== undefined && !revalidation.current) {
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
    const adapters = opts.adapters ?? await defaultWakeAdapters();
    const transport = createWakeTransport(adapters, hostLedger, now, env);
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
  const adapters = suppliedAdapters ?? await defaultWakeAdapters();
  for (const squarePath of paths) {
    if (remainingMs() === 0 || signal?.aborted) break;
    try {
      const square = await openSquare(squarePath, { hostLedger, env, signal });
      try {
        if (remainingMs() === 0 || signal?.aborted) break;
        const limit = Number.parseInt(env.SQUARE_NOTIFY_SWEEP_LIMIT ?? '8', 10);
        const graceMs = 0;
        const selected = await sweepPending({ artifact: square.artifact, hostLedger, location: squarePath, now: Date.now(), graceMs, limit: Number.isFinite(limit) && limit > 0 ? limit : 8 }).catch(() => []);
        const transport = createWakeTransport(adapters, hostLedger, Date.now, env);
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
