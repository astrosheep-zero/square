import type { OpenSquare } from './open-square.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { recordObservation } from './runtime.js';

/** Commit seen only for complete, actually rendered boundary bodies. */
export async function markBoundarySeen(
  squarePath: string,
  name: string,
  actIndexes: readonly number[],
  at = Date.now(),
): Promise<void> {
  let square: OpenSquare;
  try { square = await openSquare(squarePath); } catch { return; }
  try {
    await square.artifact.transact((state) => {
      let changed = false;
      for (const index of actIndexes) changed = recordObservation(state, name, index, 'seen', at) || changed;
      return changed ? { state, result: undefined } : { result: undefined };
    });
  } finally {
    await closeOpenSquare(square);
  }
}
