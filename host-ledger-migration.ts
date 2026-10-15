import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPathSync } from './canonical-path.js';
import { withFileLock } from './file-lock.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import {
  LEDGER_FILENAME, initializeLedger, insertLedgerRecord, ledgerRecordColumns,
  setLedgerRevisions, validateLedger, verifyLedger,
} from './host-ledger-sqlite.js';
import { inSqliteTransaction } from './sqlite-transaction.js';

type Kind = 'presence' | 'evidence';
export interface LedgerSourceReport { records: number; ignored: number; rejected: number; sha256: string | null }
export interface HostLedgerReport {
  status: 'empty' | 'legacy' | 'sqlite' | 'migrated';
  presence: number;
  evidence: number;
  presenceRevision?: number;
  evidenceRevision?: number;
  sources?: Record<Kind, LedgerSourceReport>;
  ready?: boolean;
}
export interface HostLedgerMaintenanceOptions {
  rootPath?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
function rootFor(options: HostLedgerMaintenanceOptions): string {
  return canonicalPathSync(options.rootPath ?? hostLedgerRoot(options.env));
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Host ledger migration aborted');
}
async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function verifyDatabase(file: string, signal?: AbortSignal): Promise<HostLedgerReport> {
  abort(signal);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const counts = await inSqliteTransaction(db, false, () => validateLedger(db!), () => verifyLedger(db!), signal);
    return { status: 'sqlite', ...counts };
  } catch {
    abort(signal);
    throw new Error('Host ledger database verification failed; destination left untouched.');
  } finally { db?.close(); }
}
interface LegacySource { rows: object[]; report: LedgerSourceReport; firstRejectedLine?: number }
async function readLegacy(root: string, kind: Kind, signal?: AbortSignal): Promise<LegacySource> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(path.join(root, `${kind}.ndjsonl`)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], report: { records: 0, ignored: 0, rejected: 0, sha256: null } };
    throw new Error(`Cannot read legacy ${kind} source.`);
  }
  const rows: object[] = [];
  let ignored = 0, rejected = 0;
  let firstRejectedLine: number | undefined;
  const lines = bytes.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    abort(signal);
    if (lines[index].trim() === '') continue;
    let row: any;
    try { row = JSON.parse(lines[index]); } catch { ignored++; continue; }
    if (row === null || typeof row !== 'object' || row.v !== 1 || typeof (row.at ?? row.updatedAt) !== 'number') {
      ignored++; continue;
    }
    // This compatibility normalization belongs only to the explicit importer.
    if (row.kind === 'wake' && row.outcome === 'unknown' && row.unknownSource === undefined) {
      row = { ...row, unknownSource: row.signature === 'worker_interrupted_during_dispatch' ? 'interrupted' : 'transport' };
    }
    try { ledgerRecordColumns(kind, row); }
    catch { rejected++; firstRejectedLine ??= index + 1; continue; }
    rows.push(row);
  }
  return { rows, firstRejectedLine, report: { records: rows.length, ignored, rejected, sha256: createHash('sha256').update(bytes).digest('hex') } };
}
async function readSources(root: string, signal?: AbortSignal): Promise<Record<Kind, LegacySource>> {
  return { presence: await readLegacy(root, 'presence', signal), evidence: await readLegacy(root, 'evidence', signal) };
}
function sourceReport(sources: Record<Kind, LegacySource>): HostLedgerReport {
  return {
    status: sources.presence.report.sha256 === null && sources.evidence.report.sha256 === null ? 'empty' : 'legacy',
    presence: sources.presence.rows.length, evidence: sources.evidence.rows.length,
    sources: { presence: sources.presence.report, evidence: sources.evidence.report },
    ready: sources.presence.report.rejected === 0 && sources.evidence.report.rejected === 0,
  };
}
/** Read-only readiness/integrity check. Never creates a root, lock, or database. */
export async function verifyHostLedger(options: HostLedgerMaintenanceOptions = {}): Promise<HostLedgerReport> {
  const root = rootFor(options);
  abort(options.signal);
  const destination = path.join(root, LEDGER_FILENAME);
  if (await exists(destination)) return verifyDatabase(destination, options.signal);
  return sourceReport(await readSources(root, options.signal));
}
/** Offline only: locks fence compatible writers, but do not prove hosts have stopped. */
export async function migrateHostLedger(options: HostLedgerMaintenanceOptions = {}): Promise<HostLedgerReport> {
  const root = rootFor(options), signal = options.signal;
  abort(signal);
  const destination = path.join(root, LEDGER_FILENAME);
  if (await exists(destination)) return verifyDatabase(destination, signal);
  if (!await exists(path.join(root, 'presence.ndjsonl')) && !await exists(path.join(root, 'evidence.ndjsonl'))) {
    return { status: 'empty', presence: 0, evidence: 0 };
  }
  const lockOptions = { retryMs: 10, signal };
  return withFileLock(path.join(root, 'presence-claim.lock'), lockOptions, () =>
    withFileLock(path.join(root, 'presence.ndjsonl.lock'), lockOptions, () =>
      withFileLock(path.join(root, 'evidence.ndjsonl.lock'), lockOptions, async (): Promise<HostLedgerReport> => {
        if (await exists(destination)) return verifyDatabase(destination, signal);
        const sources = await readSources(root, signal);
        const report = sourceReport(sources);
        if (!report.ready) {
          const rejected = (['presence', 'evidence'] as const).filter((kind) => sources[kind].report.rejected > 0)
            .map((kind) => `${kind}: ${sources[kind].report.rejected} rejected (first line ${sources[kind].firstRejectedLine})`);
          throw new Error(`Unsafe legacy records; conversion refused. ${rejected.join('; ')}.`);
        }
        const temporary = await fs.mkdtemp(path.join(root, '.host-ledger-migrate-'));
        const file = path.join(temporary, LEDGER_FILENAME);
        let db: DatabaseSync | undefined;
        try {
          abort(signal);
          // The temporary connection remains under the ledger root, including journals.
          await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
          db = new DatabaseSync(file);
          initializeLedger(db);
          await inSqliteTransaction(db, true, () => {}, () => {
            for (const kind of ['presence', 'evidence'] as const) {
              for (const row of sources[kind].rows) { abort(signal); insertLedgerRecord(db!, kind, row); }
            }
            setLedgerRevisions(db!, { presence: report.presence ? 1 : 0, evidence: report.evidence ? 1 : 0 });
          }, signal);
          db.close(); db = undefined;
          const verified = await verifyDatabase(file, signal);
          if (verified.presence !== report.presence || verified.evidence !== report.evidence) {
            throw new Error('Host ledger import counts do not match; conversion refused.');
          }
          abort(signal);
          try { await fs.link(file, destination); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') return await verifyDatabase(destination, signal);
            throw error;
          }
          const directory = await fs.open(root, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
          return { ...verified, status: 'migrated', sources: report.sources };
        } finally {
          db?.close();
          await fs.rm(temporary, { recursive: true, force: true });
        }
      }))).catch((error) => { abort(signal); throw error; });
}
