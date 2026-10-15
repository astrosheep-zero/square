import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('SQLite operation aborted');
}
function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);
}
/** Yield rather than blocking the process while another connection owns SQLite. */
export async function retrySqliteBusy<T>(operation: () => T, signal?: AbortSignal): Promise<T> {
  for (;;) {
    abort(signal);
    try { return operation(); }
    catch (error) {
      if (!isBusy(error)) throw error;
      try { await sleep(25, undefined, { signal }); }
      catch (error) { abort(signal); throw error; }
    }
  }
}
/** Acquisition may retry; COMMIT retries retain the callback's result and transaction. */
export async function inSqliteTransaction<T>(db: DatabaseSync, write: boolean, validate: () => void, change: () => T, signal?: AbortSignal): Promise<T> {
  let begun = false;
  try {
    await retrySqliteBusy(() => {
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      begun = true;
      try { validate(); }
      catch (error) { db.exec('ROLLBACK'); begun = false; throw error; }
    }, signal);
    abort(signal);
    const result = change();
    if (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('SQLite transaction callbacks must be synchronous.');
    }
    await retrySqliteBusy(() => db.exec('COMMIT'), signal);
    begun = false;
    return result;
  } catch (error) {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* retain original failure */ } }
    throw error;
  }
}
