import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalPath } from './canonical-path.js';
import { observeFileVersion } from './file-changes.js';
import { retrySqliteBusy, inSqliteTransaction } from './sqlite-transaction.js';
import { InternalSquareError, SquareError } from './neutral.js';
import { readStorageRevision } from './sqlite-framing.js';
import { invalidArtifact } from './sqlite-values.js';

export interface StoreFormat {
  readonly applicationId: number;
  readonly userVersion: number;
  readonly validate: (db: DatabaseSync, location: string) => void;
  readonly reset: (db: DatabaseSync) => void;
  readonly observerKey: string;
}
export type StoreInitializer = (db: DatabaseSync) => void;
export type StoreChanges = { readonly changed: boolean; readonly deliveryChanged: boolean };
export interface StoreTransaction {
  readonly db: DatabaseSync;
  guard<F extends (...args: never[]) => unknown>(fn: F): F;
  track(changes: StoreChanges): void;
}
export function requireSquareExtension(location: string): void {
  if (!location.endsWith('.square')) throw new SquareError('invalid_args', `Square artifacts must use the .square extension: ${location}`);
}
export function storageError(error: unknown, location: string): unknown {
  if (!(error instanceof Error) || error instanceof SquareError || error instanceof InternalSquareError) return error;
  if (/unable to open database file|no such file|SQLITE_CANTOPEN/i.test(error.message))
    return new InternalSquareError('not_found', `square file not found: ${location}`);
  if (/not a database|SQLITE_NOTADB/i.test(error.message)) return invalidArtifact('not a SQLite database.');
  return error;
}
/** Private storage opening; never creates a missing file. */
export function openExistingSquareDatabase(location: string): DatabaseSync {
  requireSquareExtension(location);
  const uri = pathToFileURL(path.resolve(location));
  uri.searchParams.set('mode', 'rw');
  try { return new DatabaseSync(uri.href); } catch (error) { throw storageError(error, location); }
}
export function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Square artifact operation aborted');
}
function synchronous(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError('Square artifact callbacks must be synchronous.');
  }
}
/** One ordered connection and transaction lifetime, shared by Channel and Agora compositions. */
export function createArtifactStore(location: string, format: StoreFormat, initialize?: StoreInitializer, externalSignal?: AbortSignal) {
  let database: DatabaseSync | undefined, closed = false, inCallback = false;
  let tail: Promise<void> = Promise.resolve();
  const cancel = new AbortController();
  const canonical = initialize === undefined ? canonicalPath(location) : Promise.resolve(location);
  if (initialize) {
    database = new DatabaseSync(':memory:');
    try { initialize(database); database.exec(`PRAGMA application_id=${format.applicationId}; PRAGMA user_version=${format.userVersion}`); }
    catch (error) { database.close(); throw error; }
  }
  const combined = (signal?: AbortSignal) => AbortSignal.any([cancel.signal, ...(externalSignal ? [externalSignal] : []), ...(signal ? [signal] : [])]);
  const validate = (db: DatabaseSync) => { format.validate(db, initialize ? ':memory:' : location); return readStorageRevision(db); };
  async function connection(signal: AbortSignal): Promise<DatabaseSync> {
    if (database) return database;
    location = await canonical;
    abort(signal);
    database = openExistingSquareDatabase(location);
    try { await retrySqliteBusy(() => validate(database!), signal); database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL'); }
    catch (error) { database.close(); database = undefined; throw storageError(error, location); }
    return database;
  }
  function queue<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    if (inCallback) throw new TypeError('Square artifact operations cannot nest inside a callback.');
    if (closed) return Promise.reject(new Error('Square artifact is closed'));
    const result = tail.then(() => { abort(signal); return operation(signal); });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  function transaction<R>(write: boolean, callback: (tx: StoreTransaction) => R, signal: AbortSignal) {
    return connection(signal).then(db => inSqliteTransaction(db, write, () => validate(db), version => {
      const changes: StoreChanges[] = [];
      let active = true, failed = false, failure: unknown;
      const guard: StoreTransaction['guard'] = fn => ((...args: never[]) => {
        if (!active) throw new Error('Square artifact transaction capability expired');
        abort(signal);
        if (failed) throw failure;
        try { return fn(...args); }
        catch (error) { failed = true; failure = storageError(error, location); throw failure; }
      }) as typeof fn;
      let value: R;
      inCallback = true;
      try { value = callback({ db, guard, track: item => changes.push(item) }); synchronous(value); }
      finally { inCallback = false; active = false; }
      if (failed) throw failure;
      const changed = write && changes.some(item => item.changed), deliveryChanged = write && changes.some(item => item.deliveryChanged);
      if (changed || deliveryChanged) {
        if ((changed && version === Number.MAX_SAFE_INTEGER) || (deliveryChanged && readStorageRevision(db, true) === Number.MAX_SAFE_INTEGER))
          throw invalidArtifact('revision cannot advance beyond the safe integer limit.');
        db.prepare('UPDATE storage_meta SET revision=revision+?, delivery_revision=delivery_revision+? WHERE id=1').run(Number(changed), Number(deliveryChanged));
      }
      return { value, version: version + Number(changed), changed, deliveryChanged };
    }, signal));
  }
  const revision = (signal?: AbortSignal, delivery = false) => queue(async s => {
    const db = await connection(s);
    return inSqliteTransaction(db, false, () => validate(db), () => readStorageRevision(db, delivery), s);
  }, combined(signal));
  return {
    run<R>(write: boolean, callback: (tx: StoreTransaction) => R, signal?: AbortSignal, settlement = false) {
      return queue(s => transaction(write, callback, s), settlement
        ? AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]) : combined(signal));
    },
    revision,
    deliveryRevision: (signal?: AbortSignal) => revision(signal, true),
    async changed(since: number, timeout: number, signal?: AbortSignal): Promise<boolean> {
      if (inCallback) throw new TypeError('Square artifact operations cannot nest inside a callback.');
      if (closed) return false;
      const s = combined(signal), deadline = Date.now() + Math.max(0, timeout);
      if (initialize) {
        try {
          do {
            if (await revision(s) > since) return true;
            if (Date.now() >= deadline) return false;
            await sleep(Math.min(25, deadline - Date.now()), undefined, { signal: s });
          } while (!closed);
        } catch (error) { if (closed) return false; abort(s); throw error; }
        return false;
      }
      const observer = await observeStoreRevision(await canonical, format);
      try { return await observer.changed(since, Math.max(0, deadline - Date.now()), s); }
      catch (error) { if (closed) return false; abort(s); throw error; }
      finally { observer.close(); }
    },
    async close(): Promise<void> {
      if (inCallback) throw new TypeError('Square artifact cannot close inside a callback.');
      if (!closed) { closed = true; cancel.abort(new Error('Square artifact is closed')); }
      await tail;
      database?.close(); database = undefined;
    },
  };
}
export async function inspectStore<R>(location: string, format: StoreFormat, select: (db: DatabaseSync) => R, signal?: AbortSignal): Promise<R> {
  const db = openExistingSquareDatabase(location);
  return inSqliteTransaction(db, false, () => format.validate(db, location), () => select(db), signal)
    .catch(error => { throw storageError(error, location); }).finally(() => db.close());
}
export function observeStoreRevision(location: string, format: StoreFormat, delivery = false) {
  return observeFileVersion(location, `${format.observerKey}-${delivery ? 'delivery-revision' : 'revision'}`, async (file, signal) => {
    try { return await inspectStore(file, format, db => readStorageRevision(db, delivery), signal); }
    catch (error) { abort(signal); if (error instanceof InternalSquareError && error.code === 'not_found') return null; throw error; }
  });
}
/** Atomic publication and explicit replacement share the same closed physical schema. */
export async function createStoreFile(location: string, format: StoreFormat, initialize: StoreInitializer, signal?: AbortSignal): Promise<boolean> {
  abort(signal);
  location = await canonicalPath(location); requireSquareExtension(location);
  await fs.promises.mkdir(path.dirname(location), { recursive: true });
  const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.promises.open(temporary, 'wx'); await handle.close();
  try {
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
      await inSqliteTransaction(db, true, () => {}, () => { initialize(db); db.exec(`PRAGMA application_id=${format.applicationId}; PRAGMA user_version=${format.userVersion}`); }, signal);
    } finally { db.close(); }
    const flush = await fs.promises.open(temporary, 'r+');
    try { await flush.sync(); } finally { await flush.close(); }
    abort(signal);
    try { await fs.promises.link(temporary, location); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  } finally { await fs.promises.unlink(temporary).catch(() => undefined); }
}
export async function replaceStoreFile(location: string, format: StoreFormat, initialize: (db: DatabaseSync, revision: number) => void, signal?: AbortSignal): Promise<void> {
  if (await createStoreFile(location, format, db => initialize(db, 0), signal)) return;
  abort(signal);
  const db = openExistingSquareDatabase(await canonicalPath(location));
  try {
    await retrySqliteBusy(() => format.validate(db, location), signal);
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    await inSqliteTransaction(db, true, () => format.validate(db, location), () => {
      const revision = readStorageRevision(db);
      if (revision === Number.MAX_SAFE_INTEGER) throw invalidArtifact('revision cannot advance beyond the safe integer limit.');
      format.reset(db);
      initialize(db, revision + 1);
    }, signal);
  } finally { db.close(); }
}
