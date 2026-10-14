import type { DatabaseSync } from 'node:sqlite';

import { inSqliteTransaction, openExistingSquareDatabase } from './artifact.js';
import { canonicalPath } from './canonical-path.js';
import type { SquareState } from './model.js';
import { APPLICATION_ID, createSqliteDriver, initializeSqlite, invalidArtifact, validateSqliteHeader } from './square-sqlite.js';
import { V1_SNAPSHOT_TABLE, validateLegacyFraming, validateSquareState } from './square-state.js';

export interface MigrationCounts {
  readonly activities: number;
  readonly receipts: number;
  readonly leases: number;
  readonly routes: number;
}

export interface MigrationOutcome {
  readonly status: 'migrated' | 'already-format-2';
  /** Participants standing after the conversion, for the CLI header. */
  readonly standing: number;
  readonly counts?: MigrationCounts;
}

function identity(database: DatabaseSync): { applicationId: unknown; userVersion: unknown } {
  const row = database.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as { application_id?: unknown; user_version?: unknown };
  return { applicationId: row.application_id, userVersion: row.user_version };
}

function standing(database: DatabaseSync): number {
  return createSqliteDriver(database).roster().filter((participant) => participant.joined).length;
}

/** The snapshot row, decoded only by the legacy validator. */
function decodeLegacySnapshot(database: DatabaseSync): { revision: number; state: SquareState } {
  const rows = database.prepare(`SELECT id, revision, state FROM ${V1_SNAPSHOT_TABLE}`).all() as { id?: unknown; revision?: unknown; state?: unknown }[];
  if (rows.length !== 1 || rows[0].id !== 1 || !Number.isSafeInteger(rows[0].revision) || (rows[0].revision as number) < 0) throw invalidArtifact('snapshot row is malformed.');
  if (typeof rows[0].state !== 'string') throw invalidArtifact('snapshot state is malformed.');
  let parsed: unknown;
  try { parsed = JSON.parse(rows[0].state); } catch { throw invalidArtifact('snapshot state is not valid JSON.'); }
  return { revision: rows[0].revision as number, state: validateSquareState(parsed) };
}

function counts(state: SquareState): MigrationCounts {
  let receipts = 0;
  for (const observations of Object.values(state.runtime.observations)) receipts += Object.keys(observations).length;
  return {
    activities: state.acts.length,
    receipts,
    leases: Object.keys(state.runtime.leases).length,
    routes: state.routes?.length ?? 0,
  };
}

/**
 * Explicit in-place conversion of a normally persisted version 1 artifact.
 *
 * The legacy snapshot is read, validated and written here and nowhere else in
 * production; the row schema, codec and landing transition come from the driver.
 * One transaction: preflight framing, the same recheck under the lock, the
 * preserved authority, the derived facts, the format flip and a single COMMIT.
 */
export async function migrateSquareFile(location: string, signal?: AbortSignal): Promise<MigrationOutcome> {
  const squarePath = await canonicalPath(location);
  const database = openExistingSquareDatabase(squarePath);
  try {
    // Owned framing, read-only, before any pragma or DDL touches the artifact.
    // Every preflight statement reads one snapshot taken in the helper's
    // retryable stage: a transient writer lock is waited out like any other
    // acquisition, and a migrator that commits while we look cannot move the
    // artifact between the identity read and the schema reads.
    let alreadyConverted: MigrationOutcome | undefined;
    const preflight = await inSqliteTransaction(database, false, () => {
      const before = identity(database);
      if (before.applicationId === APPLICATION_ID && before.userVersion === 1) {
        validateLegacyFraming(database, APPLICATION_ID, squarePath);
        return;
      }
      // A row artifact means another migrator finished here; anything else is
      // refused by the row header itself.
      validateSqliteHeader(database, squarePath);
      alreadyConverted = { status: 'already-format-2', standing: standing(database) };
    }, () => alreadyConverted, signal);
    if (preflight !== undefined) return preflight;

    database.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
    const result: { outcome?: MigrationOutcome; converted?: boolean } = {};
    await inSqliteTransaction(database, true, () => {
      // Another migration may have finished between preflight and this lock.
      const locked = identity(database);
      if (locked.applicationId !== APPLICATION_ID || locked.userVersion !== 1) {
        // A valid row artifact is done already; anything else is refused here.
        validateSqliteHeader(database, squarePath);
        return;
      }
      validateLegacyFraming(database, APPLICATION_ID, squarePath);
      result.converted = true;
    }, () => {
      if (result.converted !== true) return;
      const legacy = decodeLegacySnapshot(database);
      initializeSqlite(database, legacy.state, legacy.revision);
      database.exec(`DROP TABLE ${V1_SNAPSHOT_TABLE}; PRAGMA user_version = 2`);
      result.outcome = { status: 'migrated', standing: standing(database), counts: counts(legacy.state) };
    }, signal);
    return result.outcome ?? { status: 'already-format-2', standing: standing(database) };
  } finally {
    database.close();
  }
}
