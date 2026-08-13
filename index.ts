export { SquareError } from './model.js';
export type {
  ActivitiesOptions,
  BuildOptions,
  HardCap,
  ReadCursor,
  SquareDoc,
  StoredAct,
  WatchLease,
  WatchOptions,
} from './model.js';
export type { Act, Reach } from './square-core.js';
export { loadSquare } from './artifact.js';
export {
  extractMentions,
  countSays,
  joinedNames,
  doneNames,
  isCurrentlyJoined,
  publicActs,
  readCursor,
} from './runtime.js';

import { loadSquare } from './artifact.js';
import {
  hasDeliveredNotification as hasDeliveredNotificationImpl,
  waitForDeliveredNotification as waitForDeliveredNotificationImpl,
} from './notifications.js';
import { type ReadCursor, type WatchLease } from './model.js';
import {
  WATCH_STALE_MS,
  freshWatchLease,
  getReadState as getDocReadState,
} from './runtime.js';
import { decideAct, resolveKnownName } from './decisions.js';
import { execute } from './square-application.js';

export { WATCH_STALE_MS };

export type ActRef = number | `act_${number}`;

export interface ParticipantPresence {
  watching: boolean;
  lease?: WatchLease;
}

export interface ExpressOptions {
  force?: boolean;
  reply?: ActRef;
}

function actRefIndex(ref: ActRef): number {
  if (typeof ref === 'number') return ref;
  const match = ref.match(/^act_(\d+)$/);
  if (!match) throw new Error(`Invalid act ref: ${ref}`);
  return Number(match[1]);
}

export function getReadState(squarePath: string, name: string): ReadCursor | undefined {
  const doc = loadSquare(squarePath);
  return getDocReadState(doc, resolveKnownName(doc, name));
}

export function hasConsumedAct(squarePath: string, name: string, ref: ActRef): boolean {
  const state = getReadState(squarePath, name);
  return (state?.consumedThroughIndex ?? -1) >= actRefIndex(ref);
}

export function hasDeliveredNotification(squarePath: string, name: string, ref: ActRef): boolean {
  return hasDeliveredNotificationImpl(squarePath, name, actRefIndex(ref));
}

export async function waitForDeliveredNotification(
  squarePath: string,
  name: string,
  ref: ActRef,
  opts: { timeoutMs?: number } = {}
): Promise<boolean> {
  return waitForDeliveredNotificationImpl(squarePath, name, actRefIndex(ref), opts);
}

export function getParticipantPresence(squarePath: string, name: string, now = Date.now()): ParticipantPresence {
  const doc = loadSquare(squarePath);
  const known = resolveKnownName(doc, name);
  const lease = freshWatchLease(doc, known, now);
  return lease === undefined ? { watching: false } : { watching: true, lease };
}

export function isWatching(squarePath: string, name: string, now = Date.now()): boolean {
  return getParticipantPresence(squarePath, name, now).watching;
}

/** Typed participant intents share the same commit/effect pipeline as the CLI. */
export async function join(squarePath: string, name: string): Promise<void> {
  await execute(squarePath, { type: 'join', name, now: Date.now() });
}

export async function done(squarePath: string, name: string, body = ''): Promise<void> {
  await execute(squarePath, { type: 'done', name, body, now: Date.now() });
}

export async function hold(squarePath: string, actor: string, body = ''): Promise<void> {
  await execute(squarePath, { type: 'hold', actor, body, now: Date.now() });
}

export async function resume(squarePath: string, actor: string): Promise<void> {
  await execute(squarePath, { type: 'resume', actor, now: Date.now() });
}

export async function express(squarePath: string, name: string, body: string, opts: ExpressOptions = {}): Promise<void> {
  const committed = await execute<ReturnType<typeof decideAct>>(squarePath, {
    type: 'say',
    name,
    body,
    force: opts.force ?? false,
    now: Date.now(),
    ...(opts.reply === undefined ? {} : { reply: actRefIndex(opts.reply) }),
  });
  if (committed.result.type !== 'sent') throw new Error(`Activity rejected: ${committed.result.type}`);
}
