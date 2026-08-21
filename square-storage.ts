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

export function readSquareFile(squarePath: string): SquareState {
  return loadSquare(squarePath);
}

export function probeSquareFile(squarePath: string): SquareState | undefined {
  return probeSquare(squarePath);
}

export function diagnoseSquareFile(squarePath: string): ReturnType<typeof diagnoseArtifactFile> {
  return diagnoseArtifactFile(squarePath);
}

export function writeSquareSnapshot(squarePath: string, squareState: SquareState): void {
  writeSquareFile(squarePath, squareState);
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

function fileFingerprint(squarePath: string): string {
  try {
    const stat = fs.statSync(squarePath);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return 'missing';
  }
}

/** File-backed cell retaining the existing .square codec and lock boundary. */
export function createFileCell(squarePath: string): StateCell {
  let closed = false;
  let version = 0;
  let fingerprint = fileFingerprint(squarePath);

  function observe(): void {
    const next = fileFingerprint(squarePath);
    if (next === fingerprint) return;
    fingerprint = next;
    version += 1;
  }

  return {
    async transact<R>(fn: (state: SquareState, version: number) => { state?: SquareState; result: R }) {
      assertCellOpen(closed);
      return withFileLock(`${squarePath}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, () => {
        assertCellOpen(closed);
        observe();
        const current = readSquareFile(squarePath);
        const working = cloneState(current);
        const outcome = fn(working, version);
        if (outcome.state !== undefined) {
          writeSquareSnapshot(squarePath, outcome.state);
          fingerprint = fileFingerprint(squarePath);
          version += 1;
        }
        return outcome.result;
      });
    },
    async read() {
      assertCellOpen(closed);
      observe();
      const state = readSquareFile(squarePath);
      return { state: cloneState(state), version };
    },
    async changed(sinceVersion, timeoutMs) {
      assertCellOpen(closed);
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (true) {
        observe();
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
