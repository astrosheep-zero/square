import { type StoredAct, type SquareState } from './model.js';
import { deriveDeliveryModel } from './delivery.js';

export function actDelta(acts: StoredAct[], cursor: number): StoredAct[] {
  return acts.filter((act) => act.index > cursor);
}

/** Visible activities after the participant's derived continuous-seen prefix. */
export function deliveryDelta(squareState: SquareState, name: string, delivery = deriveDeliveryModel(squareState)): StoredAct[] {
  return actDelta(squareState.acts, delivery.cursorFor(name));
}

export function directedPeerSays(squareState: SquareState, delta: StoredAct[], name: string, delivery = deriveDeliveryModel(squareState)): Extract<StoredAct, { kind: 'say' }>[] {
  return delta.filter((act): act is Extract<StoredAct, { kind: 'say' }> => delivery.directedTo(act, name));
}
