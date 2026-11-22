import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkControl, squareLocation, type OperationControl, type SquareLocation } from '../core/neutral.js';
import { inSqliteTransaction, retrySqliteBusy } from '../storage/sqlite-transaction.js';
import { validateSchema } from '../storage/sqlite-framing.js';
import { abort, APPLICATION_ID, createSqliteDriver, FORMAT12_SQUARE_SQL, FORMAT13_SQUARE_SQL, openExistingSquareDatabase, storageError, validateWatchLease } from './square-store.js';
import { FORMAT13_ADDITIONS_SQL } from './square-producer-store.js';
import { validateActivityMetadata, isWakeRouteKind } from '../core/model.js';
import { validateEndpointGeneration } from '../core/message.js';
import { validateMetadataMatch } from '../core/delivery-deferral.js';
import { decoded, finite, integer, json, key, object, requireFact, shape, string, type Row } from '../storage/sqlite-values.js';

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
  d.read.header(); d.read.roster();
  each('activities', r => { d.read.activity(integer(r.act_index)); });
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
  validateSchema(db, version === 12 ? FORMAT12_SQUARE_SQL : FORMAT13_SQUARE_SQL, location);
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
      db.exec(FORMAT13_ADDITIONS_SQL);
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
