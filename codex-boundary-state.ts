import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLockSync } from './file-lock.js';

export interface CodexBoundary {
  lastStop: number;
  lastNonStop: number;
}

interface BoundaryFile {
  v: 1;
  nextSequence: number;
  threads: Record<string, CodexBoundary>;
}

function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_CODEX_BOUNDARIES || path.join(os.homedir(), '.square', 'codex-boundaries.json');
}

function lockPath(filePath: string): string {
  return `${filePath}.lock`;
}

function emptyFile(): BoundaryFile {
  return { v: 1, nextSequence: 0, threads: {} };
}

function readFile(filePath: string): BoundaryFile {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<BoundaryFile>;
    if (value.v !== 1 || typeof value.nextSequence !== 'number' || !Number.isSafeInteger(value.nextSequence) || value.nextSequence < 0 || value.threads === null || typeof value.threads !== 'object') return emptyFile();
    const nextSequence = value.nextSequence;
    const threads: Record<string, CodexBoundary> = {};
    for (const [threadId, boundary] of Object.entries(value.threads)) {
      if (boundary === null || typeof boundary !== 'object') continue;
      const item = boundary as Partial<CodexBoundary>;
      const lastStop = item.lastStop;
      const lastNonStop = item.lastNonStop;
      if (typeof lastStop === 'number' && Number.isSafeInteger(lastStop) && lastStop >= 0 && typeof lastNonStop === 'number' && Number.isSafeInteger(lastNonStop) && lastNonStop >= 0) {
        threads[threadId] = { lastStop, lastNonStop };
      }
    }
    return { v: 1, nextSequence, threads };
  } catch {
    return emptyFile();
  }
}

function writeFile(filePath: string, value: BoundaryFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function readCodexBoundary(threadId: string, env: NodeJS.ProcessEnv = process.env): CodexBoundary | undefined {
  if (!threadId) return undefined;
  const filePath = statePath(env);
  return readFile(filePath).threads[threadId];
}

export function codexQueueEligible(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const boundary = readCodexBoundary(threadId, env);
  return boundary !== undefined && boundary.lastStop > boundary.lastNonStop;
}

export function recordCodexBoundary(
  threadId: string,
  event: 'Stop' | 'non-stop',
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!threadId) return;
  const filePath = statePath(env);
  withFileLockSync(lockPath(filePath), { retryMs: 10, staleMs: 30_000 }, () => {
    const value = readFile(filePath);
    value.nextSequence += 1;
    const current = value.threads[threadId] ?? { lastStop: 0, lastNonStop: 0 };
    value.threads[threadId] = event === 'Stop'
      ? { ...current, lastStop: value.nextSequence }
      : { ...current, lastNonStop: value.nextSequence };
    writeFile(filePath, value);
  });
}

export function clearCodexBoundary(threadId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!threadId) return;
  const filePath = statePath(env);
  withFileLockSync(lockPath(filePath), { retryMs: 10, staleMs: 30_000 }, () => {
    const value = readFile(filePath);
    if (!(threadId in value.threads)) return;
    delete value.threads[threadId];
    writeFile(filePath, value);
  });
}
