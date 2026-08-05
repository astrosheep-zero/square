import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadSquare } from './artifact.js';
import { deriveDeliveryModel, type DirectedNotificationRoute } from './delivery.js';
import { readNotificationFailures } from './notification-failures.js';
import { isCurrentlyJoined } from './runtime.js';
import { sameName } from './model.js';
import { formatDuration } from './time.js';

const STALE_MS = 60_000;
const LOOKBACK_MS = 60 * 60 * 1000;

export interface StalePendingDelivery {
  squarePath: string;
  recipient: string;
  actIndex: number;
  actor: string;
  at: number;
  ageMs: number;
  route: DirectedNotificationRoute;
  actedAfterWithoutDelivery: boolean;
}

export interface PendingDeliveryPartition {
  recent: StalePendingDelivery[];
  historical: StalePendingDelivery[];
}

function positive(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}: expected a positive integer.`);
  return value;
}

export function deliveryStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive('SQUARE_DELIVERY_STALE_MS', STALE_MS, env);
}

export function deliveryLookbackMs(env: NodeJS.ProcessEnv = process.env): number {
  return positive('SQUARE_DELIVERY_LOOKBACK_MS', LOOKBACK_MS, env);
}

function actedAfter(doc: ReturnType<typeof loadSquare>, recipient: string, actIndex: number): boolean {
  return doc.acts.some((act) => act.actor !== undefined && sameName(act.actor, recipient) && act.index > actIndex);
}

function pending(squarePath: string, now: number): StalePendingDelivery[] {
  const doc = loadSquare(squarePath);
  const model = deriveDeliveryModel(doc);
  const recipients = [...new Set(doc.acts.filter((act) => act.kind === 'join').map((act) => act.actor))]
    .filter((name) => isCurrentlyJoined(doc.acts, name));
  return recipients.flatMap((recipient) => model.pendingFor(recipient).map((note) => ({
    squarePath,
    recipient: note.recipient,
    actIndex: note.item.index,
    actor: note.item.actor,
    at: note.item.at,
    ageMs: now - note.item.at,
    route: note.route,
    actedAfterWithoutDelivery: actedAfter(doc, note.recipient, note.item.index),
  })));
}

export function partitionPendingDeliveries(
  squarePath: string,
  opts: { now?: number; staleMs?: number; lookbackMs?: number } = {},
): PendingDeliveryPartition {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? deliveryStaleMs();
  const lookbackMs = Math.max(opts.lookbackMs ?? deliveryLookbackMs(), staleMs);
  const recent: StalePendingDelivery[] = [];
  const historical: StalePendingDelivery[] = [];
  for (const item of pending(squarePath, now)) {
    if (item.ageMs >= staleMs && item.ageMs <= lookbackMs) recent.push(item);
    else if (item.ageMs >= staleMs) historical.push(item);
  }
  return { recent, historical };
}

function byRecipient(items: StalePendingDelivery[]): string[] {
  const groups = new Map<string, StalePendingDelivery[]>();
  for (const item of items) groups.set(item.recipient, [...(groups.get(item.recipient) ?? []), item]);
  return [...groups].map(([recipient, notes]) => {
    const oldest = notes.reduce((first, item) => item.at < first.at ? item : first);
    const adapterFault = notes.some((item) => item.actedAfterWithoutDelivery);
    return adapterFault
      ? `  · @${recipient}: ${notes.length} pending; they acted after it without a receipt (act_${oldest.actIndex})`
      : `  · @${recipient}: ${notes.length} pending (oldest act_${oldest.actIndex} from @${oldest.actor})`;
  });
}

export function formatStaleDeliveryWarnings(
  recent: StalePendingDelivery[],
  historical: StalePendingDelivery[] = [],
  opts: { previousBacklog?: number } = {},
): string[] {
  const out: string[] = [];
  if (recent.length > 0) {
    const adapterFaults = recent.filter((item) => item.actedAfterWithoutDelivery);
    out.push(adapterFaults.length > 0
      ? `✕ ${adapterFaults.length} pending notification(s) point to an adapter/pull dead path.`
      : `✕ ${recent.length} recent notification(s) have no delivered receipt.`);
    out.push(...byRecipient(recent));
  }
  if (historical.length > 0) {
    out.push(`○ ${historical.length} older pending notification(s) remain as historical backlog.`);
    out.push(...byRecipient(historical));
    if (opts.previousBacklog !== undefined) {
      const delta = historical.length - opts.previousBacklog;
      out.push(delta === 0 ? '  · backlog unchanged since last doctor.' : delta > 0 ? `  · backlog grew by ${delta} since last doctor.` : `  · backlog shrank by ${-delta} since last doctor.`);
    }
  } else if ((opts.previousBacklog ?? 0) > 0) out.push(`○ backlog cleared (was ${opts.previousBacklog}).`);
  return out;
}

function baselineFile(env: NodeJS.ProcessEnv): string {
  return env.SQUARE_DELIVERY_BASELINE ?? path.join(os.homedir(), '.square', 'delivery-baseline.json');
}

function baseline(squarePath: string, env: NodeJS.ProcessEnv): number | undefined {
  try { return JSON.parse(fs.readFileSync(baselineFile(env), 'utf8'))[path.resolve(squarePath)]?.backlogCount; } catch { return undefined; }
}

function writeBaseline(squarePath: string, backlogCount: number, env: NodeJS.ProcessEnv, at: number): void {
  const file = baselineFile(env);
  let rows: Record<string, { backlogCount: number; at: number }> = {};
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  rows[path.resolve(squarePath)] = { backlogCount, at };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
}

function formatFailures(squarePath: string, recent: StalePendingDelivery[], env: NodeJS.ProcessEnv): string[] {
  const failures = readNotificationFailures(squarePath, env);
  if (failures.length === 0) return [];
  const pendingKeys = new Set(recent.map((item) => `${item.recipient}\0${item.actIndex}`));
  const current = failures.filter((item) => item.recipient !== undefined && pendingKeys.has(`${item.recipient}\0${item.actIndex}`));
  const rows = current.length > 0 ? current : failures;
  const historical = current.length === 0;
  const latest = rows.at(-1)!;
  const diagnostic = latest.diagnostic as { passwordPresent?: boolean } | undefined;
  return [
    historical ? `○ ${rows.length} historical notification failure(s) retained: ${latest.message}` : `✕ ${rows.length} notification attempt(s) failed: ${latest.message}; receipt remains pending.`,
    ...(diagnostic?.passwordPresent === false ? ['  · PASEO_PASSWORD absent; pass PASEO_PASSWORD to the Codex process.'] : []),
    `  · ${notificationFailuresPathForDisplay(squarePath, env)}`,
  ];
}

function notificationFailuresPathForDisplay(squarePath: string, env: NodeJS.ProcessEnv): string {
  return env.SQUARE_NOTIFICATION_FAILURES ?? path.join(path.dirname(squarePath), 'notification-failures.ndjsonl');
}

export function doctorDeliveryHealth(squarePath: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string[] {
  const { recent, historical } = partitionPendingDeliveries(squarePath, { now, staleMs: deliveryStaleMs(env), lookbackMs: deliveryLookbackMs(env) });
  const prior = baseline(squarePath, env);
  writeBaseline(squarePath, historical.length, env, now);
  return [
    `· stale after ${formatDuration(deliveryStaleMs(env))} · scan window ${formatDuration(deliveryLookbackMs(env))}`,
    ...(recent.length === 0 && historical.length === 0 ? ['✓ no stale undelivered notifications'] : formatStaleDeliveryWarnings(recent, historical, { previousBacklog: prior })),
    ...formatFailures(squarePath, recent, env),
  ];
}
