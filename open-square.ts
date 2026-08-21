import type { StateCell } from './state-cell.js';
import type { WakeNotifier } from './square-facade.js';

/** Private binding assembled by storage and consumed by the four concerns. */
export interface OpenSquare {
  readonly cell: StateCell;
  readonly clock: () => number;
  readonly notifier?: WakeNotifier;
  readonly location: string;
}

/** Package-private lifecycle boundary for bound squares. */
export function closeOpenSquare(square: OpenSquare): Promise<void> {
  return square.cell.close();
}
