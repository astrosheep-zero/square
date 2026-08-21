import fs from 'node:fs';

import { createSquareDoc, loadArchive, loadSquare, writeArchiveFile, writeSquareFile } from './artifact.js';
import { coreCompact } from './decisions.js';
import { withFileLock } from './file-lock.js';
import { stageReplacement, type StagedReplacement } from './harness-stage.js';
import {
  InternalSquareError,
  SquareError,
  type BuildOptions,
  type HardCap,
  type SquareDoc,
  type StoredAct,
} from './model.js';
import { LOCK_RETRY_MS, LOCK_STALE_MS } from './runtime.js';
import { createApplication, type SquareApplication, type WakeNotifier } from './square-engine.js';
import { createFileCell, createMemoryCell } from './square-storage.js';

/** The current CLI file mutation boundary. */
async function withSquareLock<T>(squarePath: string, fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(
    `${squarePath}.lock`,
    { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS },
    fn,
  );
}

function writeSquareDoc(squarePath: string, doc: SquareDoc): void {
  writeSquareFile(squarePath, doc);
}

/** Publish a dependent archive before the main snapshot, retaining rollback evidence. */
function prepareArchive(filePath: string, acts: StoredAct[]): StagedReplacement {
  const existing = fs.existsSync(filePath) ? loadArchive(filePath) : [];
  return stageReplacement(filePath, (stage) => {
    writeArchiveFile(stage, [...existing, ...acts]);
  });
}

export async function compactSquare(squarePath: string, keep: number, archivePath: string): Promise<ReturnType<typeof coreCompact>> {
  return withSquareLock(squarePath, () => {
    const result = coreCompact(loadSquare(squarePath), keep);
    if (result.archived.length === 0) return result;
    let persistence: StagedReplacement | undefined;
    try {
      persistence = prepareArchive(archivePath, result.archived);
      writeSquareDoc(squarePath, result.doc);
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
  await withSquareLock(squarePath, () => {
    if (fs.existsSync(squarePath) && !options.force) {
      throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${squarePath}\nPass -f to overwrite.`);
    }
    writeSquareFile(squarePath, createSquareDoc(options, snippet));
  });
}

export interface ApplicationBuildOptions {
  markdown: string;
  hardCap?: number | null;
  throttlePerMinute?: number;
  clock?: () => number;
  notifier?: WakeNotifier;
}

function validateBuildOptions(options: ApplicationBuildOptions): void {
  if (options.hardCap !== undefined && options.hardCap !== null
    && (!Number.isSafeInteger(options.hardCap) || options.hardCap < 1)) {
    throw new SquareError('invalid_args', 'hardCap must be a positive integer or null');
  }
  if (options.throttlePerMinute !== undefined
    && (!Number.isSafeInteger(options.throttlePerMinute) || options.throttlePerMinute < 1)) {
    throw new SquareError('invalid_args', 'throttlePerMinute must be a positive integer');
  }
}

function applicationOptions(options: ApplicationBuildOptions): { clock?: () => number; notifier?: WakeNotifier } {
  return {
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.notifier === undefined ? {} : { notifier: options.notifier }),
  };
}

export async function openFileApplication(
  squarePath: string,
  options: Pick<ApplicationBuildOptions, 'clock' | 'notifier'> = {},
): Promise<SquareApplication> {
  const cell = createFileCell(squarePath);
  try {
    await cell.read();
    return createApplication({ cell, ...applicationOptions({ markdown: '', ...options }) });
  } catch (error) {
    await cell.close();
    if (error instanceof InternalSquareError && error.code === 'not_found') {
      throw new SquareError('unavailable', `Square is unavailable at ${squarePath}`);
    }
    throw error;
  }
}

export async function buildFileApplication(squarePath: string, options: ApplicationBuildOptions): Promise<SquareApplication> {
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
  return openFileApplication(squarePath, options);
}

export function buildMemoryApplication(options: ApplicationBuildOptions): SquareApplication {
  validateBuildOptions(options);
  const doc = createSquareDoc({
    force: false,
    hardCap: options.hardCap ?? null,
    ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
  }, options.markdown);
  return createApplication({ cell: createMemoryCell(doc), ...applicationOptions(options) });
}
