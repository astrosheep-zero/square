import path from 'node:path';
import fs from 'node:fs';
import { canonicalPath } from './canonical-path.js';
import { InternalSquareError, SquareError, type BuildOptions } from './model.js';
import type { SquareArtifactPort, SquareRead, SquareWrite, ArtifactWriteAuthority } from './ports.js';
import { wrapSquareWrite, type LandingWriter } from './square-domain.js';
import { createSqliteDriver, initializeSqlite, exportSqliteState, inspectSqlite, emptyRuntimeState, squareStoreFormat, type SquareState } from './square-sqlite.js';
import { resetStorageMeta } from './sqlite-framing.js';
import { createArtifactStore, createStoreFile, replaceStoreFile, inspectStore, observeStoreRevision } from './artifact-store.js';
export { openExistingSquareDatabase } from './artifact-store.js';
const format = squareStoreFormat(resetStorageMeta);
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
export function prepareSquareBuild(options: Omit<BuildOptions, 'force'>, snippet: string, includeGuides = true): SquareState {
    if (options.hardCap !== undefined && options.hardCap !== null
        && (!Number.isSafeInteger(options.hardCap) || options.hardCap < 1))
        throw new SquareError('invalid_args', 'hardCap must be a positive integer or null');
    if (options.throttlePerMinute !== undefined
        && (!Number.isSafeInteger(options.throttlePerMinute) || options.throttlePerMinute < 1))
        throw new SquareError('invalid_args', 'throttlePerMinute must be a positive integer');
    const guides = includeGuides ? [readGuide('participant')] : [];
    if (includeGuides && options.template !== undefined)
        guides.push(readGuide(options.template));
    return {
        hardCap: options.hardCap ?? null,
        ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
        preamble: normalizedLines(snippet), warmup: includeGuides ? normalizedLines(guides.join('\n\n')) : [],
        acts: [], runtime: emptyRuntimeState(),
    };
}
/** File build owns publication and CLI conflict semantics, not host resources. */
export async function createSquare(location: string, options: BuildOptions, snippet: string, signal?: AbortSignal, includeGuides = true): Promise<Pick<SquareState, 'hardCap' | 'throttlePerMinute'>> {
    const state = prepareSquareBuild(options, snippet, includeGuides);
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
    problems: DoctorProblem[];
    standingCount?: number;
}
export interface SquareSnapshot {
    readonly state: SquareState;
    readonly revision: number;
}
const readMethods: readonly (keyof SquareRead)[] = [
    'header', 'participant', 'roster', 'attention', 'incomingAttention',
    'activity', 'activityHeads', 'activities', 'activityCount', 'contextIndexes', 'sayOrdinals', 'recentSayTimes',
    'audience', 'directed', 'directedAt', 'directedCount',
    'receipt', 'receiptFacts', 'lease', 'participantCounts', 'seat', 'seatsForOwner',
    'pendingPosts', 'postedPosts', 'ownsPost',
];
const writeMethods: readonly (keyof LandingWriter)[] = ['applyLanding', 'putLease', 'removeLease', 'storeSeat', 'removeSeat', 'markSeen', 'setSeatAttachment', 'insertNotice', 'ackMatching', 'acquirePost', 'settlePost', 'foldReceipt'];
/** Square social state and producer state share one synchronous artifact transaction. */
export function createArtifactPort(location: string, initial?: SquareState, externalSignal?: AbortSignal): SquareArtifactPort {
    const store = createArtifactStore(location, format, initial === undefined ? undefined : db => initializeSqlite(db, initial, 0), externalSignal);
    function transaction<R>(select: (facts: SquareRead | SquareWrite) => R, write: boolean, authority?: ArtifactWriteAuthority, signal?: AbortSignal, settlement = false) {
        return store.run(write, ({ db, guard, track }) => {
            const driver = createSqliteDriver(db);
            track(driver);
            const reads = Object.fromEntries(readMethods.map(name => [name, guard((driver as unknown as Record<string, (...args: never[]) => unknown>)[name])])) as unknown as SquareRead;
            const writes = Object.fromEntries(writeMethods.map(name => [name, guard((driver as unknown as Record<string, (...args: never[]) => unknown>)[name])])) as unknown as LandingWriter;
            const gate = write ? wrapSquareWrite(reads, writes, authority!) : undefined;
            const value = select(gate?.facts ?? reads);
            gate?.complete();
            return value;
        }, signal, settlement);
    }
    const port: SquareArtifactPort = {
        read: (select, signal) => transaction(select, false, undefined, signal),
        transactAs: (authority, change, signal) => transaction(change as (facts: SquareRead | SquareWrite) => ReturnType<typeof change>, true, authority, signal),
        settleAs: (authority, change) => transaction(change as (facts: SquareRead | SquareWrite) => ReturnType<typeof change>, true, authority, undefined, true),
        revision: store.revision, deliveryRevision: store.deliveryRevision,
        changed: store.changed, close: store.close,
    };
    return port;
}
export function createSquareFile(location: string, state: SquareState, signal?: AbortSignal): Promise<boolean> {
    return createStoreFile(location, format, db => initializeSqlite(db, state, 0), signal);
}
export function writeSquareFile(location: string, state: SquareState, signal?: AbortSignal): Promise<void> {
    return replaceStoreFile(location, format, (db, revision) => initializeSqlite(db, state, revision), signal);
}
export function readSquareSnapshot(location: string, signal?: AbortSignal): Promise<SquareSnapshot> {
    return inspectStore(location, format, db => ({ state: exportSqliteState(db), revision: createSqliteDriver(db).header().revision }), signal);
}
export function readSquareRevision(location: string, signal?: AbortSignal): Promise<number> {
    return inspectStore(location, format, db => createSqliteDriver(db).header().revision, signal);
}
export function readSquareDeliveryRevision(location: string, signal?: AbortSignal): Promise<number> {
    return inspectStore(location, format, db => createSqliteDriver(db).header().deliveryRevision, signal);
}
export const observeSquareRevision = (location: string) => observeStoreRevision(location, format);
export const observeSquareDeliveryRevision = (location: string) => observeStoreRevision(location, format, true);
export async function diagnoseSquareFile(location: string): Promise<DiagnoseResult> {
    try {
        return { problems: [], ...await inspectStore(await canonicalPath(location), format, db => inspectSqlite(db)) };
    }
    catch (error) {
        return { unfixable: error instanceof Error ? error.message : String(error), problems: [] };
    }
}
