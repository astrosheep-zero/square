import type { DatabaseSync } from 'node:sqlite';

import { openExistingSquareDatabase } from './artifact.js';
import { inSqliteTransaction } from './sqlite-transaction.js';
import { canonicalPath } from './canonical-path.js';
import { isWakeRouteKind, type StoredAct } from './model.js';
import { parseActivityId } from './square-core.js';
import { APPLICATION_ID, ACTIVITIES_TABLE_SQL, ACTIVITY_INDEXES_SQL, CURRENT_USER_VERSION, V2_USER_VERSION, V1_SNAPSHOT_TABLE, createSqliteDriver, initializeSqlite, invalidArtifact,
  validateLegacyFraming, validateRowFraming, validateSqliteHeader, validateStoredActivity, validateWatchLease,
  type SquareRuntimeState, type SquareState,
} from './square-sqlite.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateRecord(value: unknown, item: (candidate: unknown) => boolean): value is Record<string, unknown> {
  return isObject(value) && Object.entries(value).every(([key, candidate]) => key.length > 0 && item(candidate));
}

function validateRuntime(value: unknown): value is SquareRuntimeState {
  return isObject(value) && hasExactKeys(value, ['nextActIndex', 'observations', 'leases'])
    && isNonNegativeInteger(value.nextActIndex)
    && validateRecord(value.observations, (candidate) => isObject(candidate)
      && Object.entries(candidate).every(([id, observation]) => parseActivityId(id) !== undefined && isObject(observation) && hasExactKeys(observation, ['state', 'at']) && observation.state === 'seen' && isFiniteNumber(observation.at)))
    && validateRecord(value.leases, (candidate) => {
      try { validateWatchLease(candidate); return true; } catch { return false; }
    });
}

function validateAssignedRuntimeReferences(runtime: SquareRuntimeState): 'ok' | 'malformed' | 'future' {
  for (const observations of Object.values(runtime.observations)) {
    for (const id of Object.keys(observations)) {
      const index = parseActivityId(id);
      if (index === undefined) return 'malformed';
      if (index >= runtime.nextActIndex) return 'future';
    }
  }
  return 'ok';
}

function validateActs(value: unknown): value is StoredAct[] {
  if (!Array.isArray(value)) return false;
  let previous = -1;
  try {
    for (const candidate of value) {
      const act = validateStoredActivity(candidate);
      if (act.kind === 'unlisten' || act.index <= previous) return false;
      previous = act.index;
    }
  } catch { return false; }
  return true;
}

function nonFiniteRoutePath(value: unknown, path: string): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = nonFiniteRoutePath(value[index], `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      const found = nonFiniteRoutePath(item, `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Refuse exponent overflow with its legacy path before JSON could coerce it. */
function assertFiniteRouteNumbers(routes: readonly unknown[]): void {
  for (let index = 0; index < routes.length; index += 1) {
    const found = nonFiniteRoutePath(routes[index], `routes[${index}]`);
    if (found !== undefined) throw invalidArtifact(`${found} is not a finite number.`);
  }
}

/** Validate persisted v1 JSON; row codecs share activity and lease acceptance. */
export function validateSquareState(value: unknown): SquareState {
  if (isObject(value) && Array.isArray(value.routes)) assertFiniteRouteNumbers(value.routes);
  if (!isObject(value) || !hasExactKeys(value, ['hardCap', 'preamble', 'warmup', 'acts', 'runtime'], ['throttlePerMinute', 'routes'])
    || !(value.hardCap === null || (Number.isSafeInteger(value.hardCap) && (value.hardCap as number) > 0))
    || (value.throttlePerMinute !== undefined && (!Number.isSafeInteger(value.throttlePerMinute) || (value.throttlePerMinute as number) <= 0))
    || !isStringArray(value.preamble) || !isStringArray(value.warmup) || !validateActs(value.acts)
    || (value.routes !== undefined && (!Array.isArray(value.routes) || !value.routes.every((route) => isObject(route) && isWakeRouteKind(route.kind)
      && typeof route.location === 'string' && typeof route.participant === 'string' && typeof route.sessionId === 'string'
      && typeof route.channel === 'string' && isObject(route.address) && Object.values(route.address).every((item) => typeof item === 'string')
      && typeof route.updatedAt === 'number')))
    || !validateRuntime(value.runtime)) throw invalidArtifact('snapshot schema is malformed.');
  const historyBoundary = value.acts.at(-1)?.index ?? -1;
  if (value.runtime.nextActIndex <= historyBoundary) throw invalidArtifact('nextActIndex is behind the activity history.');
  const references = validateAssignedRuntimeReferences(value.runtime as SquareRuntimeState);
  if (references === 'malformed') throw invalidArtifact('snapshot schema is malformed.');
  if (references === 'future') throw invalidArtifact('runtime references an unassigned activity index.');
  return value as unknown as SquareState;
}

export interface MigrationCounts {
  readonly activities: number;
  readonly receipts: number;
  readonly leases: number;
  readonly routes: number;
}

export interface MigrationOutcome {
  readonly status: 'migrated' | 'already-current';
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

function rowCounts(database: DatabaseSync): MigrationCounts {
  const count = (table: string): number => Number((database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: unknown }).n);
  return { activities: count('activities'), receipts: count('receipts'), leases: count('catch_leases'), routes: count('routes') };
}

const ACTIVITY_INDEX_NAMES = ['activity_kind_index', 'activity_actor_index', 'activity_say_actor_index', 'activity_say_time', 'activity_bell_actor_time'] as const;
function rebuildV2Activities(database: DatabaseSync): void {
  database.exec([
    ...ACTIVITY_INDEX_NAMES.map((name) => `DROP INDEX ${name};`),
    'ALTER TABLE activities RENAME TO activities_v2;',
    ACTIVITIES_TABLE_SQL,
    'INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) SELECT act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json FROM activities_v2 ORDER BY act_index;',
    'DROP TABLE activities_v2;',
    ...ACTIVITY_INDEXES_SQL.map((sql) => `${sql};`),
  ].join('\n'));
}

function validateMigrationSource(database: DatabaseSync, location: string): 1 | 2 | undefined {
  const before = identity(database);
  if (before.applicationId !== APPLICATION_ID) throw invalidArtifact('unrelated SQLite database.');
  if (before.userVersion === 1) {
    validateLegacyFraming(database, APPLICATION_ID, location);
    return 1;
  }
  if (before.userVersion === V2_USER_VERSION) {
    validateRowFraming(database, V2_USER_VERSION, location);
    createSqliteDriver(database).header();
    return 2;
  }
  if (before.userVersion === CURRENT_USER_VERSION) {
    validateSqliteHeader(database, location);
    return undefined;
  }
  throw invalidArtifact('unsupported SQLite format version.');
}

/**
 * Explicit in-place conversion of a version 1 snapshot or version 2 row
 * artifact. Each source is validated before and under the write lock; v1 is
 * imported through the normal current row initializer, while v2 rebuilds only
 * activities and its indexes before publishing the new format version.
 */
export async function migrateSquareFile(location: string, signal?: AbortSignal): Promise<MigrationOutcome> {
  const squarePath = await canonicalPath(location);
  const database = openExistingSquareDatabase(squarePath);
  try {
    let alreadyCurrent: MigrationOutcome | undefined;
    const preflight = await inSqliteTransaction(database, false, () => {
      const source = validateMigrationSource(database, squarePath);
      if (source === undefined) alreadyCurrent = { status: 'already-current', standing: standing(database) };
      return source;
    }, (source) => source, signal);
    if (preflight === undefined) return alreadyCurrent!;

    database.exec('PRAGMA busy_timeout = 0; PRAGMA synchronous = FULL');
    const result: { outcome?: MigrationOutcome; source?: 1 | 2 } = {};
    await inSqliteTransaction(database, true, () => {
      const source = validateMigrationSource(database, squarePath);
      result.source = source;
    }, () => {
      if (result.source === 1) {
        const legacy = decodeLegacySnapshot(database);
        initializeSqlite(database, legacy.state, legacy.revision);
        database.exec(`DROP TABLE ${V1_SNAPSHOT_TABLE}; PRAGMA user_version = ${CURRENT_USER_VERSION}`);
        result.outcome = { status: 'migrated', standing: standing(database), counts: counts(legacy.state) };
      }
      else if (result.source === 2) {
        rebuildV2Activities(database);
        database.exec(`PRAGMA user_version = ${CURRENT_USER_VERSION}`);
        result.outcome = { status: 'migrated', standing: standing(database), counts: rowCounts(database) };
      }
    }, signal);
    return result.outcome ?? { status: 'already-current', standing: standing(database) };
  } finally {
    database.close();
  }
}
