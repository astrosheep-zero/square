import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface FileLockOptions {
  retryMs: number;
  staleMs: number;
}

const lockWait = new Int32Array(new SharedArrayBuffer(4));
const heldSyncLocks = new Set<string>();

function ownerState(lockPath: string): 'alive' | 'dead' | 'unknown' {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').split('\n')[0], 10);
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

function createLock(lockPath: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }

  const token = `${process.pid}\n${Date.now()}\n${randomUUID()}\n`;
  try {
    fs.writeFileSync(fd, token, 'utf8');
    return token;
  } catch (error) {
    try { fs.unlinkSync(lockPath); } catch {}
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}

function reclaimLock(lockPath: string, staleMs: number): boolean {
  try {
    const stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
    if (ownerState(lockPath) !== 'dead' && !stale) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (fs.readFileSync(lockPath, 'utf8') === token) fs.unlinkSync(lockPath);
  } catch {}
}

function prepare(lockPath: string): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
}

export function withFileLockSync<T>(
  lockPath: string,
  options: FileLockOptions,
  fn: () => T,
): T {
  if (heldSyncLocks.has(lockPath)) throw new Error(`Reentrant file lock: ${lockPath}`);
  prepare(lockPath);

  let token: string | undefined;
  while (token === undefined) {
    token = createLock(lockPath);
    if (token !== undefined) break;
    if (reclaimLock(lockPath, options.staleMs)) continue;
    Atomics.wait(lockWait, 0, 0, options.retryMs);
  }

  heldSyncLocks.add(lockPath);
  try {
    return fn();
  } finally {
    heldSyncLocks.delete(lockPath);
    releaseLock(lockPath, token);
  }
}

export async function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions,
  fn: () => T | Promise<T>,
): Promise<T> {
  prepare(lockPath);

  let token: string | undefined;
  while (token === undefined) {
    token = createLock(lockPath);
    if (token !== undefined) break;
    if (reclaimLock(lockPath, options.staleMs)) continue;
    await sleep(options.retryMs);
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
