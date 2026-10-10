import { isDeepStrictEqual } from 'node:util';

import {
  createSquareFile,
  createSquareState,
  diagnoseSquareFile as diagnoseArtifactFile,
  probeSquare,
  observeSquareRevision,
  readSquareSnapshot,
  transactSquareSnapshot,
  writeSquareFile,
  type SquareTransition,
} from './artifact.js';
import type { SquareState } from './model.js';
import type { SquareArtifactPort } from './ports.js';
import { canonicalPath } from './canonical-path.js';

export { createSquareState };

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
  if (closed) throw new Error('Square artifact is closed');
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

function discardThenable(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).catch(() => undefined);
}

interface MemoryWaiter {
  onAbort?: () => void;
  signal?: AbortSignal;
  since: number;
  resolve: (changed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-process artifact for fast behavior tests and embedded consumers. */
export function createMemoryCell(initial: SquareState): SquareArtifactPort {
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
      waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
      waiter.resolve(true);
    }
  }

  return {
    transact<R>(fn: SquareTransition<R>, signal?: AbortSignal) {
      assertCellOpen(closed);
      if (signal?.aborted) throw signal.reason ?? new Error('Square artifact operation aborted');
      const operation = tail.then(() => {
        assertCellOpen(closed);
        if (signal?.aborted) throw signal.reason ?? new Error('Square artifact operation aborted');
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
    async read(signal?: AbortSignal) {
      assertCellOpen(closed);
      if (signal?.aborted) throw signal.reason ?? new Error('Square artifact operation aborted');
      await tail;
      assertCellOpen(closed);
      if (signal?.aborted) throw signal.reason ?? new Error('Square artifact operation aborted');
      return { state: cloneState(state), version };
    },
    changed(sinceVersion, timeoutMs, signal) {
      assertCellOpen(closed);
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Square artifact operation aborted"));
      if (version > sinceVersion) return Promise.resolve(true);
      if (timeoutMs <= 0) return Promise.resolve(false);
      return new Promise<boolean>((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason ?? new Error("Square artifact operation aborted")); return; }
        const abort = () => { waiters.delete(waiter); clearTimeout(waiter.timer); signal?.removeEventListener("abort", abort); reject(signal?.reason ?? new Error("Square artifact operation aborted")); };
        const waiter: MemoryWaiter = {
          since: sinceVersion,
          resolve,
          timer: setTimeout(() => { waiters.delete(waiter); signal?.removeEventListener("abort", abort); resolve(false); }, timeoutMs),
          onAbort: abort,
          signal,
        };
        waiters.add(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await tail;
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
        waiter.resolve(false);
      }
    },
  };
}

/** SQLite-backed artifact. Revisions are read from the authoritative database, not file metadata. */
export function createFileCell(squarePath: string, externalSignal?: AbortSignal): SquareArtifactPort {
  let closed = false;
  let storage: Promise<string> | undefined;
  let tail: Promise<void> = Promise.resolve();
  const cancel = new AbortController();

  function storagePath(): Promise<string> {
    storage ??= canonicalPath(squarePath);
    return storage;
  }

  /** Close wins over every operation; a per-call deadline bounds busy retries alongside it. */
  function operationSignal(signal?: AbortSignal): AbortSignal | undefined {
    if (signal === undefined && externalSignal === undefined) return cancel.signal;
    return AbortSignal.any([cancel.signal, ...(externalSignal === undefined ? [] : [externalSignal]), ...(signal === undefined ? [] : [signal])]);
  }

  return {
    transact<R>(fn: SquareTransition<R>, signal?: AbortSignal) {
      assertCellOpen(closed);
      const opSignal = operationSignal(signal);
      const operation = tail.then(async () => {
        assertCellOpen(closed);
        const result = await transactSquareSnapshot(await storagePath(), fn, opSignal);
        return result.result;
      });
      tail = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async read(signal?: AbortSignal) {
      assertCellOpen(closed);
      await tail;
      assertCellOpen(closed);
      const snapshot = await readSquareSnapshot(await storagePath(), operationSignal(signal));
      return { state: cloneState(snapshot.state), version: snapshot.revision };
    },
    async changed(sinceVersion, timeoutMs, signal) {
      assertCellOpen(closed);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const observer = await observeSquareRevision(await storagePath());
      try {
        return await observer.changed(sinceVersion, Math.max(0, deadline - Date.now()), operationSignal(signal));
      } catch (error) {
        if (closed || cancel.signal.aborted) return false;
        throw error;
      } finally { observer.close(); }
    },
    async close() {
      if (closed) return;
      closed = true;
      cancel.abort(new Error('Square artifact is closed'));
      await tail;
    },
  };
}
