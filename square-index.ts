import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.js';
import { canonicalPath } from './canonical-path.js';
import { observeFileMetadata, type VersionObserver } from './file-changes.js';
import { validateOwner, type Owner } from './model.js';

/** A rebuildable discovery hint: the owner that may have used an artifact and its path. */
export interface SquareIndexEntry {
  readonly location: string;
  readonly owner: Owner;
}

export interface SquareIndexQuery {
  readonly owner?: Owner;
}

export function squareIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SQUARE_INDEX?.trim();
  return path.resolve(configured ?? path.join(os.homedir(), '.square', 'index.ndjsonl'));
}

function lockPath(index: string): string {
  return `${index}.lock`;
}

function validEntry(value: unknown): SquareIndexEntry | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.location !== 'string' || !path.isAbsolute(row.location) || typeof row.owner !== 'string') return undefined;
  try { validateOwner(row.owner); } catch { return undefined; }
  if (Object.keys(row).some((key) => !['location', 'owner'].includes(key))) return undefined;
  return { location: row.location, owner: row.owner };
}

async function readEntries(index: string): Promise<SquareIndexEntry[]> {
  let content: string;
  try { content = await fs.readFile(index, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: SquareIndexEntry[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = validEntry(JSON.parse(line));
      if (entry !== undefined) entries.push(entry);
    } catch { /* Disposable discovery input. */ }
  }
  return entries;
}

function matches(entry: SquareIndexEntry, query: SquareIndexQuery): boolean {
  return query.owner === undefined || entry.owner === query.owner;
}

export async function indexedSquareEntries(query: SquareIndexQuery = {}, env: NodeJS.ProcessEnv = process.env): Promise<readonly SquareIndexEntry[]> {
  const entries = await readEntries(squareIndexPath(env));
  const result: SquareIndexEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!matches(entry, query)) continue;
    let location: string;
    try { location = await canonicalPath(entry.location); } catch { continue; }
    const key = JSON.stringify([location, entry.owner]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ location, owner: entry.owner });
  }
  return result;
}

export async function indexedSquarePaths(query: SquareIndexQuery = {}, env: NodeJS.ProcessEnv = process.env): Promise<readonly string[]> {
  return [...new Set((await indexedSquareEntries(query, env)).map((entry) => entry.location))];
}

/** Best-effort discovery only: a busy index skips publication, never queues or delays artifact work. */
export async function rememberSquarePath(location: string, owner: Owner, index: string): Promise<boolean> {
  validateOwner(owner);
  const canonical = await canonicalPath(location);
  await fs.mkdir(path.dirname(index), { recursive: true });
  return await withFileLock(lockPath(index), { retryMs: 10, skipIfBusy: true }, async () => {
    const entries = await readEntries(index);
    if (entries.some((entry) => entry.location === canonical && entry.owner === owner)) return false;
    const next = [...entries, { location: canonical, owner }];
    const temporary = `${index}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, next.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, index);
    } finally { await fs.rm(temporary, { force: true }); }
    return true;
  }) ?? false;
}

export function observeSquareIndex(env: NodeJS.ProcessEnv = process.env): Promise<VersionObserver<string>> {
  return observeFileMetadata(squareIndexPath(env));
}
