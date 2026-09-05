import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  retryMs: number;
  signal?: AbortSignal;
  createParent?: boolean;
}

export class FileLockError extends Error {
  readonly code = 'not_a_database' as const;

  constructor(lockPath: string, cause?: unknown) {
    super(`File lock is not a database: ${lockPath}`);
    this.name = 'FileLockError';
    if (cause !== undefined) this.cause = cause;
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

function isNotADatabase(error: unknown): boolean {
  return error instanceof Error && /not a database|file is not a database/i.test(error.message);
}

export async function withFileLock<T>(lockPath: string, options: FileLockOptions, fn: () => T | Promise<T>): Promise<T> {
  if (options.createParent !== false) await fs.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted');
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(lockPath);
      database.exec(`PRAGMA busy_timeout = 0;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS __square_file_lock (id INTEGER PRIMARY KEY CHECK (id = 1));`);
    } catch (error) {
      try { database?.close(); } catch {}
      if (isBusy(error)) {
        await sleep(options.retryMs, undefined, { signal: options.signal });
        continue;
      }
      if (isNotADatabase(error)) throw new FileLockError(lockPath, error);
      throw error;
    }
    try {
      const result = await fn();
      database!.exec('COMMIT;');
      return result;
    } catch (error) {
      try { database!.exec('ROLLBACK;'); } catch {}
      throw error;
    } finally {
      database!.close();
    }
  }
}
