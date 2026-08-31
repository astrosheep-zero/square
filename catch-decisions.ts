import { audienceOf, formatActivityId, replayLandedAudiences, type Perception } from './square-core.js';
import { matchesMentionTarget, observationFor, readCursor, recordObservation } from './runtime.js';
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

export interface CatchProjection {
  cursorFor(name: string): number;
  directedTo(activity: StoredAct, name: string): boolean;
  perceive(activity: StoredAct, name: string): Perception;
  isSeen(name: string, index: number): boolean;
}

function defaultProjection(state: SquareState): CatchProjection {
  const landed = replayLandedAudiences(state.acts);
  return {
    cursorFor: (name) => readCursor(state, name, landed),
    directedTo: (activity, name) => activity.kind === 'say' && landed.includes(activity, name),
    perceive: (activity, name) => activity.kind !== 'say' || sameName(activity.actor, name) || landed.includes(activity, name) ? 'full' : 'presence',
    isSeen: (name, index) => observationFor(state, name, index)?.state === 'seen',
  };
}

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
  project: (state: SquareState) => CatchProjection = defaultProjection,
): CatchDecision {
  const viewer = resolveCatchName(state, requestedName);
  const limit = catchLimit(options.limit);
  const delivery = project(state);
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
