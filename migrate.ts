import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { abort, openExistingSquareDatabase, storageError } from './artifact-store.js';
import { squareLocation } from './square-location.js';
import { checkControl } from './operation-control.js';
import type { OperationControl, SquareLocation } from './square-facade.js';
import { inSqliteTransaction, retrySqliteBusy } from './sqlite-transaction.js';
import { validateSchema, STORAGE_META_SQL } from './sqlite-framing.js';
import { AGORA_SCHEMA_SQL, APPLICATION_ID, createSqliteDriver, validateWatchLease } from './square-sqlite.js';
import { producerSchemaSql } from './square-producer-sqlite.js';
import { validateActivityMetadata, isWakeRouteKind } from './model.js';
import { validateEndpointGeneration } from './message.js';
import { validateMetadataMatch } from './delivery-deferral.js';
import { decoded, finite, integer, json, key, object, requireFact, shape, string, type Row } from './sqlite-values.js';

/** Exact a6cf8c22 Format12 framing. This is a single offline edge, never a runtime reader. */
const FORMAT12_SQL = `CREATE TABLE storage_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  delivery_revision INTEGER NOT NULL CHECK (delivery_revision BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE square_notices (
  notice_index INTEGER PRIMARY KEY CHECK (notice_index >= 0), at REAL NOT NULL,
  sender_json TEXT NOT NULL, body_json TEXT NOT NULL, metadata_json TEXT
);
CREATE TABLE notice_audience (
  notice_index INTEGER NOT NULL, recipient_key_json TEXT NOT NULL, recipient_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation_json TEXT NOT NULL, consumed_at REAL,
  PRIMARY KEY (notice_index,recipient_key_json)
) WITHOUT ROWID;
CREATE TABLE producer_consumption (
  recipient_key_json TEXT NOT NULL, owner_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  sender_json TEXT NOT NULL, match_json TEXT NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (recipient_key_json,generation_json,sender_json,match_json)
) WITHOUT ROWID;
CREATE TABLE square_posts (
  kind TEXT NOT NULL CHECK (kind IN ('activity','notice')), item_index INTEGER NOT NULL,
  recipient_key_json TEXT NOT NULL, token TEXT UNIQUE, owner_pid INTEGER,
  first_export_at REAL NOT NULL, claim_at REAL NOT NULL,
  posted INTEGER NOT NULL DEFAULT 0 CHECK (posted IN (0,1)), full INTEGER CHECK (full IN (0,1)),
  PRIMARY KEY (kind,item_index,recipient_key_json)
) WITHOUT ROWID;
CREATE TABLE square_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_act_index INTEGER NOT NULL CHECK (next_act_index BETWEEN 0 AND 9007199254740991),
  hard_cap INTEGER CHECK (hard_cap BETWEEN 1 AND 9007199254740991),
  throttle_per_minute INTEGER CHECK (throttle_per_minute BETWEEN 1 AND 9007199254740991),
  preamble_json TEXT NOT NULL CHECK (json_valid(preamble_json)),
  warmup_json TEXT NOT NULL CHECK (json_valid(warmup_json))
);
CREATE TABLE activities (
  act_index INTEGER PRIMARY KEY CHECK (act_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('join','done','say','read','listen','ignore','unlisten')),
  actor_json TEXT COLLATE BINARY NOT NULL,
  actor_key_json TEXT COLLATE BINARY NOT NULL,
  reach TEXT CHECK (reach = 'bell'),
  reply_index INTEGER CHECK (reply_index >= 0 AND reply_index < act_index),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK (kind = 'say' OR (reach IS NULL AND reply_index IS NULL))
);
CREATE INDEX activity_kind_index ON activities(kind, act_index);
CREATE INDEX activity_actor_index ON activities(actor_key_json, act_index);
CREATE INDEX activity_say_actor_index ON activities(actor_key_json, act_index) WHERE kind='say';
CREATE INDEX activity_say_time ON activities(at, act_index) WHERE kind='say';
CREATE INDEX activity_bell_actor_time ON activities(actor_key_json, at, act_index) WHERE kind='say' AND reach='bell';
CREATE TABLE participants (
  name_key_json TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  name_json TEXT NOT NULL,
  first_index INTEGER NOT NULL UNIQUE,
  joined INTEGER NOT NULL CHECK (joined IN (0,1)),
  done INTEGER NOT NULL CHECK (done IN (0,1)),
  say_count INTEGER NOT NULL CHECK (say_count >= 0),
  last_active_at REAL,
  last_join_index INTEGER,
  CHECK (NOT (joined=1 AND done=1))
) WITHOUT ROWID;
CREATE TABLE attention (
  listener_key_json TEXT COLLATE BINARY NOT NULL,
  target_key_json TEXT COLLATE BINARY NOT NULL,
  target_json TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('listen','ignore')),
  since_index INTEGER NOT NULL,
  PRIMARY KEY (listener_key_json, target_key_json)
) WITHOUT ROWID;
CREATE INDEX attention_target ON attention(target_key_json, kind, listener_key_json);
CREATE TABLE landed_audience (
  act_index INTEGER NOT NULL,
  recipient_key_json TEXT COLLATE BINARY NOT NULL,
  recipient_order INTEGER NOT NULL CHECK (recipient_order >= 0),
  reason TEXT NOT NULL CHECK (reason IN ('mention','reply','attention','bell')),
  owner_json TEXT,
  generation_json TEXT,
  PRIMARY KEY (act_index, recipient_key_json),
  UNIQUE (act_index, recipient_order)
) WITHOUT ROWID;
CREATE INDEX audience_recipient ON landed_audience(recipient_key_json, act_index);
CREATE TABLE participant_seats (
  participant_key_json TEXT PRIMARY KEY NOT NULL, participant_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  wake_address_json TEXT, attachment TEXT NOT NULL CHECK (attachment IN ('attached','detached'))
) WITHOUT ROWID;
CREATE INDEX participant_seat_owner ON participant_seats(owner_json);
CREATE TABLE caught_activity (
  recipient_key_json TEXT NOT NULL, act_index INTEGER NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (recipient_key_json,act_index)
) WITHOUT ROWID;
CREATE TABLE catch_leases (
  recipient_key_json TEXT PRIMARY KEY NOT NULL, generation_json TEXT NOT NULL,
  lease_json TEXT NOT NULL CHECK (json_valid(lease_json))
) WITHOUT ROWID;`;

const ADD_TABLES_SQL = `CREATE TABLE producer_receipt_watermarks (
  owner_json TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID;
CREATE TABLE producer_departures (
  participant_key_json TEXT NOT NULL, participant_json TEXT NOT NULL, owner_json TEXT NOT NULL, generation_json TEXT NOT NULL, token TEXT NOT NULL,
  PRIMARY KEY (owner_json,generation_json,participant_key_json)
) WITHOUT ROWID;`;

/** Concrete result; migration never resolves or opens a host delivery ledger. */
export interface MigrateSquareResult {
  readonly location: string;
  readonly fromVersion: 12 | 13;
  readonly toVersion: 13;
  readonly changed: boolean;
}

/** Validate every logical row, including facts hidden by runtime joins/filters. */
function validateContents(db: DatabaseSync, version: 12 | 13, signal?: AbortSignal): void {
  const rows = (sql: string) => db.prepare(sql).all() as Row[];
  const each = (table: string, validate: (row: Row) => void) => {
    for (const row of db.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<Row>) { abort(signal); validate(row); }
  };
  const name = (value: unknown) => decoded(value, true);
  const nameKey = (value: unknown) => { const n = name(value); requireFact(key(n) === value); };
  const generation = (value: unknown) => validateEndpointGeneration(decoded(value, true));
  const identity = (r: Row) => {
    requireFact(key(name(r.participant_json)) === r.participant_key_json);
    decoded(r.owner_json, true); generation(r.generation_json);
  };
  const d = createSqliteDriver(db);
  d.header(); d.roster();
  each('activities', r => { d.activity(integer(r.act_index)); });
  each('participants', r => { name(r.name_json); });
  each('attention', r => {
    nameKey(r.listener_key_json); requireFact(key(name(r.target_json)) === r.target_key_json);
    integer(r.since_index); requireFact(r.kind === 'listen' || r.kind === 'ignore');
  });
  each('participant_seats', r => {
    identity(r); requireFact(r.attachment === 'attached' || r.attachment === 'detached');
    if (r.wake_address_json !== null) {
      const w = shape(json(r.wake_address_json), ['kind', 'address']);
      requireFact(isWakeRouteKind(w.kind));
      Object.values(object(w.address)).forEach(v => string(v));
    }
  });
  each('landed_audience', r => {
    integer(r.act_index); nameKey(r.recipient_key_json); integer(r.recipient_order);
    requireFact(['mention', 'reply', 'attention', 'bell'].includes(string(r.reason)));
    // A half-captured address is allowed, but never supplies a departure identity.
    if (r.owner_json !== null) decoded(r.owner_json, true);
    if (r.generation_json !== null) generation(r.generation_json);
  });
  each('caught_activity', r => { nameKey(r.recipient_key_json); integer(r.act_index); finite(r.at); });
  each('catch_leases', r => { nameKey(r.recipient_key_json); generation(r.generation_json); validateWatchLease(json(r.lease_json)); });
  each('square_notices', r => {
    integer(r.notice_index); finite(r.at); name(r.sender_json);
    decoded(r.body_json);
    if (r.metadata_json !== null) validateActivityMetadata(json(r.metadata_json));
  });
  each('notice_audience', r => {
    integer(r.notice_index); requireFact(key(name(r.recipient_json)) === r.recipient_key_json);
    decoded(r.owner_json, true); generation(r.generation_json);
    if (r.consumed_at !== null) finite(r.consumed_at);
  });
  each('producer_consumption', r => {
    nameKey(r.recipient_key_json); decoded(r.owner_json, true); generation(r.generation_json);
    nameKey(r.sender_json); validateMetadataMatch(json(r.match_json)); finite(r.at);
  });
  each('square_posts', r => {
    requireFact(r.kind === 'activity' || r.kind === 'notice'); integer(r.item_index); nameKey(r.recipient_key_json);
    finite(r.first_export_at); finite(r.claim_at);
    requireFact(r.posted === 0 || r.posted === 1); requireFact(r.full === null || r.full === 0 || r.full === 1);
    if (r.token === null) requireFact(r.owner_pid === null);
    else { string(r.token, true); integer(r.owner_pid, 1); requireFact(r.posted === 0); }
  });
  // Producer work must retain its source identity; imported Agora observations and
  // leases may name dormant/unknown participants and are validated above as stored.
  for (const [table, joins, missing] of [
    ['participant_seats s', 'participants p ON p.name_key_json=s.participant_key_json', 'p.name_key_json IS NULL'],
    ['attention t', 'participants p ON p.name_key_json=t.listener_key_json', 'p.name_key_json IS NULL'],
    ['landed_audience d', 'activities a ON a.act_index=d.act_index LEFT JOIN participants p ON p.name_key_json=d.recipient_key_json', "a.act_index IS NULL OR a.kind<>'say' OR p.name_key_json IS NULL"],
    ['notice_audience a', 'square_notices n ON n.notice_index=a.notice_index', 'n.notice_index IS NULL'],
  ]) requireFact(rows(`SELECT 1 FROM ${table} LEFT JOIN ${joins} WHERE ${missing} LIMIT 1`).length === 0, 'orphaned logical row.');
  requireFact(rows(`SELECT 1 FROM square_posts x WHERE NOT (
    x.kind='activity' AND EXISTS (SELECT 1 FROM landed_audience d WHERE d.act_index=x.item_index AND d.recipient_key_json=x.recipient_key_json AND d.owner_json IS NOT NULL AND d.generation_json IS NOT NULL)
    OR x.kind='notice' AND EXISTS (SELECT 1 FROM notice_audience a WHERE a.notice_index=x.item_index AND a.recipient_key_json=x.recipient_key_json)
  ) LIMIT 1`).length === 0, 'orphaned producer post.');
  if (version === 13) {
    each('producer_receipt_watermarks', r => { decoded(r.owner_json, true); integer(r.seq); });
    each('producer_departures', r => { identity(r); string(r.token, true); });
  }
}

function validate(db: DatabaseSync, location: string, signal?: AbortSignal): 12 | 13 {
  abort(signal);
  const r = db.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as Row;
  requireFact(r.application_id === APPLICATION_ID, 'unrelated SQLite database.');
  requireFact(r.user_version === 12 || r.user_version === 13, 'offline migration supports only format 12 to 13.');
  const version = r.user_version;
  validateSchema(db, version === 12 ? FORMAT12_SQL : [STORAGE_META_SQL, producerSchemaSql, AGORA_SCHEMA_SQL].join('\n'), location);
  const check = db.prepare('PRAGMA integrity_check').all() as Row[];
  requireFact(check.length === 1 && check[0].integrity_check === 'ok', 'SQLite integrity check failed.');
  validateContents(db, version, signal);
  return version;
}

function backfillDepartures(db: DatabaseSync, signal?: AbortSignal): void {
  const captured = db.prepare(`WITH captured(participant_key_json,participant_json,owner_json,generation_json) AS (
    SELECT d.recipient_key_json,p.name_json,d.owner_json,d.generation_json
      FROM landed_audience d JOIN activities a ON a.act_index=d.act_index
      JOIN participants p ON p.name_key_json=d.recipient_key_json
      WHERE d.owner_json IS NOT NULL AND d.generation_json IS NOT NULL
    UNION
    SELECT a.recipient_key_json,a.recipient_json,a.owner_json,a.generation_json
      FROM notice_audience a JOIN square_notices n ON n.notice_index=a.notice_index
    UNION
    SELECT participant_key_json,participant_json,owner_json,generation_json FROM participant_seats
  ) SELECT c.* FROM captured c WHERE NOT EXISTS (
    SELECT 1 FROM participant_seats s JOIN participants p ON p.name_key_json=s.participant_key_json
      WHERE p.joined=1 AND s.participant_key_json=c.participant_key_json
      AND s.owner_json=c.owner_json AND s.generation_json=c.generation_json
  )`);
  const insert = db.prepare('INSERT INTO producer_departures VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING');
  for (const row of captured.iterate() as Iterable<Row>) {
    abort(signal);
    insert.run(row.participant_key_json, row.participant_json, row.owner_json, row.generation_json, randomUUID());
  }
}

/** Explicit, offline, in-place Format12 -> 13. Stop all old writers before calling. */
export async function migrateSquare(input: SquareLocation, control?: OperationControl): Promise<MigrateSquareResult> {
  checkControl(control);
  const location = squareLocation(input), signal = control?.signal;
  const probe = await retrySqliteBusy(() => openExistingSquareDatabase(location, true), signal);
  let fromVersion: 12 | 13;
  try { fromVersion = await inSqliteTransaction(probe, false, () => validate(probe, location, signal), version => version, signal); }
  catch (error) { throw storageError(error, location); }
  finally { probe.close(); }
  if (fromVersion === 13) return { location, fromVersion, toVersion: 13, changed: false };
  const db = await retrySqliteBusy(() => openExistingSquareDatabase(location), signal);
  let begun = false;
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL');
    await retrySqliteBusy(() => { db.exec('BEGIN EXCLUSIVE'); begun = true; }, signal);
    // Another migration or writer may have committed since the read-only snapshot.
    fromVersion = validate(db, location, signal);
    if (fromVersion === 12) {
      // Only the two new tables; old tables, revisions and claim custody stay untouched.
      db.exec(ADD_TABLES_SQL);
      backfillDepartures(db, signal);
      db.exec('PRAGMA user_version=13');
      validate(db, location, signal);
    }
    await retrySqliteBusy(() => db.exec('COMMIT'), signal);
    begun = false;
    return { location, fromVersion, toVersion: 13, changed: fromVersion === 12 };
  } catch (error) {
    if (begun) { try { db.exec('ROLLBACK'); } catch { /* retain the original failure */ } }
    throw storageError(error, location);
  } finally { db.close(); }
}
