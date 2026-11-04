import { type DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { validateActivityMetadata, activityMetadataHasContent, type ActivityMetadata, type ActivityObservation, type HardCap, type Seat, type StoredAct, type HydratedAct, type WatchLease } from './model.js';
import type { SquareHeader, SquareRead, ParticipantFact, AttentionFact, ActivityHead, ActivityFilter, DirectedFilter, DirectedHead } from './ports.js';
import type { SeatRef } from './ports.js';
import { deriveLanding, landingFacts, type LandingWriter } from './square-domain.js';
import { formatActivityId } from './square-core.js';
import { compileSearchPattern } from './search.js';
import { validateEndpointGeneration as endpointGeneration } from './message.js';
import { createProducerDriver, producerSchemaSql, initializeProducerSqlite, resetProducerSqlite } from './square-producer-sqlite.js';
import { readStorageRevision, initializeStorageMeta, STORAGE_META_SQL, validateSchema } from './sqlite-framing.js';
import type { StoreFormat } from './artifact-store.js';
import { type Row, encode, key, invalidArtifact, requireFact, integer, finite, string, json, object, shape, strings, decoded, immutable, pageRows, pageLimit } from './sqlite-values.js';
export { invalidArtifact } from './sqlite-values.js';
export { validateEndpointGeneration as endpointGeneration } from './message.js';
export const APPLICATION_ID = 0x53515245;
export const CURRENT_USER_VERSION = 12;
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
/** Square owns activity, audience, participant, and read-state facts. */
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
export interface AgoraConfig { readonly hardCap?: number | null; readonly throttlePerMinute?: number; readonly preamble?: readonly string[]; readonly warmup?: readonly string[] }
export function initializeAgoraSqlite(db: DatabaseSync, configuration: AgoraConfig = {}): void {
    db.exec(AGORA_SCHEMA_SQL);
    db.prepare('INSERT INTO square_meta(id,next_act_index,hard_cap,throttle_per_minute,preamble_json,warmup_json) VALUES(1,0,?,?,?,?)')
        .run(configuration.hardCap ?? null, configuration.throttlePerMinute ?? null, JSON.stringify(configuration.preamble ?? []), JSON.stringify(configuration.warmup ?? []));
}
export function resetAgoraSqlite(db: DatabaseSync): void {
    for (const table of ['catch_leases', 'caught_activity', 'participant_seats', 'landed_audience', 'attention', 'participants', 'activities', 'square_meta']) db.exec(`DROP TABLE ${table}`);
}
function validateSquareFraming(db: DatabaseSync, location = ''): void {
    const identity = db.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get() as Row;
    requireFact(identity.application_id === APPLICATION_ID, 'unrelated SQLite database.');
    requireFact(identity.user_version === CURRENT_USER_VERSION, 'unsupported SQLite format version; this build opens only fresh format-12 squares.');
    validateSchema(db, [STORAGE_META_SQL, producerSchemaSql, AGORA_SCHEMA_SQL].join('\n'), location);
}
/** Full Square framing and reset, including producer state. */
export function squareStoreFormat(resetStorage: (db: DatabaseSync) => void): StoreFormat {
    return {
        applicationId: APPLICATION_ID, userVersion: CURRENT_USER_VERSION, observerKey: 'square',
        validate: (db, location) => validateSquareFraming(db, location),
        reset(db) { resetProducerSqlite(db); resetAgoraSqlite(db); resetStorage(db); },
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
    return immutable({
        index, at, kind: row.kind as StoredAct['kind'], actor, ...(row.reach === null ? {} : { reach: 'bell' as const }), ...(row.reply_index === null ? {} : { reply: row.reply_index as number }),
    });
}
/** Validate the complete persisted activity. */
export function validateStoredActivity(value: unknown): StoredAct {
    const a = object(value);
    integer(a.index);
    finite(a.at);
    requireFact(kinds.includes(string(a.kind)));
    const common = ['kind', 'at', 'index', 'actor'];
    string(a.actor, true);
    switch (a.kind) {
        case 'say':
            shape(a, [...common], ['mentions', 'reach', 'reply', 'body', 'metadata']);
            if (a.body !== undefined) string(a.body);
            if (a.metadata !== undefined) {
                try { validateActivityMetadata(a.metadata); } catch { throw invalidArtifact('say metadata is malformed.'); }
            }
            requireFact((typeof a.body === 'string' && a.body.trim() !== '') || activityMetadataHasContent(a.metadata as ActivityMetadata | undefined), 'say must contain a non-empty body or non-empty metadata.');
            if (Object.hasOwn(a, 'mentions'))
                strings(a.mentions);
            if (Object.hasOwn(a, 'reach'))
                requireFact(a.reach === 'bell');
            if (Object.hasOwn(a, 'reply'))
                requireFact(integer(a.reply) < (a.index as number));
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
/** Validate complete activity content. */
export function validateHydratedActivity(value: unknown): HydratedAct {
    const a = object(value);
    if (a.kind !== 'say') return validateStoredActivity(a);
    return validateStoredActivity(a);
}
/** Decode an activity with its complete payload. */
function activity(row: Row): StoredAct {
    const h = head(row), payload = object(json(row.payload_json));
    // Payload cannot shadow indexed structural columns.
    const allowed = h.kind === 'say' ? ['mentions', 'body', 'metadata'] : h.kind === 'done' ? ['body'] : h.kind === 'read' ? ['through'] : h.kind === 'listen' || h.kind === 'ignore' || h.kind === 'unlisten' ? ['target'] : [];
    requireFact(Object.keys(payload).every(k => allowed.includes(k)));
    return immutable(validateStoredActivity({ ...h, ...payload }));
}
/** Activity and content are one stored fact. */
function activityWithContent(row: Row): HydratedAct {
    return activity(row);
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
                    SELECT json_extract(${alias}.payload_json,'$.metadata'), json_type(${alias}.payload_json,'$.metadata'),0
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
        terms.push(`square_search(?,?,'act/'||${alias}.act_index,${alias}.actor_json,json_extract(${alias}.payload_json,'$.body'))=1`);
        args.push(filter.search.mode, filter.search.text);
    }
    return { sql: terms.length ? terms.join(' AND ') : '1', args };
}
export interface SqliteDriver extends SquareRead {
    storeSeat(seat: Seat): boolean;
    removeSeat(seat: SeatRef): boolean;
    applyLanding(effect: import('./square-domain.js').LandingEffect): void;
    readonly changed: boolean;
    readonly deliveryChanged: boolean;
    /** Explicit import replay of activity and audience facts. */
    importLanding(activity: HydratedAct): StoredAct;
}
export function createSqliteDriver(db: DatabaseSync): SqliteDriver {
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
    const producer = createProducerDriver(db);
    const currentEndpoint = (name: string): Seat | undefined => {
        const row = one('SELECT * FROM participant_seats WHERE participant_key_json=?', [key(name)]);
        if (!row) return undefined;
        return immutable({ participant: decoded(row.participant_json, true), owner: decoded(row.owner_json, true), generation: endpointGeneration(decoded(row.generation_json, true)), attachment: row.attachment as Seat['attachment'], ...(row.wake_address_json === null ? {} : { wakeAddress: json(row.wake_address_json) as Seat['wakeAddress'] }) });
    };
    function directedSelection(recipient: string, filter: DirectedFilter): { base: Selection; participant: ParticipantFact | undefined } {
        const participant = read.participant(recipient), base = selectActivity({ ...filter, actors: filter.senders });
        base.sql += ' AND d.recipient_key_json=?';
        base.args.push(participant ? key(participant.name) : '');
        if (filter.currentGeneration) {
            base.sql += ' AND (d.generation_json IS NULL OR d.generation_json=?)';
            base.args.push(participant ? encode(currentEndpoint(participant.name)?.generation ?? '') : '');
        }
        if (filter.unseenOnly) {
            base.sql += ' AND NOT EXISTS (SELECT 1 FROM caught_activity r WHERE r.recipient_key_json=? AND r.act_index=a.act_index)';
            base.args.push(key(participant?.name ?? recipient));
        }
        if (filter.attentionOnly) base.sql += " AND d.reason IN ('mention','reply','bell')";
        return { base, participant };
    }
    // ----- Upper Agora read capabilities -----
    const readMethods: SquareRead = {
        pendingPosts: producer.pendingPosts, postedPosts: producer.postedPosts, ownsPost: producer.ownsPost,
        seat: currentEndpoint,
        seatsForOwner: requested => immutable(all('SELECT participant_json FROM participant_seats WHERE owner_json=?', [encode(requested)]).map(row => currentEndpoint(decoded(row.participant_json, true))!)),
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
        activityHeads(filter, page) {
            const s = selectActivity(filter), limit = pageLimit(page);
            return pageRows(all(`SELECT a.* FROM activities a WHERE ${s.sql} ORDER BY a.act_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...s.args, limit]), page, head);
        },
        activities(indexes) {
            indexes.forEach(v => integer(v));
            return immutable(all('SELECT a.* FROM activities a WHERE a.act_index IN (SELECT value FROM json_each(?)) ORDER BY a.act_index', [encode(indexes)]).map(activityWithContent));
        },
        activityCount(filter) { const s = selectActivity(filter); return integer(one(`SELECT COUNT(*) AS n FROM activities a WHERE ${s.sql}`, s.args)!.n); },
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
        audience(index) { return immutable(all('SELECT p.name_json,d.reason,d.generation_json,d.owner_json FROM landed_audience d JOIN participants p ON p.name_key_json=d.recipient_key_json WHERE d.act_index=? ORDER BY d.recipient_order', [integer(index)]).map(r => ({ recipient: decoded(r.name_json, true), route: routeKind(r.reason), ...(r.generation_json === null ? {} : { generation: endpointGeneration(decoded(r.generation_json, true)) }), ...(r.owner_json === null ? {} : { owner: decoded(r.owner_json, true) }) }))); },
        directed(recipient, filter, page) {
            const { base, participant: p } = directedSelection(recipient, filter), limit = pageLimit(page);
            const rows = all(`SELECT a.*,d.reason,d.generation_json FROM activities a JOIN landed_audience d ON d.act_index=a.act_index WHERE ${base.sql} ORDER BY a.act_index ${page.edge === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`, [...base.args, limit]);
            return pageRows(rows, page, r => {
                const h = head(r);
                return { index: h.index, at: h.at, actor: h.actor, recipient: p?.name ?? recipient,
                    route: routeKind(r.reason),
                    ...(r.generation_json === null ? {} : { generation: endpointGeneration(decoded(r.generation_json, true)) }) };
            }) as never;
        },
        directedAt(recipient, index) { return read.directed(recipient, { afterIndex: integer(index) - 1, throughIndex: index }, { edge: 'oldest', limit: 1 }).items[0]; },
        directedCount(recipient, filter) {
            const { base } = directedSelection(recipient, filter);
            return integer(one(`SELECT COUNT(*) AS n FROM activities a JOIN landed_audience d ON d.act_index=a.act_index WHERE ${base.sql}`, base.args)!.n);
        },
        receipt(name, index) {
            const r = one('SELECT at FROM caught_activity WHERE recipient_key_json=? AND act_index=?', [key(name), integer(index)]);
            return r ? immutable({ at: finite(r.at) }) : undefined;
        },
        receiptFacts(name, afterIndex) {
            const k = key(name);
            const r = one('SELECT MAX(at) AS latest FROM caught_activity WHERE recipient_key_json=?', [k])!;
            const e = one('SELECT MAX(act_index) AS latest FROM caught_activity WHERE recipient_key_json=? AND act_index>?', [k, integer(afterIndex, -1)])!;
            return immutable({ ...(r.latest === null ? {} : { latestAt: finite(r.latest) }), ...(e.latest === null ? {} : { latestActorActivityIndex: integer(e.latest) }) });
        },
        lease(name) {
            const row = one('SELECT lease_json FROM catch_leases WHERE recipient_key_json=?', [key(name)]);
            return row ? immutable(validateWatchLease(json(row.lease_json))) : undefined;
        },
    };
    Object.assign(read, readMethods);

    // ----- Upper Agora writes / landing -----
    const writes: LandingWriter = {
        insertNotice: producer.insertNotice, ackMatching: producer.ackMatching,
        acquirePost: producer.acquirePost, settlePost: producer.settlePost, foldReceipt: producer.foldReceipt,
        setSeatAttachment(seat, attachment) {
            const count = run('UPDATE participant_seats SET attachment=? WHERE participant_key_json=? AND owner_json=? AND generation_json=? AND attachment<>?', [attachment, key(seat.participant), encode(seat.owner), encode(seat.generation), attachment]);
            changed ||= count > 0; return count > 0;
        },
        storeSeat(value) {
            run('INSERT INTO participant_seats(participant_key_json,participant_json,owner_json,generation_json,wake_address_json,attachment) VALUES(?,?,?,?,?,?) ON CONFLICT(participant_key_json) DO UPDATE SET participant_json=excluded.participant_json,owner_json=excluded.owner_json,generation_json=excluded.generation_json,wake_address_json=excluded.wake_address_json,attachment=excluded.attachment', [key(value.participant), encode(value.participant), encode(value.owner), encode(value.generation), value.wakeAddress === undefined ? null : encode(value.wakeAddress), value.attachment]);
            changed = true; return true;
        },
        removeSeat(value) {
            const count = run('DELETE FROM participant_seats WHERE participant_key_json=? AND owner_json=? AND generation_json=?', [key(value.participant), encode(value.owner), encode(value.generation)]);
            if (count) run('DELETE FROM catch_leases WHERE recipient_key_json=? AND generation_json=?', [key(value.participant), encode(value.generation)]);
            changed ||= count > 0; return count > 0;
        },
        applyLanding(effect) {
            const a = validateStoredActivity(effect.activity);
            requireFact(a.index >= read.header().nextActIndex && a.index < Number.MAX_SAFE_INTEGER, 'activity index cannot advance.');
            const { index, at, kind, actor, reach, reply, ...payload } = a as StoredAct & { reach?: string; reply?: number };
            run('INSERT INTO activities(act_index,at,kind,actor_json,actor_key_json,reach,reply_index,payload_json) VALUES(?,?,?,?,?,?,?,?)', [index, at, kind, encode(actor), key(actor), reach ?? null, reply ?? null, encode(payload)]);
            effect.audience.forEach((address, order) => {
                run('INSERT INTO landed_audience(act_index,recipient_key_json,recipient_order,reason,owner_json,generation_json) VALUES(?,?,?,?,?,?)', [index, key(address.recipient), order, address.route, address.owner === undefined ? null : encode(address.owner), address.generation === undefined ? null : encode(address.generation)]);
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
            if (kind === 'say') producer.consumeActivity(index, at);
            changed = true;
        },
        putLease(name, value, generation) {
            const l = validateWatchLease(value), seat = currentEndpoint(name);
            if (!seat || generation !== undefined && generation !== seat.generation) return false;
            run('INSERT INTO catch_leases(recipient_key_json,generation_json,lease_json) VALUES(?,?,?) ON CONFLICT(recipient_key_json) DO UPDATE SET generation_json=excluded.generation_json,lease_json=excluded.lease_json', [key(name), encode(seat.generation), encode(l)]);
            changed = true; return true;
        },
        removeLease(name, expected, generation) {
            if (read.lease(name)?.leaseId !== expected || generation !== undefined && currentEndpoint(name)?.generation !== generation) return false;
            const count = run('DELETE FROM catch_leases WHERE recipient_key_json=?', [key(name)]);
            changed ||= count > 0; return count > 0;
        },
        markSeen(name, indexes, at) {
            finite(at); let count = 0;
            for (const index of indexes) count += run('INSERT OR IGNORE INTO caught_activity(recipient_key_json,act_index,at) SELECT recipient_key_json,act_index,? FROM landed_audience WHERE recipient_key_json=? AND act_index=?', [at, key(name), integer(index)]);
            changed ||= count > 0; return count;
        },
    };

    function importLanding(activityValue: HydratedAct): StoredAct {
        const validated = validateHydratedActivity(activityValue);
        driver.applyLanding(deriveLanding(validated, landingFacts(read, validated)));
        if (validated.kind === 'join') driver.storeSeat({ participant: validated.actor, owner: 'import', generation: formatActivityId(validated.index), attachment: 'attached' });
        else if (validated.kind === 'done') { const current = read.seat(validated.actor); if (current) driver.removeSeat(current); }
        return validated;
    }
    const driver = Object.defineProperties(Object.assign(read, writes, { importLanding }), {
        changed: { get: () => changed || producer.changed },
        deliveryChanged: { get: () => producer.deliveryChanged },
    }) as unknown as SqliteDriver;
    return driver;
}
/** Explicit import replay. Caller owns the transaction and format publication. */
export function initializeSqlite(db: DatabaseSync, state: SquareState, revision: number): void {
    integer(revision);
    integer(state.runtime.nextActIndex);
    if (state.hardCap !== null) integer(state.hardCap, 1);
    if (state.throttlePerMinute !== undefined) integer(state.throttlePerMinute, 1);
    initializeStorageMeta(db, revision);
    initializeProducerSqlite(db);
    initializeAgoraSqlite(db, { ...state, preamble: strings(state.preamble), warmup: strings(state.warmup) });
    const driver = createSqliteDriver(db);
    for (const activity of state.acts) driver.importLanding(activity);
    requireFact(state.runtime.nextActIndex > driver.header().lastActIndex, 'nextActIndex is behind the activity history.');
    db.prepare('UPDATE square_meta SET next_act_index=? WHERE id=1').run(state.runtime.nextActIndex);
    const insert = db.prepare('INSERT INTO caught_activity(recipient_key_json,act_index,at) VALUES(?,?,?)');
    for (const [owner, observations] of Object.entries(state.runtime.observations)) {
        string(owner, true);
        for (const [id, observation] of Object.entries(observations)) {
            const match = /^act\/(0|[1-9][0-9]*)$/.exec(id);
            requireFact(match, 'malformed receipt coordinate.');
            const index = integer(Number(match[1]));
            requireFact(index < state.runtime.nextActIndex, 'receipt references an unassigned activity index.');
            requireFact(observation.state === 'seen');
            const activity = driver.activity(index);
            if (activity?.kind !== 'say') continue;
            insert.run(key(owner), index, finite(observation.at));
        }
    }
    for (const [owner, value] of Object.entries(state.runtime.leases)) {
        string(owner, true);
        const l = validateWatchLease(value), generation = driver.seat(owner)?.generation ?? 'detached';
        db.prepare('INSERT INTO catch_leases(recipient_key_json,generation_json,lease_json) VALUES(?,?,?)').run(key(owner), encode(generation), encode(l));
    }
}
export function exportSqliteState(db: DatabaseSync): SquareState {
    const d = createSqliteDriver(db), h = d.header();
    const observations: SquareState['runtime']['observations'] = {}, leases: Record<string, WatchLease> = {};
    for (const row of db.prepare('SELECT p.name_json,r.act_index,r.at FROM caught_activity r JOIN participants p ON p.name_key_json=r.recipient_key_json').all() as Row[]) {
        const owner = decoded(row.name_json, true);
        if (!Object.hasOwn(observations, owner)) Object.defineProperty(observations, owner, { value: {}, enumerable: true, writable: true });
        observations[owner][formatActivityId(integer(row.act_index))] = { state: 'seen', at: finite(row.at) };
    }
    for (const row of db.prepare('SELECT p.name_json,l.lease_json FROM catch_leases l JOIN participants p ON p.name_key_json=l.recipient_key_json').all() as Row[]) {
        Object.defineProperty(leases, decoded(row.name_json, true), { value: validateWatchLease(json(row.lease_json)), enumerable: true });
    }
    return {
        hardCap: h.hardCap, ...(h.throttlePerMinute === undefined ? {} : { throttlePerMinute: h.throttlePerMinute }), preamble: [...h.preamble], warmup: [...h.warmup],
        acts: (db.prepare('SELECT * FROM activities ORDER BY act_index').all() as Row[]).map(activityWithContent),
        runtime: { nextActIndex: h.nextActIndex, observations, leases }
    };
}
/** Read-only integrity inspection. */
export function inspectSqlite(db: DatabaseSync): { standingCount: number } {
    const check = db.prepare('PRAGMA integrity_check').all() as Row[];
    requireFact(check.length === 1 && check[0].integrity_check === 'ok', 'SQLite integrity check failed.');
    const state = exportSqliteState(db), d = createSqliteDriver(db);
    d.roster();
    for (const p of d.roster()) { d.attention(p.name); d.incomingAttention(p.name); }
    for (const a of state.acts) if (a.kind === 'say') d.audience(a.index);
    return { standingCount: d.roster().filter(p => p.joined).length };
}
