import fs from 'node:fs';

import {
  createSquareState,
  loadArchive,
  probeSquareFile,
  readSquareFile,
  writeArchiveFile,
  writeSquareSnapshot,
  withSquareFileLock,
  openSquareCell,
  createMemoryCell,
} from './square-storage.js';
import { coreCompact } from './decisions.js';
import { stageReplacement, type StagedReplacement } from './harness-stage.js';
import {
  InternalSquareError,
  SquareError,
  type BuildOptions,
  type HardCap,
  type SquareState,
  type StoredAct,
} from './model.js';
import type { OpenSquare } from './open-square.js';
import type { WakeNotifier } from './square-facade.js';

/** The current CLI file mutation boundary. */
function writeSquareState(squarePath: string, squareState: SquareState): void {
  writeSquareSnapshot(squarePath, squareState);
}

/** Publish a dependent archive before the main snapshot, retaining rollback evidence. */
function prepareArchive(filePath: string, acts: StoredAct[]): StagedReplacement {
  const existing = fs.existsSync(filePath) ? loadArchive(filePath) : [];
  return stageReplacement(filePath, (stage) => {
    writeArchiveFile(stage, [...existing, ...acts]);
  });
}

export async function compactSquare(squarePath: string, keep: number, archivePath: string): Promise<ReturnType<typeof coreCompact>> {
  return withSquareFileLock(squarePath, () => {
    const result = coreCompact(readSquareFile(squarePath), keep);
    if (result.archived.length === 0) return result;
    let persistence: StagedReplacement | undefined;
    try {
      persistence = prepareArchive(archivePath, result.archived);
      writeSquareState(squarePath, result.state);
      persistence.finalize();
      return result;
    } catch (error) {
      try { persistence?.rollback(); } catch {}
      throw error;
    }
  });
}

/** File-owned artifact creation for the CLI and path-backed public facade. */
export async function createSquare(
  squarePath: string,
  options: BuildOptions & { hardCap: HardCap },
  snippet: string
): Promise<void> {
  await withSquareFileLock(squarePath, () => {
    if (fs.existsSync(squarePath) && !options.force) {
      throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${squarePath}\nPass -f to overwrite.`);
    }
    writeSquareSnapshot(squarePath, createSquareState(options, snippet));
  });
}

export interface SquareBuildOptions {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  notifier?: WakeNotifier;
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
  options: Pick<SquareBuildOptions, 'clock' | 'notifier'> = {},
): Promise<OpenSquare> {
  const cell = openSquareCell(squarePath);
  try {
    await cell.read();
    return { cell, clock: options.clock ?? Date.now, ...(options.notifier === undefined ? {} : { notifier: options.notifier }), location: squarePath };
  } catch (error) {
    await cell.close();
    if (error instanceof InternalSquareError && error.code === 'not_found') {
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    }
    throw error;
  }
}

export function probeSquare(squarePath: string): OpenSquare | undefined {
  const state = probeSquareFile(squarePath);
  return state === undefined ? undefined : { cell: createMemoryCell(state), clock: Date.now, location: squarePath };
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
  return { cell: createMemoryCell(squareState), clock: options.clock ?? Date.now, ...(options.notifier === undefined ? {} : { notifier: options.notifier }), location: 'memory' };
}
