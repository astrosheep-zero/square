import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { matchesMetadata, validateMetadataMatch } from './delivery-deferral.js';
import type { MetadataMatch } from './delivery-deferral.js';
import { SquareError, sameName, validateName, validateActivityMetadata, type ActivityMetadata } from './model.js';
import type { SeatRef } from './ports.js';
import type { FutureAck, ProducerRead, ProducerWrite, SendInput, SendResult, SquarePost, SquarePostDisposition } from './square-post.js';
import { decoded, encode, finite, integer, json, key, object, string, type Row } from './sqlite-values.js';

/** Private Square producer bookkeeping, on the artifact's existing connection/transaction. */
export const producerSchemaSql = `CREATE TABLE producer_receipt_watermarks (
  owner_json TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL CHECK (seq BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID;
CREATE TABLE producer_departures (
  participant_key_json TEXT NOT NULL, participant_json TEXT NOT NULL, owner_json TEXT NOT NULL, generation_json TEXT NOT NULL, token TEXT NOT NULL,
  PRIMARY KEY (owner_json,generation_json,participant_key_json)
) WITHOUT ROWID;
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
) WITHOUT ROWID;`;
export function initializeProducerSqlite(db: DatabaseSync): void { db.exec(producerSchemaSql); }
export function resetProducerSqlite(db: DatabaseSync): void {
  for (const table of ['producer_receipt_watermarks', 'producer_departures', 'square_posts', 'producer_consumption', 'notice_audience', 'square_notices']) db.exec(`DROP TABLE ${table}`);
}
function canonicalMatch(match: MetadataMatch): string {
  const fields = validateMetadataMatch(match).fields.map(field => ({ path: [...field.path], equals: field.equals }));
  fields.sort((a, b) => {
    const left = JSON.stringify(a.path), right = JSON.stringify(b.path);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return encode({ fields });
}
const EXPORT_IDENTITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const EXPORT_OWNERSHIP_MS = 60_000;
function withinExportWindow(first: number, now: number): boolean {
  return now >= first && now - first < EXPORT_IDENTITY_WINDOW_MS;
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function createProducerDriver(db: DatabaseSync): ProducerRead & ProducerWrite & {
  readonly changed: boolean; readonly deliveryChanged: boolean;
  recordDeparture(seat: SeatRef): void;
  consumeActivity(index: number, at: number): void;
} {
  let changed = false;
  const rows = (sql: string, args: readonly SQLInputValue[] = []) => db.prepare(sql).all(...args) as Row[];
  const one = (sql: string, args: readonly SQLInputValue[] = []) => db.prepare(sql).get(...args) as Row | undefined;
  const run = (sql: string, args: readonly SQLInputValue[] = []) => {
    const count = Number(db.prepare(sql).run(...args).changes);
    if (count) changed = true;
    return count;
  };
  function authority(seat: SeatRef): void {
    const current = one(`SELECT s.*,p.joined FROM participant_seats s JOIN participants p
      ON p.name_key_json=s.participant_key_json WHERE s.participant_key_json=?`, [key(seat.participant)]);
    if (!current || current.joined !== 1 || current.owner_json !== encode(seat.owner)
      || current.generation_json !== encode(seat.generation) || current.attachment !== 'attached')
      throw new SquareError('already_joined', 'This participant seat is away or has been replaced.', { reason: 'needs_seat' });
  }
  function consumed(post: SquarePost): boolean {
    return rows(`SELECT sender_json,match_json FROM producer_consumption WHERE recipient_key_json=? AND owner_json=? AND generation_json=?`,
      [key(post.recipient), encode(post.owner), encode(post.generation)])
      .some(row => sameName(decoded(row.sender_json, true), post.from) && matchesMetadata(post.metadata, json(row.match_json) as MetadataMatch));
  }
  function consume(post: SquarePost, at: number): number {
    return post.kind === 'activity'
      ? run('INSERT INTO caught_activity(recipient_key_json,act_index,at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [key(post.recipient), post.index, at])
      : run('UPDATE notice_audience SET consumed_at=? WHERE recipient_key_json=? AND notice_index=? AND consumed_at IS NULL', [at, key(post.recipient), post.index]);
  }
  const dispositions = {
    content: false,
    decode(row: Row, kind: SquarePost['kind']): SquarePostDisposition {
      return { kind, index: integer(kind === 'activity' ? row.act_index : row.notice_index),
        recipient: decoded(kind === 'activity' ? row.name_json : row.recipient_json, true),
        owner: decoded(row.owner_json, true), generation: decoded(row.generation_json, true), consumed: row.consumed === 1 };
    },
  };
  const fullPosts = {
    content: true,
    decode(row: Row, kind: SquarePost['kind']): SquarePost {
      const identity = dispositions.decode(row, kind);
      const full = row.full === null ? {} : { full: row.full === 1 };
      if (kind === 'activity') {
        const payload = object(json(row.payload_json));
        return { ...identity, from: decoded(row.actor_json, true), at: finite(row.at),
          ...(payload.body === undefined ? {} : { body: payload.body as string }),
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata as ActivityMetadata }), route: row.reason as SquarePost['route'], ...full };
      }
      return { ...identity, from: decoded(row.sender_json, true), at: finite(row.at),
        body: decoded(row.body_json), ...(row.metadata_json === null ? {} : { metadata: json(row.metadata_json) as ActivityMetadata }), ...full };
    },
  };
  function selectPosts<T>(projection: { readonly content: boolean; decode(row: Row, kind: SquarePost['kind']): T }, mode: 'all' | 'pending' | 'withdrawn' | 'receipt' = 'all', exact?: readonly (Pick<SquarePost, 'kind' | 'index'> & { readonly recipient?: string; readonly generation?: string })[], now?: number): T[] {
    const disposition = (audience: string) => {
      const current = `EXISTS(SELECT 1 FROM participant_seats s JOIN participants p ON p.name_key_json=s.participant_key_json
        WHERE p.joined=1 AND s.participant_key_json=${audience}.recipient_key_json
        AND s.owner_json=${audience}.owner_json AND s.generation_json=${audience}.generation_json)`;
      return mode === 'pending' ? `AND COALESCE(x.posted,0)=0 AND consumed=0 AND ${current}
          AND (x.item_index IS NULL OR (x.first_export_at<=? AND x.first_export_at>? AND x.claim_at<=?))`
        : mode === 'withdrawn' ? `AND x.token IS NOT NULL AND x.posted=0 AND x.first_export_at<=? AND x.first_export_at>?
          AND (consumed=1 OR NOT ${current})` : mode === 'receipt' ? 'AND consumed=0 AND x.full=1' : '';
    };
    const args: SQLInputValue[] = mode === 'pending' ? [finite(now), finite(now) - EXPORT_IDENTITY_WINDOW_MS, finite(now)]
      : mode === 'withdrawn' ? [finite(now), finite(now) - EXPORT_IDENTITY_WINDOW_MS] : [];
    if (exact !== undefined) args.push(encode(exact.map(id => [id.kind, id.index,
      id.recipient === undefined ? null : key(id.recipient), id.generation === undefined ? null : encode(id.generation)])));
    const exactWhere = (kind: SquarePost['kind'], index: string, audience: string) => exact === undefined ? '' : `
      AND json_extract(q.value,'$[0]')='${kind}' AND ${index}=json_extract(q.value,'$[1]')
      AND (json_extract(q.value,'$[2]') IS NULL OR ${audience}.recipient_key_json=json_extract(q.value,'$[2]'))
      AND (json_extract(q.value,'$[3]') IS NULL OR ${audience}.generation_json=json_extract(q.value,'$[3]'))`;
    const activity = exact !== undefined && !exact.some(id => id.kind === 'activity') ? [] : rows(`WITH read_through AS (
        SELECT actor_key_json,MAX(json_extract(payload_json,'$.through')) AS through FROM activities WHERE kind='read' GROUP BY actor_key_json
      ) SELECT a.act_index,d.owner_json,d.generation_json,p.name_json,${projection.content ? 'a.at,a.actor_json,a.payload_json,d.reason,x.full,' : ''}
        (c.act_index IS NOT NULL OR COALESCE(r.through>=a.act_index,0)) AS consumed
        FROM ${exact === undefined ? '' : 'json_each(?) q CROSS JOIN'} activities a JOIN landed_audience d ON d.act_index=a.act_index
        JOIN participants p ON p.name_key_json=d.recipient_key_json
        LEFT JOIN square_posts x ON x.kind='activity' AND x.item_index=a.act_index AND x.recipient_key_json=d.recipient_key_json
        LEFT JOIN caught_activity c ON c.recipient_key_json=d.recipient_key_json AND c.act_index=a.act_index
        LEFT JOIN read_through r ON r.actor_key_json=d.recipient_key_json
        WHERE a.kind='say' AND d.owner_json IS NOT NULL AND d.generation_json IS NOT NULL ${disposition('d')}
        ${exactWhere('activity', 'a.act_index', 'd')}
        ORDER BY a.act_index,d.recipient_order`, args)
      .map(row => projection.decode(row, 'activity'));
    const notices = exact !== undefined && !exact.some(id => id.kind === 'notice') ? [] : rows(`SELECT a.notice_index,a.recipient_json,a.owner_json,a.generation_json,${projection.content ? 'n.at,n.sender_json,n.body_json,n.metadata_json,x.full,' : ''}(a.consumed_at IS NOT NULL) AS consumed
      FROM ${exact === undefined ? '' : 'json_each(?) q CROSS JOIN'} square_notices n JOIN notice_audience a USING(notice_index)
      LEFT JOIN square_posts x ON x.kind='notice' AND x.item_index=n.notice_index AND x.recipient_key_json=a.recipient_key_json
      WHERE 1=1 ${disposition('a')} ${exactWhere('notice', 'n.notice_index', 'a')}
      ORDER BY n.notice_index,a.recipient_key_json`, args)
      .map(row => projection.decode(row, 'notice'));
    return [...activity, ...notices];
  }
  function recordDeparture(seat: SeatRef): void {
    run(`INSERT INTO producer_departures VALUES(?,?,?,?,?) ON CONFLICT(owner_json,generation_json,participant_key_json)
      DO UPDATE SET token=excluded.token`,
      [key(seat.participant), encode(seat.participant), encode(seat.owner), encode(seat.generation), randomUUID()]);
  }
  const driver: ProducerRead & ProducerWrite & { recordDeparture(seat: SeatRef): void; consumeActivity(index: number, at: number): void } = {
    recordDeparture,
    departedSeats: () => rows('SELECT * FROM producer_departures').map(row => ({
      participant: decoded(row.participant_json, true), owner: decoded(row.owner_json, true), generation: decoded(row.generation_json, true), token: string(row.token, true),
    })),
    clearDepartedSeat(seat) {
      run('DELETE FROM producer_departures WHERE owner_json=? AND generation_json=? AND participant_key_json=? AND token=?',
        [encode(seat.owner), encode(seat.generation), key(seat.participant), seat.token]);
    },
    receiptWatermark: owner => integer(one('SELECT seq FROM producer_receipt_watermarks WHERE owner_json=?', [encode(owner)])?.seq ?? 0),
    advanceReceiptWatermark(owner, seq) {
      integer(seq);
      run(`INSERT INTO producer_receipt_watermarks VALUES(?,?) ON CONFLICT(owner_json)
        DO UPDATE SET seq=excluded.seq WHERE excluded.seq>producer_receipt_watermarks.seq`, [encode(owner), seq]);
    },
    pendingPosts: (now = Date.now()) => selectPosts(fullPosts, 'pending', undefined, now),
    postsAt: (identities, selection) => selectPosts(fullPosts, selection ?? 'all', identities.map(id => ({ ...id, recipient: id.recipientKey }))),
    postDispositionsAt: identities => selectPosts(dispositions, 'all', identities.map(id => ({ ...id, recipient: id.recipientKey }))),
    withdrawnClaims: now => selectPosts(dispositions, 'withdrawn', undefined, now),
    ownsPost(token, exportAt = Date.now()) {
      const row = one('SELECT * FROM square_posts WHERE token=?', [token]);
      return !!row && row.posted !== 1 && withinExportWindow(finite(row.first_export_at), finite(exportAt))
        && exportAt >= finite(row.claim_at) && exportAt - finite(row.claim_at) < EXPORT_OWNERSHIP_MS;
    },
    insertNotice(input: SendInput, at: number): SendResult {
      validateName(input.from);
      if (typeof input.body !== 'string' || !input.body.trim()) throw new SquareError('invalid_args', 'A notification needs a non-empty body.');
      const metadata = validateActivityMetadata(input.metadata);
      const targets = typeof input.to === 'string' ? [input.to] : input.to;
      if (!Array.isArray(targets) || targets.length < 1 || targets.length > 10) throw new SquareError('invalid_args', 'A notification needs between 1 and 10 recipients.');
      const recipients: Row[] = [];
      for (const name of targets) {
        validateName(name);
        if (recipients.some(row => sameName(decoded(row.participant_json, true), name))) continue;
        const row = one(`SELECT s.* FROM participant_seats s JOIN participants p ON p.name_key_json=s.participant_key_json WHERE p.joined=1 AND p.name_key_json=?`, [key(name)]);
        if (!row) throw new SquareError('invalid_args', `Notification recipient ${name} is not standing.`, { reason: 'not_standing', targets: [name] });
        recipients.push(row);
      }
      const index = integer(one('SELECT COALESCE(MAX(notice_index),-1)+1 AS n FROM square_notices')!.n);
      if (!Number.isSafeInteger(index + 1)) throw new SquareError('invalid_args', 'Notification index is exhausted.');
      const body = input.body;
      run('INSERT INTO square_notices VALUES(?,?,?,?,?)', [index, finite(at), encode(input.from), encode(body), metadata === undefined ? null : encode(metadata)]);
      for (const row of recipients) {
        const post: SquarePost = { kind: 'notice', index, recipient: decoded(row.participant_json, true), owner: decoded(row.owner_json, true),
          generation: decoded(row.generation_json, true), from: input.from, body, at, ...(metadata === undefined ? {} : { metadata }) };
        run('INSERT INTO notice_audience VALUES(?,?,?,?,?,?)', [index, key(post.recipient), encode(post.recipient), encode(post.owner), encode(post.generation), consumed(post) ? at : null]);
      }
      return { id: `notice/${index}`, at, from: input.from, to: recipients.map(row => decoded(row.participant_json, true)), body, ...(metadata === undefined ? {} : { metadata }) };
    },
    ackMatching(seat: SeatRef, input: FutureAck, at: number): number {
      authority(seat); validateName(input.from);
      if (input.future !== 'exact') throw new SquareError('invalid_args', 'Future consumption requires an explicit exact outcome.');
      const match = canonicalMatch(input.match);
      run('INSERT INTO producer_consumption VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        [key(seat.participant), encode(seat.owner), encode(seat.generation), key(input.from), match, finite(at)]);
      let count = 0;
      for (const post of selectPosts(fullPosts)) {
        if (sameName(post.recipient, seat.participant) && post.owner === seat.owner && post.generation === seat.generation
          && sameName(post.from, input.from) && matchesMetadata(post.metadata, input.match) && !post.consumed) count += consume(post, at);
      }
      return count;
    },
    acquirePost(post, token, pid, now, exportAt = Date.now()) {
      // A scanned value is not custody. Re-read this source and policy under the World writer.
      const current = selectPosts(fullPosts, 'all', [post])[0];
      if (!current || current.owner !== post.owner || current.generation !== post.generation || current.consumed) return false;
      const seat = one('SELECT * FROM participant_seats WHERE participant_key_json=?', [key(post.recipient)]);
      if (!seat || seat.owner_json !== encode(post.owner) || seat.generation_json !== encode(post.generation) || seat.attachment !== 'attached') return false;
      if (consumed(current)) { consume(current, now); return false; }
      const previous = one('SELECT * FROM square_posts WHERE kind=? AND item_index=? AND recipient_key_json=?', [post.kind, post.index, key(post.recipient)]);
      finite(exportAt);
      if (previous?.posted === 1) return false;
      const first = previous ? finite(previous.first_export_at) : exportAt;
      // Missing ledger identity after retention cannot prove an abandoned export was unsent.
      if (!withinExportWindow(first, exportAt) || previous && exportAt < finite(previous.claim_at)) return false;
      if (previous?.token != null && exportAt >= finite(previous.claim_at)
        && exportAt - finite(previous.claim_at) < EXPORT_OWNERSHIP_MS && processIsAlive(integer(previous.owner_pid, 1))) return false;
      run(`INSERT INTO square_posts(kind,item_index,recipient_key_json,token,owner_pid,full,first_export_at,claim_at) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(kind,item_index,recipient_key_json) DO UPDATE SET token=excluded.token,owner_pid=excluded.owner_pid,full=excluded.full,claim_at=excluded.claim_at`,
        [post.kind, post.index, key(post.recipient), token, integer(pid, 1), post.full === undefined ? null : Number(post.full), first, exportAt]);
      return previous ? 'recovered' : 'initial';
    },
    settlePost(token, full, disposition) {
      const claim = one('SELECT kind,item_index,recipient_key_json FROM square_posts WHERE token=?', [token]);
      if (!claim) return false;
      const audience = claim.kind === 'activity'
        ? one(`SELECT p.name_json AS recipient_json,d.owner_json,d.generation_json FROM landed_audience d
          JOIN participants p ON p.name_key_json=d.recipient_key_json WHERE d.act_index=? AND d.recipient_key_json=?`, [claim.item_index, claim.recipient_key_json])
        : one('SELECT recipient_json,owner_json,generation_json FROM notice_audience WHERE notice_index=? AND recipient_key_json=?', [claim.item_index, claim.recipient_key_json]);
      // Only a proved-unsent initial claim may erase its export age; prior uncertainty survives.
      const count = disposition === 'never-exported'
        ? run('DELETE FROM square_posts WHERE token=?', [token])
        : run('UPDATE square_posts SET token=NULL,owner_pid=NULL,posted=?,full=? WHERE token=?', [Number(disposition === 'posted'), Number(full), token]);
      if (audience && !one(`SELECT 1 FROM participant_seats s JOIN participants p ON p.name_key_json=s.participant_key_json
        WHERE p.joined=1 AND s.participant_key_json=? AND s.owner_json=? AND s.generation_json=?`,
        [claim.recipient_key_json, audience.owner_json, audience.generation_json]))
        recordDeparture({ participant: decoded(audience.recipient_json, true), owner: decoded(audience.owner_json, true), generation: decoded(audience.generation_json, true) });
      return count > 0;
    },
    foldReceipt(post, at) {
      const current = selectPosts(fullPosts, 'all', [post])[0];
      if (!current || current.owner !== post.owner || current.generation !== post.generation || current.full !== true || current.consumed) return false;
      return consume(current, finite(at)) > 0;
    },
    consumeActivity(index, at) {
      for (const post of selectPosts(fullPosts, 'all', [{ kind: 'activity', index }])) if (consumed(post)) consume(post, at);
    },
  };
  return Object.defineProperties(driver, { changed: { get: () => changed }, deliveryChanged: { get: () => changed } }) as ReturnType<typeof createProducerDriver>;
}
