import { audienceOf, formatActivityId, replayLandedAudiences, type Perception } from './square-core.js';
import { matchesMentionTarget, readCursor, recordObservation } from './runtime.js';
import { participantIdentity } from './participant-identity.js';
import { SquareError, sameName, type SquareState, type StoredAct, validateName } from './model.js';
import { resolveRosterName, rosterNames } from './runtime.js';
import type { CatchOptions } from './square-facade.js';

export interface CatchDecision {
  readonly viewer: string;
  readonly delivered: readonly StoredAct[];
  readonly perceptions: ReadonlyMap<number, Perception>;
  readonly consumedThrough: string | null;
  readonly changed: boolean;
}

export interface CatchProjection {
  cursorFor(name: string): number;
  directedTo(activity: StoredAct, name: string): boolean;
  perceive(activity: StoredAct, name: string): Perception;
}

function defaultProjection(state: SquareState): CatchProjection {
  const landed = replayLandedAudiences(state.acts);
  return {
    cursorFor: (name) => readCursor(state, name, landed),
    directedTo: (activity, name) => activity.kind === 'say' && landed.includes(activity, name),
    perceive: (activity, name) => activity.kind !== 'say' || sameName(activity.actor, name) || landed.includes(activity, name) ? 'full' : 'presence',
  };
}

function resolveCatchName(state: SquareState, requestedName: string): string {
  validateName(requestedName);
  const known = resolveRosterName(state, requestedName);
  if (known === undefined) {
    throw new SquareError('invalid_args', `Unknown participant "${participantIdentity(requestedName)}". Expected one of: ${rosterNames(state).map(participantIdentity).join(', ')}.`);
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
  const delivery = project(state);
  const cursor = delivery.cursorFor(viewer);
  const from = options.from;
  const mentionOnly = options.mention === true;
  const delivered: StoredAct[] = [];
  const perceptions = new Map<number, Perception>();

  for (const activity of state.acts) {
    if (activity.index <= cursor || activity.kind !== 'say' || !delivery.directedTo(activity, viewer)) continue;
    if (from !== undefined && !from.some((participant) => sameName(participant, activity.actor))) continue;
    if (mentionOnly && audienceOf(activity).kind !== 'bell' && !matchesMentionTarget(activity, viewer)) continue;
    delivered.push(activity);
    perceptions.set(activity.index, delivery.perceive(activity, viewer));
  }

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
  };
}
