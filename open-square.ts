import type { SquareArtifactPort } from './ports.js';

/** Private binding assembled by storage and consumed by the four concerns. */
export interface OpenSquare {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location: string;
}

/** Package-private lifecycle boundary for bound squares. */
export function closeOpenSquare(square: OpenSquare): Promise<void> {
  return square.artifact.close();
}
