import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { readCursor, terminalStatusFor } from './runtime.js';
import { SquareError, type StoredAct } from './model.js';
import { resolveKnownName } from './decisions.js';
import type { ActivityIndex, DirectedFilter, SquareRead, SquareWrite } from './ports.js';
import type { CatchOptions } from './square-facade.js';
import { catchHint } from './hints.js';

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
  readonly hint?: string;
}

/** Capture a selected page (or an empty completion) without opening another resource. */
export function observeCatchSelection(facts: SquareRead, participant: string, activities: readonly StoredAct[], filter: DirectedFilter, at: number): CatchSelection {
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new SquareError('invalid_args', 'Catch time must be a finite number.');
  const cursor = readCursor(facts, participant);
  const counts = facts.participantCounts(), header = facts.header(), current = facts.participant(participant)!;
  return {
    participant, activities, consumedThrough: cursor < 0 ? null : formatActivityId(cursor),
    remaining: facts.directedCount(participant, filter),
    sayNumbers: activities.length === 0 ? {} : facts.sayOrdinals(activities.map((item) => item.index)),
    standingCount: counts.joined, held: facts.hold().active, now: at,
    ownActivityCount: current.sayCount, hardCap: header.hardCap,
    terminalStatus: terminalStatusFor(current, header.hardCap, counts),
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

/** Select non-ID catch coordinates without hydrating bodies or recording receipts. */
export function selectCatchPage(facts: SquareRead, requestedName: string, options: CatchOptions): {
  readonly participant: string;
  readonly indexes: readonly ActivityIndex[];
  readonly filter: DirectedFilter;
} {
  const participant = resolveKnownName(facts, requestedName);
  const limit = catchLimit(options.limit);
  const senders = options.from?.map((name) => resolveKnownName(facts, name));
  const filter: DirectedFilter = { unseenOnly: true, ...(senders === undefined ? {} : { senders }), ...(options.mention === true ? { attentionOnly: true } : {}) };
  return { participant, indexes: facts.directed(participant, filter, { edge: 'oldest', limit }).items.map((item) => item.index), filter };
}

/** Selection, receipts and resulting cursor belong to one artifact write transaction. */
export function decideCatch(facts: SquareWrite, requestedName: string, options: CatchOptions, at: number): CatchSelection {
  let viewer: string;
  let delivered: readonly StoredAct[];
  let filter: DirectedFilter = { unseenOnly: true };
  if (options.id !== undefined) {
    viewer = resolveKnownName(facts, requestedName);
    catchLimit(options.limit);
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
    const page = selectCatchPage(facts, requestedName, options);
    viewer = page.participant;
    filter = page.filter;
    delivered = facts.activities(page.indexes);
  }
  const marked = facts.markSeen(viewer, delivered.map((item) => item.index), at);
  const selection = observeCatchSelection(facts, viewer, delivered, filter, at);
  // Receipts are the durable catch count: everything directed here minus what is still unseen.
  const caught = facts.directedCount(viewer, {}) - facts.directedCount(viewer, { unseenOnly: true });
  // An exact id catch is a targeted fetch and stays repeatable, so it carries no nudge.
  const hint = options.id === undefined ? catchHint(caught - marked, caught) : undefined;
  return hint === undefined ? selection : { ...selection, hint };
}
