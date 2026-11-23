import { parseActivityId, PERCEIVE_DEFAULT_LIMIT } from './square-core.js';
import { terminalStatusFor } from './runtime.js';
import { SquareError, type HydratedAct } from './model.js';
import { resolveKnownName } from './decisions.js';
import type { DirectedFilter, SquareRead, SquareWrite } from './ports.js';
import { toPerceivedActivity, type PerceivedActivity } from './observations.js';
import { perceiveHint } from './hints.js';
import type { PerceiveOptions } from './operation-inputs.js';

export type PerceiveReason = 'drained' | 'idle' | 'capped' | 'quorum' | 'replaced' | 'already-active';

export interface PerceiveSelection {
  readonly participant: string;
  readonly activities: readonly PerceivedActivity[];
  readonly remaining: number;
  readonly standingCount: number;
  readonly now: number;
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
  readonly terminalStatus: Extract<PerceiveReason, 'capped' | 'quorum'> | undefined;
  readonly hint?: string;
}

export function perceiveFilter(options: PerceiveOptions): DirectedFilter {
  return { kinds: ['say'], unseenOnly: true, indexes: options.ids?.map(id => parseActivityId(id)!),
    senders: options.from, attentionOnly: options.mention || undefined };
}

export function observePerceiveSelection(facts: SquareRead, participant: string, activities: readonly HydratedAct[], filter: DirectedFilter, at: number): PerceiveSelection {
  if (!Number.isFinite(at)) throw new SquareError('invalid_args', 'Perceive time must be a finite number.');
  const counts = facts.participantCounts(), header = facts.header(), current = facts.participant(participant)!;
  return {
    participant, activities: activities.map(activity => toPerceivedActivity(facts, activity, participant)),
    remaining: facts.directedCount(participant, filter), standingCount: counts.joined, now: at,
    ownActivityCount: current.sayCount, hardCap: header.hardCap,
    terminalStatus: terminalStatusFor(current, header.hardCap, counts),
  };
}

/** Select unread coordinates without hydrating bodies or recording receipts. */
export function selectPerceivePage(facts: SquareRead, requestedName: string, options: PerceiveOptions) {
  const participant = resolveKnownName(facts, requestedName);
  const filter = perceiveFilter(options);
  const { items } = facts.directed(participant, filter, { edge: 'oldest', limit: options.limit ?? PERCEIVE_DEFAULT_LIMIT });
  return { participant, indexes: items.map(item => item.index), filter };
}

/** Selection, receipts and remaining count share the write transaction. */
export function decidePerceive(facts: SquareWrite, requestedName: string, options: PerceiveOptions, at: number): PerceiveSelection {
  const { participant, indexes, filter } = selectPerceivePage(facts, requestedName, options);
  const delivered = facts.activities(indexes);
  if (delivered.length !== indexes.length) throw new SquareError('invalid_args', 'Invalid square artifact: addressed activity is missing.');
  const newlyConsumed = facts.markSeen(participant, indexes, at);
  const observed = observePerceiveSelection(facts, participant, delivered, filter, at);
  if (newlyConsumed === 0) return observed;
  const perceived = facts.directedCount(participant, { kinds: ['say'] }) - facts.directedCount(participant, { kinds: ['say'], unseenOnly: true });
  const hint = perceiveHint(perceived - newlyConsumed, perceived);
  return hint === undefined ? observed : { ...observed, hint };
}
