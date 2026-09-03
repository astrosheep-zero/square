import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  retryMs: number;
  staleMs: number;
  signal?: AbortSignal;
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);
}

async function ownerState(lockPath: string): Promise<'alive' | 'dead' | 'unknown'> {
  let pid: number;
  try {
    pid = Number.parseInt((await fs.readFile(lockPath, 'utf8')).split('\n')[0], 10);
  } catch {
    return 'unknown';
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive';
  }
}

async function createLegacyLock(lockPath: string): Promise<string | undefined> {
  let fd: Awaited<ReturnType<typeof fs.open>>;
  try {
    fd = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  const token = `${process.pid}\n${Date.now()}\n${randomUUID()}\n`;
  try {
    await fd.writeFile(token, 'utf8');
    return token;
  } catch (error) {
    await fs.unlink(lockPath).catch(() => undefined);
    throw error;
  } finally {
    await fd.close();
  }
}

async function reclaimLegacyLock(lockPath: string, staleMs: number): Promise<boolean> {
  const quarantinePath = `${lockPath}.reclaim-${randomUUID()}`;
  try {
    const stale = Date.now() - (await fs.stat(lockPath)).mtimeMs > staleMs;
    const owner = await ownerState(lockPath);
    if (owner === 'alive' || (owner !== 'dead' && !stale)) return false;
    await fs.rename(lockPath, quarantinePath);
    await fs.unlink(quarantinePath).catch(() => undefined);
    return true;
  } catch (error) {
    await fs.unlink(quarantinePath).catch(() => undefined);
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function releaseLegacyLock(lockPath: string, token: string): Promise<void> {
  try {
    if (await fs.readFile(lockPath, 'utf8') === token) await fs.unlink(lockPath);
  } catch {}
}

async function withLegacyFileLock<T>(lockPath: string, options: FileLockOptions, fn: () => T | Promise<T>): Promise<T> {
  let token: string | undefined;
  while (token === undefined) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted');
    token = await createLegacyLock(lockPath);
    if (token !== undefined) break;
    if (await reclaimLegacyLock(lockPath, options.staleMs)) continue;
    await sleep(options.retryMs, undefined, { signal: options.signal });
  }
  try {
    return await fn();
  } finally {
    await releaseLegacyLock(lockPath, token);
  }
}

async function withSqliteLock<T>(lockPath: string, options: FileLockOptions, fn: () => T | Promise<T>): Promise<T> {
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
      if (error instanceof Error && /not a database|file is not a database/i.test(error.message)) {
        return withLegacyFileLock(lockPath, options, fn);
      }
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

export async function withFileLock<T>(lockPath: string, options: FileLockOptions, fn: () => T | Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  return withSqliteLock(lockPath, options, fn);
}
