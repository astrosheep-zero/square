import fs from 'node:fs';
import path from 'node:path';

import {
  createSquareState,
  probeSquareFile,
  writeSquareSnapshot,
  withSquareFileLock,
  openSquareCell,
  createMemoryCell,
  squareFileFingerprint,
} from './square-storage.js';
import {
  InternalSquareError,
  SquareError,
  type BuildOptions,
  type HardCap,
  type SquareState,
} from './model.js';
import { closeOpenSquare, type OpenSquare } from './open-square.js';
import type { HostLedgerPort, SquareArtifactPort } from './ports.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';

/** File-owned artifact creation for the CLI and path-backed public facade. */
export async function createSquare(
  squarePath: string,
  options: BuildOptions & { hardCap: HardCap },
  snippet: string
): Promise<void> {
  await withSquareFileLock(squarePath, async () => {
    if (await fs.promises.access(squarePath).then(() => true, () => false) && !options.force) {
      throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${squarePath}\nPass -f to overwrite.`);
    }
    await writeSquareSnapshot(squarePath, await createSquareState(options, snippet));
  });
}

export interface SquareBuildOptions {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  hostLedger?: HostLedgerPort;
  wakeTransport?: import('./ports.js').WakeTransportPort;
  env?: NodeJS.ProcessEnv;
}

function validateBuildOptions(options: SquareBuildOptions): void {
  if (options.hardCap !== undefined && options.hardCap !== null
    && (!Number.isSafeInteger(options.hardCap) || options.hardCap < 1)) {
    throw new SquareError('invalid_args', 'hardCap must be a positive integer or null');
  }
  if (options.throttlePerMinute !== undefined
    && (!Number.isSafeInteger(options.throttlePerMinute) || options.throttlePerMinute < 1)) {
    throw new SquareError('invalid_args', 'throttlePerMinute must be a positive integer');
  }
}

export async function openSquare(
  squarePath: string,
  options: Pick<SquareBuildOptions, 'clock' | 'hostLedger' | 'wakeTransport' | 'env'> = {},
): Promise<OpenSquare> {
  const env = options.env ?? process.env;
  const ledgerRoot = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
  const cell = openSquareCell(squarePath);
  try {
    await cell.read();
    const artifact: SquareArtifactPort = { read: () => cell.read(), transact: (fn) => cell.transact(fn), changed: (since, timeout) => cell.changed(since, timeout), close: () => cell.close() };
    return {
      artifact,
      clock: options.clock ?? Date.now,
      location: squarePath,
      env,
      hostLedger: options.hostLedger ?? createHostLedgerPort({
        userPath: env.SQUARE_HOST_LEDGER_USER ?? ledgerRoot,
        localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? ledgerRoot,
      }),
      wakeTransport: options.wakeTransport,
    };
  } catch (error) {
    await cell.close();
    if (error instanceof InternalSquareError && error.code === 'not_found') {
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    }
    throw error;
  }
}

export async function probeSquare(squarePath: string): Promise<OpenSquare | undefined> {
  const state = await probeSquareFile(squarePath);
  return state === undefined ? undefined : { artifact: memoryArtifact(createMemoryCell(state)), clock: Date.now, location: squarePath };
}

export async function buildSquare(squarePath: string, options: SquareBuildOptions): Promise<OpenSquare> {
  validateBuildOptions(options);
  try {
    await createSquare(squarePath, {
      force: false,
      hardCap: options.hardCap ?? null,
      ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
    }, options.markdown);
  } catch (error) {
    if (error instanceof InternalSquareError && error.code === 'conflict') {
      throw new SquareError('io', `Cannot build over an existing square at ${squarePath}`);
    }
    throw error;
  }
  return openSquare(squarePath, options);
}

export function buildMemorySquare(options: SquareBuildOptions): OpenSquare {
  validateBuildOptions(options);
  const squareState = createSquareState({
    force: false,
    hardCap: options.hardCap ?? null,
    ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
  }, options.markdown);
  return { artifact: memoryArtifact(createMemoryCell(squareState)), clock: options.clock ?? Date.now, location: 'memory', hostLedger: options.hostLedger, wakeTransport: options.wakeTransport };
}

function memoryArtifact(cell: ReturnType<typeof createMemoryCell>): SquareArtifactPort {
  return { read: () => cell.read(), transact: (fn) => cell.transact(fn), changed: (since, timeout) => cell.changed(since, timeout), close: () => cell.close() };
}

/** Wait for any bound artifact to change; delivery callers re-project after the edge. */
export type SquareChangeWaitResult<T> =
  | { status: 'ready'; value: T }
  | { status: 'changed' }
  | { status: 'expired' };

/** Durable file observations that let a retrier retain a change boundary across waits. */
export interface SquareChangeCursor {
  readonly fingerprints: ReadonlyMap<string, string>;
}

export async function captureSquareChangeCursor(squarePaths: readonly string[]): Promise<SquareChangeCursor> {
  const paths = [...new Set(squarePaths)];
  return {
    fingerprints: new Map(await Promise.all(paths.map(async (squarePath) =>
      [squarePath, await squareFileFingerprint(squarePath)] as const))),
  };
}

export async function waitForSquareChanges<T>(
  squarePaths: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  afterReady?: () => Promise<T | undefined>,
  cursor?: SquareChangeCursor,
): Promise<SquareChangeWaitResult<T>> {
  if (timeoutMs <= 0 || signal?.aborted || squarePaths.length === 0) return { status: 'expired' };
  const squares: OpenSquare[] = [];
  try {
    for (const squarePath of [...new Set(squarePaths)]) {
      try { squares.push(await openSquare(squarePath)); } catch { /* stale binding */ }
    }
    if (squares.length === 0) return { status: 'expired' };
    const baselines = await Promise.all(squares.map(async (square) => ({
      square,
      version: (await square.artifact.read()).version,
    })));
    if (cursor !== undefined) {
      const changedSinceCursor = await Promise.all(squares.map(async (square) => (
        cursor.fingerprints.get(square.location) !== await squareFileFingerprint(square.location)
      )));
      if (changedSinceCursor.some(Boolean)) {
        const ready = await afterReady?.();
        return ready === undefined ? { status: 'changed' } : { status: 'ready', value: ready };
      }
    }
    const ready = await afterReady?.();
    if (ready !== undefined) return { status: 'ready', value: ready };
    const waits = baselines.map(async ({ square, version }) => {
      const changed = await square.artifact.changed(version, timeoutMs).catch(() => false);
      if (changed) return true;
      throw new Error('square wait expired');
    });
    let abortWait: (() => void) | undefined;
    const abort = new Promise<boolean>((resolve) => {
      abortWait = () => resolve(false);
      if (signal?.aborted) abortWait();
      else signal?.addEventListener('abort', abortWait, { once: true });
    });
    try {
      const changed = await Promise.race([Promise.any(waits).catch(() => false), abort]);
      return changed ? { status: 'changed' } : { status: 'expired' };
    } finally {
      if (abortWait) signal?.removeEventListener('abort', abortWait);
    }
  } finally {
    await Promise.all(squares.map((square) => closeOpenSquare(square)));
  }
}
