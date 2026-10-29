import { DatabaseSync } from 'node:sqlite';
import { retrySqliteBusy, inSqliteTransaction } from './sqlite-transaction.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { observeFileVersion } from './file-changes.js';
import { canonicalPath } from './canonical-path.js';
import { InternalSquareError, SquareError, type BuildOptions } from './model.js';
import type { SquareResourceOwner, SquareArtifactPort, SquareRead, SquareWrite, ArtifactWriteAuthority, DeliveryClaimInput, DeliveryClaimResult } from './ports.js';
import { wrapSquareWrite, type LandingWriter } from './square-domain.js';
import { APPLICATION_ID, CURRENT_USER_VERSION, createSqliteDriver, initializeSqlite, exportSqliteState, inspectSqlite, invalidArtifact, validateSqliteHeader, emptyRuntimeState, type SquareState } from './square-sqlite.js';

/** Explicit-lifetime holder of one reused artifact connection. Request cancellation
 * never becomes the shared connection's lifetime; close drains the owner once. */
export function createSquareResourceOwner(): SquareResourceOwner {
    let held: { readonly location: string; readonly artifact: SquareArtifactPort } | undefined;
    let closed = false;
    return {
        artifact(location: string): SquareArtifactPort {
            if (closed) throw new SquareError('unavailable', 'Square resource owner is closed');
            const key = path.resolve(location);
            if (held === undefined) held = { location: key, artifact: createArtifactPort(key) };
            if (held.location !== key)
                throw new SquareError('unavailable', `Square resource owner already holds ${held.location}; it cannot also open ${key}`);
            return held.artifact;
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            const artifact = held?.artifact;
            held = undefined;
            if (artifact !== undefined) await artifact.close();
        },
    };
}

const guideContents = new Map<string, string>();
function readGuide(name: string): string {
    if (!['participant', 'architect', 'brainstorm'].includes(name))
        throw new SquareError('invalid_args', `Unknown square guide: ${name}`);
    let content = guideContents.get(name);
    if (content === undefined) {
        content = fs.readFileSync(new URL(`../guides/${name}.md`, import.meta.url), 'utf8').trim();
        guideContents.set(name, content);
    }
    return content;
}
function normalizedLines(value: string): string[] {
    const normalized = value.replace(/\r\n/g, '\n').trim();
    return normalized === '' ? [] : normalized.split('\n');
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
export async function createSquare(location: string, options: BuildOptions, snippet: string, signal?: AbortSignal): Promise<Pick<SquareState, 'hardCap' | 'throttlePerMinute'>> {
    const state = prepareSquareBuild(options, snippet);
    if (options.force) {
        await writeSquareFile(location, state, signal);
    } else if (!await createSquareFile(location, state, signal)) {
        throw new InternalSquareError('conflict', `Refusing to overwrite existing square: ${location}\nPass -f to overwrite.`);
    }
    return { hardCap: state.hardCap, ...(state.throttlePerMinute === undefined ? {} : { throttlePerMinute: state.throttlePerMinute }) };
}

export interface DoctorProblem {
    kind: string;
    message: string;
}
export interface DiagnoseResult {
    unfixable?: string;
    migrationRequired?: string;
    problems: DoctorProblem[];
    standingCount?: number;
}
export interface SquareSnapshot {
    readonly state: SquareState;
    readonly revision: number;
}
function requireSquareExtension(location: string): void {
    if (!location.endsWith('.square'))
        throw new SquareError('invalid_args', `Square artifacts must use the .square extension: ${location}`);
}
function storageError(error: unknown, location: string): unknown {
    if (!(error instanceof Error) || error instanceof SquareError || error instanceof InternalSquareError)
        return error;
    if (/unable to open database file|no such file|SQLITE_CANTOPEN/i.test(error.message))
        return new InternalSquareError('not_found', `square file not found: ${location}`);
    if (/not a database|SQLITE_NOTADB/i.test(error.message))
        return invalidArtifact('not a SQLite database.');
    return error;
}
/** Private artifact-boundary connection shared with explicit migration. Never creates a path. */
export function openExistingSquareDatabase(location: string): DatabaseSync {
    requireSquareExtension(location);
    const uri = pathToFileURL(path.resolve(location));
    uri.searchParams.set('mode', 'rw');
    try {
        return new DatabaseSync(uri.href);
    }
    catch (error) {
        throw storageError(error, location);
    }
}
function abort(signal?: AbortSignal): void {
    if (signal?.aborted)
        throw signal.reason ?? new Error('Square artifact operation aborted');
}
function synchronous(value: unknown): void {
    if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as {
        then?: unknown;
    }).then === 'function') {
        void Promise.resolve(value).catch(() => undefined);
        throw new TypeError('Square artifact callbacks must be synchronous.');
    }
}
const readMethods: readonly (keyof SquareRead)[] = [
    'header', 'participant', 'roster', 'attention', 'incomingAttention',
    'activity', 'activityHeads', 'activities', 'activityCount', 'contextIndexes', 'sayOrdinals', 'recentSayTimes',
    'audience', 'directed', 'directedAt', 'directedCount', 'pendingAudience',
    'receipt', 'receiptFacts', 'receiptAssignments', 'lease', 'participantCounts', 'seat', 'seatsForOwner',
    'deliveryEvidence', 'deliveryByToken', 'cancelledThrough', 'deliveryDeferrals',
];
const writeMethods: readonly (keyof LandingWriter)[] = ['applyLanding', 'markSeen', 'putLease', 'removeLease', 'storeSeat', 'removeSeat', 'updateWakeAddress', 'reattachSeat', 'detachSeat', 'cancelThrough', 'claimDelivery', 'prepareDelivery', 'completeDelivery', 'observeNativeDelivery', 'putDeliveryDeferral', 'renewDeliveryDeferral', 'releaseDeliveryDeferral'];
/** One connection, ordered operations, guarded synchronous transaction capabilities. */
export function createArtifactPort(location: string, initial?: SquareState, externalSignal?: AbortSignal): SquareArtifactPort {
    let database: DatabaseSync | undefined;
    let closed = false, inCallback = false;
    let tail: Promise<void> = Promise.resolve();
    const cancel = new AbortController();
    const canonical = initial === undefined ? canonicalPath(location) : Promise.resolve(location);
    if (initial !== undefined) {
        database = new DatabaseSync(':memory:');
        try {
            initializeSqlite(database, initial);
            database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${CURRENT_USER_VERSION}`);
        }
        catch (error) {
            database.close();
            throw error;
        }
    }
    const combined = (signal?: AbortSignal) => AbortSignal.any([cancel.signal, ...(externalSignal ? [externalSignal] : []), ...(signal ? [signal] : [])]);
    const validate = (db: DatabaseSync) => validateSqliteHeader(db, initial === undefined ? location : ':memory:');
    async function connection(signal: AbortSignal): Promise<DatabaseSync> {
        if (database)
            return database;
        location = await canonical;
        abort(signal);
        database = openExistingSquareDatabase(location);
        try {
            await retrySqliteBusy(() => validate(database!), signal);
            database.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
        }
        catch (error) {
            database.close();
            database = undefined;
            throw storageError(error, location);
        }
        return database;
    }
    function queue<T>(operation: (signal: AbortSignal) => Promise<T>, operationSignal: AbortSignal): Promise<T> {
        if (inCallback)
            throw new TypeError('Square artifact operations cannot nest inside a callback.');
        if (closed)
            return Promise.reject(new Error('Square artifact is closed'));
        const result = tail.then(() => {
            abort(operationSignal);
            return operation(operationSignal);
        });
        tail = result.then(() => undefined, () => undefined);
        return result;
    }
    async function transaction<R>(callback: (facts: SquareRead | SquareWrite) => R, write: boolean, signal: AbortSignal, authority?: ArtifactWriteAuthority) {
        const db = await connection(signal);
        return inSqliteTransaction(db, write, () => validate(db), (header) => {
            const driver = createSqliteDriver(db), version = header.revision;
            let active = true, failed = false, failure: unknown;
            function guard<F extends (...args: never[]) => unknown>(fn: F): F {
                return ((...args: never[]) => {
                    if (!active)
                        throw new Error('Square artifact transaction capability expired');
                    abort(signal);
                    if (failed)
                        throw failure;
                    try {
                        return fn(...args);
                    }
                    catch (error) {
                        failed = true;
                        failure = storageError(error, location);
                        throw failure;
                    }
                }) as F;
            }
            const reads = Object.fromEntries(readMethods.map(name => [name, guard(driver[name] as (...args: never[]) => unknown)])) as unknown as SquareRead;
            const writes = Object.fromEntries(writeMethods.map(name => [name, guard(driver[name] as (...args: never[]) => unknown)])) as unknown as LandingWriter;
            const gate = write ? wrapSquareWrite(reads, writes, authority!) : undefined;
            const facts = gate?.facts ?? reads;
            let value: R;
            inCallback = true;
            try {
                value = callback(facts);
                synchronous(value);
                if (!failed) gate?.complete();
            }
            finally {
                inCallback = false;
                active = false;
            }
            if (failed)
                throw failure;
            const changed = write && driver.changed;
            const deliveryChanged = write && driver.deliveryChanged;
            if (changed || deliveryChanged) {
                if (version === Number.MAX_SAFE_INTEGER)
                    throw invalidArtifact('revision cannot advance beyond the safe integer limit.');
                db.prepare('UPDATE square_meta SET revision=revision+?, delivery_revision=delivery_revision+? WHERE id=1').run(Number(changed), Number(deliveryChanged));
            }
            return {
                value, version: version + Number(changed), changed, deliveryChanged
            };
        }, signal);
    }
    const revision: SquareArtifactPort['revision'] = signal => queue(async (s) => {
        const db = await connection(s);
        return inSqliteTransaction(db, false, () => validate(db), (header) => header.revision, s);
    }, combined(signal));
    return {
        read: (select, signal) => queue(async (s) => {
            const { value, version } = await transaction(select, false, s);
            return { value, version };
        }, combined(signal)),
        transactAs: (authority, change, signal) => queue(s => transaction(change as (facts: SquareRead | SquareWrite) => ReturnType<typeof change>, true, s, authority), combined(signal)),
        // Keep the acquired connection and authority, not the cancelled work lifetime. A
        // blocked evidence commit/cleanup gets five seconds, and close still cancels it.
        settleAs: (authority, change) => queue(s => transaction(change as (facts: SquareRead | SquareWrite) => ReturnType<typeof change>, true, s, authority),
            AbortSignal.any([cancel.signal, AbortSignal.timeout(5000)])),
        revision,
        async deliveryRevision(signal) {
            return queue(async (s) => {
                const db = await connection(s);
                return inSqliteTransaction(db, false, () => validate(db), (header) => header.deliveryRevision, s);
            }, combined(signal));
        },
        async claimDelivery(input, signal) {
            return (await this.transactAs({ kind: 'participant', seat: input.seat }, (facts) => (facts as SquareWrite & { claimDelivery(input: DeliveryClaimInput): DeliveryClaimResult }).claimDelivery(input), signal)).value;
        },
        async prepareDelivery(input, signal) {
            return (await this.transactAs({ kind: 'participant', seat: input.seat }, facts => facts.prepareDelivery(input), signal)).value;
        },
        async completeDelivery(input, signal) {
            return (await this.transactAs({ kind: 'participant', seat: input.seat }, facts => facts.completeDelivery(input), signal)).value;
        },
        async cancelDeliveries(seat, through, signal) {
            return (await this.transactAs({ kind: 'participant', seat }, facts => {
                const boundary = through ?? facts.header().lastActIndex;
                return boundary < 0 ? false : facts.cancelThrough(seat, boundary);
            }, signal)).value;
        },
        async changed(since, timeout, signal) {
            if (inCallback)
                throw new TypeError('Square artifact operations cannot nest inside a callback.');
            if (closed)
                return false;
            const s = combined(signal), deadline = Date.now() + Math.max(0, timeout);
            if (initial !== undefined) {
                try {
                    do {
                        if (await revision(s) > since)
                            return true;
                        if (Date.now() >= deadline)
                            return false;
                        await sleep(Math.min(25, deadline - Date.now()), undefined, { signal: s });
                    } while (!closed);
                }
                catch (error) {
                    if (closed)
                        return false;
                    abort(s);
                    throw error;
                }
                return false;
            }
            const observer = await observeSquareRevision(await canonical);
            try {
                return await observer.changed(since, Math.max(0, deadline - Date.now()), s);
            }
            catch (error) {
                if (closed)
                    return false;
                throw error;
            }
            finally {
                observer.close();
            }
        },
        async close() {
            if (inCallback)
                throw new TypeError('Square artifact cannot close inside a callback.');
            if (closed) {
                await tail;
                return;
            }
            closed = true;
            cancel.abort(new Error('Square artifact is closed'));
            await tail;
            database?.close();
            database = undefined;
        },
    };
}
async function temporaryArtifact(location: string): Promise<string> {
    await fs.promises.mkdir(path.dirname(location), { recursive: true });
    const temporary = path.join(path.dirname(location), `.${path.basename(location)}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporary, 'wx');
    await handle.close();
    return temporary;
}
async function initializeFile(location: string, state: SquareState, signal?: AbortSignal): Promise<void> {
    const db = new DatabaseSync(location);
    try {
        db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
        await inSqliteTransaction(db, true, () => { }, () => {
            initializeSqlite(db, state);
            db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${CURRENT_USER_VERSION}`);
        }, signal);
    }
    finally {
        db.close();
    }
    const handle = await fs.promises.open(location, 'r+');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
/** New-format creation; initial authority is accepted only at this explicit boundary. */
export async function createSquareFile(location: string, state: SquareState, signal?: AbortSignal): Promise<boolean> {
    abort(signal);
    location = await canonicalPath(location);
    requireSquareExtension(location);
    const temporary = await temporaryArtifact(location);
    try {
        await initializeFile(temporary, state, signal);
        abort(signal);
        try {
            await fs.promises.link(temporary, location);
            return true;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST')
                return false;
            throw error;
        }
    }
    finally {
        await fs.promises.unlink(temporary).catch(() => undefined);
    }
}
/** Explicit build --force / fixture import, never a runtime state-replacement callback. */
export async function writeSquareFile(location: string, state: SquareState, signal?: AbortSignal): Promise<void> {
    location = await canonicalPath(location);
    if (await createSquareFile(location, state, signal))
        return;
    abort(signal);
    const db = openExistingSquareDatabase(location);
    try {
        await retrySqliteBusy(() => validateSqliteHeader(db, location), signal);
        db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
        await inSqliteTransaction(db, true, () => validateSqliteHeader(db, location), () => {
            const revision = createSqliteDriver(db).header().revision;
            if (revision === Number.MAX_SAFE_INTEGER)
                throw invalidArtifact('revision cannot advance beyond the safe integer limit.');
            for (const table of ['landed_audience', 'attention', 'participants', 'delivery_deferrals', 'delivery_cancellations', 'delivery_evidence', 'seats', 'catch_leases', 'receipts', 'activities', 'square_meta'])
                db.exec(`DROP TABLE ${table}`);
            initializeSqlite(db, state, revision + 1);
        }, signal);
    }
    finally {
        db.close();
    }
}
async function inspectFile<R>(location: string, select: (db: DatabaseSync) => R, signal?: AbortSignal): Promise<R> {
    const db = openExistingSquareDatabase(location);
    try {
        return await inSqliteTransaction(db, false, () => validateSqliteHeader(db, location), () => select(db), signal);
    }
    catch (error) {
        throw storageError(error, location);
    }
    finally {
        db.close();
    }
}
/** Explicit test/export projection. Hot callers must use the typed port. */
export function readSquareSnapshot(location: string, signal?: AbortSignal): Promise<SquareSnapshot> {
    return inspectFile(location, db => ({ state: exportSqliteState(db), revision: createSqliteDriver(db).header().revision }), signal);
}
export function readSquareRevision(location: string, signal?: AbortSignal): Promise<number> {
    return inspectFile(location, db => createSqliteDriver(db).header().revision, signal);
}
export function observeSquareRevision(location: string): Promise<import('./file-changes.js').VersionObserver<number | null>> {
    return observeFileVersion(location, 'square-revision', async (file, signal) => {
        try {
            return await readSquareRevision(file, signal);
        }
        catch (error) {
            abort(signal);
            if (error instanceof InternalSquareError && error.code === 'not_found')
                return null;
            throw error;
        }
    });
}
export function readSquareDeliveryRevision(location: string, signal?: AbortSignal): Promise<number> {
    return inspectFile(location, db => createSqliteDriver(db).header().deliveryRevision, signal);
}
export function observeSquareDeliveryRevision(location: string): Promise<import('./file-changes.js').VersionObserver<number | null>> {
    return observeFileVersion(location, 'square-delivery-revision', async (file, signal) => {
        try {
            return await readSquareDeliveryRevision(file, signal);
        }
        catch (error) {
            abort(signal);
            if (error instanceof InternalSquareError && error.code === 'not_found') return null;
            throw error;
        }
    });
}
export async function diagnoseSquareFile(location: string): Promise<DiagnoseResult> {
    try {
        return { problems: [], ...await inspectFile(await canonicalPath(location), inspectSqlite) };
    }
    catch (error) {
        if (error instanceof SquareError && error.facts?.reason === 'migration_required')
            return { migrationRequired: error.message, problems: [] };
        return { unfixable: error instanceof Error ? error.message : String(error), problems: [] };
    }
}
