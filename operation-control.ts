import type { OperationControl, OperationFailureDetail } from './neutral.js';

export function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Square operation was cancelled');
}
export function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}
