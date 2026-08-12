import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadSquare } from './artifact.js';
import {
  isDeliveryDelivered,
  isPendingNotification,
  planActNotifications,
  type WakeAdapter,
} from './delivery.js';
import { hasPresentedAttention, presentedAttentionAt } from './presented.js';
import { nameKey, SquareError, type NotifyLease } from './model.js';
import { SLEEP_MS, matchesMentionTarget, resolveRosterName, rosterNames } from './runtime.js';
import { PaseoAdapter } from './paseo-delivery.js';
import { lookupParticipant } from './registry.js';
import type { WakeRouteKind } from './routes.js';
import { execute } from './square-application.js';
import {
  deriveWakeObligation,
  isWakeRouteAttemptable,
  nextWakeAttemptNumber,
  readWakeAttempts,
  recordRecoveredUnknown,
  recordWakeAttempt,
  type WakeAttention,
} from './wake-attempts.js';
import { WakePort } from './wake-port.js';

const NOTIFY_LEASE_MS = 5 * 60 * 1000;

export type { PendingNotification, PlannedNotification } from './delivery.js';
export { planActNotifications, matchesMentionTarget };

function known(doc: ReturnType<typeof loadSquare>, name: string): string {
  const value = resolveRosterName(doc, name);
  if (value === undefined) throw new SquareError('invalid_args', `Unknown participant "${name}". Expected one of: ${rosterNames(doc).join(', ')}.`);
  return value;
}

export { notificationMessageId } from './delivery.js';

export function hasDeliveredNotification(squarePath: string, name: string, ref: number | `act_${number}`): boolean {
  const doc = loadSquare(squarePath);
  return isDeliveryDelivered(doc, known(doc, name), typeof ref === 'number' ? ref : Number(ref.slice(4)));
}

export function hasAttentionNotification(squarePath: string, name: string, ref: number | `act_${number}`, env: NodeJS.ProcessEnv = process.env): boolean {
  const doc = loadSquare(squarePath);
  const recipient = known(doc, name);
  const index = typeof ref === 'number' ? ref : Number(ref.slice(4));
  return isDeliveryDelivered(doc, recipient, index) || hasPresentedAttention(squarePath, recipient, index, env);
}

export async function waitForDeliveredNotification(squarePath: string, name: string, ref: number | `act_${number}`, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30000);
  while (Date.now() <= deadline) {
    if (hasDeliveredNotification(squarePath, name, ref)) return true;
    await sleep(Math.min(SLEEP_MS, Math.max(1, deadline - Date.now())));
  }
  return false;
}

interface ProcessNotificationOptions {
  adapters?: WakeAdapter[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function notifyLeaseKey(recipient: string, actIndex: number): string {
  return JSON.stringify([`act_${actIndex}`, nameKey(recipient)]);
}

type NotifyLeaseClaim =
  | { type: 'acquired'; leaseId: string }
  | { type: 'busy' }
  | { type: 'ambiguous'; lease: NotifyLease };

async function claimNotifyLease(squarePath: string, recipient: string, actIndex: number): Promise<NotifyLeaseClaim> {
  const at = Date.now();
  const committed = await execute<NotifyLeaseClaim>(squarePath, {
    type: 'claim-notify',
    key: notifyLeaseKey(recipient, actIndex),
    leaseId: randomUUID(),
    at,
    expiresAt: at + NOTIFY_LEASE_MS,
  });
  return committed.result;
}

async function transitionNotifyLease(
  squarePath: string,
  recipient: string,
  actIndex: number,
  leaseId: string,
  phase: 'claimed' | 'dispatching',
  routeKind?: WakeRouteKind,
  attemptN?: number,
  obligationN?: number,
): Promise<boolean> {
  const at = Date.now();
  const committed = await execute<{ updated: boolean }>(squarePath, {
    type: 'transition-notify',
    key: notifyLeaseKey(recipient, actIndex),
    leaseId,
    expiresAt: at + NOTIFY_LEASE_MS,
    phase,
    ...(routeKind === undefined ? {} : { routeKind }),
    ...(attemptN === undefined ? {} : { attemptN }),
    ...(obligationN === undefined ? {} : { obligationN }),
  });
  return committed.result.updated;
}

function releaseNotifyLease(squarePath: string, recipient: string, actIndex: number, leaseId: string): Promise<unknown> {
  return execute(squarePath, {
    type: 'release-notify',
    key: notifyLeaseKey(recipient, actIndex),
    leaseId,
  });
}

async function processNotification(
  squarePath: string,
  notification: import('./delivery.js').PendingNotification,
  opts: ProcessNotificationOptions
): Promise<void> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const attention: WakeAttention = {
    squarePath,
    actIndex: notification.item.index,
    recipient: notification.recipient,
  };
  const requiresAck = notification.item.kind === 'say' && notification.item.requiresAck === true;
  if (hasDeliveredNotification(squarePath, notification.recipient, notification.item.index)) return;
  const initialAt = now();
  const initialObligation = deriveWakeObligation(
    requiresAck,
    readWakeAttempts({ attention, env, now: initialAt }),
    initialAt,
    presentedAttentionAt(squarePath, notification.recipient, notification.item.index, env, initialAt),
  );
  if (initialObligation.type !== 'open') return;

  const claim = await claimNotifyLease(squarePath, notification.recipient, notification.item.index);
  if (claim.type === 'busy') return;
  if (claim.type === 'ambiguous') {
    const recovered = recordRecoveredUnknown(attention, claim.lease, env);
    if (recovered !== undefined) {
      await releaseNotifyLease(squarePath, notification.recipient, notification.item.index, claim.lease.leaseId);
    }
    return;
  }

  const { leaseId } = claim;
  let releaseLease = true;
  try {
    if (hasDeliveredNotification(squarePath, notification.recipient, notification.item.index)) return;
    const obligationAt = now();
    const obligation = deriveWakeObligation(
      requiresAck,
      readWakeAttempts({ attention, env, now: obligationAt }),
      obligationAt,
      presentedAttentionAt(squarePath, notification.recipient, notification.item.index, env, obligationAt),
    );
    if (obligation.type !== 'open') return;
    const obligationN = obligation.obligationN;
    const owners = new Set(
      lookupParticipant(squarePath, notification.recipient, obligationAt).map((binding) => binding.ownerId),
    );
    const port = new WakePort(opts.adapters ?? [new PaseoAdapter()], env);
    await port.dispatch(
      owners,
      {
        squarePath,
        actIndex: notification.item.index,
        recipient: notification.recipient,
        actor: notification.item.actor,
        route: notification.route,
      },
      {
        nextAttemptN: () => nextWakeAttemptNumber(attention, { env, now: now() }),
        canAttempt: (route) => isWakeRouteAttemptable(
          route,
          readWakeAttempts({ attention, env, now: now() }),
          obligationN,
        ),
        beforeSend: async (route, attemptN) => {
          if (hasDeliveredNotification(squarePath, notification.recipient, notification.item.index)) return false;
          const currentAt = now();
          const current = deriveWakeObligation(
            requiresAck,
            readWakeAttempts({ attention, env, now: currentAt }),
            currentAt,
            presentedAttentionAt(squarePath, notification.recipient, notification.item.index, env, currentAt),
          );
          if (current.type !== 'open' || current.obligationN !== obligationN) return false;
          const dispatching = await transitionNotifyLease(
            squarePath,
            notification.recipient,
            notification.item.index,
            leaseId,
            'dispatching',
            route.kind,
            attemptN,
            obligationN,
          );
          if (dispatching) releaseLease = false;
          return dispatching;
        },
        record: async (route, attemptN, outcome) => {
          if (outcome.outcome === 'failed') {
            await transitionNotifyLease(squarePath, notification.recipient, notification.item.index, leaseId, 'claimed');
            releaseLease = true;
          }
          recordWakeAttempt({
            attention,
            routeKind: route.kind,
            outcome: outcome.outcome,
            attemptN,
            obligationN,
            at: now(),
            ...('signature' in outcome ? { signature: outcome.signature } : {}),
            ...('message' in outcome ? { message: outcome.message } : {}),
            ...('diagnostic' in outcome && outcome.diagnostic !== undefined ? { diagnostic: outcome.diagnostic } : {}),
          }, env);
          if (outcome.outcome !== 'failed') releaseLease = true;
        },
      },
      obligationAt,
    );
  } finally {
    if (releaseLease) {
      await releaseNotifyLease(squarePath, notification.recipient, notification.item.index, leaseId);
    }
  }
}

export async function processActNotificationsOnce(squarePath: string, actIndex: number, opts: ProcessNotificationOptions = {}): Promise<void> {
  const doc = loadSquare(squarePath);
  const item = doc.acts.find((candidate) => candidate.index === actIndex);
  if (item === undefined) return;
  const notifications = planActNotifications(doc, item).filter(isPendingNotification);
  await Promise.all(notifications.map((notification) => processNotification(squarePath, notification, opts)));
}

export interface DispatchActNotificationsOptions {
  launchWorker?: (workerPath: string, args: string[]) => void;
}

function launchWorker(workerPath: string, args: string[]): void {
  const child = spawn(process.execPath, [workerPath, ...args], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

/** Start one detached worker only when this act contains directed attention. */
export async function dispatchActNotifications(squarePath: string, item: import('./model.js').StoredAct, opts: DispatchActNotificationsOptions = {}): Promise<void> {
  if (process.env.SQUARE_DISABLE_PASEO_WAKE === '1') return;
  const doc = loadSquare(squarePath);
  if (!planActNotifications(doc, item).some(isPendingNotification)) return;
  (opts.launchWorker ?? launchWorker)(fileURLToPath(new URL('./cmd/notify-once.js', import.meta.url)), ['--square-path', squarePath, '--act-index', String(item.index)]);
}
