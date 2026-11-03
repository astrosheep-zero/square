import { SquareError } from './neutral.js';
import type { OperationControl, OperationFailureDetail } from './neutral.js';

export function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Square operation was cancelled');
}
export function squareClock(env: NodeJS.ProcessEnv, clock?: () => number): () => number {
  if (clock !== undefined) return clock;
  if (env.SQUARE_NOW_MS === undefined) return Date.now;
  const value = Number.parseInt(env.SQUARE_NOW_MS, 10);
  if (!Number.isFinite(value)) throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
  return () => value;
}
export function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}
