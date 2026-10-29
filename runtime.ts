import { SquareError, type WatchLease } from './model.js';
import type { ParticipantCounts, ParticipantFact, SquareRead } from './ports.js';

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new SquareError('invalid_args', `Invalid ${name}: expected a positive integer.`);
  return value;
}
export const WATCH_HEARTBEAT_MS = parseIntegerEnv('SQUARE_WATCH_HEARTBEAT_MS', 60000);
export const WATCH_STALE_MS = parseIntegerEnv('SQUARE_WATCH_STALE_MS', 180000);
export const THROTTLE_WINDOW_MS = parseIntegerEnv('SQUARE_THROTTLE_WINDOW_MS', 60000);
export const UNREAD_BLOCK_GRACE_MS = parseIntegerEnv('SQUARE_UNREAD_BLOCK_GRACE_MS', 90000);
export const FACT_PAGE_SIZE = 100;

export function inSquareCount(facts: SquareRead): number { return facts.participantCounts().joined; }

export function terminalStatusFor(current: ParticipantFact | undefined, hardCap: number | null, counts: ParticipantCounts): 'capped' | 'quorum' | undefined {
  if (hardCap !== null && (current?.sayCount ?? 0) >= hardCap) return 'capped';
  const peers = counts.known - Number(current !== undefined);
  const donePeers = counts.done - Number(current?.done === true);
  return peers > 0 && donePeers === peers ? 'quorum' : undefined;
}
export function watchTerminalStatus(facts: SquareRead, name: string): 'capped' | 'quorum' | undefined {
  const cap = facts.header().hardCap, current = facts.participant(name);
  if (cap !== null && (current?.sayCount ?? 0) >= cap) return 'capped';
  return terminalStatusFor(current, cap, facts.participantCounts());
}

/** A continuous prefix stops at the first unseen historical audience edge after join. */
export function readCursor(facts: SquareRead, name: string): number {
  const boundary = facts.participant(name)?.lastJoinIndex ?? -1;
  const block = facts.directed(name, { afterIndex: boundary, unseenOnly: true }, { edge: 'oldest', limit: 1 }).items[0]?.index;
  const last = facts.activityHeads({
    afterIndex: boundary, ...(block === undefined ? {} : { beforeIndex: block }),
    kinds: ['join', 'done', 'say', 'listen', 'ignore', 'unlisten'],
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
