import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { inSqliteTransaction } from './sqlite-transaction.js';
import { validateSchema } from './sqlite-framing.js';
import { renderDeliveryBatch } from './delivery-ledger-render.js';
import type { DeliveryAttempt, DeliveryCard, DeliveryCorrelation, DeliveryHealth, DeliveryOutcome, DeliveryReceipt, DeliveryRoute, DeliverySession, PostResult, RetractResult } from './delivery-ledger.js';

type Row = Record<string, SQLInputValue>;
const FORMAT = 1;
const APPLICATION_ID = 0x444c4752;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCHEMA = `CREATE TABLE meta (format INTEGER NOT NULL, next_seq INTEGER NOT NULL);
CREATE TABLE sessions (owner TEXT PRIMARY KEY, generation TEXT NOT NULL, state TEXT NOT NULL, routes_json TEXT NOT NULL, at REAL NOT NULL);
CREATE TABLE cards (seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, key TEXT NOT NULL, text TEXT NOT NULL, posted_at REAL NOT NULL, retracted_at REAL, UNIQUE(owner,key));
CREATE INDEX cards_owner ON cards(owner,seq);
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
  return { seq: row.seq as number, owner: row.owner as string, key: row.key as string, text: row.text as string, postedAt: row.posted_at as number };
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
  private constructor(readonly location: string, private readonly db: DatabaseSync, private readonly clock: () => number) {}
  static async open(location: string, clock: () => number): Promise<LedgerStore> {
    try { await fs.access(location); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
      const temporary = location + '.' + randomUUID() + '.tmp';
      let initial: DatabaseSync | undefined;
      try {
        await (await fs.open(temporary, 'wx', 0o600)).close();
        initial = new DatabaseSync(temporary);
        await inSqliteTransaction(initial, true, () => undefined, () => {
          initial!.exec(SCHEMA);
          initial!.prepare('INSERT INTO meta VALUES(?,1)').run(FORMAT);
          initial!.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${FORMAT}`);
        });
        initial.close(); initial = undefined;
        try { await fs.link(temporary, location); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      } finally {
        initial?.close();
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
    // Existing formats are inspected on a read-only connection before any writable open.
    const probe = new DatabaseSync(location, { readOnly: true });
    try { validate(probe, location); } finally { probe.close(); }
    const db = new DatabaseSync(location);
    try { validate(db, location); return new LedgerStore(location, db, clock); }
    catch (error) { db.close(); throw error; }
  }
  close(): Promise<void> {
    this.closed = true;
    return this.pending.then(() => this.db.close());
  }
  private transaction<T>(write: boolean, change: (now: number) => T, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Delivery ledger is closed'));
    const result = this.pending.then(() => inSqliteTransaction(this.db, write, () => validate(this.db, this.location), () => {
      const now = this.clock();
      if (!Number.isFinite(now)) throw new TypeError('Expected finite ledger time');
      const changes = Number(this.db.prepare('SELECT total_changes() AS n').get()!.n);
      const result = change(now);
      if (write && Number(this.db.prepare('SELECT total_changes() AS n').get()!.n) > changes) {
        this.normalize(now);
        this.gc(now);
      }
      return result;
    }, signal));
    this.pending = result.catch(() => undefined);
    return result;
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
  private getAttempt(token: string): DeliveryAttempt | undefined {
    const row = this.db.prepare('SELECT * FROM attempts WHERE token=?').get(token) as Row | undefined;
    return row ? attempt(row) : undefined;
  }
  private normalize(now: number): void {
    this.db.prepare(`UPDATE attempts SET outcome='unknown', settled_at=? WHERE outcome='dispatching' AND
      (expires_at<=? OR NOT EXISTS(SELECT 1 FROM cards c JOIN sessions s ON s.owner=c.owner
        WHERE c.seq=attempts.seq AND s.generation=attempts.generation AND s.state='attached'))`).run(now, now);
  }
  private gc(now: number): void {
    const cutoff = now - RETENTION_MS;
    const old = this.db.prepare(`SELECT c.seq FROM cards c WHERE c.posted_at<? AND
      (c.retracted_at<? OR EXISTS(SELECT 1 FROM attempts p WHERE p.seq=c.seq AND p.track='presentation' AND p.outcome='presented' AND p.settled_at<?))
      AND NOT EXISTS(SELECT 1 FROM attempts a WHERE a.seq=c.seq AND a.outcome='dispatching') ORDER BY c.seq LIMIT 100`).all(cutoff, cutoff, cutoff) as Row[];
    for (const row of old) {
      this.db.prepare('DELETE FROM attempts WHERE seq=?').run(row.seq);
      this.db.prepare('DELETE FROM cards WHERE seq=?').run(row.seq);
    }
    this.db.prepare('DELETE FROM receipts WHERE rowid IN (SELECT rowid FROM receipts WHERE at<? ORDER BY at LIMIT 100)').run(cutoff);
  }
  session(owner: string): Promise<DeliverySession | undefined> { return this.transaction(false, () => this.getSession(owner)); }
  attach(input: { owner: string; expectedGeneration: string | null; routes: readonly DeliveryRoute[] }): Promise<DeliverySession | false> {
    const encoded = JSON.stringify(input.routes);
    return this.transaction(true, now => {
      const previous = this.getSession(input.owner);
      if (previous?.state === 'deleted' || (previous ? previous.generation !== input.expectedGeneration : input.expectedGeneration !== null)) return false;
      const generation = randomUUID();
      this.db.prepare(`INSERT INTO sessions VALUES(?,?,'attached',?,?) ON CONFLICT(owner)
        DO UPDATE SET generation=excluded.generation,state=excluded.state,routes_json=excluded.routes_json,at=excluded.at`).run(input.owner, generation, encoded, now);
      return this.getSession(input.owner)!;
    });
  }
  updateRoutes(input: { owner: string; generation: string; routes: readonly DeliveryRoute[] }): Promise<boolean> {
    const encoded = JSON.stringify(input.routes);
    return this.transaction(true, now => {
      if (!this.attached(input.owner, input.generation)) return false;
      this.db.prepare('UPDATE sessions SET routes_json=?,at=? WHERE owner=?').run(encoded, now, input.owner);
      return true;
    });
  }
  lifecycle(input: { owner: string; generation: string }, state: 'detached' | 'deleted'): Promise<boolean> {
    return this.transaction(true, now => {
      const s = this.getSession(input.owner);
      if (!s || s.generation !== input.generation || s.state === 'deleted') return false;
      this.db.prepare('UPDATE sessions SET state=?,at=? WHERE owner=?').run(state, now, input.owner);
      return true;
    });
  }
  post(input: { owner: string; key: string; text: string }): Promise<PostResult> {
    return this.transaction(true, now => {
      const s = this.getSession(input.owner);
      if (!s) return { status: 'unknown-session' };
      if (s.state === 'deleted') return { status: 'deleted-session' };
      const previous = this.db.prepare('SELECT text,retracted_at FROM cards WHERE owner=? AND key=?').get(input.owner, input.key);
      if (previous) return { status: previous.text !== input.text ? 'conflict' : previous.retracted_at === null ? 'duplicate' : 'retracted' };
      const seq = Number(this.db.prepare('SELECT next_seq FROM meta').get()!.next_seq);
      if (!Number.isSafeInteger(seq + 1)) throw new RangeError('Delivery sequence exhausted');
      this.db.prepare('UPDATE meta SET next_seq=?').run(seq + 1);
      this.db.prepare('INSERT INTO cards VALUES(?,?,?,?,?,NULL)').run(seq, input.owner, input.key, input.text, now);
      return { status: 'posted' };
    });
  }
  retract(input: { owner: string; key: string }): Promise<RetractResult> {
    return this.transaction(true, now => {
      const row = this.db.prepare('SELECT * FROM cards WHERE owner=? AND key=?').get(input.owner, input.key) as Row | undefined;
      if (!row) return 'not-found';
      if (this.listAttempts(row.seq as number).some(holds)) return 'in-custody';
      this.db.prepare('UPDATE cards SET retracted_at=COALESCE(retracted_at,?) WHERE seq=?').run(now, row.seq);
      return 'retracted';
    });
  }
  cancel(input: { owner: string; generation: string }): Promise<boolean> {
    return this.transaction(true, () => {
      if (!this.attached(input.owner, input.generation)) return false;
      this.db.prepare(`INSERT INTO cancellations VALUES(?,?,(SELECT next_seq-1 FROM meta))
        ON CONFLICT(owner) DO UPDATE SET generation=excluded.generation,through_seq=MAX(through_seq,excluded.through_seq)`).run(input.owner, input.generation);
      return true;
    });
  }
  private eligible(row: Row): boolean {
    if (row.retracted_at !== null) return false;
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
      for (const row of this.db.prepare('SELECT * FROM cards WHERE owner=? ORDER BY seq').all(owner) as Row[]) {
        if (!this.eligible(row) || this.listAttempts(row.seq as number).some(holds)) continue;
        const next = card(row);
        const size = renderDeliveryBatch([...cards, next]).length;
        if (size > budgetChars && cards.length > 0) continue;
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
      if (!row || !this.eligible(row) || this.listAttempts(row.seq as number).some(holds)) return undefined;
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
      return !!row && !!s && this.eligible(row) && (route === undefined || !!registered
        && Object.keys(route.address).length === Object.keys(registered.address).length
        && Object.entries(route.address).every(([key, value]) => Object.hasOwn(registered.address, key) && registered.address[key] === value));
    }), signal);
  }
  prepare(token: string, value: DeliveryCorrelation, signal?: AbortSignal): Promise<boolean> {
    const encoded = JSON.stringify(value);
    return this.transaction(true, now => {
      const a = this.getAttempt(token);
      if (!a || a.outcome !== 'dispatching' || a.expiresAt <= now) return false;
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
  settle(tokens: readonly string[], outcome: Exclude<DeliveryOutcome, 'dispatching'>): Promise<boolean> {
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
    });
  }
  observePresentation(token: string): Promise<boolean> {
    return this.transaction(true, now => {
      const a = this.getAttempt(token);
      return a ? this.confirm(a, now) : false;
    });
  }
  receipts(owner: string, options: { keys?: readonly string[]; since?: number }): Promise<readonly DeliveryReceipt[]> {
    return this.transaction(false, () => (this.db.prepare('SELECT * FROM receipts WHERE owner=? AND at>=? ORDER BY at,key').all(owner, options.since ?? -Number.MAX_VALUE) as Row[])
      .filter(row => options.keys === undefined || options.keys.includes(row.key as string))
      .map(row => ({ owner: row.owner as string, key: row.key as string, at: row.at as number })));
  }
  health(owner?: string): Promise<DeliveryHealth> {
    return this.transaction(false, now => {
      const all = (this.db.prepare('SELECT a.* FROM attempts a JOIN cards c ON c.seq=a.seq WHERE (? IS NULL OR c.owner=?) ORDER BY a.started_at,a.token').all(owner ?? null, owner ?? null) as Row[]).map(attempt);
      const repeatedFailures = (this.db.prepare(`SELECT c.owner,c.key,COUNT(*) AS count FROM attempts a JOIN cards c ON c.seq=a.seq
        WHERE a.outcome='failed' AND (? IS NULL OR c.owner=?) GROUP BY c.owner,c.key HAVING COUNT(*)>=2 ORDER BY c.seq`).all(owner ?? null, owner ?? null) as Row[])
        .map(row => ({ owner: row.owner as string, key: row.key as string, count: row.count as number }));
      const sessions = (this.db.prepare("SELECT * FROM sessions WHERE state='attached' AND (? IS NULL OR owner=?) ORDER BY owner").all(owner ?? null, owner ?? null) as Row[]).map(row => session(row)!);
      return { unknownAttempts: all.filter(a => a.outcome === 'unknown' || a.outcome === 'dispatching' && a.expiresAt <= now)
        .map(a => a.outcome === 'dispatching' ? { ...a, outcome: 'unknown' as const } : a), repeatedFailures,
        sessionsWithoutRoute: sessions.filter(s => s.routes.length === 0).map(s => s.owner) };
    });
  }
}
