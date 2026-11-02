import { DatabaseSync as MemoryDatabase, type DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { validateActivityMetadata, activityMetadataHasContent, type ActivityMetadata, type ActivityObservation, type HardCap, type Seat, type StoredAct, type HydratedAct, type SayRelation, type WakeAddress, type WatchLease } from './model.js';
import type { SquareHeader, SquareRead, ParticipantFact, AttentionFact, ActivityHead, ActivityFilter, DirectedFilter, DirectedHead } from './ports.js';
import type { ChannelWrite, EndpointFact, EndpointRef } from './channel-ports.js';
import { catchCoverage, deriveLanding, landingFacts, extendLandingCatchCoverage, type LandingWriter } from './square-domain.js';
import { formatActivityId } from './square-core.js';
import { compileSearchPattern } from './search.js';
import type { JsonValue } from './model.js';
import { createChannelSqlite, endpoint, endpointGeneration, messageAddress, deliveryEvidence, deliveryDeferral, receiveClaim } from './sqlite-channel.js';
import { readStorageRevision, initializeStorageMeta, STORAGE_META_SQL, validateSchema } from './sqlite-framing.js';
import type { StoreFormat } from './artifact-store.js';
import { type Row, encode, key, invalidArtifact, requireFact, integer, finite, string, json, object, shape, strings, decoded, immutable, stableJson, pageRows, pageLimit } from './sqlite-values.js';
export { invalidArtifact } from './sqlite-values.js';
export { endpointGeneration } from './sqlite-channel.js';
export const APPLICATION_ID = 0x53515245;
export const CURRENT_USER_VERSION = 11;
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
    acts: HydratedAct[];
    runtime: SquareRuntimeState;
}
export function emptyRuntimeState(nextActIndex = 0): SquareRuntimeState {
    return { nextActIndex, observations: {}, leases: {} };
}

const ACTIVITY_KIND_CHECK = "kind IN ('join','done','say','read','listen','ignore','unlisten')";
/** Agora owns only its allocator/configuration header and social tables; neutral storage owns the revision header. */
export const AGORA_SCHEMA_SQL = `CREATE TABLE square_meta (
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
  kind TEXT NOT NULL CHECK (${ACTIVITY_KIND_CHECK}),
  actor_json TEXT COLLATE BINARY NOT NULL,
  actor_key_json TEXT COLLATE BINARY NOT NULL,
  reach TEXT CHECK (reach = 'bell'),
  reply_index INTEGER CHECK (reply_index >= 0 AND reply_index < act_index),
  message_index INTEGER CHECK (message_index IS NULL OR message_index BETWEEN 0 AND 9007199254740991),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  CHECK ((kind = 'say') = (message_index IS NOT NULL)),
  CHECK (kind = 'say' OR (reach IS NULL AND reply_index IS NULL))
);
CREATE INDEX activity_kind_index ON activities(kind, act_index);
CREATE INDEX activity_actor_index ON activities(actor_key_json, act_index);
CREATE INDEX activity_say_actor_index ON activities(actor_key_json, act_index) WHERE kind='say';
CREATE INDEX activity_say_time ON activities(at, act_index) WHERE kind='say';
CREATE INDEX activity_bell_actor_time ON activities(actor_key_json, at, act_index) WHERE kind='say' AND reach='bell';
CREATE UNIQUE INDEX activity_message ON activities(message_index) WHERE message_index IS NOT NULL;
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
  PRIMARY KEY (act_index, recipient_key_json),
  UNIQUE (act_index, recipient_order)
) WITHOUT ROWID;
CREATE INDEX audience_recipient ON landed_audience(recipient_key_json, act_index);`;
export interface AgoraConfig { readonly hardCap?: number | null; readonly throttlePerMinute?: number; readonly preamble?: readonly string[]; readonly warmup?: readonly string[] }
export function initializeAgoraSqlite(db: DatabaseSync, configuration: AgoraConfig = {}): void {
    db.exec(AGORA_SCHEMA_SQL);
    db.prepare('INSERT INTO square_meta(id,next_act_index,hard_cap,throttle_per_minute,preamble_json,warmup_json) VALUES(1,0,?,?,?,?)')
        .run(configuration.hardCap ?? null, configuration.throttlePerMinute ?? null, JSON.stringify(configuration.preamble ?? []), JSON.stringify(configuration.warmup ?? []));
}
export function resetAgoraSqlite(db: DatabaseSync): void {
    for (const table of ['landed_audience', 'attention', 'participants', 'activities', 'square_meta']) db.exec(`DROP TABLE ${table}`);
}
/** The lower schema is supplied by the composition root; Agora never defines Channel tables. */
export interface LowerSchema { readonly schemaSql: string; initialize(db: DatabaseSync): void; reset(db: DatabaseSync): void }
function validateSquareFraming(db: DatabaseSync, lower: LowerSchema, location = ''): void {
    const identity = db.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as Row;
    requireFact(identity.application_id === APPLICATION_ID, 'unrelated SQLite database.');
    requireFact(identity.user_version === CURRENT_USER_VERSION, 'unsupported SQLite format version; this build opens only fresh format-11 squares.');
    validateSchema(db, [STORAGE_META_SQL, lower.schemaSql, AGORA_SCHEMA_SQL].join('\n'), location);
}
/** Explicit full-Square framing and reset, composed from the neutral store and the supplied Channel schema. */
export function squareStoreFormat(lower: LowerSchema, resetStorage: (db: DatabaseSync) => void): StoreFormat {
    return {
        applicationId: APPLICATION_ID, userVersion: CURRENT_USER_VERSION, observerKey: 'square',
        validate: (db, location) => validateSquareFraming(db, lower, location),
        reset(db) { lower.reset(db); resetAgoraSqlite(db); resetStorage(db); },
    };
}

const kinds = ['join', 'done', 'say', 'read', 'listen', 'ignore', 'unlisten'];
function head(row: Row): ActivityHead {
    const index = integer(row.act_index), at = finite(row.at);
    requireFact(kinds.includes(string(row.kind)));
    const actor = decoded(row.actor_json, true);
    requireFact(row.actor_key_json === key(actor));
    requireFact(row.reach === null || row.kind === 'say' && row.reach === 'bell');
    if (row.reply_index !== null)
        requireFact(row.kind === 'say' && integer(row.reply_index) < index);
    const messageIndex = row.message_index === null || row.message_index === undefined ? undefined : integer(row.message_index);
    requireFact((row.kind === 'say') === (messageIndex !== undefined));
    return immutable({
        index, at, kind: row.kind as StoredAct['kind'], actor, ...(row.reach === null ? {} : { reach: 'bell' as const }), ...(row.reply_index === null ? {} : { reply: row.reply_index as number }),
        ...(messageIndex === undefined ? {} : { messageIndex }),
    });
}
/** A persisted upper activity. A say is a relation: it may not carry content and must name its message. */
export function validateStoredActivity(value: unknown): StoredAct {
    const a = object(value);
    integer(a.index);
    finite(a.at);
    requireFact(kinds.includes(string(a.kind)));
    const common = ['kind', 'at', 'index', 'actor'];
    string(a.actor, true);
    switch (a.kind) {
        case 'say':
            shape(a, [...common], ['mentions', 'reach', 'reply', 'messageIndex']);
            requireFact(Object.hasOwn(a, 'messageIndex'), 'say is missing its message.');
            if (Object.hasOwn(a, 'mentions'))
                strings(a.mentions);
            if (Object.hasOwn(a, 'reach'))
                requireFact(a.reach === 'bell');
            if (Object.hasOwn(a, 'reply'))
                requireFact(integer(a.reply) < (a.index as number));
            integer(a.messageIndex);
            break;
        case 'done':
            shape(a, common, ['body']);
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
        default: shape(a, common);
    }
    return value as StoredAct;
}
/** The explicit upper projection of a stored say onto its authoritative message content. */
export function validateHydratedActivity(value: unknown): HydratedAct {
    const a = object(value);
    if (a.kind !== 'say') return validateStoredActivity(a);
    const { body, metadata, ...relation } = a;
    const stored = validateStoredActivity(relation) as SayRelation;
    if (body !== undefined) string(body);
    if (metadata !== undefined) {
        try { validateActivityMetadata(metadata); }
        catch { throw invalidArtifact('say metadata is malformed.'); }
    }
    requireFact((typeof body === 'string' && body.trim() !== '') || activityMetadataHasContent(metadata as ActivityMetadata | undefined), 'say must contain a non-empty body or non-empty metadata.');
    return { ...stored, ...(body === undefined ? {} : { body: body as string }), ...(metadata === undefined ? {} : { metadata: metadata as ActivityMetadata }) };
}
/** Stored Agora relation only: say content lives in its linked Channel message. */
function activity(row: Row): StoredAct {
    const h = head(row), payload = object(json(row.payload_json));
    // Payload cannot shadow indexed structural columns or message-owned content.
    const allowed = h.kind === 'say' ? ['mentions'] : h.kind === 'done' ? ['body'] : h.kind === 'read' ? ['through'] : h.kind === 'listen' || h.kind === 'ignore' || h.kind === 'unlisten' ? ['target'] : [];
    requireFact(Object.keys(payload).every(k => allowed.includes(k)));
    return immutable(validateStoredActivity({ ...h, ...payload }));
}
/** Explicit upper projection: the stored say plus its authoritative Channel content. */
function activityWithContent(row: Row): HydratedAct {
    const stored = activity(row);
    if (stored.kind !== 'say') return stored;
    requireFact(row.body_json !== null && row.body_json !== undefined, 'say message is missing.');
    const metadata = row.metadata_json === null || row.metadata_json === undefined ? undefined : json(row.metadata_json);
    const body = decoded(row.body_json);
    return immutable(validateHydratedActivity({ ...stored,
        ...(body === '' ? {} : { body }), ...(metadata === undefined ? {} : { metadata }) }));
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
export function readSquareHeader(db: DatabaseSync): SquareHeader {
    const rows = db.prepare('SELECT m.*, (SELECT COALESCE(MAX(act_index),-1) FROM activities) AS last_act_index FROM square_meta m').all() as Row[];
    requireFact(rows.length === 1 && rows[0].id === 1, 'header row is malformed.');
    const r = rows[0], nextActIndex = integer(r.next_act_index), lastActIndex = integer(r.last_act_index, -1);
    requireFact(nextActIndex > lastActIndex, 'nextActIndex is behind the activity history.');
    return immutable({ revision: readStorageRevision(db), deliveryRevision: readStorageRevision(db, true), nextActIndex, lastActIndex,
        hardCap: r.hard_cap === null ? null : integer(r.hard_cap, 1), ...(r.throttle_per_minute === null ? {} : { throttlePerMinute: integer(r.throttle_per_minute, 1) }),
        preamble: strings(json(r.preamble_json)), warmup: strings(json(r.warmup_json)) });
}
interface Selection { sql: string; args: SQLInputValue[]; }
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
    for (const [column, values] of [['act_index', filter.indexes], ['kind', filter.kinds], [filter.actorMatch === 'exact' ? 'actor_json' : 'actor_key_json', filter.actors?.map(name => filter.actorMatch === 'exact' ? encode(name) : key(name))]] as const) {
        if (values !== undefined) {
            if (column === 'act_index')
                values.forEach(v => integer(v));
            add(`${alias}.${column} IN (SELECT value FROM json_each(?))`, encode(values));
        }
    }
    if (filter.metadataMatch !== undefined) {
        // Walk literal object keys, never JSON-path strings or array indexes.
        terms.push(`NOT EXISTS (
            SELECT 1 FROM json_each(?) field WHERE NOT EXISTS (
                WITH RECURSIVE walk(value,type,depth) AS (
                    SELECT CASE WHEN ${alias}.kind='say' THEN json_extract(m.metadata_json,'$') ELSE json_extract(${alias}.payload_json,'$.metadata') END,
                      CASE WHEN ${alias}.kind='say' THEN json_type(m.metadata_json,'$') ELSE json_type(${alias}.payload_json,'$.metadata') END,0
                    UNION ALL
                    SELECT child.value,child.type,walk.depth+1
                    FROM walk JOIN json_each(CASE WHEN walk.type='object' THEN walk.value ELSE '{}' END) child
                      ON child.key=json_extract(field.value,'$.path['||walk.depth||']')
                    WHERE walk.depth<json_array_length(field.value,'$.path')
                )
                SELECT 1 FROM walk WHERE depth=json_array_length(field.value,'$.path')
                  AND (type=json_type(field.value,'$.equals')
                    OR type IN ('integer','real') AND json_type(field.value,'$.equals') IN ('integer','real'))
                  AND value IS json_extract(field.value,'$.equals')
            )
        )`);
        args.push(encode(filter.metadataMatch.fields));
    }
    if (filter.search !== undefined) {
        terms.push(`square_search(?,?,'act/'||${alias}.act_index,${alias}.actor_json,CASE WHEN ${alias}.kind='say' THEN json_extract(m.body_json,'$') ELSE json_extract(${alias}.payload_json,'$.body') END)=1`);
        args.push(filter.search.mode, filter.search.text);
    }
    return { sql: terms.length ? terms.join(' AND ') : '1', args };
}
export interface SqliteDriver extends SquareRead {
    readonly channel: ChannelWrite;
    storeSeat(seat: Seat): boolean;
    removeSeat(seat: EndpointRef): boolean;
    applyLanding(effect: import('./square-domain.js').LandingEffect): void;
    readonly changed: boolean;
    readonly deliveryChanged: boolean;
    /** Explicit import replay: one message for every say, then the activity/audience facts. */
    importLanding(activity: HydratedAct): StoredAct;
}
export function createSqliteDriver(db: DatabaseSync, channelDriver = createChannelSqlite(db)): SqliteDriver {
    let changed = false;
    const all = (sql: string, args: readonly SQLInputValue[] = []): Row[] => db.prepare(sql).all(...args) as Row[];
    const one = (sql: string, args: readonly SQLInputValue[] = []): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
    const run = (sql: string, args: readonly SQLInputValue[] = []): number => Number(db.prepare(sql).run(...args).changes);
    let searchRegistered = false;
    function ensureSearch(): void {
        if (searchRegistered) return;
        const patterns = new Map<string, RegExp>();
        db.function('square_search', { deterministic: true }, (mode, text, index, actor, body) => {
            const cacheKey = encode([mode, text]);
            let pattern = patterns.get(cacheKey);
            if (pattern === undefined) {
                pattern = compileSearchPattern(string(text), mode === 'literal');
                patterns.set(cacheKey, pattern);
            }
            return Number([string(index), decoded(actor, true), body === null ? '' : string(body)]
                .some(field => pattern.test(field)));
        });
        searchRegistered = true;
    }
    function selectActivity(filter: ActivityFilter): Selection {
        if (filter.search !== undefined) ensureSearch();
        return activitySelection(filter);
    }
    const read = {} as SquareRead;
    const channel = channelDriver, channelRead = channel, channelWrite = channel;
    const currentEndpoint = (name: string) => channel.endpoint(name);
    const owner = (requested: string): string => read.participant(requested)?.name ?? requested;
    function directedSelection(recipient: string, filter: DirectedFilter): { base: Selection; participant: ParticipantFact | undefined } {
        const participant = read.participant(recipient), base = selectActivity({ ...filter, actors: filter.senders });
        base.sql += ' AND d.recipient_key_json=?';
        base.args.push(participant ? key(participant.name) : '');
        if (filter.currentGeneration) {
            base.sql += ' AND (ma.generation_json IS NULL OR ma.generation_json=?)';
            base.args.push(participant ? encode(currentEndpoint(participant.name)?.generation ?? '') : '');
        }
        if (filter.unseenOnly) {
            base.sql += ' AND NOT EXISTS (SELECT 1 FROM receipts r WHERE r.owner_key_json=? AND r.msg_index=a.message_index)';
            base.args.push(encode(participant?.name ?? recipient));
        }
        if (filter.attentionOnly) base.sql += " AND d.reason IN ('mention','reply','bell')";
        return { base, participant };
    }
    // ----- Upper Agora read capabilities -----
    const lower = channelRead;
    const readMethods: Omit<SquareRead, 'channel'> = {
        seat(name) { const endpointFact = currentEndpoint(name); return endpointFact === undefined ? undefined : endpointFact; },
        seatsForOwner: (requested) => lower.endpointsForOwner(requested),
        deliveryEvidence: (participant, generation, activity) => lower.deliveryEvidence(participant, generation, activity),
        deliveryByToken: (token) => lower.deliveryByToken(token),
        cancelledThrough(participant, generation) {
            const boundary = lower.cancelledThrough(participant, generation);
            if (boundary === undefined) return undefined;
            if (boundary < 0) return -1;
            const row = one('SELECT MAX(act_index) AS act_index FROM activities WHERE message_index IS NOT NULL AND message_index<=?', [boundary]);
            return row?.act_index === null || row?.act_index === undefined ? -1 : integer(row.act_index);
        },
        header() { return readSquareHeader(db); },
        participant(name) { const r = one('SELECT * FROM participants WHERE name_key_json=?', [key(name)]); return r ? participant(r) : undefined; },
        participantCounts() {
            const r = one('SELECT COUNT(*) AS known, COALESCE(SUM(joined),0) AS joined, COALESCE(SUM(done),0) AS done FROM participants')!;
            return immutable({ known: integer(r.known), joined: integer(r.joined), done: integer(r.done) });
        },
        roster: () => immutable(all('SELECT * FROM participants ORDER BY first_index').map(participant)),
        attention: name => immutable(all('SELECT t.*,p.name_json FROM attention t JOIN participants p ON p.name_key_json=t.listener_key_json WHERE t.listener_key_json=? ORDER BY t.since_index', [key(name)]).map(attention)),
        incomingAttention: name => immutable(all('SELECT t.*,p.name_json FROM attention t JOIN participants p ON p.name_key_json=t.listener_key_json WHERE t.target_key_json=? ORDER BY t.since_index', [key(name)]).map(attention)),
        activity(index) {
            const r = one('SELECT * FROM activities WHERE act_index=?', [integer(index)]);
            return r ? activity(r) : undefined;
        },
        activityByMessage(index) {
            const r = one("SELECT * FROM activities WHERE message_index=? AND kind='say'", [integer(index)]);
            return r ? activity(r) as SayRelation : undefined;
        },
        activityHeads(filter, page) {
            const s = selectActivity(filter), limit = pageLimit(page);
            return pageRows(all(`SELECT a.*,m.body_json,m.metadata_json FROM activities a LEFT JOIN messages m ON m.msg_index=a.message_index WHERE ${s.sql} ORDER BY a.act_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...s.args, limit]), page, head);
        },
        activities(indexes) {
            indexes.forEach(v => integer(v));
            return immutable(all('SELECT a.*,m.body_json,m.metadata_json FROM activities a LEFT JOIN messages m ON m.msg_index=a.message_index WHERE a.act_index IN (SELECT value FROM json_each(?)) ORDER BY a.act_index', [encode(indexes)]).map(activityWithContent));
        },
        activityCount(filter) { const s = selectActivity(filter); return integer(one(`SELECT COUNT(*) AS n FROM activities a LEFT JOIN messages m ON m.msg_index=a.message_index WHERE ${s.sql}`, s.args)!.n); },
        contextIndexes(centers, before, after) {
            integer(before); integer(after);
            const result = new Set<number>();
            for (const center of centers) {
                integer(center);
                if (!one('SELECT act_index FROM activities WHERE act_index=?', [center])) continue;
                result.add(center);
                for (const r of all('SELECT act_index FROM activities WHERE act_index<? ORDER BY act_index DESC LIMIT ?', [center, before])) result.add(integer(r.act_index));
                for (const r of all('SELECT act_index FROM activities WHERE act_index>? ORDER BY act_index LIMIT ?', [center, after])) result.add(integer(r.act_index));
            }
            return immutable([...result].sort((a, b) => a - b));
        },
        sayOrdinals(indexes) {
            indexes.forEach(v => integer(v));
            const result: Record<number, number> = {};
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
            if (actor !== undefined) { where += ' AND actor_key_json=?'; args.push(key(actor)); }
            if (bell) where += " AND reach='bell'";
            args.push(integer(take));
            return immutable(all(`SELECT at FROM activities WHERE ${where} ORDER BY at DESC,act_index DESC LIMIT ?`, args).map(r => finite(r.at)).reverse());
        },
        audience(index) { return immutable(all('SELECT p.name_json,d.reason,ma.generation_json FROM landed_audience d JOIN participants p ON p.name_key_json=d.recipient_key_json JOIN activities a ON a.act_index=d.act_index JOIN message_addresses ma ON ma.msg_index=a.message_index AND ma.recipient_key_json=d.recipient_key_json WHERE d.act_index=? ORDER BY d.recipient_order', [integer(index)]).map(r => ({ recipient: decoded(r.name_json, true), route: routeKind(r.reason), ...(r.generation_json === null ? {} : { generation: endpointGeneration(decoded(r.generation_json, true)) }) }))); },
        directed(recipient, filter, page) {
            const { base, participant: p } = directedSelection(recipient, filter), limit = pageLimit(page);
            const rows = all(`SELECT a.*,m.body_json,m.metadata_json,d.reason,ma.generation_json FROM activities a JOIN messages m ON m.msg_index=a.message_index JOIN landed_audience d ON d.act_index=a.act_index JOIN message_addresses ma ON ma.msg_index=a.message_index AND ma.recipient_key_json=d.recipient_key_json WHERE ${base.sql} ORDER BY a.act_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...base.args, limit]);
            return pageRows(rows, page, r => {
                const h = head(r);
                return { index: h.index, at: h.at, actor: h.actor, recipient: p?.name ?? recipient,
                    route: routeKind(r.reason), messageIndex: h.messageIndex!,
                    ...(r.generation_json === null ? {} : { generation: endpointGeneration(decoded(r.generation_json, true)) }) };
            }) as never;
        },
        directedAt(recipient, index) { return read.directed(recipient, { afterIndex: integer(index) - 1, throughIndex: index }, { edge: 'oldest', limit: 1 }).items[0]; },
        directedCount(recipient, filter) {
            const { base } = directedSelection(recipient, filter);
            return integer(one(`SELECT COUNT(*) AS n FROM activities a LEFT JOIN messages m ON m.msg_index=a.message_index JOIN landed_audience d ON d.act_index=a.act_index JOIN message_addresses ma ON ma.msg_index=a.message_index AND ma.recipient_key_json=d.recipient_key_json WHERE ${base.sql}`, base.args)!.n);
        },
        receipt(name, index) {
            const r = one('SELECT r.at FROM receipts r JOIN activities a ON a.message_index=r.msg_index WHERE r.owner_key_json=? AND a.act_index=?', [encode(owner(name)), integer(index)]);
            return r ? immutable({ at: finite(r.at) }) : undefined;
        },
        receiptFacts(name, afterIndex) {
            const k = encode(owner(name));
            const r = one('SELECT MAX(at) AS latest FROM receipts WHERE owner_key_json=?', [k])!;
            const e = one('SELECT MAX(a.act_index) AS latest FROM receipts r JOIN activities a ON a.message_index=r.msg_index WHERE r.owner_key_json=? AND a.act_index>?', [k, integer(afterIndex, -1)])!;
            return immutable({ ...(r.latest === null ? {} : { latestAt: finite(r.latest) }), ...(e.latest === null ? {} : { latestActorActivityIndex: integer(e.latest) }) });
        },
        lease(name) {
            const lease = lower.claimLease(name, 'agora');
            if (lease === undefined) return undefined;
            const selector = object(lease.selector);
            const parsed: Record<string, unknown> = { leaseId: lease.id, heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt };
            if (selector.filter !== undefined) parsed.filter = selector.filter;
            return immutable(validateWatchLease(parsed));
        },
        deliveryDeferrals: (participant, generation) => lower.deliveryDeferrals(participant, generation),
    };
    Object.assign(read, readMethods, { channel: channelRead });

    // ----- Upper Agora writes / landing -----
    const writes: LandingWriter = {
        channel: channelWrite,
        storeSeat(value) { return channelWrite.storeEndpoint(value); },
        updateWakeAddress(value: EndpointRef, wakeAddress?: WakeAddress) { return channelWrite.updateWakeAddress(value, wakeAddress); },
        reattachSeat(value, address) { return channelWrite.reattachEndpoint(value, address); },
        detachSeat(value) { return channelWrite.detachEndpoint(value); },
        removeSeat(value) { return channelWrite.removeEndpoint(value); },
        applyLanding(effect) {
            const a = validateStoredActivity(effect.activity);
            requireFact(a.index >= read.header().nextActIndex && a.index < Number.MAX_SAFE_INTEGER, 'activity index cannot advance.');
            const { index, at, kind, actor, reach, reply, messageIndex, ...payload } = a as StoredAct & { actor?: string; reach?: string; reply?: number; messageIndex?: number };
            const storedPayload = payload;
            run('INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,message_index,payload_json) VALUES(?,?,?,?,?,?,?,?,?)', [index, at, kind, encode(actor), key(actor), reach ?? null, reply ?? null, messageIndex ?? null, encode(storedPayload)]);
            // One message address per landed recipient is written by land() through publishMessage.
            effect.audience.forEach((address, order) => {
                run('INSERT INTO landed_audience(act_index,recipient_key_json,recipient_order,reason) VALUES(?,?,?,?)', [index, key(address.recipient), order, address.route]);
            });
            if (effect.participant) {
                const p = effect.participant;
                string(p.name, true); integer(p.firstIndex); integer(p.sayCount);
                requireFact(typeof p.joined === 'boolean' && typeof p.done === 'boolean' && !(p.joined && p.done));
                if (p.lastActiveAt !== undefined) finite(p.lastActiveAt);
                if (p.lastJoinIndex !== undefined) integer(p.lastJoinIndex);
                run('INSERT INTO participants(name_key_json,name_json,first_index,joined,done,say_count,last_active_at,last_join_index) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(name_key_json) DO UPDATE SET joined=excluded.joined,done=excluded.done,say_count=excluded.say_count,last_active_at=excluded.last_active_at,last_join_index=excluded.last_join_index', [key(p.name), encode(p.name), p.firstIndex, Number(p.joined), Number(p.done), p.sayCount, p.lastActiveAt ?? null, p.lastJoinIndex ?? null]);
            }
            if (effect.removeListeningOf !== undefined) run("DELETE FROM attention WHERE listener_key_json=? AND kind='listen'", [key(effect.removeListeningOf)]);
            if (effect.removeListening !== undefined) {
                const target = effect.removeListening;
                string(target.listener, true); string(target.target, true);
                run("DELETE FROM attention WHERE listener_key_json=? AND target_key_json=? AND kind='listen'", [key(target.listener), key(target.target)]);
            }
            if (effect.replaceAttention) {
                const t = effect.replaceAttention;
                string(t.listener, true); string(t.target, true); integer(t.sinceIndex);
                requireFact(t.kind === 'listen' || t.kind === 'ignore');
                run('INSERT INTO attention(listener_key_json,target_key_json,target_json,kind,since_index) VALUES(?,?,?,?,?) ON CONFLICT(listener_key_json,target_key_json) DO UPDATE SET target_json=excluded.target_json,kind=excluded.kind,since_index=excluded.since_index', [key(t.listener), key(t.target), encode(t.target), t.kind, t.sinceIndex]);
            }
            run('UPDATE square_meta SET next_act_index=? WHERE id=1', [index + 1]);
            extendLandingCatchCoverage(read, channelWrite.putReceiveClaim, a, effect.audience);
            changed = true;
        },
        putLease(name, value, generation, suppressed) {
            const l = validateWatchLease(value), canonical = owner(name);
            if (generation !== undefined) endpointGeneration(generation);
            const existing = channelRead.claimLease(canonical, 'agora');
            if (existing !== undefined && generation !== undefined && existing.generation !== generation) return false;
            return channelWrite.putReceiveClaim({ namespace: 'agora', id: l.leaseId, owner: canonical,
                generation: generation ?? existing?.generation ?? currentEndpoint(canonical)?.generation ?? 'detached',
                selector: { ...(l.filter === undefined ? {} : { filter: l.filter }) } as unknown as JsonValue,
                suppressed: suppressed ?? [], heartbeatAt: l.heartbeatAt, expiresAt: l.expiresAt });
        },
        removeLease(name, expected, generation) {
            const canonical = owner(name), existing = channelRead.claimLease(canonical, 'agora');
            if (existing === undefined || existing.id !== expected || generation !== undefined && existing.generation !== generation) return false;
            return channelWrite.removeReceiveClaim(canonical, 'agora', expected);
        },
    };

    function importLanding(activityValue: HydratedAct): StoredAct {
        const validated = validateHydratedActivity(activityValue);
        if (validated.kind !== 'say') {
            const effect = deriveLanding(validated, landingFacts(read, validated));
            driver.applyLanding(effect);
            // Imported custody: a join establishes the endpoint its activity coordinate names; a done drops it.
            if (validated.kind === 'join')
                channelWrite.storeEndpoint({ participant: validated.actor, owner: 'import', generation: formatActivityId(validated.index), attachment: 'attached' });
            else if (validated.kind === 'done') {
                const current = channelRead.endpoint(validated.actor);
                if (current !== undefined) channelWrite.removeEndpoint(current);
            }
            return validated;
        }
        const effect = deriveLanding(validated, landingFacts(read, validated));
        const published = channelWrite.publishMessage({ from: validated.actor, at: validated.at,
            body: validated.body ?? '', ...(validated.metadata === undefined ? {} : { metadata: validated.metadata }),
            to: effect.audience.map(({ recipient, generation }) => ({ recipient, ...(generation === undefined ? {} : { generation }) })) });
        const landed: SayRelation = { kind: 'say', index: validated.index, at: validated.at, actor: validated.actor, messageIndex: published.index,
            ...(validated.mentions === undefined ? {} : { mentions: validated.mentions }),
            ...(validated.reach === undefined ? {} : { reach: validated.reach }),
            ...(validated.reply === undefined ? {} : { reply: validated.reply }) };
        driver.applyLanding({ ...effect, activity: landed });
        return landed;
    }
    const driver = Object.defineProperties(Object.assign(read, writes, { channel, importLanding }), {
        changed: { get: () => changed || channel.changed },
        deliveryChanged: { get: () => channel.deliveryChanged },
    }) as unknown as SqliteDriver;
    return driver;
}
/** Explicit import replay. Caller owns the transaction and format publication. */
export function initializeSqlite(db: DatabaseSync, state: SquareState, revision: number, lower: LowerSchema): void {
    integer(revision);
    integer(state.runtime.nextActIndex);
    if (state.hardCap !== null) integer(state.hardCap, 1);
    if (state.throttlePerMinute !== undefined) integer(state.throttlePerMinute, 1);
    initializeStorageMeta(db, revision);
    lower.initialize(db);
    initializeAgoraSqlite(db, { ...state, preamble: strings(state.preamble), warmup: strings(state.warmup) });
    const driver = createSqliteDriver(db);
    for (const activity of state.acts) driver.importLanding(activity);
    requireFact(state.runtime.nextActIndex > driver.header().lastActIndex, 'nextActIndex is behind the activity history.');
    db.prepare('UPDATE square_meta SET next_act_index=? WHERE id=1').run(state.runtime.nextActIndex);
    const insert = db.prepare('INSERT INTO receipts(owner_key_json,msg_index,at) VALUES(?,?,?)');
    for (const [owner, observations] of Object.entries(state.runtime.observations)) {
        string(owner, true);
        for (const [id, observation] of Object.entries(observations)) {
            const match = /^act\/(0|[1-9][0-9]*)$/.exec(id);
            requireFact(match, 'malformed receipt coordinate.');
            const index = integer(Number(match[1]));
            requireFact(index < state.runtime.nextActIndex, 'receipt references an unassigned activity index.');
            requireFact(observation.state === 'seen');
            const activity = driver.activity(index);
            if (activity?.kind !== 'say' || activity.messageIndex === undefined) continue;
            insert.run(encode(owner), activity.messageIndex, finite(observation.at));
        }
    }
    for (const [owner, value] of Object.entries(state.runtime.leases)) {
        string(owner, true);
        const l = validateWatchLease(value), generation = driver.seat(owner)?.generation ?? 'detached';
        db.prepare('INSERT INTO receive_claims(namespace_key_json,owner_key_json,generation_json,claim_id_json,heartbeat_at,expires_at,selector_json,suppressed_json) VALUES(?,?,?,?,?,?,?,?)')
          .run(encode('agora'), encode(owner), encode(generation), encode(l.leaseId), l.heartbeatAt, l.expiresAt, encode({ ...(l.filter === undefined ? {} : { filter: l.filter }) }), encode(catchCoverage(driver, owner, l)));
    }
}
export function exportSqliteState(db: DatabaseSync): SquareState {
    const d = createSqliteDriver(db), h = d.header();
    const observations: SquareState['runtime']['observations'] = {}, leases: Record<string, WatchLease> = {};
    // Receipts are message-coordinate now; export them under the establishing say's activity id.
    for (const row of db.prepare('SELECT r.owner_key_json AS owner_json,r.msg_index AS act_index,r.at FROM receipts r').all() as Row[]) {
        const owner = decoded(row.owner_json, true);
        const say = d.activityByMessage(integer(row.act_index));
        if (say?.kind !== 'say') continue;
        if (!Object.hasOwn(observations, owner))
            Object.defineProperty(observations, owner, { value: {}, enumerable: true, writable: true });
        observations[owner][formatActivityId(say.index)] = { state: 'seen', at: finite(row.at) };
    }
    for (const row of db.prepare("SELECT * FROM receive_claims WHERE namespace_key_json=?").all(encode('agora')) as Row[]) {
        const owner = decoded(row.owner_key_json, true);
        const selector = object(json(row.selector_json));
        Object.defineProperty(leases, owner, { value: validateWatchLease({
            leaseId: decoded(row.claim_id_json, true), heartbeatAt: finite(row.heartbeat_at), expiresAt: finite(row.expires_at), ...(selector.filter === undefined ? {} : { filter: selector.filter })
        }), enumerable: true });
    }
    return {
        hardCap: h.hardCap, ...(h.throttlePerMinute === undefined ? {} : { throttlePerMinute: h.throttlePerMinute }), preamble: [...h.preamble], warmup: [...h.warmup],
        acts: (db.prepare('SELECT a.*,m.body_json,m.metadata_json FROM activities a LEFT JOIN messages m ON m.msg_index=a.message_index ORDER BY a.act_index').all() as Row[]).map(activityWithContent),
        runtime: { nextActIndex: h.nextActIndex, observations, leases }
    };
}
/** Read-only integrity inspection; maintained-index replay runs when the lower schema is supplied. */
export function inspectSqlite(db: DatabaseSync, lower?: LowerSchema): { standingCount: number } {
    return inspectRows(db, endpoint, lower);
}
function inspectRows(db: DatabaseSync, inspectEndpoint: (row: Row) => EndpointFact, lower?: LowerSchema): { standingCount: number } {
    const check = db.prepare('PRAGMA integrity_check').all() as Row[];
    requireFact(check.length === 1 && check[0].integrity_check === 'ok', 'SQLite integrity check failed.');
    const state = exportSqliteState(db), d = createSqliteDriver(db);
    d.roster();
    for (const row of db.prepare('SELECT * FROM endpoints').all() as Row[]) inspectEndpoint(row);
    for (const row of db.prepare('SELECT * FROM delivery_evidence').all() as Row[]) deliveryEvidence(row);
    for (const row of db.prepare('SELECT * FROM delivery_deferrals').all() as Row[]) deliveryDeferral(row);
    for (const row of db.prepare('SELECT * FROM receive_claims').all() as Row[]) receiveClaim(row);
    for (const row of db.prepare('SELECT ma.*,m.msg_index AS existing_msg_index FROM message_addresses ma LEFT JOIN messages m ON m.msg_index=ma.msg_index').all() as Row[]) {
        requireFact(row.existing_msg_index !== null, 'message address references a missing message.');
        messageAddress(row);
    }
    for (const p of d.roster()) { d.attention(p.name); d.incomingAttention(p.name); }
    for (const a of state.acts) if (a.kind === 'say') d.audience(a.index);
    const standingCount = d.roster().filter(p => p.joined).length;
    if (lower === undefined) return { standingCount };
    const rebuilt = new MemoryDatabase(':memory:');
    try {
        initializeSqlite(rebuilt, state, d.header().revision, lower);
        const retainName = rebuilt.prepare('UPDATE participants SET name_json=? WHERE name_key_json=?');
        for (const p of d.roster()) retainName.run(encode(p.name), key(p.name));
        for (const table of ['participants', 'attention', 'landed_audience']) {
            const original = db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
            const expected = rebuilt.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
            requireFact(stableJson(original) === stableJson(expected), `derived ${table} index is inconsistent.`);
        }
        // Only reason-bearing Agora content replays from explicit state. Native Channel messages
        // and their unfenced addresses are not restorable from Agora activities; a null
        // generation stays unfenced here even though current landing would fence a new address.
        const upper = 'JOIN activities a ON a.message_index=ma.msg_index JOIN landed_audience d ON d.act_index=a.act_index';
        for (const [table, select] of [
            ['messages', 'SELECT DISTINCT m.* FROM messages m JOIN activities a ON a.message_index=m.msg_index JOIN landed_audience d ON d.act_index=a.act_index'],
            ['message_addresses', `SELECT DISTINCT ma.* FROM message_addresses ma ${upper} AND d.recipient_key_json=ma.recipient_key_json`],
        ] as const) {
            const original = db.prepare(`${select} ORDER BY 1,2`).all() as Row[];
            const expected = rebuilt.prepare(`${select} ORDER BY 1,2`).all() as Row[];
            const comparable = (rows: Row[]) => table === 'message_addresses'
                ? rows.map(({ generation_json: _generation, recipient_json: _recipient, ...row }) => row) : rows;
            requireFact(stableJson(comparable(original)) === stableJson(comparable(expected)), `derived ${table} index is inconsistent.`);
        }
        const actualAddresses = db.prepare("SELECT a.message_index AS msg_index,ma.recipient_key_json,ma.recipient_order FROM activities a JOIN message_addresses ma ON ma.msg_index=a.message_index WHERE a.kind='say' AND EXISTS (SELECT 1 FROM landed_audience d WHERE d.act_index=a.act_index) ORDER BY 1,2").all();
        const expectedAddresses = db.prepare("SELECT a.message_index AS msg_index,d.recipient_key_json,d.recipient_order FROM activities a JOIN landed_audience d ON d.act_index=a.act_index WHERE a.kind='say' ORDER BY 1,2").all();
        requireFact(stableJson(actualAddresses) === stableJson(expectedAddresses), 'derived message address identity/order is inconsistent.');
        return { standingCount };
    }
    finally {
        rebuilt.close();
    }
}
