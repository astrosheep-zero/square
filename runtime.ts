import { formatActivityId, type ActivityId } from './square-core.js';
import { SquareError, sameName, type StoredAct, type WatchLease } from './model.js';
import type { ParticipantFact, SquareRead } from './ports.js';

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new SquareError('invalid_args', `Invalid ${name}: expected a positive integer.`);
  return value;
}
export const WATCH_HEARTBEAT_MS = parseIntegerEnv('SQUARE_WATCH_HEARTBEAT_MS', 60000);
export const SLEEP_MS = parseIntegerEnv('SQUARE_WATCH_POLL_MS', 10000);
export const STALE_MS = parseIntegerEnv('SQUARE_WATCH_QUIET_MS', 300000);
export const WATCH_STALE_MS = parseIntegerEnv('SQUARE_WATCH_STALE_MS', 180000);
export const THROTTLE_WINDOW_MS = parseIntegerEnv('SQUARE_THROTTLE_WINDOW_MS', 60000);
export const UNREAD_BLOCK_GRACE_MS = parseIntegerEnv('SQUARE_UNREAD_BLOCK_GRACE_MS', 90000);
export const HELD_WAIT_BUDGET_MS = parseIntegerEnv('SQUARE_HELD_WAIT_BUDGET_MS', 10 * 60 * 1000);
export const FACT_PAGE_SIZE = 100;

export function nowMs(): number {
  const override = process.env.SQUARE_NOW_MS;
  if (override === undefined) return Date.now();
  const value = parseInt(override, 10);
  if (!Number.isFinite(value)) throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
  return value;
}
export function rosterNames(facts: SquareRead): string[] { return facts.roster().map((participant) => participant.name); }
export function inSquareCount(facts: SquareRead): number { return facts.roster().filter((participant) => participant.joined).length; }
export function actId(actOrIndex: StoredAct | number): ActivityId { return formatActivityId(typeof actOrIndex === 'number' ? actOrIndex : actOrIndex.index); }

export function terminalStatusFor(name: string, ownActivityCount: number, hardCap: number | null, roster: readonly ParticipantFact[]): 'capped' | 'quorum' | undefined {
  if (hardCap !== null && ownActivityCount >= hardCap) return 'capped';
  const peers = roster.filter((participant) => !sameName(participant.name, name));
  return peers.length > 0 && peers.every((peer) => peer.done) ? 'quorum' : undefined;
}
export function watchTerminalStatus(facts: SquareRead, name: string): 'capped' | 'quorum' | undefined {
  const cap = facts.header().hardCap;
  const ownActivityCount = cap === null ? 0 : facts.participant(name)?.sayCount ?? 0;
  if (cap !== null && ownActivityCount >= cap) return 'capped';
  return terminalStatusFor(name, ownActivityCount, cap, facts.roster());
}

/** A continuous prefix stops at the first unseen historical audience edge after join. */
export function readCursor(facts: SquareRead, name: string): number {
  const boundary = facts.participant(name)?.lastJoinIndex ?? -1;
  const block = facts.directed(name, { afterIndex: boundary, unseenOnly: true }, { edge: 'oldest', limit: 1 }).items[0]?.index;
  const last = facts.activityHeads({
    afterIndex: boundary, ...(block === undefined ? {} : { beforeIndex: block }), actorRequired: true,
    kinds: ['join', 'done', 'say', 'hold', 'resume', 'listen', 'ignore'],
  }, { edge: 'newest', limit: 1 }).items[0]?.index;
  return Math.max(boundary, last ?? boundary);
}

/** Presence rides on own activity or exact receipts, not nonaddressed cursor progress. */
export function presenceAnchor(facts: SquareRead, name: string): number {
  const boundary = facts.participant(name)?.lastJoinIndex ?? -1;
  if (boundary < 0) return -1;
  const own = facts.activityHeads({ afterIndex: boundary, actors: [name] }, { edge: 'newest', limit: 1 }).items[0]?.index;
  const evidence = Math.max(boundary, own ?? boundary, facts.receiptFacts(name, boundary).latestActorActivityIndex ?? boundary);
  return facts.activityHeads({ afterIndex: boundary, throughIndex: evidence, kinds: ['say', 'done'] }, { edge: 'newest', limit: 1 }).items[0]?.index ?? -1;
}
export function freshWatchLease(facts: SquareRead, name: string, at = Date.now()): WatchLease | undefined {
  const lease = facts.lease(name);
  return lease === undefined || lease.expiresAt <= at || at - lease.heartbeatAt > WATCH_STALE_MS ? undefined : lease;
}
