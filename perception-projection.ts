import { formatActivityId, replayLandedAudiences, type LandedAudienceReplay, type Perception } from './square-core.js';
import { type SquareState, type StoredAct, sameName } from './model.js';
import { readCursor } from './runtime.js';

/**
 * The small, state-only perception surface shared by catch and delivery.
 * Notification planning deliberately remains outside this projection.
 */
export interface PerceptionProjection {
  directedTo(activity: StoredAct, name: string): boolean;
  perceive(activity: StoredAct, name: string): Perception;
  cursorFor(name: string): number;
  isSeen(name: string, index: number): boolean;
  readonly replayedActivityCount: number;
}

/** Build perception over one audience replay of a SquareState snapshot. */
export function derivePerceptionProjection(
  state: SquareState,
  landed: LandedAudienceReplay = replayLandedAudiences(state.acts),
): PerceptionProjection {
  function canonicalName(name: string): string {
    return landed.resolveParticipant(name) ?? name;
  }

  function directedTo(activity: StoredAct, name: string): boolean {
    return activity.kind === 'say' && landed.includes(activity, name);
  }

  function perceive(activity: StoredAct, name: string): Perception {
    if (activity.kind !== 'say' || sameName(activity.actor, name)) return 'full';
    return directedTo(activity, name) ? 'full' : 'presence';
  }

  function isSeen(name: string, index: number): boolean {
    const recipient = canonicalName(name);
    return state.runtime.observations?.[recipient]?.[formatActivityId(index)]?.state === 'seen';
  }

  return {
    directedTo,
    perceive,
    cursorFor: (name) => readCursor(state, name, landed),
    isSeen,
    replayedActivityCount: landed.replayedActivityCount,
  };
}
