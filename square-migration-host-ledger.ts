import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalPath } from './canonical-path.js';
import { inSqliteTransaction } from './sqlite-transaction.js';
import { nameKey, validateBody, type Body } from './model.js';

/** Offline conversion input only; never a runtime ownership or evidence reader. */
export interface LegacyOwner {
  readonly participant: string;
  readonly body: Body;
}
export interface LegacyHostData {
  readonly owners: readonly LegacyOwner[];
  readonly evidence: readonly LegacyDeliveryEvidence[];
}
export interface LegacyDeliveryEvidence {
  readonly v: 1;
  readonly location: string;
  readonly participant: string;
  readonly session: string;
  readonly activity: string;
  readonly kind: 'wake' | 'presentation' | 'lifecycle';
  readonly outcome: string;
  readonly at?: number;
  readonly expiresAt?: number;
  readonly attemptN?: number;
  readonly claimToken?: string;
  readonly [key: string]: unknown;
}

const LEDGER_FILENAME = 'host-ledger.sqlite';
const LEDGER_APPLICATION_ID = 0x5351484c;
const LEDGER_VERSION = 2;
const tableSchema = {
  host_meta: 'CREATE TABLE host_meta (id INTEGER PRIMARY KEY CHECK(id=1), presence_revision INTEGER NOT NULL, evidence_revision INTEGER NOT NULL)',
  host_presence: 'CREATE TABLE host_presence (seq INTEGER PRIMARY KEY AUTOINCREMENT, location_key TEXT NOT NULL, participant_key TEXT NOT NULL, session_key TEXT NOT NULL, channel_key TEXT NOT NULL, effective_at REAL NOT NULL, row_json TEXT NOT NULL)',
  host_evidence: 'CREATE TABLE host_evidence (seq INTEGER PRIMARY KEY AUTOINCREMENT, location_key TEXT NOT NULL, participant_key TEXT NOT NULL, session_key TEXT NOT NULL, activity_key TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, claim_token_key TEXT, effective_at REAL NOT NULL, row_json TEXT NOT NULL)',
  host_native_tokens: "CREATE TABLE host_native_tokens (harness TEXT NOT NULL CHECK(harness='claude'), session_key TEXT NOT NULL, token_key TEXT NOT NULL, PRIMARY KEY(harness,session_key,token_key)) WITHOUT ROWID",
};
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

const LEGACY_FILES = ['presence.ndjsonl', 'evidence.ndjsonl'] as const;

function indexSql(name: string, fields: readonly string[]): string {
  return `CREATE INDEX ${name} ON ${fields[0]} (${fields.slice(1).join(',')})`;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/g, '').replace(/;$/, '');
}

function recordKey(value: string): string { return JSON.stringify(value); }

function validateLedger(database: DatabaseSync): void {
  const application = (database.prepare('PRAGMA application_id').get() as { application_id?: unknown }).application_id;
  const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version;
  if (application !== LEDGER_APPLICATION_ID || version !== LEDGER_VERSION) throw invalid('unsupported format.');
  if ((database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode !== 'delete') throw invalid('unsupported journal mode.');
  const expected = new Map<string, string>([
    ...Object.entries(tableSchema),
    ...Object.entries(indexes).map(([name, fields]) => [name, indexSql(name, fields)] as const),
  ]);
  const schema = database.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as { name?: unknown; sql?: unknown }[];
  if (schema.length !== expected.size || schema.some((row) => typeof row.name !== 'string' || typeof row.sql !== 'string'
    || !expected.has(row.name) || normalizedSql(row.sql) !== normalizedSql(expected.get(row.name)!))) throw invalid('schema or indexes are malformed.');
  const meta = database.prepare('SELECT id,presence_revision,evidence_revision FROM host_meta').all() as Record<string, unknown>[];
  if (meta.length !== 1 || meta[0].id !== 1 || ![meta[0].presence_revision, meta[0].evidence_revision].every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) throw invalid('revision header is malformed.');
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw invalid('integrity check failed.');
  // Token-only tombstones have no artifact coordinate. Never guess or discard replay protection.
  if (database.prepare('SELECT 1 FROM host_native_tokens LIMIT 1').get() !== undefined)
    throw invalid('native token tombstones cannot be mapped safely; preserve replay protection and resolve the ledger offline.');
}

function ledgerRoot(env: NodeJS.ProcessEnv): string {
  return path.resolve(env.SQUARE_HOST_LEDGER_ROOT
    ?? (env.SQUARE_REGISTRY === undefined ? path.join(env.HOME ?? os.homedir(), '.square', 'host-ledger') : path.dirname(env.SQUARE_REGISTRY)));
}

function invalid(detail: string): Error {
  return new Error(`Invalid legacy host ledger: ${detail}`);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function decodeEvidence(value: unknown): LegacyDeliveryEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('evidence record is not an object.');
  const row = value as Record<string, unknown>;
  if (row.v !== 1 || typeof row.location !== 'string' || typeof row.participant !== 'string' || typeof row.session !== 'string'
    || typeof row.activity !== 'string' || !['wake', 'presentation', 'lifecycle'].includes(row.kind as string)
    || typeof row.outcome !== 'string') throw invalid('evidence record fields are malformed.');
  if (row.at !== undefined && !finite(row.at)) throw invalid('evidence time is malformed.');
  if (row.expiresAt !== undefined && !finite(row.expiresAt)) throw invalid('evidence expiry is malformed.');
  if (row.attemptN !== undefined && (!Number.isSafeInteger(row.attemptN) || (row.attemptN as number) < 0)) throw invalid('evidence attempt is malformed.');
  if (row.claimToken !== undefined && (typeof row.claimToken !== 'string' || row.claimToken.length === 0)) throw invalid('evidence claim token is malformed.');
  return row as LegacyDeliveryEvidence;
}

function record(row: Record<string, unknown>): Record<string, unknown> {
  if (!Number.isSafeInteger(row.seq) || (row.seq as number) < 1 || typeof row.row_json !== 'string') throw invalid('row framing is malformed.');
  let value: unknown;
  try { value = JSON.parse(row.row_json); } catch { throw invalid('record JSON is malformed.'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid('record is not an object.');
  return value as Record<string, unknown>;
}
function projections(row: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)) throw invalid('record projections are malformed.');
}

/** One frozen snapshot, latest owners only; no age, expiry, or ownership history inference. */
export async function readLegacyHostData(location: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<LegacyHostData> {
  if (signal?.aborted) throw signal.reason;
  const root = ledgerRoot(env);
  const file = path.join(root, LEDGER_FILENAME);
  try { await fs.promises.stat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    for (const legacy of LEGACY_FILES) {
      try { await fs.promises.stat(path.join(root, legacy)); throw invalid('legacy line sources require separate host-ledger migration.'); }
      catch (nested) {
        if ((nested as NodeJS.ErrnoException).code !== 'ENOENT') throw nested;
      }
    }
    return { owners: [], evidence: [] };
  }
  const uri = pathToFileURL(file);
  uri.searchParams.set('mode', 'ro');
  const database = new DatabaseSync(uri.href);
  try {
    const canonical = await canonicalPath(location);
    return await inSqliteTransaction(database, false, () => validateLedger(database), () => {
      const owners = (database.prepare(`SELECT * FROM (
        SELECT *,row_number() OVER (PARTITION BY participant_key ORDER BY effective_at DESC,seq DESC) AS ordinal
        FROM host_presence WHERE location_key=?) WHERE ordinal=1`).all(recordKey(canonical)) as Record<string, unknown>[]).map(row => {
        const value = record(row);
        const at = value.at ?? value.updatedAt;
        if (value.v !== 1 || value.location !== canonical || typeof value.participant !== 'string'
          || !finite(at)) throw invalid('owner fields are malformed.');
        const body = { channel: value.channel, session: value.session, ...(value.agent === undefined ? {} : { agent: value.agent }) } as Body;
        validateBody(body);
        projections(row, { location_key: recordKey(canonical), participant_key: recordKey(nameKey(value.participant)),
          channel_key: recordKey(body.channel), session_key: recordKey(body.session), effective_at: at });
        return { participant: value.participant, body };
      });
      const evidence = (database.prepare("SELECT * FROM host_evidence WHERE location_key=? AND kind IN ('wake','presentation') ORDER BY seq").all(recordKey(canonical)) as Record<string, unknown>[]).map(row => {
        const value = decodeEvidence(record(row));
        if (value.location !== canonical || !finite(value.at)) throw invalid('evidence fields are malformed.');
        projections(row, { location_key: recordKey(canonical), participant_key: recordKey(nameKey(value.participant)), session_key: recordKey(value.session),
          activity_key: recordKey(value.activity), kind: value.kind, outcome: value.outcome,
          claim_token_key: value.claimToken === undefined ? null : recordKey(value.claimToken), effective_at: value.at });
        return value;
      });
      return { owners, evidence };
    }, signal);
  } finally { database.close(); }
}
