import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  retryMs: number;
  staleMs: number;
  signal?: AbortSignal;
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

async function createLock(lockPath: string): Promise<string | undefined> {
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

async function reclaimLock(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stale = Date.now() - (await fs.stat(lockPath)).mtimeMs > staleMs;
    if (await ownerState(lockPath) !== 'dead' && !stale) return false;
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if (await fs.readFile(lockPath, 'utf8') === token) await fs.unlink(lockPath);
  } catch {}
}

export async function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  let token: string | undefined;
  while (token === undefined) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted');
    token = await createLock(lockPath);
    if (token !== undefined) break;
    if (await reclaimLock(lockPath, options.staleMs)) continue;
    await sleep(options.retryMs, undefined, { signal: options.signal });
  }

  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
