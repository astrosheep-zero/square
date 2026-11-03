import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { matchesMetadata, matchingDeferrals, validateMetadataMatch } from './delivery-deferral.js';
import type { DeliveryDeferralFact, MetadataMatch } from './delivery-deferral.js';
import { SquareError, sameName, validateName, validateActivityMetadata, type ActivityMetadata } from './model.js';
import type { SeatRef } from './ports.js';
import type { FutureAck, ProducerRead, ProducerWrite, SendInput, SendResult, SquarePost } from './square-post.js';
import { decoded, encode, finite, integer, json, key, object, type Row } from './sqlite-values.js';

/** Private Square producer bookkeeping, on the artifact's existing connection/transaction. */
export const producerSchemaSql = `CREATE TABLE square_notices (
  notice_index INTEGER PRIMARY KEY CHECK (notice_index >= 0), at REAL NOT NULL,
  sender_json TEXT NOT NULL, body_json TEXT NOT NULL, metadata_json TEXT
);
CREATE TABLE notice_audience (
  notice_index INTEGER NOT NULL, recipient_key_json TEXT NOT NULL, recipient_json TEXT NOT NULL,
  owner_json TEXT NOT NULL, generation_json TEXT NOT NULL, consumed_at REAL,
  PRIMARY KEY (notice_index,recipient_key_json)
) WITHOUT ROWID;
CREATE TABLE producer_leases (
  recipient_key_json TEXT NOT NULL, owner_json TEXT NOT NULL, generation_json TEXT NOT NULL,
  lease_id TEXT NOT NULL, match_json TEXT NOT NULL, expires_at REAL NOT NULL,
  PRIMARY KEY (recipient_key_json,generation_json,lease_id)
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
  for (const table of ['square_posts', 'producer_consumption', 'producer_leases', 'notice_audience', 'square_notices']) db.exec(`DROP TABLE ${table}`);
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
  function knownConsumed(post: SquarePost): boolean {
    return post.kind === 'activity'
      ? !!one('SELECT 1 FROM caught_activity WHERE recipient_key_json=? AND act_index=?', [key(post.recipient), post.index])
        || !!one(`SELECT 1 FROM activities WHERE kind='read' AND actor_key_json=? AND json_extract(payload_json,'$.through')>=?`, [key(post.recipient), post.index])
      : one('SELECT consumed_at FROM notice_audience WHERE recipient_key_json=? AND notice_index=?', [key(post.recipient), post.index])?.consumed_at != null;
  }
  function consume(post: SquarePost, at: number): number {
    return post.kind === 'activity'
      ? run('INSERT INTO caught_activity(recipient_key_json,act_index,at) VALUES(?,?,?) ON CONFLICT DO NOTHING', [key(post.recipient), post.index, at])
      : run('UPDATE notice_audience SET consumed_at=? WHERE recipient_key_json=? AND notice_index=? AND consumed_at IS NULL', [at, key(post.recipient), post.index]);
  }
  function allPosts(): SquarePost[] {
    const activity = rows(`SELECT a.act_index,a.at,a.actor_json,a.payload_json,d.*,p.name_json,
        x.full,x.posted FROM activities a JOIN landed_audience d ON d.act_index=a.act_index
        JOIN participants p ON p.name_key_json=d.recipient_key_json
        LEFT JOIN square_posts x ON x.kind='activity' AND x.item_index=a.act_index AND x.recipient_key_json=d.recipient_key_json
        WHERE a.kind='say' AND d.owner_json IS NOT NULL AND d.generation_json IS NOT NULL ORDER BY a.act_index,d.recipient_order`)
      .map((row): SquarePost => {
        const payload = object(json(row.payload_json));
        return { kind: 'activity', index: integer(row.act_index), recipient: decoded(row.name_json, true),
          owner: decoded(row.owner_json, true), generation: decoded(row.generation_json, true), from: decoded(row.actor_json, true), at: finite(row.at),
          ...(payload.body === undefined ? {} : { body: payload.body as string }),
          ...(payload.metadata === undefined ? {} : { metadata: payload.metadata as ActivityMetadata }), route: row.reason as SquarePost['route'],
          ...(row.full === null ? {} : { full: row.full === 1 }) };
      });
    const notices = rows(`SELECT n.*,a.*,x.full FROM square_notices n JOIN notice_audience a USING(notice_index)
      LEFT JOIN square_posts x ON x.kind='notice' AND x.item_index=n.notice_index AND x.recipient_key_json=a.recipient_key_json ORDER BY n.notice_index,a.recipient_key_json`)
      .map((row): SquarePost => ({ kind: 'notice', index: integer(row.notice_index), recipient: decoded(row.recipient_json, true),
        owner: decoded(row.owner_json, true), generation: decoded(row.generation_json, true), from: decoded(row.sender_json, true), at: finite(row.at),
        body: decoded(row.body_json), ...(row.metadata_json === null ? {} : { metadata: json(row.metadata_json) as ActivityMetadata }),
        ...(row.full === null ? {} : { full: row.full === 1 }) }));
    return [...activity, ...notices].map(post => ({ ...post, consumed: knownConsumed(post) }));
  }
  const driver: ProducerRead & ProducerWrite & { consumeActivity(index: number, at: number): void } = {
    pendingPosts() {
      return allPosts().filter(post => !post.consumed && !one(`SELECT 1 FROM square_posts WHERE kind=? AND item_index=? AND recipient_key_json=? AND posted=1`,
        [post.kind, post.index, key(post.recipient)]));
    },
    postedPosts() {
      return allPosts().filter(post => !!one(`SELECT 1 FROM square_posts WHERE kind=? AND item_index=? AND recipient_key_json=? AND (posted=1 OR token IS NOT NULL)`,
        [post.kind, post.index, key(post.recipient)]));
    },
    ownsPost(token, exportAt = Date.now()) {
      const row = one('SELECT * FROM square_posts WHERE token=?', [token]);
      return !!row && row.posted !== 1 && withinExportWindow(finite(row.first_export_at), finite(exportAt))
        && exportAt >= finite(row.claim_at) && exportAt - finite(row.claim_at) < EXPORT_OWNERSHIP_MS;
    },
    deliveryDeferrals(participant, generation) {
      return rows('SELECT * FROM producer_leases WHERE recipient_key_json=? AND generation_json=?', [key(participant), encode(generation)])
        .map(row => ({ participant, generation, id: row.lease_id as string, expiresAt: finite(row.expires_at), match: json(row.match_json) as MetadataMatch }));
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
      for (const post of allPosts()) {
        if (sameName(post.recipient, seat.participant) && post.owner === seat.owner && post.generation === seat.generation
          && sameName(post.from, input.from) && matchesMetadata(post.metadata, input.match) && !post.consumed) count += consume(post, at);
      }
      return count;
    },
    putDeliveryDeferral(seat, id, match, expiresAt, now) {
      authority(seat); finite(now);
      run('INSERT INTO producer_leases VALUES(?,?,?,?,?,?)', [key(seat.participant), encode(seat.owner), encode(seat.generation), id, canonicalMatch(match), finite(expiresAt)]);
    },
    renewDeliveryDeferral(seat, id, expiresAt, now) {
      authority(seat);
      return run('UPDATE producer_leases SET expires_at=? WHERE recipient_key_json=? AND owner_json=? AND generation_json=? AND lease_id=? AND expires_at>?',
        [finite(expiresAt), key(seat.participant), encode(seat.owner), encode(seat.generation), id, finite(now)]) > 0;
    },
    releaseDeliveryDeferral(seat, id, now) {
      authority(seat); finite(now);
      return run('DELETE FROM producer_leases WHERE recipient_key_json=? AND owner_json=? AND generation_json=? AND lease_id=?',
        [key(seat.participant), encode(seat.owner), encode(seat.generation), id]) > 0;
    },
    acquirePost(post, token, pid, now, exportAt = Date.now()) {
      // A scanned value is not custody. Re-read all source and policy facts under the World writer.
      const current = allPosts().find(candidate => candidate.kind === post.kind && candidate.index === post.index && candidate.recipient === post.recipient);
      if (!current || current.owner !== post.owner || current.generation !== post.generation || current.consumed) return false;
      const seat = one('SELECT * FROM participant_seats WHERE participant_key_json=?', [key(post.recipient)]);
      if (!seat || seat.owner_json !== encode(post.owner) || seat.generation_json !== encode(post.generation) || seat.attachment !== 'attached') return false;
      if (consumed(current)) { consume(current, now); return false; }
      if (matchingDeferrals(driver.deliveryDeferrals(post.recipient, post.generation), current.metadata, now).length) return false;
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
      // Only a proved-unsent initial claim may erase its export age; prior uncertainty survives.
      if (disposition === 'never-exported') return run('DELETE FROM square_posts WHERE token=?', [token]) > 0;
      return run('UPDATE square_posts SET token=NULL,owner_pid=NULL,posted=?,full=? WHERE token=?', [Number(disposition === 'posted'), Number(full), token]) > 0;
    },
    foldReceipt(post, at) {
      const current = allPosts().find(candidate => candidate.kind === post.kind && candidate.index === post.index && candidate.recipient === post.recipient);
      if (!current || current.owner !== post.owner || current.generation !== post.generation || current.full !== true || current.consumed) return false;
      return consume(current, finite(at)) > 0;
    },
    consumeActivity(index, at) {
      for (const post of allPosts()) if (post.kind === 'activity' && post.index === index && consumed(post)) consume(post, at);
    },
  };
  return Object.defineProperties(driver, { changed: { get: () => changed }, deliveryChanged: { get: () => changed } }) as ReturnType<typeof createProducerDriver>;
}
