import { createDefaultWakeTransport, type WakeTransports } from './wake-transports.js';
export { createDefaultWakeTransport, createWakeTransport, type WakeTransports } from './wake-transports.js';
import { squareWakeProjection } from './wake-preview.js';
import path from 'node:path';
import { canonicalPath } from './canonical-path.js';
import fs from 'node:fs';

import { indexedSquareEntries } from './square-index.js';

import { InternalSquareError, SquareError } from './model.js';
import { channelArtifact, createArtifactPort } from './artifact.js';
import { deliverPending, sweepPending } from './delivery-operations.js';
import { formatMessageId } from './message.js';

export const PRIVILEGED_HOOK_BUDGET_MS = 3000;

export function wakeGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? '5000', 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', 'Invalid SQUARE_NOTIFY_DELIVERY_WAIT_MS: expected a positive integer.');
  }
  return value;
}

interface ProcessNotificationOptions {
  transports?: WakeTransports;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export async function processActNotificationsOnce(squarePath: string, actIndex: number, opts: ProcessNotificationOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  squarePath = await canonicalPath(squarePath);
  const artifact = createArtifactPort(squarePath);
  try {
    await artifact.read(facts => facts.header());
    const transport = await createDefaultWakeTransport(env, opts.transports);
    try {
      const message = (await artifact.read(facts => { const activity = facts.activity(actIndex); return activity?.kind === 'say' ? activity.messageIndex : undefined; })).value;
      if (message === undefined) return;
      await deliverPending({ artifact: channelArtifact(artifact), preparePresentation: squareWakeProjection(artifact), transport, location: squarePath, message: formatMessageId(message), timeoutMs: Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000), now: now() });
    } catch { /* Delivery failure does not undo the activity. */ }
  } catch (error) {
    if (error instanceof InternalSquareError && error.code === 'not_found')
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    throw error;
  } finally {
    await artifact.close();
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
  for (const candidate of paths) {
    if (remainingMs() === 0 || signal?.aborted) break;
    try {
      const squarePath = await canonicalPath(candidate);
      const artifact = createArtifactPort(squarePath, undefined, signal);
      try {
        await artifact.read(facts => facts.header(), signal);
        if (remainingMs() === 0 || signal?.aborted) break;
        const limit = Number.parseInt(env.SQUARE_NOTIFY_SWEEP_LIMIT ?? '8', 10);
        const graceMs = 0;
        const selected = await sweepPending({ artifact: channelArtifact(artifact), location: squarePath, now: Date.now(), graceMs, limit: Number.isFinite(limit) && limit > 0 ? limit : 8 }).catch(() => []);
        for (const messageIndex of selected) {
          const remaining = remainingMs();
          if (remaining === 0 || signal?.aborted) break;
          const configured = Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000);
          const timeoutMs = Math.max(1, Math.min(Number.isFinite(configured) && configured > 0 ? configured : 5000, remaining));
          await deliverPending({ artifact: channelArtifact(artifact), preparePresentation: squareWakeProjection(artifact), transport, location: squarePath, message: formatMessageId(messageIndex), timeoutMs, now: Date.now() }).catch(() => undefined);
        }
      } finally { await artifact.close(); }
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
  const artifact = createArtifactPort(squarePath);
  let selected: number[];
  try {
    await artifact.read(facts => facts.header());
    selected = await sweepPending({ artifact: channelArtifact(artifact), location: squarePath, now, graceMs: wakeGraceMs(env), limit });
  } catch (error) {
    if (error instanceof InternalSquareError && error.code === 'not_found')
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    throw error;
  } finally {
    await artifact.close();
  }
  if (opts.dispatchCandidate !== undefined) {
    for (const messageIndex of selected) await opts.dispatchCandidate(messageIndex);
  }
  return selected;
}
