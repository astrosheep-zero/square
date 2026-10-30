import { formatActivityId, parseActivityId } from './square-core.js';
import { terminalStatusFor } from './runtime.js';
import { SquareError, type StoredAct } from './model.js';
import { resolveKnownName } from './decisions.js';
import type { ActivityIndex, DirectedFilter, SquareRead, SquareWrite } from './ports.js';
import type { CatchOptions, CatchReason, PerceivedActivity } from './square-facade.js';
import { toPerceivedActivity } from './views.js';
import { catchHint } from './hints.js';
import { consumeReceived, ReceiveError, selectReceivedHeads, type Selection } from './receive.js';
import { squareReceiveRead } from './square-receive.js';

export interface CatchSelection {
  readonly participant: string;
  readonly activities: readonly PerceivedActivity[];
  readonly remaining: number;
  readonly standingCount: number;
  readonly deliveryAvailable: boolean;
  readonly now: number;
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
  readonly terminalStatus: Extract<CatchReason, 'capped' | 'quorum'> | undefined;
  readonly hint?: string;
}

/** Capture a selected page (or an empty completion) without opening another resource. */
export function observeCatchSelection(facts: SquareRead, participant: string, activities: readonly StoredAct[], filter: DirectedFilter, at: number, remaining?: number): CatchSelection {
  if (typeof at !== 'number' || !Number.isFinite(at)) throw new SquareError('invalid_args', 'Catch time must be a finite number.');
  const counts = facts.participantCounts(), header = facts.header(), current = facts.participant(participant)!;
  return {
    participant, activities: activities.map(activity => toPerceivedActivity(facts, activity, participant)),
    remaining: remaining ?? facts.directedCount(participant, filter),
    standingCount: counts.joined, now: at,
    deliveryAvailable: facts.seat(participant)?.wakeAddress !== undefined,
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

function catchPageSelection(facts: SquareRead, requestedName: string, options: CatchOptions) {
  const participant = resolveKnownName(facts, requestedName);
  const limit = catchLimit(options.limit);
  const senders = options.from?.map(name => resolveKnownName(facts, name));
  const filter: DirectedFilter = { unseenOnly: true, ...(senders === undefined ? {} : { senders }), ...(options.mention === true ? { attentionOnly: true } : {}) };
  return { participant, filter, selection: { kind: 'page' as const, query: filter, limit } };
}

/** Select non-ID catch coordinates without hydrating bodies or recording receipts. */
export function selectCatchPage(facts: SquareRead, requestedName: string, options: CatchOptions): {
  readonly participant: string;
  readonly indexes: readonly ActivityIndex[];
  readonly filter: DirectedFilter;
} {
  const { participant, filter, selection } = catchPageSelection(facts, requestedName, options);
  return { participant, indexes: selectReceivedHeads(squareReceiveRead(facts), participant, selection).map(item => item.key), filter };
}

/** Selection, receipts and resulting cursor belong to one artifact write transaction. */
export function decideCatch(facts: SquareWrite, requestedName: string, options: CatchOptions, at: number): CatchSelection {
  let viewer: string;
  let filter: DirectedFilter = { unseenOnly: true };
  let selection: Selection<number, DirectedFilter>;
  if (options.id !== undefined) {
    viewer = resolveKnownName(facts, requestedName);
    catchLimit(options.limit);
    if (['idle', 'from', 'mention', 'limit'].some((key) => Object.hasOwn(options, key))) throw new SquareError('invalid_args', 'Catch id cannot be combined with idle, from, mention or limit.');
    const index = parseActivityId(options.id);
    if (index === undefined) throw new SquareError('invalid_args', 'Invalid catch id: expected an activity id like act/12.');
    selection = { kind: 'exact', key: index, remainingQuery: filter };
  } else {
    const page = catchPageSelection(facts, requestedName, options);
    viewer = page.participant;
    filter = page.filter;
    selection = page.selection;
  }
  let consumed;
  try {
    consumed = consumeReceived({
      ...squareReceiveRead(facts),
      insertReceipt: (ref, time) => facts.markSeen(ref.recipient, [ref.item], time) > 0,
    }, viewer, selection, at);
  } catch (error) {
    if ((error instanceof TypeError || error instanceof RangeError) && (typeof at !== 'number' || !Number.isFinite(at))) {
      throw new SquareError('invalid_args', 'Invalid square artifact: row is malformed.');
    }
    if (!(error instanceof ReceiveError)) throw error;
    if (error.code === 'missing_item') throw new SquareError('invalid_args', 'Invalid square artifact: addressed activity is missing.');
    const index = error.key as number;
    throw new SquareError('invalid_args', `✕ ${formatActivityId(index)} isn't addressed to you`, {
      reason: 'not_addressed', activityId: formatActivityId(index), activityExists: facts.activity(index) !== undefined,
    });
  }
  const delivered = consumed.items.map(item => item.data);
  const observed = observeCatchSelection(facts, viewer, delivered, filter, at, consumed.remaining);
  // Receipts are the durable catch count: everything directed here minus what is still unseen.
  const caught = facts.directedCount(viewer, {}) - facts.directedCount(viewer, { unseenOnly: true });
  // An exact id catch is a targeted fetch and stays repeatable, so it carries no nudge.
  const hint = options.id === undefined ? catchHint(caught - consumed.newlyConsumed, caught) : undefined;
  return hint === undefined ? observed : { ...observed, hint };
}
