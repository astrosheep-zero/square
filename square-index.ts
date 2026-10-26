import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './file-lock.js';
import { canonicalPath } from './canonical-path.js';
import { observeFileMetadata, type VersionObserver } from './file-changes.js';
import { sameBody, validateBody, type Body } from './model.js';

/** A rebuildable discovery hint: the body that may have used an artifact and its path.
 * It is deliberately not a participant, generation, ownership, suppression, or evidence row. */
export interface SquareIndexEntry {
  readonly location: string;
  readonly body: Body;
}

export interface SquareIndexQuery {
  readonly body?: Body;
  readonly channel?: string;
  readonly session?: string;
  readonly agent?: string;
}

/** The index is the only host-side Square state. Its path is test/configuration plumbing, not authority. */
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
  if (typeof row.location !== 'string' || !path.isAbsolute(row.location)
    || row.body === null || typeof row.body !== 'object' || Array.isArray(row.body)) return undefined;
  const raw = row.body as Record<string, unknown>;
  const body = {
    channel: raw.channel,
    session: raw.session,
    ...(raw.agent === undefined ? {} : { agent: raw.agent }),
  } as Body;
  try { validateBody(body); } catch { return undefined; }
  if (Object.keys(raw).some((key) => !['channel', 'session', 'agent'].includes(key))) return undefined;
  return { location: row.location, body };
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
    } catch {
      // The index is disposable discovery input. A malformed line is ignored rather than
      // becoming a second authority or preventing access to valid entries beside it.
    }
  }
  return entries;
}

function matches(entry: SquareIndexEntry, query: SquareIndexQuery): boolean {
  if (query.body !== undefined && !sameBody(entry.body, query.body)) return false;
  if (query.channel !== undefined && entry.body.channel !== query.channel) return false;
  if (query.session !== undefined && entry.body.session !== query.session) return false;
  if (query.agent !== undefined && entry.body.agent !== query.agent) return false;
  return true;
}

/** Read and verify the disposable index. Paths are canonicalized on access and duplicates collapse. */
export async function indexedSquareEntries(query: SquareIndexQuery = {}, env: NodeJS.ProcessEnv = process.env): Promise<readonly SquareIndexEntry[]> {
  const entries = await readEntries(squareIndexPath(env));
  const result: SquareIndexEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!matches(entry, query)) continue;
    let location: string;
    try { location = await canonicalPath(entry.location); } catch { continue; }
    const key = JSON.stringify([location, entry.body.channel, entry.body.session, entry.body.agent ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ location, body: entry.body });
  }
  return result;
}

export async function indexedSquarePaths(query: SquareIndexQuery = {}, env: NodeJS.ProcessEnv = process.env): Promise<readonly string[]> {
  return [...new Set((await indexedSquareEntries(query, env)).map((entry) => entry.location))];
}

/** Best-effort discovery only: a busy index skips publication, never queues or delays artifact work. */
export async function rememberSquarePath(location: string, body: Body, index: string): Promise<boolean> {
  validateBody(body);
  const canonical = await canonicalPath(location);
  await fs.mkdir(path.dirname(index), { recursive: true });
  return await withFileLock(lockPath(index), { retryMs: 10, skipIfBusy: true }, async () => {
    const entries = await readEntries(index);
    if (entries.some((entry) => entry.location === canonical && sameBody(entry.body, body))) return false;
    const next = [...entries, { location: canonical, body }];
    const temporary = `${index}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, next.map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, index);
    } finally { await fs.rm(temporary, { force: true }); }
    return true;
  }) ?? false;
}

/** Index loss is tolerated by every caller; this observer is only a wake hint for rediscovery. */
export function observeSquareIndex(env: NodeJS.ProcessEnv = process.env): Promise<VersionObserver<string>> {
  return observeFileMetadata(squareIndexPath(env));
}

export function bodyKey(body: Body): string {
  validateBody(body);
  return JSON.stringify([body.channel, body.session, body.agent ?? null]);
}