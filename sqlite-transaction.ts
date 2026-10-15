import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('SQLite operation aborted');
}
function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);
}
/** Yield rather than blocking the process while another connection owns SQLite. */
export async function retrySqliteBusy<T>(operation: () => T, signal?: AbortSignal, retryMs: number | (() => number) = 25): Promise<T> {
  for (;;) {
    abort(signal);
    try { return operation(); }
    catch (error) {
      if (!isBusy(error)) throw error;
      try { await sleep(typeof retryMs === 'function' ? retryMs() : retryMs, undefined, { signal }); }
      catch (error) { abort(signal); throw error; }
    }
  }
}
/** Acquisition may retry; COMMIT retries retain the callback's result and transaction. */
export async function inSqliteTransaction<T, V>(db: DatabaseSync, write: boolean, validate: () => V, change: (validated: V) => T, signal?: AbortSignal): Promise<T> {
  let begun = false, backoffMs = 25;
  // Spread writer contenders out without delaying a writer that already owns the lock.
  const writerDelay = () => {
    const delay = 1 + Math.floor(Math.random() * backoffMs);
    backoffMs = Math.min(100, backoffMs * 2);
    return delay;
  };
  try {
    const validated = await retrySqliteBusy(() => {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      begun = true;
      try { return validate(); }
      catch (error) { db.exec('ROLLBACK'); begun = false; throw error; }
    }, signal, write ? writerDelay : 25);
    abort(signal);
    const result = change(validated);
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('SQLite transaction callbacks must be synchronous.');
    }
    // A busy commit still owns the writer lock. Retry promptly once readers leave;
    // acquisition contenders keep the longer backoff above.
    await retrySqliteBusy(() => db.exec('COMMIT'), signal, 1);
    begun = false;
    return result;
  } catch (error) {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* retain original failure */ } }
    throw error;
  }
}
