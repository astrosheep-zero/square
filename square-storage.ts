import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import {
  createSquareFile,
  createSquareState,
  diagnoseSquareFile as diagnoseArtifactFile,
  loadSquare,
  probeSquare,
  readSquareSnapshot,
  transactSquareSnapshot,
  writeSquareFile,
  type SquareTransition,
} from './artifact.js';
import type { SquareState } from './model.js';
import type { StateCell } from './state-cell.js';

export { createSquareState };

async function canonicalPath(squarePath: string): Promise<string> {
  const absolute = path.resolve(squarePath);
  try {
    return await fs.promises.realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = await fs.promises.realpath(path.dirname(absolute)).catch(() => path.dirname(absolute));
    return path.join(parent, path.basename(absolute));
  }
}

export async function readSquareFile(squarePath: string): Promise<SquareState> {
  return loadSquare(await canonicalPath(squarePath));
}

export async function probeSquareFile(squarePath: string): Promise<SquareState | undefined> {
  if (!squarePath.endsWith('.square')) return undefined;
  return probeSquare(await canonicalPath(squarePath));
}

export async function diagnoseSquareFile(squarePath: string): ReturnType<typeof diagnoseArtifactFile> {
  return diagnoseArtifactFile(await canonicalPath(squarePath));
}

/** Test-helper snapshot replacement backed by one SQLite artifact. */
export async function writeSquareSnapshot(squarePath: string, squareState: SquareState): Promise<void> {
  await writeSquareFile(await canonicalPath(squarePath), squareState);
}

/** Race-safe non-force creation for the file adapter. */
export async function createSquareSnapshot(squarePath: string, squareState: SquareState): Promise<boolean> {
  return createSquareFile(await canonicalPath(squarePath), squareState);
}

function cloneState(squareState: SquareState): SquareState {
  return structuredClone(squareState);
}

function assertCellOpen(closed: boolean): void {
  if (closed) throw new Error('StateCell is closed');
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

function discardThenable(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).catch(() => undefined);
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);
}

interface MemoryWaiter {
  since: number;
  resolve: (changed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-process cell for fast behavior tests and embedded consumers. */
export function createMemoryCell(initial: SquareState): StateCell {
  let state = cloneState(initial);
  let version = 0;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const waiters = new Set<MemoryWaiter>();

  function publish(): void {
    for (const waiter of [...waiters]) {
      if (version <= waiter.since) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(true);
    }
  }

  return {
    transact<R>(fn: SquareTransition<R>) {
      assertCellOpen(closed);
      const operation = tail.then(() => {
        assertCellOpen(closed);
        const current = cloneState(state);
        const outcome = fn(current, version);
        if (isThenable(outcome)) {
          discardThenable(outcome);
          throw new TypeError('Square artifact transitions must be synchronous.');
        }
        if (typeof outcome !== 'object' || outcome === null || !Object.hasOwn(outcome, 'result')) {
          throw new TypeError('Square artifact transition must return { state?, result }.');
        }
        if (outcome.state !== undefined && !isDeepStrictEqual(outcome.state, state)) {
          state = cloneState(outcome.state);
          version += 1;
          publish();
        }
        return outcome.result;
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async read() {
      assertCellOpen(closed);
      await tail;
      assertCellOpen(closed);
      return { state: cloneState(state), version };
    },
    changed(sinceVersion, timeoutMs) {
      assertCellOpen(closed);
      if (version > sinceVersion) return Promise.resolve(true);
      if (timeoutMs <= 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const waiter: MemoryWaiter = {
          since: sinceVersion,
          resolve,
          timer: setTimeout(() => { waiters.delete(waiter); resolve(false); }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(false);
      }
    },
  };
}

/** SQLite-backed cell. Revisions are read from the authoritative database, not file metadata. */
export function createFileCell(squarePath: string): StateCell {
  let closed = false;
  let storage: Promise<string> | undefined;
  let tail: Promise<void> = Promise.resolve();
  const cancel = new AbortController();

  function storagePath(): Promise<string> {
    storage ??= canonicalPath(squarePath);
    return storage;
  }

  function abortError(): Error {
    return new Error('StateCell is closed');
  }

  return {
    transact<R>(fn: SquareTransition<R>) {
      assertCellOpen(closed);
      const operation = tail.then(async () => {
        assertCellOpen(closed);
        const result = await transactSquareSnapshot(await storagePath(), fn, cancel.signal);
        return result.result;
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async read() {
      assertCellOpen(closed);
      await tail;
      assertCellOpen(closed);
      const snapshot = await readSquareSnapshot(await storagePath(), cancel.signal);
      return { state: cloneState(snapshot.state), version: snapshot.revision };
    },
    async changed(sinceVersion, timeoutMs) {
      assertCellOpen(closed);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (!closed) {
        const remaining = deadline - Date.now();
        const timeout = AbortSignal.timeout(Math.max(1, remaining));
        const readSignal = AbortSignal.any([cancel.signal, timeout]);
        try {
          if ((await readSquareSnapshot(await storagePath(), readSignal)).revision > sinceVersion) return true;
        } catch (error) {
          if (closed || cancel.signal.aborted || timeout.aborted) return false;
          if (!isBusy(error)) throw error;
        }
        const nextRemaining = deadline - Date.now();
        if (nextRemaining <= 0) return false;
        try {
          await sleep(Math.min(25, nextRemaining), undefined, { signal: cancel.signal });
        } catch (error) {
          if (closed || cancel.signal.aborted) return false;
          throw error;
        }
      }
      return false;
    },
    async close() {
      if (closed) return;
      closed = true;
      cancel.abort(abortError());
      await tail;
    },
  };
}

/** Consumer-facing file cell factory; keeps SQLite framing behind this module. */
export function openSquareCell(squarePath: string): StateCell {
  return createFileCell(squarePath);
}
