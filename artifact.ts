import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import { InternalSquareError, SquareError, type SquareState } from './model.js';
import { createSquareState, emptyRuntimeState, validateSquareState } from './square-state.js';

const APPLICATION_ID = 0x53515245;
const USER_VERSION = 1;
const SNAPSHOT_TABLE = 'square_snapshot';
const SNAPSHOT_DDL = `CREATE TABLE ${SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL)`;
const SNAPSHOT_COLUMNS = [
  { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
  { cid: 1, name: 'revision', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 2, name: 'state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
] as const;

export { createSquareState, emptyRuntimeState } from './square-state.js';

export interface DoctorProblem { kind: string; message: string; }
export interface DiagnoseResult { unfixable?: string; problems: DoctorProblem[]; state?: SquareState; }
export interface SquareSnapshot { readonly state: SquareState; readonly revision: number; }

function invalidArtifact(detail: string): SquareError {
  return new SquareError('invalid_args', `Invalid square artifact: ${detail}`);
}

function requireSquareExtension(squarePath: string): void {
  if (!squarePath.endsWith('.square')) throw new SquareError('invalid_args', `Square artifacts must use the .square extension: ${squarePath}`);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /unable to open database file|no such file|SQLITE_CANTOPEN/i.test(error.message);
}

function isNotADatabase(error: unknown): boolean {
  return error instanceof Error && /not a database|file is not a database|SQLITE_NOTADB/i.test(error.message);
}

function existingDatabaseUri(squarePath: string): string {
  const uri = pathToFileURL(path.resolve(squarePath));
  uri.searchParams.set('mode', 'rw');
  return uri.href;
}

function openExistingDatabase(squarePath: string): DatabaseSync {
  try {
    return new DatabaseSync(existingDatabaseUri(squarePath));
  } catch (error) {
    if (isNotFound(error)) throw new InternalSquareError('not_found', `square file not found: ${squarePath}`);
    if (isNotADatabase(error)) throw invalidArtifact('not a SQLite database.');
    throw error;
  }
}

function closeQuietly(database: DatabaseSync | undefined): void {
  try { database?.close(); } catch { /* closing does not alter the primary failure */ }
}

function parseState(state: unknown): SquareState {
  if (typeof state !== 'string') throw invalidArtifact('snapshot state is malformed.');
  try { return validateSquareState(JSON.parse(state) as unknown); } catch (error) {
    if (error instanceof SquareError) throw error;
    throw invalidArtifact('snapshot state is not valid JSON.');
  }
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ').replace(/\s*(>=|[(),=])\s*/g, '$1');
}

function isOwnedSnapshotSchema(database: DatabaseSync): boolean {
  const objects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
    .all() as { type?: unknown; name?: unknown; tbl_name?: unknown; sql?: unknown }[];
  if (objects.length !== 1) return false;
  const [object] = objects;
  if (object.type !== 'table' || object.name !== SNAPSHOT_TABLE || object.tbl_name !== SNAPSHOT_TABLE
    || typeof object.sql !== 'string' || normalizedSql(object.sql) !== normalizedSql(SNAPSHOT_DDL)) return false;
  const columns = database.prepare('SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid')
    .all(SNAPSHOT_TABLE) as { cid?: unknown; name?: unknown; type?: unknown; notnull?: unknown; dflt_value?: unknown; pk?: unknown; hidden?: unknown }[];
  return columns.length === SNAPSHOT_COLUMNS.length && columns.every((column, index) => {
    const expected = SNAPSHOT_COLUMNS[index];
    return column.cid === expected.cid && column.name === expected.name && column.type === expected.type
      && column.notnull === expected.notnull && column.dflt_value === expected.dflt_value
      && column.pk === expected.pk && column.hidden === expected.hidden;
  });
}

function validateDatabase(database: DatabaseSync): SquareSnapshot {
  try {
    const identity = database.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as { application_id?: unknown; user_version?: unknown };
    if (identity.application_id !== APPLICATION_ID) throw invalidArtifact('unrelated SQLite database.');
    if (identity.user_version !== USER_VERSION) throw invalidArtifact('unsupported SQLite format version.');
    if (!isOwnedSnapshotSchema(database)) throw invalidArtifact('unsupported snapshot schema.');
    const rows = database.prepare(`SELECT id, revision, state FROM ${SNAPSHOT_TABLE}`).all() as { id?: unknown; revision?: unknown; state?: unknown }[];
    if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || (rows[0].revision as number) < 0) throw invalidArtifact('snapshot row is malformed.');
    return { state: parseState(rows[0].state), revision: rows[0].revision as number };
  } catch (error) {
    if (error instanceof SquareError) throw error;
    if (isNotADatabase(error)) throw invalidArtifact('not a SQLite database.');
    throw error;
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
}

/** Opens an existing artifact without permitting SQLite to create a missing path. */
function readSquareSnapshotOnce(squarePath: string): SquareSnapshot {
  requireSquareExtension(squarePath);
  let database: DatabaseSync | undefined;
  try {
    database = openExistingDatabase(squarePath);
    return validateDatabase(database);
  } catch (error) {
    if (error instanceof SquareError) throw error;
    if (isNotFound(error)) throw new InternalSquareError('not_found', `square file not found: ${squarePath}`);
    if (isNotADatabase(error)) throw invalidArtifact('not a SQLite database.');
    throw error;
  } finally {
    closeQuietly(database);
  }
}

async function createTemporaryArtifact(squarePath: string): Promise<string> {
  const directory = path.dirname(squarePath);
  await fs.promises.mkdir(directory, { recursive: true });
  while (true) {
    const temporary = path.join(directory, `.${path.basename(squarePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.promises.open(temporary, 'wx');
      await handle.close();
      return temporary;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
  }
}

async function syncTemporaryArtifact(temporary: string): Promise<void> {
  const handle = await fs.promises.open(temporary, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeTemporaryArtifact(temporary: string): Promise<void> {
  try { await fs.promises.unlink(temporary); } catch { /* cleanup cannot invalidate a published artifact */ }
}

function initializeDatabase(squarePath: string, state: SquareState): void {
  const encoded = JSON.stringify(state);
  let database: DatabaseSync | undefined;
  try {
    database = openExistingDatabase(squarePath);
    database.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE; PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${USER_VERSION}; ${SNAPSHOT_DDL};`);
    database.prepare(`INSERT INTO ${SNAPSHOT_TABLE} (id, revision, state) VALUES (1, 0, ?)`).run(encoded);
    database.exec('COMMIT;');
  } catch (error) {
    try { database?.exec('ROLLBACK;'); } catch { /* retain initialization failure */ }
    throw error;
  } finally {
    closeQuietly(database);
  }
}

/** Creates a new SQLite artifact only when its pathname did not already exist. */
export async function createSquareFile(squarePath: string, state: SquareState): Promise<boolean> {
  requireSquareExtension(squarePath);
  const validated = validateSquareState(state);
  const temporary = await createTemporaryArtifact(squarePath);
  try {
    initializeDatabase(temporary, validated);
    await syncTemporaryArtifact(temporary);
    try {
      await fs.promises.link(temporary, squarePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await removeTemporaryArtifact(temporary);
  }
}

function isBusy(error: unknown): boolean {
  return error instanceof Error && /database is locked|database is busy|SQLITE_BUSY/i.test(error.message);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

function discardThenable(value: PromiseLike<unknown>): void {
  void Promise.resolve(value).catch(() => undefined);
}

function closedError(): Error {
  return new Error('Square artifact is closed');
}

async function pauseForBusy(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? closedError();
  try {
    await sleep(25, undefined, { signal });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? closedError();
    throw error;
  }
}

/**
 * Reads a complete validated snapshot, yielding between transient SQLite lock
 * conflicts. The URI remains create-disabled throughout the retry loop.
 */
export async function readSquareSnapshot(squarePath: string, signal?: AbortSignal): Promise<SquareSnapshot> {
  while (true) {
    if (signal?.aborted) throw signal.reason ?? closedError();
    try {
      return readSquareSnapshotOnce(squarePath);
    } catch (error) {
      if (!isBusy(error)) throw error;
      await pauseForBusy(signal);
    }
  }
}

export type SquareTransition<R> = (state: SquareState, revision: number) => { state?: SquareState; result: R };

/**
 * Executes one synchronous SquareState transition under SQLite's write lock.
 * A busy COMMIT retries on this same transaction, so fn is never replayed.
 */
export async function transactSquareSnapshot<R>(
  squarePath: string,
  fn: SquareTransition<R>,
  signal?: AbortSignal,
  forceCommit = false,
): Promise<{ result: R; revision: number; changed: boolean }> {
  requireSquareExtension(squarePath);
  let database: DatabaseSync | undefined;
  let begun = false;
  try {
    database = openExistingDatabase(squarePath);
    // Validate before any persistent pragma can touch an unsupported artifact.
    while (true) {
      try {
        validateDatabase(database);
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        await pauseForBusy(signal);
      }
    }
    while (true) {
      if (signal?.aborted) throw signal.reason ?? closedError();
      try {
        configureDatabase(database);
        database.exec('BEGIN IMMEDIATE;');
        begun = true;
        break;
      } catch (error) {
        if (!isBusy(error)) throw error;
        await pauseForBusy(signal);
      }
    }
    const current = validateDatabase(database);
    const outcome = fn(structuredClone(current.state), current.revision);
    if (isThenable(outcome)) {
      discardThenable(outcome);
      throw new TypeError('Square artifact transitions must be synchronous.');
    }
    if (typeof outcome !== 'object' || outcome === null || !Object.hasOwn(outcome, 'result')) {
      throw new TypeError('Square artifact transition must return { state?, result }.');
    }
    if (outcome.state === undefined || (!forceCommit && isDeepStrictEqual(outcome.state, current.state))) {
      database.exec('ROLLBACK;');
      begun = false;
      return { result: outcome.result, revision: current.revision, changed: false };
    }
    const state = validateSquareState(outcome.state);
    if (current.revision === Number.MAX_SAFE_INTEGER) {
      throw invalidArtifact('snapshot revision cannot advance beyond the safe integer limit.');
    }
    const revision = current.revision + 1;
    database.prepare(`UPDATE ${SNAPSHOT_TABLE} SET revision = ?, state = ? WHERE id = 1`)
      .run(revision, JSON.stringify(state));
    while (true) {
      if (signal?.aborted) throw signal.reason ?? closedError();
      try {
        database.exec('COMMIT;');
        begun = false;
        return { result: outcome.result, revision, changed: true };
      } catch (error) {
        if (!isBusy(error)) throw error;
        await pauseForBusy(signal);
      }
    }
  } catch (error) {
    if (begun) {
      try { database?.exec('ROLLBACK;'); } catch { /* retain callback and SQLite failures */ }
    }
    throw error;
  } finally {
    closeQuietly(database);
  }
}

/** Replaces an existing validated snapshot in place and always advances its revision. */
export async function replaceSquareSnapshot(squarePath: string, state: SquareState): Promise<SquareSnapshot> {
  const replacement = structuredClone(validateSquareState(state));
  const committed = await transactSquareSnapshot(
    squarePath,
    () => ({ state: replacement, result: undefined }),
    undefined,
    true,
  );
  return { state: replacement, revision: committed.revision };
}

export async function writeSquareFile(squarePath: string, squareState: SquareState): Promise<void> {
  requireSquareExtension(squarePath);
  if (await createSquareFile(squarePath, squareState)) return;
  await replaceSquareSnapshot(squarePath, squareState);
}

export async function loadSquare(squarePath: string): Promise<SquareState> {
  return structuredClone((await readSquareSnapshot(squarePath)).state);
}

export async function probeSquare(squarePath: string): Promise<SquareState | undefined> {
  if (!squarePath.endsWith('.square')) return undefined;
  try { return structuredClone(readSquareSnapshotOnce(squarePath).state); } catch { return undefined; }
}

export async function diagnoseSquareFile(squarePath: string): Promise<DiagnoseResult> {
  try { return { problems: [], state: await loadSquare(squarePath) }; } catch (error) {
    return { unfixable: error instanceof Error ? error.message : String(error), problems: [] };
  }
}
