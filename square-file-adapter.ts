import path from 'node:path';
export { observeSquareRevision as observeSquareChanges } from './artifact.js';
import { hostLedgerRoot } from './host-ledger-root.js';

import {
  createSquareState,
  createSquareSnapshot,
  probeSquareFile,
  writeSquareSnapshot,
  openSquareCell,
  createMemoryCell,
} from './square-storage.js';
import {
  InternalSquareError,
  SquareError,
  type BuildOptions,
  type HardCap,
  type SquareState,
} from './model.js';
import type { OpenSquare } from './open-square.js';
import type { HostLedgerPort, SquareArtifactPort } from './ports.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';

/** File-owned artifact creation for the CLI and path-backed public facade. */
export async function createSquare(
  squarePath: string,
  options: BuildOptions & { hardCap: HardCap },
  snippet: string
): Promise<void> {
  const state = createSquareState(options, snippet);
  if (options.force) {
    await writeSquareSnapshot(squarePath, state);
    return;
  }
  if (!await createSquareSnapshot(squarePath, state)) {
    throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${squarePath}\nPass -f to overwrite.`);
  }
}

export interface SquareBuildOptions {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  hostLedger?: HostLedgerPort;
  wakeTransport?: import('./ports.js').WakeTransportPort;
  env?: NodeJS.ProcessEnv;
  /** One caller deadline (e.g. a native hook budget) propagated into artifact busy retries. */
  signal?: AbortSignal;
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
  options: Pick<SquareBuildOptions, 'clock' | 'hostLedger' | 'wakeTransport' | 'env' | 'signal'> = {},
): Promise<OpenSquare> {
  const env = options.env ?? process.env;
  const ledgerRoot = hostLedgerRoot(env);
  const artifact = openSquareArtifact(squarePath, options.signal);
  try {
    await artifact.read();
    return {
      artifact,
      clock: options.clock ?? Date.now,
      location: squarePath,
      env,
      hostLedger: options.hostLedger ?? createHostLedgerPort({
        rootPath: ledgerRoot,
      }),
      wakeTransport: options.wakeTransport,
    };
  } catch (error) {
    await artifact.close();
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

/** A projection reads and validates its snapshot once; no preliminary duplicate read. */
export function openSquareArtifact(squarePath: string, signal?: AbortSignal): SquareArtifactPort {
  return memoryArtifact(openSquareCell(squarePath, signal));
}

function memoryArtifact(cell: ReturnType<typeof createMemoryCell>): SquareArtifactPort {
  return { read: (signal) => cell.read(signal), transact: (fn, signal) => cell.transact(fn, signal), changed: (since, timeout, signal) => cell.changed(since, timeout, signal), close: () => cell.close() };
}
