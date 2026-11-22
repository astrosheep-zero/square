import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalPath } from '../storage/canonical-path.js';
import { observeFileVersion } from '../storage/file-changes.js';
import { retrySqliteBusy, inSqliteTransaction, awaitSqliteQueue } from '../storage/sqlite-transaction.js';
import { InternalSquareError, SquareError, type BuildOptions } from '../core/model.js';
import type { SquareArtifactPort, SquareRead, SquareWrite, ArtifactWriteAuthority } from '../core/ports.js';
import { wrapSquareWrite, type LandingWriter } from '../core/square-domain.js';
import {
    createSqliteDriver, initializeSqlite, exportSqliteState, inspectSqlite, emptyRuntimeState,
    validateSquareFraming, resetSquareSqlite, APPLICATION_ID, CURRENT_USER_VERSION,
    abort, openExistingSquareDatabase, requireSquareExtension, storageError, type SquareState,
} from './square-store.js';
import { readStorageRevision } from '../storage/sqlite-framing.js';
import { invalidArtifact } from '../storage/sqlite-values.js';

const guideContents = new Map<string, string>();
function readGuide(name: string): string {
    if (!['participant', 'architect', 'brainstorm'].includes(name))
        throw new SquareError('invalid_args', `Unknown square guide: ${name}`);
    let content = guideContents.get(name);
    if (content === undefined) {
        content = fs.readFileSync(new URL(`../../guides/${name}.md`, import.meta.url), 'utf8').trim();
        guideContents.set(name, content);
    }
    return content;
}
function normalizedLines(value: string): string[] {
    const normalized = value.replace(/\r\n/g, '\n').trim();
    return normalized === '' ? [] : normalized.split('\n');
}
function synchronous(value: unknown): void {
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
        void Promise.resolve(value).catch(() => undefined);
        throw new TypeError('Square artifact callbacks must be synchronous.');
    }
}
/** All build paths share configuration validation and lazy guide preparation. */
export function prepareSquareBuild(options: Omit<BuildOptions, 'force'>, snippet: string): SquareState {
    if (options.hardCap !== undefined && options.hardCap !== null
        && (!Number.isSafeInteger(options.hardCap) || options.hardCap < 1))
        throw new SquareError('invalid_args', 'hardCap must be a positive integer or null');
    if (options.throttlePerMinute !== undefined
        && (!Number.isSafeInteger(options.throttlePerMinute) || options.throttlePerMinute < 1))
        throw new SquareError('invalid_args', 'throttlePerMinute must be a positive integer');
    const guides = [readGuide('participant')];
    if (options.template !== undefined)
        guides.push(readGuide(options.template));
    return {
        hardCap: options.hardCap ?? null,
        ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
        preamble: normalizedLines(snippet), warmup: normalizedLines(guides.join('\n\n')),
        acts: [], runtime: emptyRuntimeState(),
    };
}
/** File build owns publication and CLI conflict semantics, not host resources. */
export async function createSquare(location: string, options: BuildOptions, snippet: string, signal?: AbortSignal): Promise<void> {
    const state = prepareSquareBuild(options, snippet);
    if (options.force) {
        await writeSquareFile(location, state, signal);
    } else if (!await createSquareFile(location, state, signal)) {
        throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${location}`);
    }
}

interface SquareSnapshot {
    readonly state: SquareState;
    readonly revision: number;
}
/** One connection, queue, guarded port and publication lifetime for a Square artifact. */
export function createArtifactPort(location: string, initial?: SquareState, externalSignal?: AbortSignal): SquareArtifactPort {
    let database: DatabaseSync | undefined, closed = false, inCallback = false;
    let tail: Promise<void> = Promise.resolve();
    const cancel = new AbortController();
    const memory = initial !== undefined;
    const canonical = memory ? undefined : canonicalPath(location);
    if (initial !== undefined) {
        database = new DatabaseSync(':memory:');
        try {
            initializeSqlite(database, initial, 0);
            database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${CURRENT_USER_VERSION}`);
        }
        catch (error) { database.close(); throw error; }
    }
    const combined = (signal?: AbortSignal) => AbortSignal.any([cancel.signal, ...(externalSignal ? [externalSignal] : []), ...(signal ? [signal] : [])]);
    const validate = (db: DatabaseSync) => { validateSquareFraming(db, memory ? ':memory:' : location); return readStorageRevision(db); };
    async function connection(signal: AbortSignal): Promise<DatabaseSync> {
        if (database) return database;
        location = await canonical!;
        abort(signal);
        const probe = await retrySqliteBusy(() => openExistingSquareDatabase(location, true), signal);
        try { await retrySqliteBusy(() => validate(probe), signal); }
        catch (error) { throw storageError(error, location); }
        finally { probe.close(); }
        database = await retrySqliteBusy(() => openExistingSquareDatabase(location), signal);
        try { await retrySqliteBusy(() => { validate(database!); database!.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL'); }, signal); }
        catch (error) { database.close(); database = undefined; throw storageError(error, location); }
        return database;
    }
    function queue<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
        if (inCallback) throw new TypeError('Square artifact operations cannot nest inside a callback.');
        if (closed) return Promise.reject(new Error('Square artifact is closed'));
        let started = false;
        const result = tail.then(() => { abort(signal); started = true; return operation(signal); });
        tail = result.then(() => undefined, () => undefined);
        return awaitSqliteQueue(result, signal, () => started);
    }
    function transaction<R>(write: boolean, authority: ArtifactWriteAuthority | undefined, invoke: (facts: SquareRead | SquareWrite) => R, signal?: AbortSignal, settlement = false) {
        return queue(s => connection(s).then(db => inSqliteTransaction(db, write, () => validate(db), version => {
            const driver = createSqliteDriver(db);
            let active = true, failed = false, failure: unknown;
            const guard = <T extends object>(bucket: T): T => Object.fromEntries(Object.entries(bucket).map(([name, method]) => [name, (...args: never[]) => {
                if (!active) throw new Error('Square artifact transaction capability expired');
                abort(s);
                if (failed) throw failure;
                try { return (method as (...args: never[]) => unknown)(...args); }
                catch (error) { failed = true; failure = storageError(error, location); throw failure; }
            }])) as T;
            const reads = guard(driver.read), writes = guard(driver.writes);
            let value: R;
            inCallback = true;
            try {
                if (write) {
                    const gate = wrapSquareWrite(reads, writes, authority!);
                    value = invoke(gate.facts);
                    gate.complete();
                } else value = invoke(reads);
                synchronous(value);
            }
            finally { inCallback = false; active = false; }
            if (failed) throw failure;
            const changed = write && driver.changed, deliveryChanged = write && driver.deliveryChanged;
            if (changed || deliveryChanged) {
                if ((changed && version === Number.MAX_SAFE_INTEGER) || (deliveryChanged && readStorageRevision(db, true) === Number.MAX_SAFE_INTEGER))
                    throw invalidArtifact('revision cannot advance beyond the safe integer limit.');
                db.prepare('UPDATE storage_meta SET revision=revision+?, delivery_revision=delivery_revision+? WHERE id=1').run(Number(changed), Number(deliveryChanged));
            }
            return { value, version: version + Number(changed), changed, deliveryChanged };
        }, s)), settlement ? AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)]) : combined(signal));
    }
    const revision = (signal?: AbortSignal) => queue(async s => {
        const db = await connection(s);
        return inSqliteTransaction(db, false, () => validate(db), () => readStorageRevision(db), s);
    }, combined(signal));
    return {
        read: (select, signal) => transaction(false, undefined, select, signal),
        transactAs: (authority, change, signal) => transaction(true, authority, change as (facts: SquareRead | SquareWrite) => ReturnType<typeof change>, signal),
        settleAs: (authority, change) => transaction(true, authority, change as (facts: SquareRead | SquareWrite) => ReturnType<typeof change>, undefined, true),
        revision,
        async changed(since: number, timeout: number, signal?: AbortSignal): Promise<boolean> {
            if (inCallback) throw new TypeError('Square artifact operations cannot nest inside a callback.');
            if (closed) return false;
            const s = combined(signal), deadline = Date.now() + Math.max(0, timeout);
            if (memory) {
                try {
                    do {
                        if (await revision(s) > since) return true;
                        if (Date.now() >= deadline) return false;
                        await sleep(Math.min(25, deadline - Date.now()), undefined, { signal: s });
                    } while (!closed);
                }
                catch (error) { if (closed) return false; abort(s); throw error; }
                return false;
            }
            const observer = await observeSquareRevision(await canonical!);
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
/** Private read-only inspection; never creates the file and never canonicalizes its path. */
function inspectStore<R>(location: string, select: (db: DatabaseSync) => R, signal?: AbortSignal): Promise<R> {
    return retrySqliteBusy(() => openExistingSquareDatabase(location, true), signal).then(async db => {
        try {
            return await inSqliteTransaction(db, false, () => validateSquareFraming(db, location), () => select(db), signal);
        }
        catch (error) { throw storageError(error, location); }
        finally { db.close(); }
    });
}
/** No-force publication: a completed link stays success even if cancellation follows. */
export async function createSquareFile(location: string, state: SquareState, signal?: AbortSignal): Promise<boolean> {
    abort(signal);
    location = await canonicalPath(location); requireSquareExtension(location);
    await fs.promises.mkdir(path.dirname(location), { recursive: true });
    const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, 'wx'); await handle.close();
    try {
        const db = await retrySqliteBusy(() => new DatabaseSync(temporary), signal);
        try {
            await retrySqliteBusy(() => db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL'), signal);
            await inSqliteTransaction(db, true, () => {}, () => {
                initializeSqlite(db, state, 0);
                db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${CURRENT_USER_VERSION}`);
            }, signal);
        }
        finally { db.close(); }
        const flush = await fs.promises.open(temporary, 'r+');
        try { await flush.sync(); } finally { await flush.close(); }
        abort(signal);
        try { await fs.promises.link(temporary, location); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
    }
    finally { await fs.promises.unlink(temporary).catch(() => undefined); }
}
/** Explicit replacement resets and reinitializes the live inode, never renaming over it. */
export async function writeSquareFile(location: string, state: SquareState, signal?: AbortSignal): Promise<void> {
    if (await createSquareFile(location, state, signal)) return;
    abort(signal);
    location = await canonicalPath(location);
    const probe = await retrySqliteBusy(() => openExistingSquareDatabase(location, true), signal);
    try { await retrySqliteBusy(() => validateSquareFraming(probe, location), signal); } finally { probe.close(); }
    const db = await retrySqliteBusy(() => openExistingSquareDatabase(location), signal);
    try {
        await retrySqliteBusy(() => { validateSquareFraming(db, location); db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL'); }, signal);
        await inSqliteTransaction(db, true, () => validateSquareFraming(db, location), () => {
            const revision = readStorageRevision(db);
            if (revision === Number.MAX_SAFE_INTEGER) throw invalidArtifact('revision cannot advance beyond the safe integer limit.');
            resetSquareSqlite(db);
            initializeSqlite(db, state, revision + 1);
        }, signal);
    }
    finally { db.close(); }
}
export function readSquareSnapshot(location: string, signal?: AbortSignal): Promise<SquareSnapshot> {
    return inspectStore(location, db => ({ state: exportSqliteState(db), revision: createSqliteDriver(db).read.header().revision }), signal);
}
/** Low-level observed storage revision: only a missing artifact maps to `null`. */
export const observeSquareRevision = (location: string) => observeFileVersion(location, 'square-revision', async (file, signal) => {
    try { return await inspectStore(file, db => readStorageRevision(db), signal); }
    catch (error) { abort(signal); if (error instanceof InternalSquareError && error.code === 'not_found') return null; throw error; }
});
export async function diagnoseSquareFile(location: string): Promise<{ unfixable?: string; problems: { kind: string; message: string }[]; standingCount?: number }> {
    try {
        return { problems: [], ...await inspectStore(await canonicalPath(location), db => inspectSqlite(db)) };
    }
    catch (error) {
        return { unfixable: error instanceof Error ? error.message : String(error), problems: [] };
    }
}
