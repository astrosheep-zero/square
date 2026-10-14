import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import {
  isWakeRouteKind,
  SquareError,
  type ActivityObservation,
  type BuildOptions,
  type HardCap,
  type SquareRuntimeState,
  type SquareState,
  type StoredAct,
  type WatchLease,
} from './model.js';
import { parseActivityId } from './square-core.js';

const guideNames = ['participant', 'architect', 'brainstorm'];
const guideContents = new Map<string, string>(await Promise.all(
  guideNames.map(async (name) => [name, (await fs.promises.readFile(new URL(`../guides/${name}.md`, import.meta.url), 'utf8')).trim()] as const),
));

// ---------------------------------------------------------------------------
// Legacy v1 framing. This is the only place that knows the pre-row artifact
// shape; the row runtime never decodes it and the migration transaction is its
// only production reader.
// ---------------------------------------------------------------------------

const V1_USER_VERSION = 1;
export const V1_SNAPSHOT_TABLE = 'square_snapshot';
const V1_SNAPSHOT_DDL = `CREATE TABLE ${V1_SNAPSHOT_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL CHECK(revision>=0), state TEXT NOT NULL)`;
const V1_SNAPSHOT_COLUMNS = [
  { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
  { cid: 1, name: 'revision', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
  { cid: 2, name: 'state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
] as const;

export interface LegacyFraming {
  readonly applicationId: number;
  readonly userVersion: number;
  readonly journalMode: string;
}

/**
 * The one recovery command for an owned legacy artifact, with a shell-quoted
 * path. Kept here, beside the framing check, so the refusal and the migration
 * instruction cannot drift apart. (presentation.ts quotes other recovery
 * commands; this module stays free of the renderer.)
 */
export function migrationRecoveryCommand(location: string): string {
  return `square --location '${location.replace(/'/g, `'\\''`)}' migrate`;
}

/**
 * Read-only legacy framing: application id, format version, journal mode and the
 * exact owned snapshot schema. It decodes no snapshot payload, writes no pragma
 * and runs no DDL, so a caller can establish that a file really is an owned v1
 * square before offering the migration recovery command. Anything else is
 * refused as unrelated or unsupported rather than repaired.
 */
export function validateLegacyFraming(database: DatabaseSync, applicationId: number, location = ''): LegacyFraming {
  const identity = database.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as { application_id?: unknown; user_version?: unknown };
  if (identity.application_id !== applicationId) throw invalidArtifact('unrelated SQLite database.');
  if (identity.user_version !== V1_USER_VERSION) throw invalidArtifact('unsupported SQLite format version.');
  const journalMode = (database.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }).journal_mode;
  if (typeof journalMode !== 'string' || journalMode !== (location === ':memory:' ? 'memory' : 'delete')) throw invalidArtifact('unsupported journal mode.');
  const objects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name")
    .all() as { type?: unknown; name?: unknown; tbl_name?: unknown; sql?: unknown }[];
  if (objects.length !== 1) throw invalidArtifact('unsupported snapshot schema.');
  const [object] = objects;
  if (object.type !== 'table' || object.name !== V1_SNAPSHOT_TABLE || object.tbl_name !== V1_SNAPSHOT_TABLE
    || typeof object.sql !== 'string' || normalizedSchemaSql(object.sql) !== normalizedSchemaSql(V1_SNAPSHOT_DDL)) throw invalidArtifact('unsupported snapshot schema.');
  const columns = database.prepare('SELECT cid, name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid')
    .all(V1_SNAPSHOT_TABLE) as { cid?: unknown; name?: unknown; type?: unknown; notnull?: unknown; dflt_value?: unknown; pk?: unknown; hidden?: unknown }[];
  if (columns.length !== V1_SNAPSHOT_COLUMNS.length || !columns.every((column, index) => {
    const expected = V1_SNAPSHOT_COLUMNS[index];
    return column.cid === expected.cid && column.name === expected.name && column.type === expected.type
      && column.notnull === expected.notnull && column.dflt_value === expected.dflt_value
      && column.pk === expected.pk && column.hidden === expected.hidden;
  })) throw invalidArtifact('unsupported snapshot schema.');
  return { applicationId, userVersion: V1_USER_VERSION, journalMode };
}

function normalizedSchemaSql(sql: string): string {
  return sql.trim().replace(/\s+/g, ' ').replace(/\s*(>=|[(),=])\s*/g, '$1');
}

function invalidArtifact(detail: string): SquareError {
  return new SquareError('invalid_args', `Invalid square artifact: ${detail}`);
}

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

function isNonblankString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateWatchLease(value: unknown): value is WatchLease {
  if (!isObject(value) || !hasExactKeys(value, ['leaseId', 'heartbeatAt', 'expiresAt'], ['filter'])
    || !isNonblankString(value.leaseId) || !isFiniteNumber(value.heartbeatAt)
    || !isFiniteNumber(value.expiresAt) || value.expiresAt < value.heartbeatAt) return false;
  if (value.filter === undefined) return true;
  return isObject(value.filter) && hasExactKeys(value.filter, [], ['participants', 'mention'])
    && (value.filter.participants === undefined || isStringArray(value.filter.participants))
    && (value.filter.mention === undefined || typeof value.filter.mention === 'string');
}

function validateRecord(value: unknown, item: (candidate: unknown) => boolean): value is Record<string, unknown> {
  return isObject(value) && Object.entries(value).every(([key, candidate]) => key.length > 0 && item(candidate));
}

function validateRuntime(value: unknown): value is SquareRuntimeState {
  return isObject(value) && hasExactKeys(value, ['nextActIndex', 'observations', 'leases'])
    && isNonNegativeInteger(value.nextActIndex)
    && validateRecord(value.observations, (candidate) => isObject(candidate)
      && Object.entries(candidate).every(([id, observation]) => parseActivityId(id) !== undefined && isObject(observation) && hasExactKeys(observation, ['state', 'at']) && observation.state === 'seen' && isFiniteNumber(observation.at)))
    && validateRecord(value.leases, validateWatchLease);
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

function validateActor(value: unknown, required: boolean): boolean {
  return required ? isNonblankString(value) : value === undefined || isNonblankString(value);
}

function validateStoredAct(value: unknown): value is StoredAct {
  if (!isObject(value) || typeof value.kind !== 'string' || !isNonNegativeInteger(value.index) || !isFiniteNumber(value.at)) return false;
  switch (value.kind) {
    case 'join': return hasExactKeys(value, ['kind', 'actor', 'at', 'index']) && validateActor(value.actor, true);
    case 'done': return hasExactKeys(value, ['kind', 'actor', 'at', 'index'], ['body']) && validateActor(value.actor, true) && (value.body === undefined || typeof value.body === 'string');
    case 'say': return hasExactKeys(value, ['kind', 'actor', 'at', 'body', 'index'], ['mentions', 'reach', 'reply'])
      && validateActor(value.actor, true) && typeof value.body === 'string'
      && (value.mentions === undefined || isStringArray(value.mentions)) && (value.reach === undefined || value.reach === 'bell')
      && (value.reply === undefined || isNonNegativeInteger(value.reply));
    case 'hold': return hasExactKeys(value, ['kind', 'at', 'index'], ['actor', 'body']) && validateActor(value.actor, false) && (value.body === undefined || typeof value.body === 'string');
    case 'resume': return hasExactKeys(value, ['kind', 'at', 'index'], ['actor']) && validateActor(value.actor, false);
    case 'read': return hasExactKeys(value, ['kind', 'actor', 'at', 'through', 'index']) && validateActor(value.actor, true) && isNonNegativeInteger(value.through);
    case 'listen':
    case 'ignore': return hasExactKeys(value, ['kind', 'actor', 'target', 'at', 'index']) && validateActor(value.actor, true) && validateActor(value.target, true);
    default: return false;
  }
}

function validateActs(value: unknown): value is StoredAct[] {
  if (!Array.isArray(value) || !value.every(validateStoredAct)) return false;
  let previous = -1;
  for (const act of value) {
    if (act.index <= previous || (act.kind === 'say' && act.reply !== undefined && act.reply >= act.index)) return false;
    previous = act.index;
  }
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

/**
 * The one restriction layered on the permissive v1 route validator: an
 * exponent-overflow number (`1e999`) parses to Infinity, passes the old checks,
 * and cannot survive an ordinary JSON round trip. It is refused rather than
 * silently coerced, wherever it sits in a route — updatedAt, epoch, or a nested
 * extra.
 */
function assertFiniteRouteNumbers(routes: readonly unknown[]): void {
  for (let index = 0; index < routes.length; index += 1) {
    const found = nonFiniteRoutePath(routes[index], `routes[${index}]`);
    if (found !== undefined) throw invalidArtifact(`${found} is not a finite number.`);
  }
}

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

export function emptyRuntimeState(nextActIndex = 0): SquareRuntimeState {
  return { nextActIndex, observations: {}, leases: {} };
}

function normalizedLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized === '' ? [] : normalized.split('\n');
}

function readGuide(name: string): string {
  const guide = guideContents.get(name);
  if (guide === undefined) throw new SquareError('invalid_args', `Unknown square guide: ${name}`);
  return guide;
}

export function createSquareState(options: BuildOptions & { hardCap: HardCap }, snippet: string): SquareState {
  const guides = [readGuide('participant')];
  if (options.template !== undefined) guides.push(readGuide(options.template));
  return {
    hardCap: options.hardCap,
    ...(options.throttlePerMinute === undefined ? {} : { throttlePerMinute: options.throttlePerMinute }),
    preamble: normalizedLines(snippet),
    warmup: normalizedLines(guides.join('\n\n')),
    acts: [], routes: [], runtime: emptyRuntimeState(),
  };
}
