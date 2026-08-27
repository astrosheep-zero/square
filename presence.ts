import { formatActivityId } from './square-core.js';
import { deriveDeliveryModel, type DeliveryModel } from './delivery.js';
import { SquareError, type StoredAct } from './model.js';
import type { OpenSquare } from './open-square.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { resolveKnownName } from './decisions.js';
import { recordObservation } from './runtime.js';
import type { CatchOptions, CatchResult } from './square-facade.js';
import { catchUp as applicationCatchUp } from './application.js';
import type { CatchProjection } from './catch-decisions.js';

function applicationContext(square: OpenSquare | { readonly cell: OpenSquare['artifact']; readonly clock: () => number }) {
  return 'artifact' in square
    ? { artifact: square.artifact, clock: square.clock }
    : { artifact: square.cell, clock: square.clock };
}

export async function catchUp(
  square: OpenSquare,
  name: string,
  options: CatchOptions = {},
  deriveDelivery: (state: import('./model.js').SquareState) => DeliveryModel = deriveDeliveryModel,
): Promise<CatchResult> {
  const project = deriveDelivery === deriveDeliveryModel
    ? undefined
    : (state: import('./model.js').SquareState): CatchProjection => deriveDelivery(state);
  return applicationCatchUp(applicationContext(square), name, options, project);
}

/** Commit seen only for complete, actually rendered boundary bodies. */
export async function markBoundarySeen(
  squarePath: string,
  name: string,
  ownerId: string | undefined,
  actIndexes: readonly number[],
  at = Date.now(),
): Promise<void> {
  let square: OpenSquare;
  try { square = await openSquare(squarePath); } catch { return; }
  try {
    await square.artifact.transact((state) => {
      let changed = false;
      for (const index of actIndexes) changed = recordObservation(state, name, index, 'seen', at, ownerId) || changed;
      return changed ? { state, result: undefined } : { result: undefined };
    });
  } finally {
    await closeOpenSquare(square);
  }
}
