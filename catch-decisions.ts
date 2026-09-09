import { audienceOf, formatActivityId, parseActivityId, type Perception } from './square-core.js';
import { derivePerceptionProjection, type PerceptionProjection } from './perception-projection.js';
import { matchesMentionTarget, recordObservation } from './runtime.js';
import { participantIdentity } from './participant-identity.js';
import { SquareError, sameName, type SquareState, type StoredAct, validateName } from './model.js';
import { resolveRosterName } from './runtime.js';
import type { CatchOptions } from './square-facade.js';

export interface CatchDecision {
  readonly viewer: string;
  readonly delivered: readonly StoredAct[];
  readonly perceptions: ReadonlyMap<number, Perception>;
  readonly consumedThrough: string | null;
  readonly changed: boolean;
  readonly remaining: number;
}

export const CATCH_DEFAULT_LIMIT = 10;
export const CATCH_MAX_LIMIT = 100;

function catchLimit(value: number | undefined): number {
  const limit = value ?? CATCH_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATCH_MAX_LIMIT) {
    throw new SquareError('invalid_args', `Catch limit must be a positive integer no greater than ${CATCH_MAX_LIMIT}.`);
  }
  return limit;
}

export type CatchProjection = Pick<PerceptionProjection, 'cursorFor' | 'directedTo' | 'perceive' | 'isSeen'>;

function resolveCatchName(state: SquareState, requestedName: string): string {
  validateName(requestedName);
  const known = resolveRosterName(state, requestedName);
  if (known === undefined) {
    throw new SquareError('invalid_args', `Unknown participant "${participantIdentity(requestedName)}".`);
  }
  return known;
}

/** Pure catch selection and acknowledgement over one SquareState snapshot. */
export function decideCatch(
  state: SquareState,
  requestedName: string,
  options: CatchOptions,
  at: number,
  project: (state: SquareState) => CatchProjection = derivePerceptionProjection,
): CatchDecision {
  const viewer = resolveCatchName(state, requestedName);
  const limit = catchLimit(options.limit);
  const delivery = project(state);
  if (options.id !== undefined) {
    if (['idle', 'from', 'mention', 'limit'].some((key) => Object.hasOwn(options, key))) {
      throw new SquareError('invalid_args', 'Catch id cannot be combined with idle, from, mention or limit.');
    }
    const index = parseActivityId(options.id);
    if (index === undefined) throw new SquareError('invalid_args', 'Invalid catch id: expected an activity id like act/12.');
    const activity = state.acts.find((item) => item.index === index);
    if (activity === undefined || activity.kind !== 'say' || !delivery.directedTo(activity, viewer)) {
      throw new SquareError('invalid_args', 'That activity is not available to catch.');
    }
    const perception = delivery.perceive(activity, viewer);
    const changed = recordObservation(state, viewer, index, 'seen', at);
    const cursor = delivery.cursorFor(viewer);
    return {
      viewer,
      delivered: [activity],
      perceptions: new Map([[index, perception]]),
      consumedThrough: cursor < 0 ? null : formatActivityId(cursor),
      changed,
      remaining: state.acts.filter((item) => item.kind === 'say' && delivery.directedTo(item, viewer) && !delivery.isSeen(viewer, item.index)).length,
    };
  }
  const from = options.from;
  const mentionOnly = options.mention === true;
  const delivered: StoredAct[] = [];
  const perceptions = new Map<number, Perception>();

  const matching: StoredAct[] = [];
  for (const activity of state.acts) {
    if (activity.kind !== 'say' || !delivery.directedTo(activity, viewer)) continue;
    if (from !== undefined && !from.some((participant) => sameName(participant, activity.actor))) continue;
    if (mentionOnly && audienceOf(activity).kind !== 'bell' && !matchesMentionTarget(activity, viewer)) continue;
    if (delivery.isSeen(viewer, activity.index)) continue;
    matching.push(activity);
  }

  delivered.push(...matching.slice(0, limit));
  for (const activity of delivered) perceptions.set(activity.index, delivery.perceive(activity, viewer));

  let changed = false;
  for (const activity of delivered) {
    changed = recordObservation(state, viewer, activity.index, 'seen', at) || changed;
  }
  const consumed = delivery.cursorFor(viewer);
  return {
    viewer,
    delivered,
    perceptions,
    consumedThrough: consumed < 0 ? null : formatActivityId(consumed),
    changed,
    remaining: Math.max(0, matching.length - delivered.length),
  };
}
