import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as NodeDatabaseSync, DatabaseSyncOptions, SQLInputValue } from 'node:sqlite';

const bunSqlite = 'bun:sqlite';
export const { DatabaseSync } = await (process.versions.bun
  ? import(bunSqlite).then(({ Database }) => ({
      DatabaseSync: class {
        private readonly db: InstanceType<typeof Database>;
        constructor(location: string, options?: DatabaseSyncOptions) {
          this.db = new Database(location, options?.readOnly ? { readonly: true } : { create: true, readwrite: true });
        }
        exec(sql: string): void { this.db.exec(sql); }
        close(): void { this.db.close(); }
        prepare(sql: string) {
          const statement = this.db.prepare(sql);
          return {
            get: (...values: SQLInputValue[]) => statement.get(...values) ?? undefined,
            all: (...values: SQLInputValue[]) => statement.all(...values),
            run: (...values: SQLInputValue[]) => statement.run(...values),
          };
        }
      },
    }))
  : import('node:sqlite')) as { DatabaseSync: typeof NodeDatabaseSync };
type DatabaseSync = NodeDatabaseSync;
import { inSqliteTransaction, retrySqliteBusy, awaitSqliteQueue } from './sqlite-transaction.js';
import { validateSchema } from './sqlite-framing.js';
import type { DeliveryAttempt, DeliveryCard, DeliveryCorrelation, DeliveryHandoffRef, DeliveryHealth, DeliveryOutcome, DeliveryReceipt, DeliveryRoute, DeliverySession, PostResult, SuppressionResult } from './delivery-ledger.js';

type Row = Record<string, SQLInputValue>;
const FORMAT = 3;
const APPLICATION_ID = 0x444c4752;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCHEMA = `CREATE TABLE meta (format INTEGER NOT NULL, next_seq INTEGER NOT NULL);
CREATE TABLE sessions (owner TEXT PRIMARY KEY, generation TEXT NOT NULL, state TEXT NOT NULL, routes_json TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE cards (seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, details TEXT, posted_at REAL NOT NULL, UNIQUE(owner,key));
CREATE INDEX cards_owner ON cards(owner,seq);
CREATE TABLE suppressions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('exact','prefix')), created_at REAL NOT NULL, expires_at REAL);
CREATE INDEX suppressions_owner ON suppressions(owner);
CREATE UNIQUE INDEX suppressions_permanent_exact ON suppressions(owner,key) WHERE scope='exact' AND expires_at IS NULL;
CREATE TABLE attempts (token TEXT PRIMARY KEY, seq INTEGER NOT NULL, generation TEXT NOT NULL, track TEXT NOT NULL, route_kind TEXT, outcome TEXT NOT NULL, correlation_json TEXT NOT NULL, started_at REAL NOT NULL, expires_at REAL NOT NULL, settled_at REAL);
CREATE INDEX attempts_seq ON attempts(seq);
CREATE TABLE receipts (owner TEXT NOT NULL, key TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(owner,key));
CREATE INDEX receipts_time ON receipts(at);
CREATE TABLE cancellations (owner TEXT PRIMARY KEY, generation TEXT NOT NULL, through_seq INTEGER NOT NULL);`;

function validate(db: DatabaseSync, location: string): void {
  const header = db.prepare('SELECT application_id, user_version FROM pragma_application_id, pragma_user_version').get();
  if (header?.application_id !== APPLICATION_ID || header.user_version !== FORMAT) throw new Error('Unsupported delivery ledger format');
  validateSchema(db, SCHEMA, location);
  const meta = db.prepare('SELECT * FROM meta').all();
  if (meta.length !== 1 || meta[0].format !== FORMAT || !Number.isSafeInteger(meta[0].next_seq) || Number(meta[0].next_seq) < 1)
    throw new Error('Invalid delivery ledger header');
}
function session(row: Row | undefined): DeliverySession | undefined {
  return row ? { owner: row.owner as string, generation: row.generation as string, state: row.state as DeliverySession['state'],
    routes: JSON.parse(row.routes_json as string), at: row.at as number } : undefined;
}
function card(row: Row): DeliveryCard {
  return { seq: row.seq as number, owner: row.owner as string, key: row.key as string, text: row.text as string,
    ...(row.details === null ? {} : { details: JSON.parse(row.details as string) }), postedAt: row.posted_at as number };
}
function attempt(row: Row): DeliveryAttempt {
  return { token: row.token as string, seq: row.seq as number, generation: row.generation as string,
    track: row.track as DeliveryAttempt['track'], routeKind: row.route_kind as string | null, outcome: row.outcome as DeliveryOutcome,
    correlation: JSON.parse(row.correlation_json as string), startedAt: row.started_at as number, expiresAt: row.expires_at as number,
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at as number }) };
}
function holds(row: DeliveryAttempt): boolean { return !['failed', 'released'].includes(row.outcome); }

/** All ledger file access and SQL are confined here. Transactions never span external effects. */
export class LedgerStore {
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly cancellation = new AbortController();
  private readonly ordinaryCancellation = new AbortController();
  private closing?: Promise<void>;
  private constructor(readonly location: string, private readonly db: DatabaseSync, private readonly clock: () => number) {}
  static async open(location: string, clock: () => number, signal?: AbortSignal): Promise<LedgerStore> {
    signal?.throwIfAborted();
    try { await fs.access(location); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
      const temporary = location + '.' + randomUUID() + '.tmp';
      let initial: DatabaseSync | undefined;
      try {
        await (await fs.open(temporary, 'wx', 0o600)).close();
        initial = await retrySqliteBusy(() => new DatabaseSync(temporary), signal);
        await inSqliteTransaction(initial, true, () => undefined, () => {
          initial!.exec(SCHEMA);
          initial!.prepare('INSERT INTO meta VALUES(?,1)').run(FORMAT);
          initial!.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT}`);
        }, signal);
        initial.close(); initial = undefined;
        signal?.throwIfAborted();
        try { await fs.link(temporary, location); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally {
        initial?.close();
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
    // Existing formats are inspected on a read-only connection before any writable open.
    const probe = await retrySqliteBusy(() => new DatabaseSync(location, { readOnly: true }), signal);
    try { await retrySqliteBusy(() => validate(probe, location), signal); } finally { probe.close(); }
    const db = await retrySqliteBusy(() => new DatabaseSync(location), signal);
    try {
      await retrySqliteBusy(() => { validate(db, location); db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL'); }, signal);
      return new LedgerStore(location, db, clock);
    }
    catch (error) { db.close(); throw error; }
  }
  /** Stop ordinary work while captured effects retain access to settlement. */
  retire(): void { this.ordinaryCancellation.abort(new Error('Delivery ledger is closed')); }
  close(): Promise<void> {
    this.retire();
    this.closed = true;
    this.cancellation.abort(new Error('Delivery ledger is closed'));
    return this.closing ??= this.pending.then(() => this.db.close());
  }
  private transaction<T>(write: boolean, change: (now: number) => T, signal?: AbortSignal, settlement = false): Promise<T> {
    if (this.closed || !settlement && this.ordinaryCancellation.signal.aborted) return Promise.reject(new Error('Delivery ledger is closed'));
    signal = AbortSignal.any([this.cancellation.signal, ...(!settlement ? [this.ordinaryCancellation.signal] : []), ...(signal ? [signal] : [])]);
    let started = false;
    const result = this.pending.then(() => {
      signal.throwIfAborted();
      started = true;
      return inSqliteTransaction(this.db, write, () => validate(this.db, this.location), () => {
        const now = this.clock();
        if (!Number.isFinite(now)) throw new TypeError('Expected finite ledger time');
        const changes = Number(this.db.prepare('SELECT total_changes() AS n').get()!.n);
        const result = change(now);
        if (write && Number(this.db.prepare('SELECT total_changes() AS n').get()!.n) > changes) {
          this.normalize(now);
          this.gc(now);
        }
        return result;
      }, signal);
    });
    this.pending = result.catch(() => undefined);
    return awaitSqliteQueue(result, signal, () => started);
  }
  private getSession(owner: string): DeliverySession | undefined {
    return session(this.db.prepare('SELECT * FROM sessions WHERE owner=?').get(owner) as Row | undefined);
  }
  private attached(owner: string, generation: string): DeliverySession | undefined {
    const s = this.getSession(owner);
    return s?.state === 'attached' && s.generation === generation ? s : undefined;
  }
  private listAttempts(seq: number): DeliveryAttempt[] {
    return (this.db.prepare('SELECT * FROM attempts WHERE seq=? ORDER BY started_at,token').all(seq) as Row[]).map(attempt);
  }
  private awaitingEffect(seq: number): boolean {
    const attempts = this.listAttempts(seq);
    if (attempts.some(a => ['dispatching', 'unknown'].includes(a.outcome))) return true;
    return attempts.some(a => a.track === 'handoff' && a.outcome === 'accepted')
      && !attempts.some(a => a.track === 'presentation' && a.outcome === 'presented');
  }
  private getAttempt(token: string): DeliveryAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM attempts WHERE token=?').get(token) as Row | undefined;
    return row ? attempt(row) : undefined;
  }
  private normalize(now: number): void {
    this.db.prepare(`UPDATE attempts SET outcome='unknown', settled_at=? WHERE outcome='dispatching' AND
      (expires_at<=? OR NOT EXISTS(SELECT 1 FROM cards c JOIN sessions s ON s.owner=c.owner
        WHERE c.seq=attempts.seq AND s.generation=attempts.generation AND s.state='attached'))`).run(now, now);
    this.db.prepare(`UPDATE cards SET text='',details=NULL WHERE (text<>'' OR details IS NOT NULL)
      AND EXISTS(SELECT 1 FROM attempts a WHERE a.seq=cards.seq AND a.outcome IN ('accepted','unknown','presented'))`).run();
    const terminal = this.db.prepare(`SELECT seq FROM cards WHERE
      EXISTS(SELECT 1 FROM attempts a WHERE a.seq=cards.seq AND a.track='presentation' AND a.outcome='presented')
      AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.seq=cards.seq AND a.outcome='dispatching')`).all() as Row[];
    for (const row of terminal) this.deleteCard(row.seq as number, now);
  }
  private deleteCard(seq: number, tombstoneAt?: number): void {
    if (tombstoneAt !== undefined) this.db.prepare(`INSERT INTO suppressions
      SELECT ?,owner,key,'exact',?,NULL FROM cards WHERE seq=?
      ON CONFLICT(owner,key) WHERE scope='exact' AND expires_at IS NULL DO UPDATE SET created_at=excluded.created_at`)
      .run(randomUUID(), tombstoneAt, seq);
    this.db.prepare('DELETE FROM attempts WHERE seq=?').run(seq);
    this.db.prepare('DELETE FROM cards WHERE seq=?').run(seq);
  }
  private gc(now: number): void {
    const cutoff = now - RETENTION_MS;
    this.db.prepare('DELETE FROM suppressions WHERE expires_at IS NOT NULL AND expires_at<=?').run(now);
    const suppressed = this.db.prepare(`SELECT seq FROM cards WHERE EXISTS(SELECT 1 FROM suppressions s WHERE s.owner=cards.owner AND s.scope='exact' AND s.key=cards.key AND s.expires_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.seq=cards.seq AND a.outcome IN ('dispatching','unknown'))`).all() as Row[];
    for (const row of suppressed) {
      if (this.awaitingEffect(row.seq as number)) continue;
      this.deleteCard(row.seq as number);
    }
    this.db.prepare(`DELETE FROM suppressions WHERE id IN (SELECT id FROM suppressions
      WHERE expires_at IS NULL AND created_at<? ORDER BY created_at LIMIT 100)`).run(cutoff);
    const expiredSessions = this.db.prepare(`SELECT c.seq FROM cards c JOIN sessions s ON s.owner=c.owner
      WHERE s.state='deleted' OR (s.state='detached' AND s.at<?) ORDER BY c.seq`).all(cutoff) as Row[];
    for (const row of expiredSessions) this.deleteCard(row.seq as number);
    this.db.prepare("DELETE FROM suppressions WHERE owner IN (SELECT owner FROM sessions WHERE state='deleted')").run();
    const old = this.db.prepare(`SELECT c.seq FROM cards c WHERE
      EXISTS(SELECT 1 FROM attempts a WHERE a.seq=c.seq AND a.outcome IN ('accepted','unknown'))
      AND (SELECT MAX(a.settled_at) FROM attempts a WHERE a.seq=c.seq)<?
      AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.seq=c.seq AND a.outcome='dispatching') ORDER BY c.seq LIMIT 100`).all(cutoff) as Row[];
    for (const row of old) this.deleteCard(row.seq as number, now);
    this.db.prepare('DELETE FROM receipts WHERE rowid IN (SELECT rowid FROM receipts WHERE at<? ORDER BY at LIMIT 100)').run(cutoff);
  }
  session(owner: string, signal?: AbortSignal): Promise<DeliverySession | undefined> { return this.transaction(false, () => this.getSession(owner), signal); }
  sessions(signal?: AbortSignal): Promise<readonly DeliverySession[]> {
    return this.transaction(false, () => (this.db.prepare('SELECT * FROM sessions ORDER BY owner').all() as Row[]).map(row => session(row)!), signal);
  }
  pendingCards(owner: string, generation: string, signal?: AbortSignal): Promise<readonly DeliveryCard[]> {
    return this.transaction(false, now => this.attached(owner, generation)
      ? (this.db.prepare('SELECT * FROM cards WHERE owner=? ORDER BY seq').all(owner) as Row[]).filter(row => this.eligible(row, now)).map(card) : [], signal);
  }
  handoffs(owner: string, generation: string, signal?: AbortSignal): Promise<readonly DeliveryAttempt[]> {
    return this.transaction(false, () => (this.db.prepare(`SELECT a.* FROM attempts a JOIN cards c ON c.seq=a.seq
      WHERE c.owner=? AND a.generation=? AND a.track='handoff' ORDER BY a.rowid`).all(owner, generation) as Row[]).map(attempt), signal);
  }
  attach(input: { owner: string; expectedGeneration: string | null; routes: readonly DeliveryRoute[] }, signal?: AbortSignal): Promise<DeliverySession | false> {
    const encoded = JSON.stringify(input.routes);
    return this.transaction(true, now => {
      const previous = this.getSession(input.owner);
      if (previous?.state === 'deleted' || (previous ? previous.generation !== input.expectedGeneration : input.expectedGeneration !== null)) return false;
      const generation = randomUUID();
      this.db.prepare(`INSERT INTO sessions VALUES(?,?,'attached',?,?) ON CONFLICT(owner)
        DO UPDATE SET generation=excluded.generation,state=excluded.state,routes_json=excluded.routes_json,at=excluded.at`).run(input.owner, generation, encoded, now);
      return this.getSession(input.owner)!;
    }, signal);
  }
  updateRoutes(input: { owner: string; generation: string; routes: readonly DeliveryRoute[] }, signal?: AbortSignal): Promise<boolean> {
    const encoded = JSON.stringify(input.routes);
    return this.transaction(true, now => {
      if (!this.attached(input.owner, input.generation)) return false;
      this.db.prepare('UPDATE sessions SET routes_json=?,at=? WHERE owner=?').run(encoded, now, input.owner);
      return true;
    }, signal);
  }
  lifecycle(input: { owner: string; generation: string }, state: 'detached' | 'deleted', signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, now => {
      const s = this.getSession(input.owner);
      if (!s || s.generation !== input.generation || s.state === 'deleted') return false;
      this.db.prepare('UPDATE sessions SET state=?,at=? WHERE owner=?').run(state, now, input.owner);
      return true;
    }, signal);
  }
  post(input: { owner: string; key: string; text: string; details: string | null }, signal?: AbortSignal): Promise<PostResult> {
    return this.transaction(true, now => {
      const s = this.getSession(input.owner);
      if (!s) return { status: 'unknown-session' };
      if (s.state === 'deleted') return { status: 'deleted-session' };
      const previous = this.db.prepare('SELECT * FROM cards WHERE owner=? AND key=?').get(input.owner, input.key) as Row | undefined;
      if (previous) {
        if (this.listAttempts(previous.seq as number).some(a => ['accepted', 'unknown', 'presented'].includes(a.outcome))) return { status: 'duplicate' };
        return { status: previous.text !== input.text || previous.details !== input.details ? 'conflict' : this.isSuppressed(input.owner, input.key, now) ? 'suppressed' : 'duplicate' };
      }
      if (this.db.prepare("SELECT 1 FROM suppressions WHERE owner=? AND key=? AND scope='exact' AND expires_at IS NULL").get(input.owner, input.key)) return { status: 'suppressed' };
      const suppressed = this.isSuppressed(input.owner, input.key, now);
      const seq = Number(this.db.prepare('SELECT next_seq FROM meta').get()!.next_seq);
      if (!Number.isSafeInteger(seq + 1)) throw new RangeError('Delivery sequence exhausted');
      this.db.prepare('UPDATE meta SET next_seq=?').run(seq + 1);
      this.db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,?)').run(seq, input.owner, input.key, input.text, input.details, now);
      return { status: suppressed ? 'suppressed' : 'posted' };
    }, signal);
  }
  suppress(input: { owner: string; key: string; scope: 'exact' | 'prefix'; expiresAt?: number }, signal?: AbortSignal): Promise<SuppressionResult> {
    return this.transaction(true, now => {
      const permanentId = input.scope === 'exact' && input.expiresAt === undefined
        ? (this.db.prepare("SELECT id FROM suppressions WHERE owner=? AND key=? AND scope='exact' AND expires_at IS NULL").get(input.owner, input.key) as Row | undefined)?.id as string | undefined
        : undefined;
      const id = permanentId ?? randomUUID();
      const matching = (this.db.prepare('SELECT * FROM cards WHERE owner=?').all(input.owner) as Row[])
        .filter(row => input.scope === 'exact' ? row.key === input.key : String(row.key).startsWith(input.key));
      const inCustody = matching.some(row => this.awaitingEffect(row.seq as number));
      if (permanentId === undefined) this.db.prepare('INSERT INTO suppressions VALUES(?,?,?,?,?,?)').run(id, input.owner, input.key, input.scope, now, input.expiresAt ?? null);
      if (input.scope === 'exact' && input.expiresAt === undefined) for (const row of matching) {
        if (!this.awaitingEffect(row.seq as number)) this.deleteCard(row.seq as number);
      }
      return { id, status: inCustody ? 'in-custody' : 'suppressed' };
    }, signal);
  }
  renewSuppression(input: { owner: string; id: string; expiresAt: number }, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, now => this.db.prepare('UPDATE suppressions SET expires_at=? WHERE owner=? AND id=? AND (expires_at IS NULL OR expires_at>?)').run(input.expiresAt, input.owner, input.id, now).changes > 0, signal);
  }
  releaseSuppression(input: { owner: string; id: string }, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, () => this.db.prepare('DELETE FROM suppressions WHERE owner=? AND id=?').run(input.owner, input.id).changes > 0, signal);
  }
  cancel(input: { owner: string; generation: string }, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, () => {
      if (!this.attached(input.owner, input.generation)) return false;
      this.db.prepare(`INSERT INTO cancellations VALUES(?,?,(SELECT next_seq-1 FROM meta))
        ON CONFLICT(owner) DO UPDATE SET generation=excluded.generation,through_seq=MAX(through_seq,excluded.through_seq)`).run(input.owner, input.generation);
      return true;
    }, signal);
  }
  private isSuppressed(owner: string, key: string, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM suppressions WHERE owner=? AND (expires_at IS NULL OR expires_at>?)
      AND ((scope='exact' AND key=?) OR (scope='prefix' AND substr(?,1,length(key))=key)) LIMIT 1`).get(owner, now, key, key);
  }
  private eligible(row: Row, now: number): boolean {
    if (this.isSuppressed(String(row.owner), String(row.key), now)) return false;
    if (this.db.prepare('SELECT 1 FROM receipts WHERE owner=? AND key=?').get(row.owner, row.key)) return false;
    const cancellation = this.db.prepare('SELECT through_seq FROM cancellations WHERE owner=?').get(row.owner);
    return !(cancellation && Number(cancellation.through_seq) >= Number(row.seq));
  }
  private insertAttempt(seq: number, generation: string, track: DeliveryAttempt['track'], routeKind: string | null, now: number, leaseMs: number): DeliveryAttempt {
    const token = randomUUID();
    this.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,?,'dispatching','{}',?,?,NULL)").run(token, seq, generation, track, routeKind, now, now + leaseMs);
    return this.getAttempt(token)!;
  }
  claimPresentation(owner: string, generation: string, budgetChars: number, leaseMs: number, signal?: AbortSignal): Promise<{ cards: DeliveryCard[]; attempts: DeliveryAttempt[] } | undefined> {
    return this.transaction(true, now => {
      if (!this.attached(owner, generation)) return undefined;
      this.normalize(now);
      const cards: DeliveryCard[] = [], attempts: DeliveryAttempt[] = [];
      let size = 0;
      for (const row of this.db.prepare('SELECT * FROM cards WHERE owner=? ORDER BY seq').all(owner) as Row[]) {
        if (!this.eligible(row, now) || this.listAttempts(row.seq as number).some(holds)) continue;
        const next = card(row);
        const nextSize = size + next.text.length + (cards.length ? 2 : 0);
        if (nextSize > budgetChars && cards.length > 0) break;
        size = nextSize;
        cards.push(next);
        attempts.push(this.insertAttempt(next.seq, generation, 'presentation', null, now, leaseMs));
        if (size > budgetChars) break;
      }
      return cards.length ? { cards, attempts } : undefined;
    }, signal);
  }
  claimHandoff(owner: string, key: string, generation: string, kind: string, leaseMs: number, signal?: AbortSignal): Promise<{ card: DeliveryCard; route: DeliveryRoute; attempt: DeliveryAttempt } | undefined> {
    return this.transaction(true, now => {
      const route = this.attached(owner, generation)?.routes.find(route => route.kind === kind);
      if (!route) return undefined;
      this.normalize(now);
      const row = this.db.prepare('SELECT * FROM cards WHERE owner=? AND key=?').get(owner, key) as Row | undefined;
      if (!row || !this.eligible(row, now) || this.listAttempts(row.seq as number).some(holds)) return undefined;
      return { card: card(row), route, attempt: this.insertAttempt(row.seq as number, generation, 'handoff', route.kind, now, leaseMs) };
    }, signal);
  }
  current(tokens: readonly string[], signal?: AbortSignal, route?: DeliveryRoute): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return this.transaction(false, now => tokens.every(token => {
      const a = this.getAttempt(token);
      if (!a || a.outcome !== 'dispatching' || a.expiresAt <= now) return false;
      const row = this.db.prepare('SELECT * FROM cards WHERE seq=?').get(a.seq) as Row | undefined;
      const s = row && this.attached(row.owner as string, a.generation);
      const registered = s?.routes.find(candidate => candidate.kind === route?.kind);
      return !!row && !!s && this.eligible(row, now) && (route === undefined || !!registered
        && Object.keys(route.address).length === Object.keys(registered.address).length
        && Object.entries(route.address).every(([key, value]) => Object.hasOwn(registered.address, key) && registered.address[key] === value));
    }), signal);
  }
  prepare(token: string, value: DeliveryCorrelation, signal?: AbortSignal): Promise<boolean> {
    const encoded = JSON.stringify(value);
    return this.transaction(true, now => {
      const a = this.getAttempt(token);
      if (!a || a.outcome !== 'dispatching' || a.expiresAt <= now) return false;
      if (a.correlation.payloadHash !== undefined && a.correlation.payloadHash !== value.payloadHash) return false;
      const row = this.db.prepare('SELECT owner FROM cards WHERE seq=?').get(a.seq);
      if (!row || !this.attached(row.owner as string, a.generation)) return false;
      this.db.prepare('UPDATE attempts SET correlation_json=? WHERE token=?').run(encoded, token);
      return true;
    }, signal);
  }
  private receipt(seq: number, now: number): void {
    this.db.prepare('INSERT INTO receipts SELECT owner,key,? FROM cards WHERE seq=? ON CONFLICT(owner,key) DO NOTHING').run(now, seq);
  }
  private confirm(handoff: DeliveryAttempt, now: number): boolean {
    if (handoff.track !== 'handoff' || !['dispatching', 'accepted', 'unknown'].includes(handoff.outcome)) return false;
    const previous = this.listAttempts(handoff.seq).filter(a => a.track === 'presentation');
    if (previous.some(a => a.outcome === 'presented')) return true;
    if (previous.some(holds)) return false;
    const p = this.insertAttempt(handoff.seq, handoff.generation, 'presentation', handoff.routeKind, now, 1);
    this.db.prepare("UPDATE attempts SET outcome='presented',correlation_json=?,settled_at=? WHERE token=?").run(JSON.stringify(handoff.correlation), now, p.token);
    this.receipt(handoff.seq, now);
    return true;
  }
  settle(tokens: readonly string[], outcome: Exclude<DeliveryOutcome, 'dispatching'>, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, now => {
      const attempts = tokens.map(token => this.getAttempt(token));
      if (attempts.some(a => !a || a.track === 'presentation' && outcome === 'accepted'
        || !['dispatching', 'unknown'].includes(a.outcome) && a.outcome !== outcome)) return false;
      for (const a of attempts as DeliveryAttempt[]) {
        if (a.outcome === outcome) continue;
        if (a.outcome === 'unknown' && !['accepted', 'presented'].includes(outcome)) return false;
      }
      for (const a of attempts as DeliveryAttempt[]) {
        if (a.outcome === outcome) continue;
        if (a.track === 'handoff' && outcome === 'presented') {
          if (!this.confirm(a, now)) throw new Error('Cannot confirm handoff presentation');
          this.db.prepare("UPDATE attempts SET outcome='accepted',settled_at=? WHERE token=?").run(now, a.token);
        } else {
          this.db.prepare('UPDATE attempts SET outcome=?,settled_at=? WHERE token=?').run(outcome, now, a.token);
          if (outcome === 'presented') this.receipt(a.seq, now);
        }
      }
      return true;
    }, signal, true);
  }
  private handoffFacts(token: string): { attempt: DeliveryAttempt; row: Row; ref: DeliveryHandoffRef & { routeKind: string } } | undefined {
    const a = this.getAttempt(token);
    if (!a || a.track !== 'handoff' || !a.routeKind || !a.correlation.payloadHash) return undefined;
    const row = this.db.prepare('SELECT * FROM cards WHERE seq=?').get(a.seq) as Row | undefined;
    if (!row) return undefined;
    return { attempt: a, row, ref: { token: a.token, owner: row.owner as string, generation: a.generation,
      payloadHash: a.correlation.payloadHash, routeKind: a.routeKind } };
  }
  private matchingHandoff(ref: DeliveryHandoffRef): ReturnType<LedgerStore['handoffFacts']> {
    if (!ref || typeof ref !== 'object' || typeof ref.token !== 'string') return undefined;
    const facts = this.handoffFacts(ref.token);
    return facts && facts.ref.owner === ref.owner && facts.ref.generation === ref.generation
      && facts.ref.payloadHash === ref.payloadHash && ref.routeKind === facts.ref.routeKind ? facts : undefined;
  }
  private currentHandoff(facts: NonNullable<ReturnType<LedgerStore['handoffFacts']>>, now: number): boolean {
    const s = this.attached(facts.ref.owner, facts.ref.generation);
    return facts.attempt.expiresAt > now && !!s && s.routes.some(route => route.kind === facts.ref.routeKind) && this.eligible(facts.row, now);
  }
  handoff(token: string, signal?: AbortSignal): Promise<(DeliveryHandoffRef & { routeKind: string }) | undefined> {
    return this.transaction(false, () => this.handoffFacts(token)?.ref, signal);
  }
  guardHandoff(ref: DeliveryHandoffRef, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(false, now => {
      const facts = this.matchingHandoff(ref);
      return !!facts && ['dispatching', 'unknown'].includes(facts.attempt.outcome) && this.currentHandoff(facts, now);
    }, signal);
  }
  acceptHandoff(ref: DeliveryHandoffRef, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, now => {
      const a = this.matchingHandoff(ref)?.attempt;
      if (!a || !['dispatching', 'unknown', 'accepted'].includes(a.outcome)) return false;
      if (a.outcome !== 'accepted') this.db.prepare("UPDATE attempts SET outcome='accepted',settled_at=? WHERE token=?").run(now, a.token);
      return true;
    }, signal);
  }
  observePresentation(handoff: string | DeliveryHandoffRef, options?: { readonly requireCurrent?: boolean }, signal?: AbortSignal): Promise<boolean> {
    return this.transaction(true, now => {
      const facts = typeof handoff === 'string' ? undefined : this.matchingHandoff(handoff);
      if (options?.requireCurrent) {
        const s = facts && this.attached(facts.ref.owner, facts.ref.generation);
        if (!facts || !s || !s.routes.some(route => route.kind === facts.ref.routeKind) || !this.eligible(facts.row, now)
          || !!this.db.prepare(`SELECT 1 FROM attempts WHERE seq=? AND rowid>(SELECT rowid FROM attempts WHERE token=?) LIMIT 1`)
            .get(facts.attempt.seq, facts.attempt.token)) return false;
      }
      const a = typeof handoff === 'string' ? this.getAttempt(handoff) : facts?.attempt;
      return a ? this.confirm(a, now) : false;
    }, signal);
  }
  receipts(owner: string, options: { keys?: readonly string[]; since?: number }, signal?: AbortSignal): Promise<readonly DeliveryReceipt[]> {
    return this.transaction(false, () => (this.db.prepare('SELECT * FROM receipts WHERE owner=? AND at>=? ORDER BY at,key').all(owner, options.since ?? -Number.MAX_VALUE) as Row[])
      .filter(row => options.keys === undefined || options.keys.includes(row.key as string))
      .map(row => ({ owner: row.owner as string, key: row.key as string, at: row.at as number })), signal);
  }
  health(owner?: string, signal?: AbortSignal): Promise<DeliveryHealth> {
    return this.transaction(false, now => {
      const all = (this.db.prepare('SELECT a.* FROM attempts a JOIN cards c ON c.seq=a.seq WHERE (? IS NULL OR c.owner=?) ORDER BY a.started_at,a.token').all(owner ?? null, owner ?? null) as Row[]).map(attempt);
      const repeatedFailures = (this.db.prepare(`SELECT c.owner,c.key,COUNT(*) AS count FROM attempts a JOIN cards c ON c.seq=a.seq
        WHERE a.outcome='failed' AND (? IS NULL OR c.owner=?) GROUP BY c.owner,c.key HAVING COUNT(*)>=2 ORDER BY c.seq`).all(owner ?? null, owner ?? null) as Row[])
        .map(row => ({ owner: row.owner as string, key: row.key as string, count: row.count as number }));
      const sessions = (this.db.prepare("SELECT * FROM sessions WHERE state='attached' AND (? IS NULL OR owner=?) ORDER BY owner").all(owner ?? null, owner ?? null) as Row[]).map(row => session(row)!);
      return { unknownAttempts: all.filter(a => a.outcome === 'unknown' || a.outcome === 'dispatching' && a.expiresAt <= now)
        .map(a => a.outcome === 'dispatching' ? { ...a, outcome: 'unknown' as const } : a), repeatedFailures,
        sessionsWithoutRoute: sessions.filter(s => s.routes.length === 0).map(s => s.owner) };
    }, signal);
  }
}
