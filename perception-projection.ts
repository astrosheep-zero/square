import type { Perception } from './square-core.js';
import { type StoredAct, sameName } from './model.js';
import type { SquareRead } from './ports.js';

export function directedTo(facts: SquareRead, activity: StoredAct, name: string): boolean {
  return activity.kind === 'say' && facts.directedAt(name, activity.index) !== undefined;
}

/** Audience is settled at landing, never reconstructed from a partial history. */
export function perceiveActivity(facts: SquareRead, activity: StoredAct, name: string): Perception {
  return activity.kind !== 'say' || sameName(activity.actor, name) || directedTo(facts, activity, name) ? 'full' : 'presence';
}
