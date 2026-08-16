import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadSquare } from './artifact.js';
import {
  deriveDeliveryModel,
  isDeliveryDelivered,
  leaseOwnsNotification,
  planActNotifications,
  type WakeAdapter,
  type WakeRequest,
} from './delivery.js';
import { sessionInbox } from './inbox.js';
import { hasPresentedAttention } from './presented.js';
import { nameKey, SquareError, type NotifyLease, type WakeRoute, type WakeRouteKind } from './model.js';
import { SLEEP_MS, matchesMentionTarget, resolveRosterName, rosterNames } from './runtime.js';
import { PaseoAdapter } from './paseo-delivery.js';
import { quoteShell } from './presentation.js';
import { lookupParticipant } from './registry.js';
import { isCurrentlyJoined } from './runtime.js';
import { execute } from './square-application.js';
import {
  nextWakeAttemptNumber,
  recordRecoveredUnknown,
  recordWakeAttempt,
  type WakeAttention,
} from './wake-attempts.js';
import { joinedRecipients, wakeEvidence, wakeIsEligible } from './wake-evidence.js';
import { WakePort } from './wake-port.js';

const NOTIFY_LEASE_MS = 5 * 60 * 1000;

export type { PlannedNotification } from './delivery.js';
export { planActNotifications, matchesMentionTarget };

function known(doc: ReturnType<typeof loadSquare>, name: string): string {
  const value = resolveRosterName(doc, name);
  if (value === undefined) throw new SquareError('invalid_args', `Unknown participant "${name}". Expected one of: ${rosterNames(doc).join(', ')}.`);
  return value;
}

export { notificationMessageId } from './delivery.js';

export function wakeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? '5000', 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', 'Invalid SQUARE_NOTIFY_DELIVERY_WAIT_MS: expected a positive integer.');
  }
  return value;
}

function catchCommand(squarePath: string, recipient: string): string {
  return `square --as ${quoteShell(recipient)} --location ${quoteShell(squarePath)} catch --now`;
}

function renderWakePayload(request: WakeRequest): string {
  const display = request.squarePath.startsWith(homedir())
    ? `~${request.squarePath.slice(homedir().length)}`
    : request.squarePath;
  return [
    '<system-reminder source="square">',
    `${request.route === 'bell' ? 'Bell' : 'Mention'} from @${request.actor} in \`${display}\``,
    'The native adapter will present it at the next boundary. If no native wake is available, pull from the square yourself.',
    `\`${catchCommand(request.squarePath, request.recipient)}\``,
    '</system-reminder>',
  ].join('\n');
}

async function waitForCatch(route: WakeRoute, request: WakeRequest, body: string): Promise<boolean> {
  const binding = lookupParticipant(request.squarePath, request.recipient)
    .find((item) => item.ownerId === route.ownerId);
  const activeCatch = binding && sessionInbox(binding.sessionId)
    .find((item) => item.name === request.recipient)?.catchLease;
  if (!activeCatch || !leaseOwnsNotification(activeCatch, {
    actor: request.actor,
    body,
    route: request.route,
  })) return false;

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const doc = loadSquare(request.squarePath);
    if (isDeliveryDelivered(doc, request.recipient, request.actIndex)) return true;
    const currentBinding = lookupParticipant(request.squarePath, request.recipient)
      .find((item) => item.ownerId === route.ownerId);
    const lease = currentBinding && sessionInbox(currentBinding.sessionId)
      .find((item) => item.name === request.recipient)?.catchLease;
    if (!lease || lease.expiresAt <= Date.now()) return false;
    await sleep(Math.min(250, lease.expiresAt - Date.now()));
  }
  return false;
}

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
  if (!wakeIsEligible(wakeEvidence(squarePath, notification.recipient, notification.item.index, initialAt, env))) return;

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
    const dispatchAt = now();
    const evidence = wakeEvidence(squarePath, notification.recipient, notification.item.index, dispatchAt, env);
    if (!wakeIsEligible(evidence)) return;
    const port = new WakePort(opts.adapters ?? [new PaseoAdapter()]);
    const request: WakeRequest = {
      squarePath,
      actIndex: notification.item.index,
      recipient: notification.recipient,
      actor: notification.item.actor,
      route: notification.route,
    };
    await port.dispatch(
      evidence.attemptableRoutes,
      renderWakePayload(request),
      {
        nextAttemptN: () => nextWakeAttemptNumber(attention, { env, now: now() }),
        beforeSend: async (route, attemptN) => {
          if (await waitForCatch(route, request, notification.item.body)) return false;
          const currentAt = now();
          const latest = loadSquare(squarePath);
          if (!isCurrentlyJoined(latest.acts, notification.recipient)) return false;
          const current = wakeEvidence(squarePath, notification.recipient, notification.item.index, currentAt, env);
          if (!wakeIsEligible(current)) return false;
          if (!current.attemptableRoutes.some((candidate) =>
            candidate.ownerId === route.ownerId && candidate.kind === route.kind && candidate.sessionId === route.sessionId
          )) return false;
          const dispatching = await transitionNotifyLease(
            squarePath,
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
            await transitionNotifyLease(squarePath, notification.recipient, notification.item.index, leaseId, 'claimed');
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
          if (outcome.outcome !== 'failed') releaseLease = true;
        },
      },
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
  const notifications = planActNotifications(doc, item);
  await Promise.all(notifications.map((notification) => processNotification(squarePath, notification, opts)));
}

export interface DispatchActNotificationsOptions {
  launchWorker?: (workerPath: string, args: string[]) => void;
  env?: NodeJS.ProcessEnv;
}

function launchWorker(workerPath: string, args: string[]): void {
  const child = spawn(process.execPath, [workerPath, ...args], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

/** Start one detached worker only when this act contains directed attention. */
export async function dispatchActNotifications(squarePath: string, item: import('./model.js').StoredAct, opts: DispatchActNotificationsOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  if (env.SQUARE_DISABLE_PASEO_WAKE === '1') return;
  const doc = loadSquare(squarePath);
  if (planActNotifications(doc, item).length === 0) return;
  (opts.launchWorker ?? launchWorker)(fileURLToPath(new URL('./cmd/notify-once.js', import.meta.url)), ['--location', squarePath, '--act-index', String(item.index)]);
}

export interface SweepPendingNotificationsOptions extends DispatchActNotificationsOptions {
  now?: number;
  limit?: number;
}

/** Reconsider old pending attention at a bounded action boundary using the existing worker. */
export function sweepPendingNotifications(
  squarePath: string,
  opts: SweepPendingNotificationsOptions = {},
): number[] {
  const env = opts.env ?? process.env;
  if (env.SQUARE_DISABLE_PASEO_WAKE === '1') return [];
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 8;
  const doc = loadSquare(squarePath);
  const model = deriveDeliveryModel(doc);
  const indexes = new Set<number>();
  for (const recipient of joinedRecipients(doc)) {
    for (const note of model.pendingFor(recipient)) {
      if (now - note.item.at <= wakeGraceMs(env)) continue;
      if (!wakeIsEligible(wakeEvidence(squarePath, recipient, note.item.index, now, env))) continue;
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
