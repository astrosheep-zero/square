import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nameKey } from './model.js';
import { inSqliteTransaction, retrySqliteBusy } from './sqlite-transaction.js';
import type { PresenceRecord, PresenceLookup, EvidenceRecord, EvidenceLookup, NativeTokenLookup, NativeTokenResult } from './host-ledger.js';

export const LEDGER_FILENAME = 'host-ledger.sqlite';
export const LEDGER_APPLICATION_ID = 0x5351484c;
export const LEDGER_VERSION = 2;
export const LEDGER_RETENTION = 7 * 86400000;
type Kind = 'presence' | 'evidence';
type RecordRow = Record<string, unknown>;
export interface Stored<T> { readonly seq: number; readonly record: T }
const tables = { presence: 'host_presence', evidence: 'host_evidence' } as const;
const columns = {
  presence: ['location_key', 'participant_key', 'session_key', 'channel_key', 'effective_at'],
  evidence: ['location_key', 'participant_key', 'session_key', 'activity_key', 'kind', 'outcome', 'claim_token_key', 'effective_at'],
} as const;
const indexes = {
  host_presence_identity: ['host_presence', 'location_key', 'participant_key', 'seq'],
  host_presence_session: ['host_presence', 'session_key', 'seq'],
  host_presence_time: ['host_presence', 'effective_at'],
  host_evidence_attention: ['host_evidence', 'location_key', 'participant_key', 'activity_key', 'kind', 'session_key', 'seq'],
  host_evidence_kind_session: ['host_evidence', 'kind', 'session_key', 'seq'],
  host_evidence_session: ['host_evidence', 'session_key', 'seq'],
  host_evidence_token: ['host_evidence', 'location_key', 'participant_key', 'activity_key', 'session_key', 'claim_token_key', 'seq'],
  host_evidence_outcome_time: ['host_evidence', 'outcome', 'effective_at'],
  host_evidence_time: ['host_evidence', 'effective_at'],
  host_evidence_native_token: ['host_evidence', 'session_key', 'claim_token_key', 'seq'],
} as const;
const tableSchema = {
  host_meta: 'CREATE TABLE host_meta (id INTEGER PRIMARY KEY CHECK(id=1), presence_revision INTEGER NOT NULL, evidence_revision INTEGER NOT NULL)',
  host_presence: 'CREATE TABLE host_presence (seq INTEGER PRIMARY KEY AUTOINCREMENT, location_key TEXT NOT NULL, participant_key TEXT NOT NULL, session_key TEXT NOT NULL, channel_key TEXT NOT NULL, effective_at REAL NOT NULL, row_json TEXT NOT NULL)',
  host_evidence: 'CREATE TABLE host_evidence (seq INTEGER PRIMARY KEY AUTOINCREMENT, location_key TEXT NOT NULL, participant_key TEXT NOT NULL, session_key TEXT NOT NULL, activity_key TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, claim_token_key TEXT, effective_at REAL NOT NULL, row_json TEXT NOT NULL)',
  host_native_tokens: "CREATE TABLE host_native_tokens (harness TEXT NOT NULL CHECK(harness='claude'), session_key TEXT NOT NULL, token_key TEXT NOT NULL, PRIMARY KEY(harness,session_key,token_key)) WITHOUT ROWID",
};
const versionTwoNames = new Set(['host_native_tokens', 'host_evidence_native_token']);
const retainedEvidence = "(kind='wake' AND (outcome IN ('accepted','unknown','dispatching') OR COALESCE(json_extract(row_json,'$.nativeDelivery.harness'),'')='claude'))";
function validToken(token: unknown): token is string { return typeof token === 'string' && /^[a-zA-Z0-9-]+$/.test(token); }
function indexSql(name: string, [table, ...fields]: readonly string[]): string {
  return `CREATE INDEX ${name} ON ${table} (${fields.join(',')})`;
}
function invalid(message: string): Error { return new Error(`Invalid host ledger: ${message}`); }
function key(value: string): string { return JSON.stringify(value); }
/** The complete record remains authority; these are only reproducible lookup projections. */
export function ledgerRecordColumns(kind: Kind, input: object): Record<string, SQLInputValue> {
  const row = input as RecordRow;
  if (!row || Array.isArray(row) || row.v !== 1) throw invalid('record version');
  for (const field of ['location', 'participant', 'session', ...(kind === 'presence' ? ['channel'] : ['activity', 'kind', 'outcome'])]) {
    if (typeof row[field] !== 'string') throw invalid(`record ${field}`);
  }
  if (kind === 'evidence' && row.claimToken !== undefined && typeof row.claimToken !== 'string') throw invalid('record claimToken');
  const at = row.at ?? row.updatedAt;
  if (typeof at !== 'number' || !Number.isFinite(at)) throw invalid('record time');
  return {
    location_key: key(row.location as string), participant_key: key(nameKey(row.participant as string)), session_key: key(row.session as string),
    ...(kind === 'presence' ? { channel_key: key(row.channel as string) } : {
      activity_key: key(row.activity as string), kind: row.kind as string, outcome: row.outcome as string,
      claim_token_key: row.claimToken === undefined ? null : key(row.claimToken as string),
    }), effective_at: at,
  };
}
export function initializeLedger(db: DatabaseSync): void {
  db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    PRAGMA application_id=${LEDGER_APPLICATION_ID}; PRAGMA user_version=${LEDGER_VERSION};`);
  initializeLedgerSchema(db);
}
export function setLedgerRevisions(db: DatabaseSync, revisions: { presence: number; evidence: number }): void {
  if (![revisions.presence, revisions.evidence].every((n) => Number.isSafeInteger(n) && n >= 0)) throw invalid('revisions');
  db.prepare('UPDATE host_meta SET presence_revision=?,evidence_revision=? WHERE id=1').run(revisions.presence, revisions.evidence);
}
export function insertLedgerRecord(db: DatabaseSync, kind: Kind, row: object): void {
  const derived = ledgerRecordColumns(kind, row);
  db.prepare(`INSERT INTO ${tables[kind]} (${columns[kind].join(',')},row_json) VALUES (${columns[kind].map(() => '?').join(',')},?)`)
    .run(...columns[kind].map((column) => derived[column]), JSON.stringify(row));
}
export function ledgerRevisions(db: DatabaseSync): { presence: number; evidence: number } {
  const rows = db.prepare('SELECT id,presence_revision,evidence_revision FROM host_meta').all();
  if (rows.length !== 1 || rows[0].id !== 1 || ![rows[0].presence_revision, rows[0].evidence_revision].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) throw invalid('revisions');
  return { presence: rows[0].presence_revision as number, evidence: rows[0].evidence_revision as number };
}
export function validateLedger(db: DatabaseSync): void { validateLedgerAtVersion(db, LEDGER_VERSION); }
function validateLedgerAtVersion(db: DatabaseSync, version: number): void {
  validateLedgerHeader(db, version);
  if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete') throw invalid('journal mode');
  const expected = new Map<string, string>([...Object.entries(tableSchema), ...Object.entries(indexes).map(([name, fields]) => [name, indexSql(name, fields)] as [string, string])].filter(([name]) => version >= 2 || !versionTwoNames.has(name)));
  const schema = db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const normalize = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '');
  if (schema.length !== expected.size || schema.some((row) => typeof row.sql !== 'string' || !expected.has(row.name as string) || normalize(row.sql) !== normalize(expected.get(row.name as string)!))) throw invalid('schema or indexes');
  ledgerRevisions(db);
}
export function verifyLedger(db: DatabaseSync): { presence: number; evidence: number; presenceRevision: number; evidenceRevision: number } {
  return verifyLedgerAtVersion(db, LEDGER_VERSION);
}
function verifyLedgerAtVersion(db: DatabaseSync, version: number): ReturnType<typeof verifyLedger> {
  validateLedgerAtVersion(db, version);
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw invalid('integrity check failed');
  const counts = { presence: 0, evidence: 0 };
  for (const kind of ['presence', 'evidence'] as const) {
    for (const stored of db.prepare(`SELECT * FROM ${tables[kind]} ORDER BY seq ASC`).iterate()) {
      let row: RecordRow;
      try { row = JSON.parse(stored.row_json as string) as RecordRow; } catch { throw invalid('record JSON'); }
      const derived = ledgerRecordColumns(kind, row);
      if (!Number.isSafeInteger(stored.seq) || (stored.seq as number) < 1 || columns[kind].some((column) => stored[column] !== derived[column])) throw invalid('record projections');
      counts[kind] += 1;
    }
  }
  if (version >= 2) {
    for (const row of db.prepare('SELECT harness,session_key,token_key FROM host_native_tokens').iterate()) {
      try {
        const session = JSON.parse(row.session_key as string), token = JSON.parse(row.token_key as string);
        if (row.harness !== 'claude' || typeof session !== 'string' || !session.length || !validToken(token)
          || key(session) !== row.session_key || key(token) !== row.token_key) throw invalid('native token codec');
      } catch { throw invalid('native token codec'); }
    }
  }
  const revision = ledgerRevisions(db);
  if ((counts.presence && !revision.presence) || (counts.evidence && !revision.evidence)) throw invalid('records without revision');
  return { ...counts, presenceRevision: revision.presence, evidenceRevision: revision.evidence };
}
/** Explicit offline migration only; the caller owns the write transaction. Preserve all records and revisions. */
export function upgradeLedger(db: DatabaseSync): boolean {
  if (db.prepare('PRAGMA user_version').get()?.user_version === LEDGER_VERSION) { verifyLedger(db); return false; }
  verifyLedgerAtVersion(db, 1);
  db.exec(tableSchema.host_native_tokens);
  db.exec(indexSql('host_evidence_native_token', indexes.host_evidence_native_token));
  db.exec(`PRAGMA user_version=${LEDGER_VERSION}`);
  verifyLedger(db);
  return true;
}
function exists(file: string): boolean { try { fs.statSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export function migrationRequired(): Error {
  return new Error('Host ledger conversion required. Stop all ledger users before running:\nsquare ledger migrate');
}
/** Compact runtime framing. Full schema, projections and integrity belong to explicit verify. */
function validateLedgerHeader(db: DatabaseSync, version = LEDGER_VERSION): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== LEDGER_APPLICATION_ID
    || db.prepare('PRAGMA user_version').get()?.user_version !== version) throw invalid('unsupported identity or version. Stop all ledger users before running:\nsquare ledger migrate');
}
/** Publish new empty authority only. Never initialize or replace an existing destination. */
function createEmptyLedger(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  try { fs.writeFileSync(path.join(root, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const temporary = path.join(root, `.host-ledger.${process.pid}.${randomUUID()}.tmp`);
  let db: DatabaseSync | undefined;
  try {
    fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
    db = new DatabaseSync(temporary);
    initializeLedger(db);
    db.close(); db = undefined;
    try { fs.linkSync(temporary, path.join(root, LEDGER_FILENAME)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally {
    db?.close();
    fs.rmSync(temporary, { force: true });
  }
}
/** Never create authority on a read, or silently replace legacy authority on a write. */
async function openLedger(root: string, write: boolean, signal?: AbortSignal): Promise<DatabaseSync | undefined> {
  const file = path.join(root, LEDGER_FILENAME);
  if (!exists(file)) {
    if (exists(path.join(root, 'presence.ndjsonl')) || exists(path.join(root, 'evidence.ndjsonl'))) throw migrationRequired();
    if (!write) return undefined;
    if (signal?.aborted) throw signal.reason;
    createEmptyLedger(root);
  }
  const uri = pathToFileURL(file);
  uri.searchParams.set('mode', write ? 'rw' : 'ro');
  const db = new DatabaseSync(uri.href);
  try {
    await retrySqliteBusy(() => db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL'), signal);
    return db;
  } catch (error) { db.close(); throw error; }
}
function initializeLedgerSchema(db: DatabaseSync): void {
  for (const sql of Object.values(tableSchema)) db.exec(sql);
  db.exec('INSERT INTO host_meta VALUES(1,0,0)');
  for (const [name, fields] of Object.entries(indexes)) db.exec(indexSql(name, fields));
}
function visibility(kind: Kind, now: number, includeFuture: boolean, includeExpired: boolean): { sql: string; args: SQLInputValue[] } {
  const durable = kind === 'evidence' ? ` OR ${retainedEvidence}` : '';
  const sql = includeExpired ? '1' : `(effective_at>=?${durable})`;
  const args: SQLInputValue[] = includeExpired ? [] : [now - LEDGER_RETENTION];
  if (!includeFuture) args.push(now);
  return { sql: `${sql}${includeFuture ? '' : ' AND effective_at<=?'}`, args };
}
/** Transaction-local storage rows; sequence coordinates never cross HostLedgerPort. */
export class LedgerTransaction {
  private readonly changed = new Set<Kind>();
  constructor(private readonly db: DatabaseSync) {}
  presence(input: PresenceLookup & { channel?: string }, now: number, includeFuture = false): Stored<PresenceRecord>[] {
    return this.select('presence', input, now, includeFuture) as Stored<PresenceRecord>[];
  }
  evidence(input: EvidenceLookup & { claimToken?: string }, now: number, includeFuture = false): Stored<EvidenceRecord>[] {
    return this.select('evidence', input, now, includeFuture) as Stored<EvidenceRecord>[];
  }
  private select(kind: Kind, input: PresenceLookup & Partial<EvidenceLookup> & { channel?: string; claimToken?: string }, now: number, includeFuture: boolean): Stored<PresenceRecord | EvidenceRecord>[] {
    const visible = visibility(kind, now, includeFuture, kind === 'evidence' && input.includeExpired === true), where = [visible.sql], args = visible.args;
    for (const [field, column] of Object.entries({ location: 'location_key', participant: 'participant_key', session: 'session_key', ...(kind === 'evidence' ? { activity: 'activity_key', kind: 'kind', claimToken: 'claim_token_key' } : { channel: 'channel_key' }) })) {
      const value = input[field as keyof typeof input];
      if (value !== undefined) { where.push(`${column}=?`); args.push(column === 'kind' ? value as string : key(field === 'participant' ? nameKey(value as string) : value as string)); }
    }
    if (kind === 'evidence' && input.includeReleased !== true) where.push("outcome<>'released'");
    return this.db.prepare(`SELECT seq,row_json FROM ${tables[kind]} WHERE ${where.join(' AND ')} ORDER BY seq ASC`).all(...args).map((stored) => ({ seq: stored.seq as number, record: JSON.parse(stored.row_json as string) as PresenceRecord | EvidenceRecord }));
  }
  /** Both halves of recognition are read in the enclosing SQLite snapshot, with indexed session/token predicates. */
  nativeTokens(input: NativeTokenLookup): NativeTokenResult {
    const tokens = [...new Set(input.tokens)], encoded = JSON.stringify(tokens.map(key));
    const deliveries = this.db.prepare("SELECT row_json FROM host_evidence WHERE session_key=? AND claim_token_key IN (SELECT value FROM json_each(?)) AND kind='wake' AND json_extract(row_json,'$.nativeDelivery.harness')='claude' ORDER BY seq ASC")
      .all(key(input.session), encoded).map(row => JSON.parse(row.row_json as string) as EvidenceRecord);
    const retired = new Set(this.db.prepare('SELECT token_key FROM host_native_tokens WHERE harness=? AND session_key=? AND token_key IN (SELECT value FROM json_each(?))')
      .all(input.harness, key(input.session), encoded).map(row => row.token_key as string));
    return { deliveries, retired: tokens.filter(token => retired.has(key(token))) };
  }
  /** Called only after exact-record CAS. No housekeeping of unrelated rows belongs here. */
  retireEvidence(row: Stored<EvidenceRecord>): boolean {
    const record = row.record;
    if (record.outcome === 'dispatching') return false;
    if (record.nativeDelivery?.harness === 'claude') {
      const native = record.nativeDelivery;
      if (!record.session || !validToken(record.claimToken) || typeof native.payload !== 'string' || !native.payload.length
        || typeof native.endpoint !== 'string' || !native.endpoint.length || !Number.isSafeInteger(native.epoch) || native.epoch < 0) return false;
      this.db.prepare("INSERT OR IGNORE INTO host_native_tokens(harness,session_key,token_key) VALUES('claude',?,?)")
        .run(key(record.session), key(record.claimToken));
    }
    this.remove('evidence', [row]);
    return true;
  }
  insert(kind: Kind, row: object): void { insertLedgerRecord(this.db, kind, row); this.changed.add(kind); }
  replace(kind: Kind, seq: number, row: object): void {
    const derived = ledgerRecordColumns(kind, row);
    const result = this.db.prepare(`UPDATE ${tables[kind]} SET ${columns[kind].map((column) => `${column}=?`).join(',')},row_json=? WHERE seq=?`).run(...columns[kind].map((column) => derived[column]), JSON.stringify(row), seq);
    if (result.changes) this.changed.add(kind);
  }
  remove(kind: Kind, rows: readonly Stored<unknown>[]): void {
    const statement = this.db.prepare(`DELETE FROM ${tables[kind]} WHERE seq=?`);
    for (const row of rows) if (statement.run(row.seq).changes) this.changed.add(kind);
  }
  /** Only invoke at the point where the former implementation published a mutation. */
  publish(kind: Kind, now: number): void {
    const durable = kind === 'evidence' ? ` AND NOT ${retainedEvidence}` : '';
    if (this.db.prepare(`DELETE FROM ${tables[kind]} WHERE effective_at<?${durable}`).run(now - LEDGER_RETENTION).changes) this.changed.add(kind);
  }
  commitRevisions(): void {
    for (const kind of this.changed) this.db.exec(`UPDATE host_meta SET ${kind}_revision=${kind}_revision+1 WHERE id=1`);
  }
}
export async function withLedger<T>(root: string, write: boolean, select: (rows: LedgerTransaction) => T, absent: T, signal?: AbortSignal): Promise<T> {
  const db = await openLedger(root, write, signal);
  if (!db) return absent;
  try {
    return await inSqliteTransaction(db, write, () => validateLedgerHeader(db), () => {
      const rows = new LedgerTransaction(db), result = select(rows);
      rows.commitRevisions();
      return result;
    }, signal);
  } finally { db.close(); }
}
export async function readLedgerRevisions(root: string, signal?: AbortSignal): Promise<{ presence: number; evidence: number } | undefined> {
  const db = await openLedger(root, false, signal);
  if (!db) return undefined;
  try { return await inSqliteTransaction(db, false, () => validateLedgerHeader(db), () => ledgerRevisions(db), signal); }
  finally { db.close(); }
}
