import { audienceIncludes, audienceOf, fold, formatActivityId, type ActivityId, type Reach } from './square-core.js';
import {
  SquareError,
  type StoredAct,
  type SquareDoc,
  type HoldState,
  type ReadCursor,
  type WatchLease,
  findParticipantName,
  nameKey,
  sameName,
} from './model.js';

function parseIntegerEnvValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', `Invalid ${name}: expected a positive integer.`);
  }
  return value;
}

function parseIntegerEnv(name: string, fallback: number): number {
  return parseIntegerEnvValue(name, process.env[name], fallback);
}

function parseIntegerEnvAlias(primary: string, aliases: string[], fallback: number): number {
  const candidates = [primary, ...aliases];
  for (const name of candidates) {
    if (process.env[name] !== undefined) return parseIntegerEnvValue(name, process.env[name], fallback);
  }
  return fallback;
}

function parseScaleEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new SquareError('invalid_args', `Invalid ${name}: expected a positive number.`);
  }
  return value;
}

function scaledMs(baseMs: number, scale: number): number {
  return Math.max(1, Math.round(baseMs * scale));
}

export const WATCH_HEARTBEAT_MS = parseIntegerEnv('SQUARE_WATCH_HEARTBEAT_MS', 60000);
export const SLEEP_MS = parseIntegerEnvAlias(
  'SQUARE_WATCH_POLL_MS',
  ['SQUARE_SLEEP_MS'],
  scaledMs(WATCH_HEARTBEAT_MS, parseScaleEnv('SQUARE_WATCH_POLL_SCALE', 1 / 6))
);
export const STALE_MS = parseIntegerEnvAlias(
  'SQUARE_WATCH_QUIET_MS',
  ['SQUARE_STALE_MS'],
  scaledMs(WATCH_HEARTBEAT_MS, parseScaleEnv('SQUARE_WATCH_QUIET_SCALE', 5))
);
export const WATCH_STALE_MS = parseIntegerEnv('SQUARE_WATCH_STALE_MS', scaledMs(WATCH_HEARTBEAT_MS, parseScaleEnv('SQUARE_WATCH_STALE_SCALE', 3)));
export const LOCK_RETRY_MS = parseIntegerEnv('SQUARE_LOCK_RETRY_MS', 25);
export const LOCK_STALE_MS = parseIntegerEnv('SQUARE_LOCK_STALE_MS', 30000);
export const THROTTLE_WINDOW_MS = parseIntegerEnv('SQUARE_THROTTLE_WINDOW_MS', 60000);
export const UNREAD_BLOCK_GRACE_MS = parseIntegerEnv('SQUARE_UNREAD_BLOCK_GRACE_MS', 90000);

export function nowMs(): number {
  const override = process.env.SQUARE_NOW_MS;
  if (override === undefined) return Date.now();
  const value = parseInt(override, 10);
  if (!Number.isFinite(value)) {
    throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
  }
  return value;
}

/** Pure directed-activity filter. Bell matches every viewer; mentions match by audience. */
export function matchesMentionTarget(act: { body: string; reach?: Reach }, mention: string | true): boolean {
  const audience = audienceOf(act);
  if (mention === true) return audience.kind === 'bell' || audience.names.length > 0;
  return audienceIncludes(audience, mention);
}

export function foldedState(doc: SquareDoc) {
  return fold(doc.acts);
}

export function rosterNames(doc: SquareDoc): string[] {
  return foldedState(doc).participants.map((participant) => participant.name);
}

export function inSquareCount(doc: SquareDoc): number {
  return foldedState(doc).joined.length;
}

export function resolveRosterName(doc: SquareDoc, name: string): string | undefined {
  return findParticipantName(rosterNames(doc), name);
}

export function hasQuorum(doc: SquareDoc, name: string, outs: Set<string>): boolean {
  const peers = rosterNames(doc).filter((participant) => !sameName(participant, name));
  return peers.length > 0 && peers.every((peer) => outs.has(nameKey(peer)));
}

export function countSays(acts: StoredAct[], name: string): number {
  return acts.filter((act) => act.kind === 'say' && sameName(act.actor, name)).length;
}

export function sayNumberFor(acts: StoredAct[], target: StoredAct): number {
  if (target.kind !== 'say') throw new Error('sayNumberFor only applies to say acts');
  let number = 0;
  for (const act of acts) {
    if (act.kind === 'say' && sameName(act.actor, target.actor)) number++;
    if (act === target) return number;
    if (target.index !== undefined && act.index === target.index) return number;
  }
  throw new Error('target say act is not present in act history');
}

export function doneNames(acts: StoredAct[]): Set<string> {
  return new Set(fold(acts).done.map((participant) => nameKey(participant)));
}

export function joinedNames(acts: StoredAct[]): Set<string> {
  return new Set(acts.filter((act) => act.kind === 'join').map((act) => nameKey(act.actor)));
}

export function isCurrentlyJoined(acts: StoredAct[], name: string): boolean {
  return fold(acts).participants.some((participant) => sameName(participant.name, name) && participant.joined);
}

/** Stable index of the recipient's most recent join act, if any. */
export function lastJoinIndex(acts: StoredAct[], name: string): number | undefined {
  let last: number | undefined;
  for (const act of acts) {
    if (act.kind === 'join' && sameName(act.actor, name)) last = actStableIndex(act);
  }
  return last;
}

export function actStableIndex(act: StoredAct): number {
  if (act.index === undefined) throw new Error(`act ${act.kind} is missing a stable index`);
  return act.index;
}

export function actId(actOrIndex: StoredAct | number): ActivityId {
  const index = typeof actOrIndex === 'number' ? actOrIndex : actStableIndex(actOrIndex);
  return formatActivityId(index);
}

export function getReadState(doc: SquareDoc, name: string): ReadCursor | undefined {
  return doc.runtime.cursors[name] ?? Object.entries(doc.runtime.cursors).find(([participant]) => sameName(participant, name))?.[1];
}

export function readCursor(doc: SquareDoc, name: string): number {
  return getReadState(doc, name)?.consumedThroughIndex ?? -1;
}

export function currentHold(acts: StoredAct[]): HoldState {
  const hold = fold(acts).hold;
  return hold.active ? { active: true, at: hold.at, reason: hold.reason } : { active: false };
}

export function publicActs(acts: StoredAct[]): Array<Extract<StoredAct, { kind: 'say' | 'done' }>> {
  return acts.filter((act): act is Extract<StoredAct, { kind: 'say' | 'done' }> => act.kind === 'say' || act.kind === 'done');
}

function canonicalRuntimeName(doc: SquareDoc, name: string): string {
  return resolveRosterName(doc, name) ?? name;
}

export function advanceCursor(
  doc: SquareDoc,
  name: string,
  index: number,
  updatedAt = Date.now()
): boolean {
  return touchPresenceCursor(doc, name, updatedAt, index);
}

export function touchPresenceCursor(
  doc: SquareDoc,
  name: string,
  at: number,
  consumedThroughIndex?: number
): boolean {
  if (!Number.isFinite(at)) return false;
  if (consumedThroughIndex !== undefined && (!Number.isInteger(consumedThroughIndex) || consumedThroughIndex < 0)) return false;
  const key = canonicalRuntimeName(doc, name);
  const current = getReadState(doc, key);
  const nextIndex =
    consumedThroughIndex === undefined
      ? (current?.consumedThroughIndex ?? readCursor(doc, key))
      : Math.max(current?.consumedThroughIndex ?? -1, consumedThroughIndex);
  const updatedAt = current === undefined ? at : Math.max(current.updatedAt, at);
  if (current?.consumedThroughIndex === nextIndex && current.updatedAt === updatedAt) return false;
  doc.runtime.cursors[key] = { consumedThroughIndex: nextIndex, updatedAt };
  return true;
}

export function latestActIndex(acts: StoredAct[]): number {
  return acts.reduce((max, act) => Math.max(max, act.index), -1);
}

export function freshWatchLease(doc: SquareDoc, name: string, at = Date.now()) {
  const key = canonicalRuntimeName(doc, name);
  const lease = watchLease(doc, key);
  if (lease === undefined || lease.expiresAt <= at || at - lease.heartbeatAt > WATCH_STALE_MS) return undefined;
  return lease;
}

export function watchLease(doc: SquareDoc, name: string): WatchLease | undefined {
  return doc.runtime.leases[canonicalRuntimeName(doc, name)];
}

export function writeWatchLease(doc: SquareDoc, name: string, lease: WatchLease): void {
  doc.runtime.leases[canonicalRuntimeName(doc, name)] = lease;
}

export function removeWatchLease(doc: SquareDoc, name: string, leaseId: string): boolean {
  const key = canonicalRuntimeName(doc, name);
  if (doc.runtime.leases[key]?.leaseId !== leaseId) return false;
  delete doc.runtime.leases[key];
  return true;
}
