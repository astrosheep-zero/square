import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  leaseOwnsNotification,
  planActNotifications,
  type WakeAdapter,
  type WakeRequest,
} from './delivery.js';
import { sessionInbox } from './inbox.js';
import { hasPresentedAttention } from './presented.js';
import { SquareError, type WakeRoute, type WakeRouteKind } from './model.js';
import { SLEEP_MS, matchesMentionTarget } from './runtime.js';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { displayAttentionPath, renderAttentionPreview } from './attention-presentation.js';
import { lookupParticipant } from './registry.js';
import { retireWakeRoute } from './routes.js';
import { openSquare } from './square-file-adapter.js';
import { markNotificationNotified } from './square-wiring.js';
import { closeOpenSquare } from './open-square.js';
import type { OpenSquare } from './open-square.js';
import type { Activity, WakeNotifier } from './square-facade.js';
import { entryPresentation, notificationDelivered, notificationForAct, pendingDeliveries, resolveParticipant } from './views.js';
import { claimNotificationLease, releaseNotificationLease, transitionNotificationLease } from './wakes.js';
import {
  nextWakeAttemptNumber,
  recordRecoveredUnknown,
  recordWakeAttempt,
  type WakeAttention,
} from './wake-attempts.js';
import { wakeEvidence, wakeIsEligible } from './wake-evidence.js';
import { WakePort } from './wake-port.js';

const NOTIFY_LEASE_MS = 5 * 60 * 1000;

export type { PlannedNotification } from './delivery.js';
export { planActNotifications, matchesMentionTarget };

export { notificationMessageId } from './delivery.js';

export function wakeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? '5000', 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', 'Invalid SQUARE_NOTIFY_DELIVERY_WAIT_MS: expected a positive integer.');
  }
  return value;
}

function wakeLabel(kind: WakeRouteKind): string {
  if (kind === 'paseo') return 'paseo';
  if (kind.startsWith('codex')) return 'codex-queue';
  return kind;
}

function renderWakePayload(request: WakeRequest, body: string, kind: WakeRouteKind): string {
  return [
    `<system-reminder source="square" wake="${wakeLabel(kind)}">`,
    `square: ${displayAttentionPath(request.squarePath)}`,
    renderAttentionPreview({
      squarePath: request.squarePath,
      actIndex: request.actIndex,
      recipient: request.recipient,
      actor: request.actor,
      route: request.route,
      body,
      compact: true,
    }),
    '</system-reminder>',
  ].join('\n');
}

async function waitForCatch(route: WakeRoute, request: WakeRequest, body: string): Promise<boolean> {
  const binding = lookupParticipant(request.squarePath, request.recipient)
    .find((item) => item.ownerId === route.ownerId);
  const activeCatch = binding && (await sessionInbox(binding.sessionId))
    .find((item) => item.name === request.recipient)?.catchLease;
  if (!activeCatch || !leaseOwnsNotification(activeCatch, {
    actor: request.actor,
    body,
    route: request.route,
    recipient: request.recipient,
  })) return false;

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await hasDeliveredNotification(request.squarePath, request.recipient, request.actIndex)) return true;
    const currentBinding = lookupParticipant(request.squarePath, request.recipient)
      .find((item) => item.ownerId === route.ownerId);
    const lease = currentBinding && (await sessionInbox(currentBinding.sessionId))
      .find((item) => item.name === request.recipient)?.catchLease;
    if (!lease || lease.expiresAt <= Date.now()) return false;
    await sleep(Math.min(250, lease.expiresAt - Date.now()));
  }
  return false;
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
    return await notificationDelivered(square, recipient, index) || hasPresentedAttention(squarePath, recipient, index, env);
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

async function defaultWakeAdapters(): Promise<WakeAdapter[]> {
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

async function claimNotifyLease(square: OpenSquare, recipient: string, actIndex: number) {
  const leaseId = randomUUID();
  return claimNotificationLease(square, recipient, actIndex, leaseId, NOTIFY_LEASE_MS);
}

async function transitionNotifyLease(
  square: OpenSquare,
  recipient: string,
  actIndex: number,
  leaseId: string,
  phase: 'claimed' | 'dispatching',
  routeKind?: WakeRouteKind,
  attemptN?: number,
): Promise<boolean> {
  return transitionNotificationLease(square, recipient, actIndex, leaseId, phase, NOTIFY_LEASE_MS, routeKind, attemptN);
}

async function releaseNotifyLease(square: OpenSquare, recipient: string, actIndex: number, leaseId: string): Promise<void> {
  await releaseNotificationLease(square, recipient, actIndex, leaseId);
}

async function processNotification(
  squarePath: string,
  notification: import('./delivery.js').PlannedNotification,
  opts: ProcessNotificationOptions
): Promise<void> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const attention: WakeAttention = {
    squarePath,
    actIndex: notification.item.index,
    recipient: notification.recipient,
  };
  const initialAt = now();
  if (!wakeIsEligible(await wakeEvidence(squarePath, notification.recipient, notification.item.index, initialAt, env))) return;

  const square = await openSquare(squarePath, { clock: now });
  const claim = await claimNotifyLease(square, notification.recipient, notification.item.index);
  if (claim.type === 'busy' || claim.type === 'delivered') {
    await closeOpenSquare(square);
    return;
  }
  if (claim.type === 'ambiguous') {
    const recovered = recordRecoveredUnknown(attention, claim.lease, env);
    if (recovered !== undefined) {
      await releaseNotifyLease(square, notification.recipient, notification.item.index, claim.lease.leaseId);
    }
    await closeOpenSquare(square);
    return;
  }

  const { leaseId } = claim;
  let releaseLease = true;
  try {
    const dispatchAt = now();
    const evidence = await wakeEvidence(squarePath, notification.recipient, notification.item.index, dispatchAt, env);
    if (!wakeIsEligible(evidence)) return;
    const port = new WakePort(opts.adapters ?? await defaultWakeAdapters());
    const request: WakeRequest = {
      squarePath,
      actIndex: notification.item.index,
      recipient: notification.recipient,
      actor: notification.item.actor,
      route: notification.route,
    };
    await port.dispatch(
      evidence.attemptableRoutes,
      (route) => renderWakePayload(request, notification.item.body, route.kind),
      {
        nextAttemptN: () => nextWakeAttemptNumber(attention, { env, now: now() }),
        beforeSend: async (route, attemptN) => {
          if (await waitForCatch(route, request, notification.item.body)) return false;
          const currentAt = now();
          if (!(await entryPresentation(square, notification.recipient)).joined) return false;
          const current = await wakeEvidence(squarePath, notification.recipient, notification.item.index, currentAt, env);
          if (!wakeIsEligible(current)) return false;
          if (!current.attemptableRoutes.some((candidate) =>
            candidate.ownerId === route.ownerId && candidate.kind === route.kind && candidate.sessionId === route.sessionId
          )) return false;
          const dispatching = await transitionNotifyLease(
            square,
            notification.recipient,
            notification.item.index,
            leaseId,
            'dispatching',
            route.kind,
            attemptN,
          );
          if (dispatching) releaseLease = false;
          return dispatching;
        },
        record: async (route, attemptN, outcome) => {
          if (outcome.outcome === 'failed') {
            await transitionNotifyLease(square, notification.recipient, notification.item.index, leaseId, 'claimed');
            releaseLease = true;
          }
          recordWakeAttempt({
            attention,
            routeKind: route.kind,
            outcome: outcome.outcome,
            attemptN,
            at: now(),
            ...('signature' in outcome ? { signature: outcome.signature } : {}),
            ...('message' in outcome ? { message: outcome.message } : {}),
            ...('diagnostic' in outcome && outcome.diagnostic !== undefined ? { diagnostic: outcome.diagnostic } : {}),
          }, env);
          if (outcome.outcome === 'accepted') {
            await markNotificationNotified(square, notification.recipient, notification.item.index, route.ownerId, now());
          }
          if (outcome.outcome !== 'failed') releaseLease = true;
        },
        invalidate: async (route) => {
          retireWakeRoute(route, { env, at: now() });
        },
      },
    );
  } finally {
    if (releaseLease) {
      await releaseNotifyLease(square, notification.recipient, notification.item.index, leaseId);
    }
      await closeOpenSquare(square);
  }
}

export async function processActNotificationsOnce(squarePath: string, actIndex: number, opts: ProcessNotificationOptions = {}): Promise<void> {
  const square = await openSquare(squarePath);
  const notifications = await notificationForAct(square, actIndex).finally(() => closeOpenSquare(square));
  await Promise.all(notifications.map((notification) => processNotification(squarePath, notification, opts)));
}

interface WorkerLaunchOptions {
  launchWorker?: (workerPath: string, args: string[]) => void;
  env?: NodeJS.ProcessEnv;
}

function launchWorker(workerPath: string, args: string[]): void {
  const child = spawn(process.execPath, [workerPath, ...args], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

export function wakeNotifierForSquare(squarePath: string, env: NodeJS.ProcessEnv = process.env): WakeNotifier {
  return {
    wake(recipients: readonly string[], activity: Activity): void {
      if (env.SQUARE_DISABLE_PASEO_WAKE === '1' || recipients.length === 0) return;
      const actIndex = parseActivityId(activity.id);
      if (actIndex === undefined) return;
      launchWorker(fileURLToPath(new URL('./cmd/notify-once.js', import.meta.url)), ['--location', squarePath, '--act-index', String(actIndex)]);
    },
  };
}

export interface SweepPendingNotificationsOptions extends WorkerLaunchOptions {
  now?: number;
  limit?: number;
}

/** Reconsider old pending attention at a bounded action boundary using the existing worker. */
export async function sweepPendingNotifications(
  squarePath: string,
  opts: SweepPendingNotificationsOptions = {},
): Promise<number[]> {
  const env = opts.env ?? process.env;
  if (env.SQUARE_DISABLE_PASEO_WAKE === '1') return [];
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 8;
  const square = await openSquare(squarePath, { clock: () => now });
  const pending = await pendingDeliveries(square).finally(() => closeOpenSquare(square));
  const indexes = new Set<number>();
  for (const delivery of pending) {
    for (const note of delivery.notifications) {
      if (now - note.item.at <= wakeGraceMs(env)) continue;
      if (!wakeIsEligible(await wakeEvidence(squarePath, delivery.recipient, note.item.index, now, env))) continue;
      indexes.add(note.item.index);
    }
  }
  const selected = [...indexes].sort((a, b) => a - b).slice(0, Math.max(0, limit));
  const workerPath = fileURLToPath(new URL('./cmd/notify-once.js', import.meta.url));
  for (const actIndex of selected) {
    (opts.launchWorker ?? launchWorker)(workerPath, ['--location', squarePath, '--act-index', String(actIndex)]);
  }
  return selected;
}
