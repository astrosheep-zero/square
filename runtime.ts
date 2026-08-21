import { audienceIncludes, audienceOf, fold, formatActivityId, type ActivityId, type Reach } from './square-core.js';
import {
  SquareError,
  type StoredAct,
  type SquareState,
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

export function foldedState(squareState: SquareState) {
  return fold(squareState.acts);
}

export function rosterNames(squareState: SquareState): string[] {
  return foldedState(squareState).participants.map((participant) => participant.name);
}

export function inSquareCount(squareState: SquareState): number {
  return foldedState(squareState).joined.length;
}

export function resolveRosterName(squareState: SquareState, name: string): string | undefined {
  return findParticipantName(rosterNames(squareState), name);
}

export function hasQuorum(squareState: SquareState, name: string, outs: Set<string>): boolean {
  const peers = rosterNames(squareState).filter((participant) => !sameName(participant, name));
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

export function getReadState(squareState: SquareState, name: string): ReadCursor | undefined {
  return squareState.runtime.cursors[name] ?? Object.entries(squareState.runtime.cursors).find(([participant]) => sameName(participant, name))?.[1];
}

export function readCursor(squareState: SquareState, name: string): number {
  return getReadState(squareState, name)?.consumedThroughIndex ?? -1;
}

export function currentHold(acts: StoredAct[]): HoldState {
  const hold = fold(acts).hold;
  return hold.active ? { active: true, at: hold.at, reason: hold.reason } : { active: false };
}

export function publicActs(acts: StoredAct[]): Array<Extract<StoredAct, { kind: 'say' | 'done' }>> {
  return acts.filter((act): act is Extract<StoredAct, { kind: 'say' | 'done' }> => act.kind === 'say' || act.kind === 'done');
}

function canonicalRuntimeName(squareState: SquareState, name: string): string {
  return resolveRosterName(squareState, name) ?? name;
}

export function advanceCursor(
  squareState: SquareState,
  name: string,
  index: number,
  updatedAt = Date.now()
): boolean {
  return touchPresenceCursor(squareState, name, updatedAt, index);
}

export function touchPresenceCursor(
  squareState: SquareState,
  name: string,
  at: number,
  consumedThroughIndex?: number
): boolean {
  if (!Number.isFinite(at)) return false;
  if (consumedThroughIndex !== undefined && (!Number.isInteger(consumedThroughIndex) || consumedThroughIndex < 0)) return false;
  const key = canonicalRuntimeName(squareState, name);
  const current = getReadState(squareState, key);
  const nextIndex =
    consumedThroughIndex === undefined
      ? (current?.consumedThroughIndex ?? readCursor(squareState, key))
      : Math.max(current?.consumedThroughIndex ?? -1, consumedThroughIndex);
  const updatedAt = current === undefined ? at : Math.max(current.updatedAt, at);
  if (current?.consumedThroughIndex === nextIndex && current.updatedAt === updatedAt) return false;
  squareState.runtime.cursors[key] = { consumedThroughIndex: nextIndex, updatedAt };
  return true;
}

export function latestActIndex(acts: StoredAct[]): number {
  return acts.reduce((max, act) => Math.max(max, act.index), -1);
}

export function freshWatchLease(squareState: SquareState, name: string, at = Date.now()) {
  const key = canonicalRuntimeName(squareState, name);
  const lease = watchLease(squareState, key);
  if (lease === undefined || lease.expiresAt <= at || at - lease.heartbeatAt > WATCH_STALE_MS) return undefined;
  return lease;
}

export function watchLease(squareState: SquareState, name: string): WatchLease | undefined {
  return squareState.runtime.leases[canonicalRuntimeName(squareState, name)];
}

export function writeWatchLease(squareState: SquareState, name: string, lease: WatchLease): void {
  squareState.runtime.leases[canonicalRuntimeName(squareState, name)] = lease;
}

export function removeWatchLease(squareState: SquareState, name: string, leaseId: string): boolean {
  const key = canonicalRuntimeName(squareState, name);
  if (squareState.runtime.leases[key]?.leaseId !== leaseId) return false;
  delete squareState.runtime.leases[key];
  return true;
}
