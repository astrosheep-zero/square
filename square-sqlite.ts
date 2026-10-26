import { DatabaseSync as MemoryDatabase, type DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SquareError, nameKey, isWakeRouteKind, validateBody, validateActivityMetadata, activityMetadataHasContent, type ActivityMetadata, type ActivityId, type ActivityObservation, type Body, type HardCap, type Seat, type StoredAct, type WakeAddress, type WatchLease } from './model.js';
import type { SquareHeader, SquareRead, ParticipantFact, AttentionFact, ActivityHead, ActivityFilter, IndexPage, FactPage, DirectedFilter, DirectedHead, SeatRef, DeliveryClaimInput, DeliveryClaimResult, DeliveryCompletion, DeliveryPreparation, DeliveryEvidence } from './ports.js';
import { deriveLanding, landingFacts, type LandingWriter } from './square-domain.js';
import { legacyRowFramingIssue } from './square-legacy-framing.js';
/** Explicit import/export DTOs, not a runtime transaction model. */
export interface SquareRuntimeState {
    nextActIndex: number;
    observations: Record<string, Record<string, ActivityObservation>>;
    leases: Record<string, WatchLease>;
}
export interface SquareState {
    hardCap: HardCap;
    throttlePerMinute?: number;
    preamble: string[];
    warmup: string[];
    acts: StoredAct[];
    runtime: SquareRuntimeState;
}
export function emptyRuntimeState(nextActIndex = 0): SquareRuntimeState {
    return { nextActIndex, observations: {}, leases: {} };
}

export const APPLICATION_ID = 0x53515245;
const V1_USER_VERSION = 1;
export const V2_USER_VERSION = 2;
export const V3_USER_VERSION = 3;
export const CURRENT_USER_VERSION = 4;
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
 * Read-only legacy framing: application id, format version, journal mode and the
 * exact owned snapshot schema. It decodes no snapshot payload, writes no pragma
 * and runs no DDL, so ordinary open can establish ownership before requiring
 * migration. Anything else is unrelated or unsupported, not repaired.
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
        || typeof object.sql !== 'string' || normalizedLegacySql(object.sql) !== normalizedLegacySql(V1_SNAPSHOT_DDL)) throw invalidArtifact('unsupported snapshot schema.');
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
function normalizedLegacySql(sql: string): string {
    return sql.trim().replace(/\s+/g, ' ').replace(/\s*(>=|[(),=])\s*/g, '$1');
}
const CURRENT_ACTIVITY_KIND_CHECK = "kind IN ('join','done','say','hold','resume','read','listen','ignore','unlisten')";

export const ACTIVITIES_TABLE_SQL = `CREATE TABLE activities (
  act_index INTEGER PRIMARY KEY CHECK (act_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL,
  kind TEXT NOT NULL CHECK (${CURRENT_ACTIVITY_KIND_CHECK}),
  actor_json TEXT COLLATE BINARY,
  actor_key_json TEXT COLLATE BINARY,
  reach TEXT CHECK (reach = 'bell'),
  reply_index INTEGER CHECK (reply_index >= 0 AND reply_index < act_index),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK ((actor_json IS NULL) = (actor_key_json IS NULL)),
  CHECK (kind IN ('hold','resume') OR actor_json IS NOT NULL),
  CHECK (kind = 'say' OR (reach IS NULL AND reply_index IS NULL))
);`;
export const ACTIVITY_INDEXES_SQL = [
  'CREATE INDEX activity_kind_index ON activities(kind, act_index)',
  'CREATE INDEX activity_actor_index ON activities(actor_key_json, act_index)',
  "CREATE INDEX activity_say_actor_index ON activities(actor_key_json, act_index) WHERE kind='say'",
  "CREATE INDEX activity_say_time ON activities(at, act_index) WHERE kind='say'",
  "CREATE INDEX activity_bell_actor_time ON activities(actor_key_json, at, act_index) WHERE kind='say' AND reach='bell'",
] as const;
export const SCHEMA_SQL = `CREATE TABLE square_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  delivery_revision INTEGER NOT NULL CHECK (delivery_revision BETWEEN 0 AND 9007199254740991),
  next_act_index INTEGER NOT NULL CHECK (next_act_index BETWEEN 0 AND 9007199254740991),
  hard_cap INTEGER CHECK (hard_cap BETWEEN 1 AND 9007199254740991),
  throttle_per_minute INTEGER CHECK (throttle_per_minute BETWEEN 1 AND 9007199254740991),
  preamble_json TEXT NOT NULL CHECK (json_valid(preamble_json)),
  warmup_json TEXT NOT NULL CHECK (json_valid(warmup_json))
);
${ACTIVITIES_TABLE_SQL}
${ACTIVITY_INDEXES_SQL.join(';\n')};

CREATE TABLE receipts (
  owner_json TEXT COLLATE BINARY NOT NULL,
  act_index INTEGER NOT NULL CHECK (act_index BETWEEN 0 AND 9007199254740991),
  at REAL NOT NULL,
  PRIMARY KEY (owner_json, act_index)
) WITHOUT ROWID;
CREATE INDEX receipt_owner_time ON receipts(owner_json, at);
CREATE TABLE catch_leases (
  owner_json TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  generation_json TEXT NOT NULL DEFAULT '""',
  lease_id_json TEXT NOT NULL,
  heartbeat_at REAL NOT NULL,
  expires_at REAL NOT NULL CHECK (expires_at >= heartbeat_at),
  filter_json TEXT CHECK (filter_json IS NULL OR json_valid(filter_json))
) WITHOUT ROWID;

CREATE TABLE seats (
  participant_key_json TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  participant_json TEXT NOT NULL,
  channel_json TEXT NOT NULL,
  session_json TEXT NOT NULL,
  agent_json TEXT,
  generation_json TEXT NOT NULL,
  wake_address_json TEXT CHECK (wake_address_json IS NULL OR json_valid(wake_address_json))
) WITHOUT ROWID;
CREATE INDEX seat_body ON seats(channel_json, session_json, agent_json);
CREATE TABLE delivery_evidence (
  participant_key_json TEXT COLLATE BINARY NOT NULL,
  participant_json TEXT NOT NULL,
  generation_json TEXT NOT NULL,
  act_index INTEGER NOT NULL CHECK (act_index BETWEEN 0 AND 9007199254740991),
  kind TEXT NOT NULL CHECK (kind IN ('wake','presentation')),
  attempt_n INTEGER NOT NULL CHECK (attempt_n >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('dispatching','accepted','failed','unknown','released','presented','clipped')),
  at REAL NOT NULL,
  expires_at REAL,
  claim_token_json TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (participant_key_json,generation_json,act_index,kind,attempt_n)
) WITHOUT ROWID;
CREATE UNIQUE INDEX delivery_claim_token ON delivery_evidence(claim_token_json) WHERE claim_token_json IS NOT NULL;
CREATE INDEX delivery_activity ON delivery_evidence(participant_key_json,generation_json,act_index,kind,attempt_n);
CREATE TABLE delivery_cancellations (
  participant_key_json TEXT COLLATE BINARY NOT NULL,
  generation_json TEXT NOT NULL,
  through_index INTEGER NOT NULL CHECK (through_index BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (participant_key_json,generation_json)
) WITHOUT ROWID;

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
  route TEXT NOT NULL CHECK (route IN ('mention','reply','attention','bell')),
  PRIMARY KEY (act_index, recipient_key_json),
  UNIQUE (act_index, recipient_order)
) WITHOUT ROWID;
CREATE INDEX audience_recipient ON landed_audience(recipient_key_json, act_index);`;
const EXPECTED_SCHEMA_SQL = SCHEMA_SQL.split(';').map(s => s.trim()).filter(Boolean).map(normalizedSql).sort();
// All strings, including identity keys, are JSON encoded before SQLite binding.
type Row = Record<string, string | number | null>;
const encode = JSON.stringify;
const key = (name: string): string => encode(nameKey(name));
export function invalidArtifact(detail: string): SquareError {
    return new SquareError('invalid_args', `Invalid square artifact: ${detail}`);
}
function requireFact(ok: unknown, detail = 'row is malformed.'): asserts ok {
    if (!ok)
        throw invalidArtifact(detail);
}
function integer(value: unknown, minimum = 0): number {
    requireFact(Number.isSafeInteger(value) && (value as number) >= minimum);
    return value as number;
}
function finite(value: unknown): number {
    requireFact(typeof value === 'number' && Number.isFinite(value));
    return value as number;
}
function string(value: unknown, nonempty = false): string {
    requireFact(typeof value === 'string' && (!nonempty || value.length > 0));
    return value as string;
}
function json(value: unknown): unknown {
    try {
        return JSON.parse(string(value));
    }
    catch {
        throw invalidArtifact('row contains invalid JSON.');
    }
}
function object(value: unknown): Record<string, unknown> {
    requireFact(typeof value === 'object' && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    const result = object(value);
    requireFact(required.every(k => Object.hasOwn(result, k)) && Object.keys(result).every(k => required.includes(k) || optional.includes(k)));
    return result;
}
function strings(value: unknown): string[] {
    requireFact(Array.isArray(value) && value.every(v => typeof v === 'string'));
    return value as string[];
}
function decoded(value: unknown, nonempty = false): string {
    const result = string(json(value), nonempty);
    requireFact(encode(result) === value, 'string encoding is malformed.');
    return result;
}
function immutable<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
        for (const item of Object.values(value))
            immutable(item);
        Object.freeze(value);
    }
    return value;
}
const kinds = ['join', 'done', 'say', 'hold', 'resume', 'read', 'listen', 'ignore', 'unlisten'];
function head(row: Row): ActivityHead {
    const index = integer(row.act_index), at = finite(row.at);
    requireFact(kinds.includes(string(row.kind)));
    const actor = row.actor_json === null ? undefined : decoded(row.actor_json, true);
    requireFact(actor === undefined ? row.actor_key_json === null && ['hold', 'resume'].includes(row.kind as string) : row.actor_key_json === key(actor));
    requireFact(row.reach === null || row.kind === 'say' && row.reach === 'bell');
    if (row.reply_index !== null)
        requireFact(row.kind === 'say' && integer(row.reply_index) < index);
    return immutable({
        index, at, kind: row.kind as StoredAct['kind'], ...(actor === undefined ? {} : { actor }), ...(row.reach === null ? {} : { reach: 'bell' as const }), ...(row.reply_index === null ? {} : { reply: row.reply_index as number })
    });
}
export function validateStoredActivity(value: unknown): StoredAct {
    const a = object(value);
    integer(a.index);
    finite(a.at);
    requireFact(kinds.includes(string(a.kind)));
    const common = ['kind', 'at', 'index'];
    if (a.kind !== 'hold' && a.kind !== 'resume') {
        common.push('actor');
        string(a.actor, true);
    }
    else if (Object.hasOwn(a, 'actor'))
        string(a.actor, true);
    switch (a.kind) {
        case 'say':
            shape(a, [...common], ['body', 'mentions', 'reach', 'reply', 'metadata']);
            if (Object.hasOwn(a, 'body')) string(a.body);
            if (Object.hasOwn(a, 'metadata')) {
                requireFact(a.metadata !== undefined, 'say metadata is malformed.');
                try { validateActivityMetadata(a.metadata); }
                catch { throw invalidArtifact('say metadata is malformed.'); }
            }
            requireFact((Object.hasOwn(a, 'body') && typeof a.body === 'string' && a.body.trim() !== '') || activityMetadataHasContent(a.metadata as ActivityMetadata | undefined), 'say must contain a non-empty body or non-empty metadata.');
            if (Object.hasOwn(a, 'mentions'))
                strings(a.mentions);
            if (Object.hasOwn(a, 'reach'))
                requireFact(a.reach === 'bell');
            if (Object.hasOwn(a, 'reply'))
                requireFact(integer(a.reply) < (a.index as number));
            break;
        case 'done':
        case 'hold':
            shape(a, common, ['body', ...(a.kind === 'hold' ? ['actor'] : [])]);
            if (Object.hasOwn(a, 'body'))
                string(a.body);
            break;
        case 'read':
            shape(a, [...common, 'through']);
            integer(a.through);
            break;
        case 'listen':
        case 'ignore':
        case 'unlisten':
            shape(a, [...common, 'target']);
            string(a.target, true);
            break;
        default: shape(a, common, a.kind === 'resume' ? ['actor'] : []);
    }
    return value as StoredAct;
}
function activity(row: Row): StoredAct {
    const h = head(row), payload = object(json(row.payload_json));
    // Payload cannot shadow indexed structural columns.
    const allowed = h.kind === 'say' ? ['body', 'mentions', 'metadata'] : h.kind === 'done' || h.kind === 'hold' ? ['body'] : h.kind === 'read' ? ['through'] : h.kind === 'listen' || h.kind === 'ignore' || h.kind === 'unlisten' ? ['target'] : [];
    requireFact(Object.keys(payload).every(k => allowed.includes(k)));
    return immutable(validateStoredActivity({ ...h, ...payload }));
}
function participant(row: Row): ParticipantFact {
    const name = decoded(row.name_json, true);
    requireFact(row.name_key_json === key(name) && [0, 1].includes(row.joined as number) && [0, 1].includes(row.done as number) && !(row.joined && row.done));
    return immutable({
        name, firstIndex: integer(row.first_index), joined: row.joined === 1, done: row.done === 1, sayCount: integer(row.say_count), ...(row.last_active_at === null ? {} : { lastActiveAt: finite(row.last_active_at) }), ...(row.last_join_index === null ? {} : { lastJoinIndex: integer(row.last_join_index) })
    });
}
function attention(row: Row): AttentionFact {
    const target = decoded(row.target_json, true), listener = decoded(row.name_json, true);
    requireFact(row.target_key_json === key(target) && row.listener_key_json === key(listener) && ['listen', 'ignore'].includes(row.kind as string));
    return immutable({
        listener, target, kind: row.kind as AttentionFact['kind'], sinceIndex: integer(row.since_index)
    });
}
function routeKind(value: unknown): DirectedHead['route'] {
    requireFact(['mention', 'reply', 'attention', 'bell'].includes(string(value)));
    return value as DirectedHead['route'];
}
export function validateWatchLease(value: unknown): WatchLease {
    const l = shape(value, ['leaseId', 'heartbeatAt', 'expiresAt'], ['filter']);
    string(l.leaseId, true);
    requireFact(finite(l.expiresAt) >= finite(l.heartbeatAt));
    if (Object.hasOwn(l, 'filter')) {
        const f = shape(l.filter, [], ['participants', 'mention']);
        if (Object.hasOwn(f, 'participants'))
            strings(f.participants);
        if (Object.hasOwn(f, 'mention'))
            string(f.mention);
    }
    return value as WatchLease;
}
// Sorted object keys express small-value structural equality, never whole-state comparison.
function stableJson(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        requireFact(value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value), 'value contains a non-finite or unsupported JSON value.');
        return encode(value);
    }
    if (Array.isArray(value))
        return '[' + value.map(stableJson).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => encode(k) + ':' + stableJson((value as Record<string, unknown>)[k])).join(',') + '}';
}
function activityId(value: unknown): ActivityId {
    const parsed = typeof value === 'string' ? /^act\/(0|[1-9]\d*)$/.exec(value) : null;
    requireFact(parsed !== null, 'activity generation is malformed.');
    const index = Number(parsed![1]);
    requireFact(Number.isSafeInteger(index));
    return value as ActivityId;
}
function activityIndex(value: unknown): number {
    const parsed = activityId(value);
    return integer(Number(parsed.slice(4)));
}
function wakeAddress(value: unknown): WakeAddress {
    const address = shape(value, ['kind', 'address']);
    requireFact(isWakeRouteKind(address.kind));
    const entries = object(address.address);
    requireFact(Object.values(entries).every((item) => typeof item === 'string'));
    stableJson(entries);
    return immutable({ kind: address.kind, address: entries as Record<string, string> });
}
function bodyFrom(row: Row): Body {
    const body = { channel: decoded(row.channel_json, true), session: decoded(row.session_json, true), ...(row.agent_json === null ? {} : { agent: decoded(row.agent_json, true) }) };
    validateBody(body);
    return immutable(body);
}
function seat(row: Row): Seat {
    const participant = decoded(row.participant_json, true);
    requireFact(row.participant_key_json === key(participant));
    const generation = activityId(decoded(row.generation_json, true));
    const parsedWake = row.wake_address_json === null ? undefined : wakeAddress(json(row.wake_address_json));
    return immutable({ participant, body: bodyFrom(row), generation, ...(parsedWake === undefined ? {} : { wakeAddress: parsedWake }) });
}
function nativeCorrelation(value: unknown): NonNullable<DeliveryEvidence['correlation']> {
    const item = shape(value, ['harness'], ['token', 'messageId', 'payloadHash']);
    requireFact(['claude', 'opencode', 'pi'].includes(string(item.harness)));
    for (const key of ['token', 'messageId', 'payloadHash']) if (Object.hasOwn(item, key)) string(item[key], true);
    return immutable({ harness: item.harness as 'claude' | 'opencode' | 'pi',
        ...(item.token === undefined ? {} : { token: item.token as string }),
        ...(item.messageId === undefined ? {} : { messageId: item.messageId as string }),
        ...(item.payloadHash === undefined ? {} : { payloadHash: item.payloadHash as string }) });
}
function deliveryEvidence(row: Row): DeliveryEvidence {
    const payload = object(json(row.payload_json));
    const participant = decoded(row.participant_json, true);
    requireFact(row.participant_key_json === key(participant));
    const generation = activityId(decoded(row.generation_json, true));
    const activity = activityId(`act/${integer(row.act_index)}`);
    requireFact(['wake', 'presentation'].includes(string(row.kind)) && ['dispatching', 'accepted', 'failed', 'unknown', 'released', 'presented', 'clipped'].includes(string(row.outcome)));
    requireFact(Number.isSafeInteger(row.attempt_n) && (row.attempt_n as number) >= 0);
    const nativeObservations = payload.nativeObservations === undefined ? undefined : (() => {
        requireFact(Array.isArray(payload.nativeObservations));
        return payload.nativeObservations.map((value) => {
            const item = shape(value, ['eventId', 'messageId', 'state', 'observedAt'], ['reason']);
            requireFact(['held', 'released', 'dropped'].includes(string(item.state)));
            return {
                eventId: string(item.eventId, true), messageId: string(item.messageId, true),
                state: item.state as 'held' | 'released' | 'dropped',
                ...(Object.hasOwn(item, 'reason') ? { reason: string(item.reason) } : {}), observedAt: finite(item.observedAt),
            };
        });
    })();
    return immutable({
        participant, generation, activity, kind: row.kind as DeliveryEvidence['kind'],
        outcome: row.outcome as DeliveryEvidence['outcome'], attemptN: integer(row.attempt_n), at: finite(row.at),
        ...(row.expires_at === null ? {} : { expiresAt: finite(row.expires_at) }),
        ...(row.claim_token_json === null ? {} : { claimToken: decoded(row.claim_token_json, true) }),
        ...(payload.route === undefined ? {} : { route: wakeAddress(payload.route) }),
        ...(payload.signature === undefined ? {} : { signature: string(payload.signature) }),
        ...(payload.message === undefined ? {} : { message: string(payload.message) }),
        ...(payload.diagnostic === undefined ? {} : { diagnostic: payload.diagnostic as import('./model.js').JsonValue }),
        ...(payload.correlation === undefined ? {} : { correlation: nativeCorrelation(payload.correlation) }),
        ...(nativeObservations === undefined ? {} : { nativeObservations }),
    });
}
function normalizedSql(sql: string): string { return sql.trim().replace(/;$/, '').replace(/\s+/g, ' ').replace(/\s*([(),=])\s*/g, '$1'); }
function validateOwnedSchema(db: DatabaseSync, expected: readonly string[], location: string): void {
    const actual = (db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL").all() as Row[]).map(r => normalizedSql(string(r.sql))).sort();
    requireFact(actual.length === expected.length && actual.every((sql, i) => sql === expected[i]), 'unsupported row schema.');
    requireFact((db.prepare('PRAGMA journal_mode').get() as Row).journal_mode === (location === ':memory:' ? 'memory' : 'delete'), 'unsupported journal mode.');
}
export function validateRowFraming(db: DatabaseSync, version: 2 | 3 | 4, location = ''): void {
    if (version === V2_USER_VERSION || version === V3_USER_VERSION) {
        const issue = legacyRowFramingIssue(db, APPLICATION_ID, version, location, SCHEMA_SQL);
        if (issue !== undefined) throw invalidArtifact(issue);
        return;
    }
    const identity = db.prepare('SELECT application_id,user_version FROM pragma_application_id,pragma_user_version').get() as Row;
    requireFact(identity.application_id === APPLICATION_ID, 'unrelated SQLite database.');
    requireFact(identity.user_version === version, 'unsupported SQLite format version.');
    validateOwnedSchema(db, EXPECTED_SCHEMA_SQL, location);
}
export function validateSqliteHeader(db: DatabaseSync, location = ''): SquareHeader {
    const identity = db.prepare('SELECT application_id,user_version FROM pragma_application_id,pragma_user_version').get() as Row;
    requireFact(identity.application_id === APPLICATION_ID, 'unrelated SQLite database.');
    if (identity.user_version === 1) {
        validateLegacyFraming(db, APPLICATION_ID, location);
        throw new SquareError('invalid_args', `Square artifact at ${location} needs migration.\nStop sessions using it, back it up, then migrate and verify before restarting.`, { reason: 'migration_required' });
    }
    if (identity.user_version === V2_USER_VERSION || identity.user_version === V3_USER_VERSION) {
        validateRowFraming(db, identity.user_version, location);
        throw new SquareError('invalid_args', `Square artifact at ${location} needs migration.\nStop sessions using it, back it up, then migrate and verify before restarting.`, { reason: 'migration_required' });
    }
    if (identity.user_version === CURRENT_USER_VERSION) {
        validateRowFraming(db, CURRENT_USER_VERSION, location);
        return createSqliteDriver(db).header();
    }
    throw invalidArtifact('unsupported SQLite format version.');
}
interface Selection {
    sql: string;
    args: SQLInputValue[];
}
function activitySelection(filter: ActivityFilter, alias = 'a'): Selection {
    const terms: string[] = [], args: SQLInputValue[] = [];
    const add = (sql: string, value: SQLInputValue) => {
        terms.push(sql);
        args.push(value);
    };
    if (filter.afterIndex !== undefined)
        add(`${alias}.act_index > ?`, integer(filter.afterIndex, -1));
    if (filter.beforeIndex !== undefined)
        add(`${alias}.act_index < ?`, integer(filter.beforeIndex));
    if (filter.throughIndex !== undefined)
        add(`${alias}.act_index <= ?`, integer(filter.throughIndex, -1));
    if (filter.afterAt !== undefined)
        add(`${alias}.at > ?`, finite(filter.afterAt));
    if (filter.actorRequired)
        terms.push(`${alias}.actor_json IS NOT NULL`);
    for (const [column, values] of [['act_index', filter.indexes], ['kind', filter.kinds], [filter.actorMatch === 'exact' ? 'actor_json' : 'actor_key_json', filter.actors?.map(name => filter.actorMatch === 'exact' ? encode(name) : key(name))]] as const) {
        if (values !== undefined) {
            if (column === 'act_index')
                values.forEach(v => integer(v));
            add(`${alias}.${column} IN (SELECT value FROM json_each(?))`, encode(values));
        }
    }
    return { sql: terms.length ? terms.join(' AND ') : '1', args };
}
function pageRows<T>(rows: Row[], page: IndexPage, decode: (row: Row) => T): FactPage<T> {
    const hasMore = rows.length > page.limit;
    if (hasMore)
        rows.pop();
    if (page.edge === 'newest')
        rows.reverse();
    return immutable({ items: rows.map(decode), hasMore });
}
function pageLimit(page: IndexPage): number {
    requireFact(page.edge === 'oldest' || page.edge === 'newest');
    return Math.min(integer(page.limit, 1) + 1, Number.MAX_SAFE_INTEGER);
}
export interface SqliteDriver extends SquareRead, LandingWriter {
    readonly changed: boolean;
    readonly deliveryChanged: boolean;
    claimDelivery(input: DeliveryClaimInput): DeliveryClaimResult;
    prepareDelivery(input: DeliveryPreparation): boolean;
    completeDelivery(input: DeliveryCompletion): boolean;
}
export function createSqliteDriver(db: DatabaseSync): SqliteDriver {
    let changed = false, deliveryChanged = false;
    const all = (sql: string, args: readonly SQLInputValue[] = []): Row[] => db.prepare(sql).all(...args) as Row[];
    const one = (sql: string, args: readonly SQLInputValue[] = []): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
    const run = (sql: string, args: readonly SQLInputValue[] = []): number => Number(db.prepare(sql).run(...args).changes);
    const owner = (requested: string): string => read.participant(requested)?.name ?? requested;
    const attentionRows = (condition: string, args: SQLInputValue[]) => all(`SELECT t.*,p.name_json FROM attention t JOIN participants p ON p.name_key_json=t.listener_key_json WHERE ${condition} ORDER BY t.since_index`, args).map(attention);
    function directedSelection(recipient: string, filter: DirectedFilter): Selection {
        const p = read.participant(recipient), base = activitySelection({
            afterIndex: filter.afterIndex, beforeIndex: filter.beforeIndex, throughIndex: filter.throughIndex, actors: filter.senders
        });
        base.sql += ' AND d.recipient_key_json=?';
        base.args.push(p ? key(p.name) : '');
        if (filter.unseenOnly) {
            base.sql += ' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.owner_json=? AND r.act_index=a.act_index)';
            base.args.push(encode(p?.name ?? recipient));
        }
        if (filter.attentionOnly)
            base.sql += " AND d.route IN ('mention','reply','bell')";
        return base;
    }
    function directedHead(row: Row, recipient: string): DirectedHead {
        const h = head(row);
        requireFact(h.kind === 'say' && h.actor !== undefined);
        return immutable({
            index: h.index, at: h.at, actor: h.actor, recipient, route: routeKind(row.route)
        });
    }
    const directedFrom = 'landed_audience d JOIN activities a ON a.act_index=d.act_index';
    const pendingFrom = `landed_audience d JOIN activities a ON a.act_index=d.act_index JOIN participants p ON p.name_key_json=d.recipient_key_json`;
    const pendingWhere = `p.joined=1 AND d.act_index>COALESCE(p.last_join_index,-1) AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.owner_json=p.name_json AND r.act_index=d.act_index)`;
    const latestSeats = `seats s JOIN participants p ON p.name_key_json=s.participant_key_json
        JOIN activities a ON a.act_index=p.last_join_index AND a.kind='join' AND a.actor_key_json=p.name_key_json
        AND s.generation_json='"act/'||a.act_index||'"'`;
    function bodySeats(body: Body, lifecycle: 'joined' | 'done'): readonly Seat[] {
        validateBody(body);
        return immutable(all(`SELECT s.* FROM ${latestSeats} WHERE p.${lifecycle}=1 AND s.channel_json=? AND s.session_json=? AND s.agent_json IS ? ORDER BY s.participant_key_json`,
            [encode(body.channel), encode(body.session), body.agent === undefined ? null : encode(body.agent)]).map(seat));
    }
    const read: SquareRead = {
        seat(name) {
            const r = one(`SELECT s.* FROM ${latestSeats} WHERE p.joined=1 AND s.participant_key_json=?`, [key(name)]);
            return r ? seat(r) : undefined;
        },
        seatsForBody: body => bodySeats(body, 'joined'),
        completedSeatsForBody: body => bodySeats(body, 'done'),
        deliveryEvidence(participant, generation, activityIndex) {
            const args: SQLInputValue[] = [key(participant), encode(generation)];
            const filter = activityIndex === undefined ? '' : ' AND act_index=?';
            if (activityIndex !== undefined) args.push(integer(Number(activityIndex.slice(4))));
            return immutable(all(`SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=?${filter} ORDER BY act_index,kind,attempt_n`, args).map(deliveryEvidence));
        },
        deliveryByToken(claimToken) {
            const row = one('SELECT * FROM delivery_evidence WHERE claim_token_json=?', [encode(claimToken)]);
            return row === undefined ? undefined : deliveryEvidence(row);
        },
        cancelledThrough(participant, generation) {
            const r = one('SELECT through_index FROM delivery_cancellations WHERE participant_key_json=? AND generation_json=?', [key(participant), encode(generation)]);
            return r === undefined ? undefined : integer(r.through_index);
        },
        header() {
            const rows = all('SELECT m.*, (SELECT COALESCE(MAX(act_index),-1) FROM activities) AS last_act_index FROM square_meta m');
            requireFact(rows.length === 1 && rows[0].id === 1, 'header row is malformed.');
            const r = rows[0], nextActIndex = integer(r.next_act_index), lastActIndex = integer(r.last_act_index, -1);
            requireFact(nextActIndex > lastActIndex, 'nextActIndex is behind the activity history.');
            return immutable({
                revision: integer(r.revision), deliveryRevision: integer(r.delivery_revision), nextActIndex, lastActIndex, hardCap: r.hard_cap === null ? null : integer(r.hard_cap, 1), ...(r.throttle_per_minute === null ? {} : { throttlePerMinute: integer(r.throttle_per_minute, 1) }), preamble: strings(json(r.preamble_json)), warmup: strings(json(r.warmup_json))
            });
        },
        participant(name) {
            const r = one('SELECT * FROM participants WHERE name_key_json=?', [key(name)]);
            return r ? participant(r) : undefined;
        },
        participantCounts() {
            const r = one('SELECT COUNT(*) AS known, COALESCE(SUM(joined),0) AS joined, COALESCE(SUM(done),0) AS done FROM participants')!;
            return immutable({ known: integer(r.known), joined: integer(r.joined), done: integer(r.done) });
        },
        roster: () => immutable(all('SELECT * FROM participants ORDER BY first_index').map(participant)),
        attention: name => immutable(attentionRows('t.listener_key_json=?', [key(name)])),
        incomingAttention: name => immutable(attentionRows('t.target_key_json=?', [key(name)])),
        hold() {
            const r = one("SELECT * FROM activities WHERE kind IN ('hold','resume') ORDER BY act_index DESC LIMIT 1");
            if (!r)
                return immutable({ active: false });
            const a = activity(r);
            if (a.kind === 'resume')
                return immutable({ active: false });
            requireFact(a.kind === 'hold');
            return immutable({
                active: true, at: a.at, ...(a.body === undefined ? {} : { reason: a.body }), ...(a.actor === undefined ? {} : { actor: a.actor })
            });
        },
        activity(index) {
            const r = one('SELECT * FROM activities WHERE act_index=?', [integer(index)]);
            return r ? activity(r) : undefined;
        },
        activityHeads(filter, page) {
            const s = activitySelection(filter), limit = pageLimit(page);
            return pageRows(all(`SELECT a.act_index,a.at,a.kind,a.actor_json,a.actor_key_json,a.reach,a.reply_index FROM activities a WHERE ${s.sql} ORDER BY a.act_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...s.args, limit]), page, head);
        },
        activities(indexes) {
            indexes.forEach(v => integer(v));
            return immutable(all('SELECT * FROM activities WHERE act_index IN (SELECT value FROM json_each(?)) ORDER BY act_index', [encode(indexes)]).map(activity));
        },
        activityCount(filter) {
            const s = activitySelection(filter);
            return integer(one(`SELECT COUNT(*) AS n FROM activities a WHERE ${s.sql}`, s.args)!.n);
        },
        contextIndexes(centers, before, after) {
            integer(before);
            integer(after);
            const result = new Set<number>();
            for (const center of centers) {
                integer(center);
                if (!one('SELECT act_index FROM activities WHERE act_index=?', [center]))
                    continue;
                result.add(center);
                for (const r of all('SELECT act_index FROM activities WHERE act_index<? ORDER BY act_index DESC LIMIT ?', [center, before]))
                    result.add(integer(r.act_index));
                for (const r of all('SELECT act_index FROM activities WHERE act_index>? ORDER BY act_index LIMIT ?', [center, after]))
                    result.add(integer(r.act_index));
            }
            return immutable([...result].sort((a, b) => a - b));
        },
        sayOrdinals(indexes) {
            indexes.forEach(v => integer(v));
            const result: Record<number, number> = {};
            // Only an actor's latest say can use its authoritative lifetime count.
            for (const r of all(`SELECT a.act_index, CASE
                WHEN p.say_count IS NOT NULL AND a.act_index=(SELECT MAX(s.act_index) FROM activities s WHERE s.kind='say' AND s.actor_key_json=a.actor_key_json)
                THEN p.say_count
                ELSE (SELECT COUNT(*) FROM activities s WHERE s.kind='say' AND s.actor_key_json=a.actor_key_json AND s.act_index<=a.act_index)
                END AS n
                FROM activities a LEFT JOIN participants p ON p.name_key_json=a.actor_key_json
                WHERE a.kind='say' AND a.act_index IN (SELECT value FROM json_each(?))`, [encode(indexes)]))
                result[integer(r.act_index)] = integer(r.n, 1);
            return immutable(result);
        },
        recentSayTimes(after, take, actor, bell) {
            const args: SQLInputValue[] = [finite(after)];
            let where = "kind='say' AND at>?";
            if (actor !== undefined) {
                where += ' AND actor_key_json=?';
                args.push(key(actor));
            }
            if (bell)
                where += " AND reach='bell'";
            args.push(integer(take));
            return immutable(all(`SELECT at FROM activities WHERE ${where} ORDER BY at DESC,act_index DESC LIMIT ?`, args).map(r => finite(r.at)).reverse());
        },
        audience(index) { return immutable(all('SELECT p.name_json,d.route FROM landed_audience d JOIN participants p ON p.name_key_json=d.recipient_key_json WHERE d.act_index=? ORDER BY d.recipient_order', [integer(index)]).map(r => ({ recipient: decoded(r.name_json, true), route: routeKind(r.route) }))); },
        directed(recipient, filter, page) {
            const s = directedSelection(recipient, filter), limit = pageLimit(page), canonical = owner(recipient);
            return pageRows(all(`SELECT a.act_index,a.at,a.kind,a.actor_json,a.actor_key_json,a.reach,a.reply_index,d.route FROM ${directedFrom} WHERE ${s.sql} ORDER BY a.act_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...s.args, limit]), page, r => directedHead(r, canonical));
        },
        directedAt(recipient, index) { return read.directed(recipient, { afterIndex: integer(index) - 1, throughIndex: index }, { edge: 'oldest', limit: 1 }).items[0]; },
        directedCount(recipient, filter) {
            const s = directedSelection(recipient, filter);
            return integer(one(`SELECT COUNT(*) AS n FROM ${directedFrom} WHERE ${s.sql}`, s.args)!.n);
        },
        pendingAudience(after, through, limit) {
            const args = [integer(after, -1), integer(through, -1)], extra = pageLimit({ edge: 'oldest', limit });
            const indices = all(`SELECT DISTINCT d.act_index FROM ${pendingFrom} WHERE ${pendingWhere} AND d.act_index>? AND d.act_index<=? ORDER BY d.act_index LIMIT ?`, [...args, extra]);
            const hasMore = indices.length > limit;
            if (hasMore)
                indices.pop();
            const groups = indices.map(r => {
                const rows = all(`SELECT a.act_index,a.at,a.kind,a.actor_json,a.actor_key_json,a.reach,a.reply_index,p.name_json,d.route FROM ${pendingFrom} WHERE ${pendingWhere} AND d.act_index=? ORDER BY d.recipient_order`, [integer(r.act_index)]);
                const h = head(rows[0]);
                requireFact(h.kind === 'say' && h.actor !== undefined);
                return {
                    index: h.index, at: h.at, actor: h.actor, recipients: rows.map(v => ({ recipient: decoded(v.name_json, true), route: routeKind(v.route) }))
                };
            });
            return immutable({ groups, hasMore });
        },
        receipt(name, index) {
            const r = one('SELECT at FROM receipts WHERE owner_json=? AND act_index=?', [encode(owner(name)), integer(index)]);
            return r ? immutable({ at: finite(r.at) }) : undefined;
        },
        receiptFacts(name, afterIndex) {
            const k = encode(owner(name)), r = one('SELECT MAX(at) AS latest FROM receipts WHERE owner_json=?', [k])!, e = one('SELECT MAX(r.act_index) AS latest FROM receipts r JOIN activities a ON a.act_index=r.act_index WHERE r.owner_json=? AND r.act_index>? AND a.actor_json IS NOT NULL', [k, integer(afterIndex, -1)])!;
            return immutable({ ...(r.latest === null ? {} : { latestAt: finite(r.latest) }), ...(e.latest === null ? {} : { latestActorActivityIndex: integer(e.latest) }) });
        },
        receiptAssignments: () => immutable(all('SELECT owner_json,act_index FROM receipts ORDER BY owner_json,act_index').map(r => ({ owner: decoded(r.owner_json, true), index: integer(r.act_index) }))),
        lease(name) {
            const canonical = owner(name), current = read.seat(canonical);
            const r = current === undefined
                ? one('SELECT * FROM catch_leases WHERE owner_json=?', [encode(canonical)])
                : one('SELECT * FROM catch_leases WHERE owner_json=? AND (generation_json=? OR generation_json=?)', [encode(canonical), encode(current.generation), encode('')]);
            return r ? immutable(validateWatchLease({
                leaseId: decoded(r.lease_id_json, true), heartbeatAt: finite(r.heartbeat_at), expiresAt: finite(r.expires_at), ...(r.filter_json === null ? {} : { filter: json(r.filter_json) })
            })) : undefined;
        },
    };
    const writes: Omit<LandingWriter, 'claimDelivery' | 'prepareDelivery' | 'completeDelivery' | 'observeNativeDelivery'> = {
        storeSeat(value) {
            validateBody(value.body);
            activityId(value.generation);
            string(value.participant, true);
            const existing = read.seat(value.participant);
            if (existing !== undefined && stableJson(existing) === stableJson(value)) return false;
            const wake = value.wakeAddress === undefined ? null : encode(value.wakeAddress);
            run('INSERT INTO seats(participant_key_json,participant_json,channel_json,session_json,agent_json,generation_json,wake_address_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(participant_key_json) DO UPDATE SET participant_json=excluded.participant_json,channel_json=excluded.channel_json,session_json=excluded.session_json,agent_json=excluded.agent_json,generation_json=excluded.generation_json,wake_address_json=excluded.wake_address_json', [key(value.participant), encode(value.participant), encode(value.body.channel), encode(value.body.session), value.body.agent === undefined ? null : encode(value.body.agent), encode(value.generation), wake]);
            run('DELETE FROM catch_leases WHERE owner_json=?', [encode(value.participant)]);
            deliveryChanged = true;
            return true;
        },
        updateWakeAddress(value, wakeAddress) {
            const current = one('SELECT wake_address_json FROM seats WHERE participant_key_json=? AND generation_json=?', [key(value.participant), encode(value.generation)])!;
            if (wakeAddress !== undefined) {
                requireFact(isWakeRouteKind(wakeAddress.kind));
                requireFact(Object.values(wakeAddress.address).every((item) => typeof item === 'string'));
            }
            if (stableJson(current.wake_address_json === null ? null : json(current.wake_address_json)) === stableJson(wakeAddress ?? null)) return false;
            const count = run('UPDATE seats SET wake_address_json=? WHERE participant_key_json=? AND generation_json=?', [wakeAddress === undefined ? null : encode(wakeAddress), key(value.participant), encode(value.generation)]);
            if (count) deliveryChanged = true;
            return count > 0;
        },
        removeSeat(value) {
            // Done hides current authority; retain only its latest coordinate for exact-body resume.
            const row = one(`SELECT s.* FROM ${latestSeats} WHERE p.done=1 AND s.participant_key_json=?`, [key(value.participant)]);
            if (row === undefined || decoded(row.generation_json) !== value.generation) return false;
            run('UPDATE seats SET wake_address_json=NULL WHERE participant_key_json=?', [key(value.participant)]);
            run('DELETE FROM catch_leases WHERE owner_json=?', [encode(value.participant)]);
            changed = true; deliveryChanged = true;
            return true;
        },
        cancelThrough(value, through) {
            activityId(value.generation);
            integer(through);
            const prior = read.cancelledThrough(value.participant, value.generation) ?? -1;
            if (through <= prior) return false;
            run('INSERT INTO delivery_cancellations(participant_key_json,generation_json,through_index) VALUES(?,?,?) ON CONFLICT(participant_key_json,generation_json) DO UPDATE SET through_index=excluded.through_index', [key(value.participant), encode(value.generation), through]);
            deliveryChanged = true;
            return true;
        },
        applyLanding(effect) {
            const a = validateStoredActivity(effect.activity);
            requireFact(a.index >= read.header().nextActIndex && a.index < Number.MAX_SAFE_INTEGER, 'activity index cannot advance.');
            const { index, at, kind, actor, reach, reply, ...payload } = a as StoredAct & {
                actor?: string;
                reach?: string;
                reply?: number;
            };
            run('INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) VALUES(?,?,?,?,?,?,?,?)', [index, at, kind, actor === undefined ? null : encode(actor), actor === undefined ? null : key(actor), reach ?? null, reply ?? null, encode(payload)]);
            if (effect.participant) {
                const p = effect.participant;
                string(p.name, true);
                integer(p.firstIndex);
                integer(p.sayCount);
                requireFact(typeof p.joined === 'boolean' && typeof p.done === 'boolean' && !(p.joined && p.done));
                if (p.lastActiveAt !== undefined)
                    finite(p.lastActiveAt);
                if (p.lastJoinIndex !== undefined)
                    integer(p.lastJoinIndex);
                run('INSERT INTO participants(name_key_json,name_json,first_index,joined,done,say_count,last_active_at,last_join_index) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name_key_json) DO UPDATE SET joined=excluded.joined,done=excluded.done,say_count=excluded.say_count,last_active_at=excluded.last_active_at,last_join_index=excluded.last_join_index', [key(p.name), encode(p.name), p.firstIndex, Number(p.joined), Number(p.done), p.sayCount, p.lastActiveAt ?? null, p.lastJoinIndex ?? null]);
            }
            if (effect.removeListeningOf !== undefined)
                run("DELETE FROM attention WHERE listener_key_json=? AND kind='listen'", [key(effect.removeListeningOf)]);
            if (effect.removeListening !== undefined) {
                const target = effect.removeListening;
                string(target.listener, true);
                string(target.target, true);
                run("DELETE FROM attention WHERE listener_key_json=? AND target_key_json=? AND kind='listen'", [key(target.listener), key(target.target)]);
            }
            if (effect.replaceAttention) {
                const t = effect.replaceAttention;
                string(t.listener, true);
                string(t.target, true);
                integer(t.sinceIndex);
                requireFact(t.kind === 'listen' || t.kind === 'ignore');
                run('INSERT INTO attention(listener_key_json,target_key_json,target_json,kind,since_index) VALUES(?,?,?,?,?) ON CONFLICT(listener_key_json,target_key_json) DO UPDATE SET target_json=excluded.target_json,kind=excluded.kind,since_index=excluded.since_index', [key(t.listener), key(t.target), encode(t.target), t.kind, t.sinceIndex]);
            }
            effect.audience.forEach((r, order) => run('INSERT INTO landed_audience(act_index,recipient_key_json,recipient_order,route) VALUES(?,?,?,?)', [index, key(r.recipient), order, r.route]));
            run('UPDATE square_meta SET next_act_index=? WHERE id=1', [index + 1]);
            changed = true;
        },
        markSeen(name, indexes, at) {
            finite(at);
            const next = read.header().nextActIndex;
            indexes.forEach(index => requireFact(integer(index) < next, 'receipt references an unassigned activity index.'));
            let count = 0;
            const encoded = encode(owner(name));
            string(owner(name), true);
            for (const index of indexes)
                count += run('INSERT OR IGNORE INTO receipts(owner_json,act_index,at) VALUES(?,?,?)', [encoded, index, at]);
            if (count)
                changed = true;
            return count;
        },
        putLease(name, value, generation) {
            const l = validateWatchLease(value), canonical = owner(name);
            const old = read.lease(canonical), row = one('SELECT generation_json FROM catch_leases WHERE owner_json=?', [encode(canonical)]);
            if (generation !== undefined) activityId(generation);
            if (row !== undefined && generation !== undefined && decoded(row.generation_json) !== '' && decoded(row.generation_json) !== generation)
                return false;
            if (old && stableJson(old) === stableJson(l) && (generation === undefined || row?.generation_json === encode(generation))) return false;
            string(canonical, true);
            run('INSERT INTO catch_leases(owner_json,generation_json,lease_id_json,heartbeat_at,expires_at,filter_json) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_json) DO UPDATE SET generation_json=excluded.generation_json,lease_id_json=excluded.lease_id_json,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at,filter_json=excluded.filter_json', [encode(canonical), encode(generation ?? ''), encode(l.leaseId), l.heartbeatAt, l.expiresAt, l.filter === undefined ? null : encode(l.filter)]);
            changed = true;
            return true;
        },
        removeLease(name, expected, generation) {
            const canonical = owner(name), row = one('SELECT generation_json FROM catch_leases WHERE owner_json=? AND lease_id_json=?', [encode(canonical), encode(expected)]);
            if (row === undefined || generation !== undefined && decoded(row.generation_json) !== generation) return false;
            const count = run('DELETE FROM catch_leases WHERE owner_json=? AND lease_id_json=? AND generation_json=?', [encode(canonical), encode(expected), row.generation_json]);
            if (count)
                changed = true;
            return count > 0;
        },
    };
    const delivery = {
        claimDelivery(input: DeliveryClaimInput): DeliveryClaimResult {
            requireFact(input.kind === 'wake' || input.kind === 'presentation');
            const index = activityIndex(input.activity);
            finite(input.at);
            const leaseMs = integer(input.leaseMs, 1);
            string(input.claimToken, true);
            if (input.route !== undefined) wakeAddress(input.route);
            if (read.activity(index)?.kind !== 'say' || read.directedAt(input.seat.participant, index) === undefined) return { status: 'stale' };
            const cancelledThrough = read.cancelledThrough(input.seat.participant, input.seat.generation);
            if (cancelledThrough !== undefined && index <= cancelledThrough) return { status: 'stale' };
            const rows = all('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND act_index=? AND kind=? ORDER BY attempt_n DESC', [key(input.seat.participant), encode(input.seat.generation), index, input.kind]);
            const decoded = rows.map(deliveryEvidence);
            const terminal = decoded.find((row) => input.kind === 'wake'
                ? row.outcome === 'accepted' || row.outcome === 'unknown'
                : row.outcome === 'presented' || row.outcome === 'unknown');
            if (terminal !== undefined) return { status: 'terminal', evidence: terminal };
            const dispatching = decoded.find((row) => row.outcome === 'dispatching');
            if (dispatching !== undefined && (dispatching.expiresAt === undefined || dispatching.expiresAt > input.at)) return { status: 'busy', evidence: dispatching };
            if (dispatching !== undefined) {
                const updated = { ...dispatching, outcome: 'unknown' as const, at: input.at, expiresAt: undefined, diagnostic: 'interrupted dispatch' };
                const source = rows.find((row) => row.attempt_n === dispatching.attemptN)!;
                run('UPDATE delivery_evidence SET outcome=?,at=?,expires_at=NULL,payload_json=? WHERE participant_key_json=? AND generation_json=? AND act_index=? AND kind=? AND attempt_n=?', ['unknown', input.at, encode({ ...object(json(source.payload_json)), diagnostic: 'interrupted dispatch' }), key(input.seat.participant), encode(input.seat.generation), index, input.kind, dispatching.attemptN]);
                deliveryChanged = true;
                return { status: 'terminal', evidence: updated };
            }
            const attemptN = (decoded[0]?.attemptN ?? -1) + 1;
            const payload = input.route === undefined ? {} : { route: input.route };
            const expiry = finite(input.at + leaseMs);
            run('INSERT INTO delivery_evidence(participant_key_json,participant_json,generation_json,act_index,kind,attempt_n,outcome,at,expires_at,claim_token_json,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [key(input.seat.participant), encode(input.seat.participant), encode(input.seat.generation), index, input.kind, attemptN, 'dispatching', input.at, expiry, encode(input.claimToken), encode(payload)]);
            deliveryChanged = true;
            return { status: 'acquired', claimToken: input.claimToken, attemptN };
        },
        prepareDelivery(input: DeliveryPreparation): boolean {
            const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (row === undefined || row.outcome !== 'dispatching') return false;
            const correlation = nativeCorrelation(input.correlation);
            const payload = object(json(row.payload_json));
            if (stableJson(payload.correlation ?? null) === stableJson(correlation)) return true;
            const count = run('UPDATE delivery_evidence SET payload_json=? WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [encode({ ...payload, correlation }), key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (count) deliveryChanged = true;
            return count > 0;
        },
        completeDelivery(input: DeliveryCompletion): boolean {
            const index = activityIndex(input.activity);
            finite(input.at);
            requireFact(['accepted', 'failed', 'unknown', 'released', 'presented', 'clipped'].includes(input.outcome));
            string(input.claimToken, true);
            const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND act_index=? AND claim_token_json=?', [key(input.seat.participant), encode(input.seat.generation), index, encode(input.claimToken)]);
            if (row === undefined) return false;
            if (row.outcome === 'accepted' && input.outcome === 'accepted') return true;
            if (row.outcome !== 'dispatching' && !(row.outcome === 'unknown' && input.outcome === 'accepted')) return false;
            const previous = object(json(row.payload_json));
            const payload = { ...previous, ...(input.signature === undefined ? {} : { signature: input.signature }), ...(input.message === undefined ? {} : { message: input.message }), ...(input.diagnostic === undefined ? {} : { diagnostic: input.diagnostic }), ...(input.correlation === undefined ? {} : { correlation: input.correlation }) };
            const count = run('UPDATE delivery_evidence SET outcome=?,at=?,expires_at=NULL,payload_json=? WHERE participant_key_json=? AND generation_json=? AND act_index=? AND claim_token_json=?', [input.outcome, input.at, encode(payload), key(input.seat.participant), encode(input.seat.generation), index, encode(input.claimToken)]);
            if (count) deliveryChanged = true;
            return count > 0;
        },
        observeNativeDelivery(input: { readonly seat: SeatRef; readonly claimToken: string; readonly observation: NonNullable<DeliveryEvidence['nativeObservations']>[number] }): boolean {
            const row = one('SELECT * FROM delivery_evidence WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (row === undefined || !['dispatching', 'accepted', 'unknown'].includes(string(row.outcome))) return false;
            const observation = input.observation;
            requireFact(typeof observation.eventId === 'string' && observation.eventId.length > 0);
            requireFact(typeof observation.messageId === 'string' && observation.messageId.length > 0);
            requireFact(observation.state === 'held' || observation.state === 'released' || observation.state === 'dropped');
            finite(observation.observedAt);
            if (observation.reason !== undefined) string(observation.reason);
            const payload = object(json(row.payload_json));
            const observations = payload.nativeObservations === undefined ? [] : payload.nativeObservations;
            requireFact(Array.isArray(observations));
            if (observations.some((item) => object(item).eventId === observation.eventId)) return true;
            const next = [...observations, observation];
            const count = run('UPDATE delivery_evidence SET payload_json=? WHERE participant_key_json=? AND generation_json=? AND claim_token_json=?', [encode({ ...payload, nativeObservations: next }), key(input.seat.participant), encode(input.seat.generation), encode(input.claimToken)]);
            if (count) deliveryChanged = true;
            return count > 0;
        },
    };
    return Object.defineProperties(Object.assign(read, writes, delivery), {
        changed: { get: () => changed },
        deliveryChanged: { get: () => deliveryChanged },
    }) as unknown as SqliteDriver;
}
/** Explicit import only. Caller owns transaction, legacy validation and format publication. */
export function initializeSqlite(db: DatabaseSync, state: SquareState, revision = 0): void {
    integer(revision);
    integer(state.runtime.nextActIndex);
    if (state.hardCap !== null) integer(state.hardCap, 1);
    if (state.throttlePerMinute !== undefined) integer(state.throttlePerMinute, 1);
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO square_meta(id,revision,delivery_revision,next_act_index,hard_cap,throttle_per_minute,preamble_json,warmup_json) VALUES(1,?,0,0,?,?,?,?)').run(revision, state.hardCap, state.throttlePerMinute ?? null, encode(strings(state.preamble)), encode(strings(state.warmup)));
    const driver = createSqliteDriver(db);
    for (const activity of state.acts)
        driver.applyLanding(deriveLanding(validateStoredActivity(activity), landingFacts(driver, activity)));
    requireFact(state.runtime.nextActIndex > driver.header().lastActIndex, 'nextActIndex is behind the activity history.');
    db.prepare('UPDATE square_meta SET next_act_index=? WHERE id=1').run(state.runtime.nextActIndex);
    const insert = db.prepare('INSERT INTO receipts(owner_json,act_index,at) VALUES(?,?,?)');
    for (const [owner, observations] of Object.entries(state.runtime.observations)) {
        string(owner, true);
        for (const [id, observation] of Object.entries(observations)) {
            const match = /^act\/(0|[1-9][0-9]*)$/.exec(id);
            requireFact(match, 'malformed receipt coordinate.');
            const index = integer(Number(match[1]));
            requireFact(index < state.runtime.nextActIndex, 'receipt references an unassigned activity index.');
            requireFact(observation.state === 'seen');
            insert.run(encode(owner), index, finite(observation.at));
        }
    }
    for (const [owner, value] of Object.entries(state.runtime.leases)) {
        string(owner, true);
        const l = validateWatchLease(value);
        db.prepare('INSERT INTO catch_leases(owner_json,lease_id_json,heartbeat_at,expires_at,filter_json) VALUES(?,?,?,?,?)').run(encode(owner), encode(l.leaseId), l.heartbeatAt, l.expiresAt, l.filter === undefined ? null : encode(l.filter));
    }
}
export function exportSqliteState(db: DatabaseSync): SquareState {
    const d = createSqliteDriver(db), h = d.header();
    const observations: SquareState['runtime']['observations'] = {}, leases: Record<string, WatchLease> = {};
    for (const row of db.prepare('SELECT * FROM receipts').all() as Row[]) {
        const owner = decoded(row.owner_json, true), index = integer(row.act_index);
        requireFact(index < h.nextActIndex, 'receipt references an unassigned activity index.');
        if (!Object.hasOwn(observations, owner))
            Object.defineProperty(observations, owner, {
                value: {}, enumerable: true, writable: true
            });
        observations[owner][`act/${index}`] = { state: 'seen', at: finite(row.at) };
    }
    for (const row of db.prepare('SELECT * FROM catch_leases').all() as Row[]) {
        const owner = decoded(row.owner_json, true);
        Object.defineProperty(leases, owner, { value: validateWatchLease({
                leaseId: decoded(row.lease_id_json, true), heartbeatAt: finite(row.heartbeat_at), expiresAt: finite(row.expires_at), ...(row.filter_json === null ? {} : { filter: json(row.filter_json) })
            }), enumerable: true });
    }
    return {
        hardCap: h.hardCap, ...(h.throttlePerMinute === undefined ? {} : { throttlePerMinute: h.throttlePerMinute }), preamble: [...h.preamble], warmup: [...h.warmup], acts: (db.prepare('SELECT * FROM activities ORDER BY act_index').all() as Row[]).map(activity), runtime: {
            nextActIndex: h.nextActIndex, observations, leases
        }
    };
}
/** Full read-only integrity inspection, including maintained-index replay comparison. */
export function inspectSqlite(db: DatabaseSync): {
    standingCount: number;
} {
    const check = db.prepare('PRAGMA integrity_check').all() as Row[];
    requireFact(check.length === 1 && check[0].integrity_check === 'ok', 'SQLite integrity check failed.');
    const state = exportSqliteState(db), d = createSqliteDriver(db);
    d.roster();
    for (const p of d.roster()) {
        d.attention(p.name);
        d.incomingAttention(p.name);
    }
    for (const a of state.acts)
        d.audience(a.index);
    // A transient memory database checks derived indices without altering authority.
    const rebuilt = new MemoryDatabase(':memory:');
    try {
        initializeSqlite(rebuilt, state, d.header().revision);
        for (const table of ['participants', 'attention', 'landed_audience']) {
            const original = db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
            const expected = rebuilt.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
            requireFact(stableJson(original) === stableJson(expected), `derived ${table} index is inconsistent.`);
        }
        return { standingCount: d.roster().filter(p => p.joined).length };
    }
    finally {
        rebuilt.close();
    }
}
