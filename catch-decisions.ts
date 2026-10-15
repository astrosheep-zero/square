import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { inSquareCount, readCursor, watchTerminalStatus } from './runtime.js';
import { SquareError, type StoredAct } from './model.js';
import { resolveKnownName } from './decisions.js';
import type { DirectedFilter, SquareRead, SquareWrite } from './ports.js';
import type { CatchOptions } from './square-facade.js';

export interface CatchSelection {
  readonly participant: string;
  readonly activities: readonly StoredAct[];
  readonly consumedThrough: ActivityId | null;
  readonly remaining: number;
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly standingCount: number;
  readonly held: boolean;
  readonly now: number;
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
  readonly terminalStatus: 'capped' | 'quorum' | undefined;
}

/** Capture a selected page (or an empty completion) without opening another resource. */
export function observeCatchSelection(facts: SquareRead, participant: string, activities: readonly StoredAct[], filter: DirectedFilter, at: number): CatchSelection {
  const cursor = readCursor(facts, participant);
  return {
    participant, activities, consumedThrough: cursor < 0 ? null : formatActivityId(cursor),
    remaining: facts.directedCount(participant, filter),
    sayNumbers: activities.length === 0 ? {} : facts.sayOrdinals(activities.map((item) => item.index)),
    standingCount: inSquareCount(facts), held: facts.hold().active, now: at,
    ownActivityCount: facts.participant(participant)!.sayCount, hardCap: facts.header().hardCap,
    terminalStatus: watchTerminalStatus(facts, participant),
  };
}
export const CATCH_DEFAULT_LIMIT = 10;
export const CATCH_MAX_LIMIT = 100;
export function catchLimit(value: number | undefined): number {
  const limit = value ?? CATCH_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATCH_MAX_LIMIT) {
    throw new SquareError('invalid_args', `Catch limit must be a positive integer no greater than ${CATCH_MAX_LIMIT}.`);
  }
  return limit;
}

/** Selection, receipts and resulting cursor belong to one artifact write transaction. */
export function decideCatch(facts: SquareWrite, requestedName: string, options: CatchOptions, at: number): CatchSelection {
  const viewer = resolveKnownName(facts, requestedName);
  const limit = catchLimit(options.limit);
  let delivered: readonly StoredAct[];
  let filter: DirectedFilter = { unseenOnly: true };
  if (options.id !== undefined) {
    if (['idle', 'from', 'mention', 'limit'].some((key) => Object.hasOwn(options, key))) throw new SquareError('invalid_args', 'Catch id cannot be combined with idle, from, mention or limit.');
    const index = parseActivityId(options.id);
    if (index === undefined) throw new SquareError('invalid_args', 'Invalid catch id: expected an activity id like act/12.');
    const activity = facts.activity(index);
    if (activity === undefined || activity.kind !== 'say' || facts.directedAt(viewer, index) === undefined) {
      throw new SquareError('invalid_args', `✕ ${formatActivityId(index)} isn't addressed to you`, {
        reason: 'not_addressed', activityId: formatActivityId(index), activityExists: activity !== undefined,
      });
    }
    delivered = [activity];
  } else {
    filter = { unseenOnly: true, ...(options.from === undefined ? {} : { senders: options.from }), ...(options.mention === true ? { attentionOnly: true } : {}) };
    delivered = facts.activities(facts.directed(viewer, filter, { edge: 'oldest', limit }).items.map((item) => item.index));
  }
  facts.markSeen(viewer, delivered.map((item) => item.index), at);
  return observeCatchSelection(facts, viewer, delivered, filter, at);
}
