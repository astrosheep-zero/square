import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadSquare } from './artifact.js';
import {
  isDeliveryDelivered,
  isPendingNotification,
  type NotificationSink,
  planActNotifications,
} from './delivery.js';
import { recordNotificationFailure } from './notification-failures.js';
import { hasPresentedAttention } from './presented.js';
import { SquareError } from './model.js';
import { SLEEP_MS, matchesMentionTarget, resolveRosterName, rosterNames } from './runtime.js';
import { defaultWakeSinks } from './wake-sink.js';

export type { NotificationSink, PendingNotification, PlannedNotification } from './delivery.js';
export { planActNotifications, matchesMentionTarget };

function known(doc: ReturnType<typeof loadSquare>, name: string): string {
  const value = resolveRosterName(doc, name);
  if (value === undefined) throw new SquareError('invalid_args', `Unknown participant "${name}". Expected one of: ${rosterNames(doc).join(', ')}.`);
  return value;
}

export { notificationMessageId } from './delivery.js';

export function notificationDeliveryWaitMs(): number {
  const value = Number.parseInt(process.env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? '5000', 10);
  if (!Number.isFinite(value) || value <= 0) throw new SquareError('invalid_args', 'Invalid SQUARE_NOTIFY_DELIVERY_WAIT_MS: expected a positive integer.');
  return value;
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

export async function processActNotificationsOnce(squarePath: string, actIndex: number, opts: { sinks?: NotificationSink[] } = {}): Promise<void> {
  const doc = loadSquare(squarePath);
  const item = doc.acts.find((candidate) => candidate.index === actIndex);
  if (item === undefined) return;
  const notifications = planActNotifications(doc, item).filter(isPendingNotification);
  for (const notification of notifications) {
    if (hasAttentionNotification(squarePath, notification.recipient, notification.item.index)) continue;
    for (const sink of opts.sinks ?? defaultWakeSinks()) {
      try {
        await sink.dispatch(notification, { squarePath });
      } catch (error) {
        recordNotificationFailure(squarePath, {
          actIndex: notification.item.index,
          recipient: notification.recipient,
          route: notification.route,
          sink: sink.name,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && 'diagnostic' in error ? { diagnostic: (error as Error & { diagnostic?: unknown }).diagnostic } : {}),
        });
      }
    }
  }
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
