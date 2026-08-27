import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';

import {
  createSquareState,
  diagnoseSquareFile as diagnoseArtifactFile,
  loadSquare,
  probeSquare,
  writeSquareFile,
} from './artifact.js';
import { withFileLock } from './file-lock.js';
import type { StateCell } from './state-cell.js';
import { type SquareState } from './model.js';
import { LOCK_RETRY_MS, LOCK_STALE_MS } from './runtime.js';

/**
 * The only production module allowed to cross the .square byte boundary.
 * Consumers receive a SquareState and never need to know which codec or lock
 * protects it.
 */
export {
  createSquareState,
};

export async function readSquareFile(squarePath: string): Promise<SquareState> {
  return withSquareFileLock(squarePath, () => loadSquare(squarePath));
}

export async function probeSquareFile(squarePath: string): Promise<SquareState | undefined> {
  if (!squarePath.endsWith('.square')) return undefined;
  return withSquareFileLock(squarePath, () => probeSquare(squarePath));
}

export async function diagnoseSquareFile(squarePath: string): ReturnType<typeof diagnoseArtifactFile> {
  return withSquareFileLock(squarePath, () => diagnoseArtifactFile(squarePath));
}

export async function writeSquareSnapshot(squarePath: string, squareState: SquareState): Promise<void> {
  await writeSquareFile(squarePath, squareState);
}

export function withSquareFileLock<T>(squarePath: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(
    `${squarePath}.lock`,
    { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS },
    fn,
  );
}

function cloneState(squareState: SquareState): SquareState {
  return structuredClone(squareState);
}

function assertCellOpen(closed: boolean): void {
  if (closed) throw new Error('StateCell is closed');
}

interface MemoryWaiter {
  since: number;
  resolve: (changed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** In-process cell for fast application tests and embedded consumers. */
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

  const cell: StateCell = {
    transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }) {
      assertCellOpen(closed);
      let operation!: Promise<R>;
      operation = tail.then(() => {
        assertCellOpen(closed);
        const working = cloneState(state);
        const outcome = fn(working, version);
        if (outcome.state !== undefined) {
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
          timer: setTimeout(() => {
            waiters.delete(waiter);
            resolve(false);
          }, timeoutMs),
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
  return cell;
}

async function fileFingerprint(squarePath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(squarePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return 'missing';
  }
}

/** File-backed cell retaining the existing .square codec and lock boundary. */
export function createFileCell(squarePath: string): StateCell {
  let closed = false;
  let version = 0;
  let fingerprint: string | undefined;
  let cached: { fingerprint: string; state: SquareState } | undefined;

  async function observe(): Promise<string> {
    const next = await fileFingerprint(squarePath);
    if (fingerprint === undefined) {
      fingerprint = next;
    } else if (next !== fingerprint) {
      fingerprint = next;
      cached = undefined;
      version += 1;
    }
    return fingerprint;
  }

  async function currentStateUnderLock(): Promise<SquareState> {
    const observed = await observe();
    if (cached?.fingerprint === observed) return cloneState(cached.state);

    const decoded = await loadSquare(squarePath);
    cached = { fingerprint: observed, state: cloneState(decoded) };
    return cloneState(cached.state);
  }

  return {
    async transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }) {
      assertCellOpen(closed);
      return withFileLock(`${squarePath}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, async () => {
        assertCellOpen(closed);
        const current = await currentStateUnderLock();
        const working = cloneState(current);
        const outcome = fn(working, version);
        if (outcome.state !== undefined) {
          await writeSquareSnapshot(squarePath, outcome.state);
          fingerprint = await fileFingerprint(squarePath);
          cached = { fingerprint, state: cloneState(outcome.state) };
          version += 1;
        }
        return outcome.result;
      });
    },
    async read() {
      assertCellOpen(closed);
      return withSquareFileLock(squarePath, async () => {
        assertCellOpen(closed);
        return { state: await currentStateUnderLock(), version };
      });
    },
    async changed(sinceVersion, timeoutMs) {
      assertCellOpen(closed);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (true) {
        await observe();
        if (version > sinceVersion) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        await sleep(Math.min(25, remaining));
        assertCellOpen(closed);
      }
    },
    async close() {
      closed = true;
    },
  };
}

/** Application-facing file cell factory; keeps storage choice behind this module. */
export function openSquareCell(squarePath: string): StateCell {
  return createFileCell(squarePath);
}
