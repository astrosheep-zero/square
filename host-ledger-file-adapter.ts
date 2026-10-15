import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock as acquireFileLock, type FileLockOptions } from './file-lock.js';
import { nameKey } from './model.js';
import { formatActivityId } from './square-core.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import { observeFileMetadata, observeFileVersion, type VersionObserver } from './file-changes.js';
import { canonicalPath, canonicalPathSync } from './canonical-path.js';
import { LEDGER_FILENAME, LEDGER_RETENTION, withLedger, readLedgerRevisions } from './host-ledger-sqlite.js';
import type { HostLedgerPort, PresenceRecord, PresenceKey, PresenceLookup, PresenceResult, PresenceClaimResult, EvidenceRecord, EvidenceClaim, EvidenceRelease, EvidenceLookup, ClaimResult, WakeAttemptClaim, WakeAttemptClaimInput, WakeAttemptLookup } from './host-ledger.js';
const LOCK = { retryMs: 10 } as const;

// The claim fence deliberately spans asynchronous artifact/native work, never a ledger transaction.
async function withFileLock<T>(file: string, options: FileLockOptions, fn: () => T | Promise<T>): Promise<T> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted');
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  try { await fs.writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  try { return await acquireFileLock(file, options, fn); }
  catch (error) { if (options.signal?.aborted) throw options.signal.reason ?? error; throw error; }
}
export interface HostLedgerFileAdapterOptions { rootPath?: string; now?: () => number }
function identity(v: { location: string; participant: string; session: string; channel?: string; activity?: string; kind?: string }): string {
  return JSON.stringify([v.location, nameKey(v.participant), v.session, v.channel, v.activity, v.kind]);
}
function durableWake(record: object): boolean {
  const row = record as { kind?: string; outcome?: string };
  return row.kind === 'wake' && ['accepted', 'unknown', 'dispatching'].includes(row.outcome ?? '');
}
function finishWake(current: EvidenceRecord, outcome: 'accepted' | 'failed' | 'released' | 'unknown', details: Partial<EvidenceRecord> = {}): EvidenceRecord {
  const { expiresAt: _expiresAt, ownerPid: _ownerPid, unknownSource: _unknownSource, ...rest } = current;
  return { ...rest, ...details, kind: 'wake', outcome, ...(outcome === 'unknown' ? { unknownSource: details.unknownSource ?? 'transport' } : {}) };
}
function processAlive(pid: number | undefined): boolean | undefined {
  if (pid === undefined) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : true; }
}
// Pair snapshots are process-shared, but subscribers own their cancellation and category scalar.
interface RevisionReader {
  refs: number;
  metadata: VersionObserver<string>;
  controller: AbortController;
  cached?: { metadata: string; revisions: { presence: number; evidence: number } | undefined };
  pending?: Promise<void>;
}
const revisionReaders = new Map<string, Promise<RevisionReader>>();
async function revisions(root: string, entry: RevisionReader, signal?: AbortSignal): Promise<{ presence: number; evidence: number } | undefined> {
  for (;;) {
    const metadata = await entry.metadata.read(signal);
    if (entry.cached?.metadata === metadata) return entry.cached.revisions;
    if (entry.pending) { await entry.pending; continue; }
    entry.pending = readLedgerRevisions(root, entry.controller.signal).then((value) => {
      // Never associate a snapshot with metadata obtained after the read.
      entry.cached = { metadata, revisions: value };
    }).finally(() => { entry.pending = undefined; });
    await entry.pending;
  }
}
async function observeLedger(root: string): Promise<{ presence: VersionObserver<string>; evidence: VersionObserver<string> }> {
  let shared = revisionReaders.get(root);
  if (!shared) {
    shared = observeFileMetadata(path.join(root, LEDGER_FILENAME)).then((metadata) => ({ metadata, refs: 0, controller: new AbortController() }));
    revisionReaders.set(root, shared);
    void shared.catch(() => { if (revisionReaders.get(root) === shared) revisionReaders.delete(root); });
  }
  const entry = await shared;
  // A previous last subscriber may have closed while this acquisition awaited metadata.
  if (revisionReaders.get(root) !== shared) return observeLedger(root);
  entry.refs += 2;
  const release = () => { if (--entry.refs === 0) { entry.controller.abort(new Error('Host ledger monitor closed')); entry.metadata.close(); revisionReaders.delete(root); } };
  async function category(kind: 'presence' | 'evidence'): Promise<VersionObserver<string>> {
    const observer = await observeFileVersion(path.join(root, LEDGER_FILENAME), `host-ledger-${kind}`, async (_file, signal) => {
      const pair = await revisions(root, entry, signal);
      return pair === undefined ? 'missing' : String(pair[kind]);
    });
    let closed = false;
    return { get generation() { return observer.generation; }, hinted: observer.hinted, read: observer.read, changed: observer.changed,
      close() { if (!closed) { closed = true; observer.close(); release(); } } };
  }
  let presence: VersionObserver<string> | undefined;
  try { presence = await category('presence'); return { presence, evidence: await category('evidence') }; }
  catch (error) { if (presence) presence.close(); else release(); release(); throw error; }
}

/** Existing port surface; each operation owns a short-lived SQLite connection. */
export class FileHostLedgerPort implements HostLedgerPort {
  private readonly root: string;
  private readonly clock: () => number;
  constructor(o: HostLedgerFileAdapterOptions = {}) {
    this.root = canonicalPathSync(o.rootPath ?? hostLedgerRoot());
    this.clock = o.now ?? Date.now;
  }
  observeChanges(): Promise<{ presence: VersionObserver<string>; evidence: VersionObserver<string> }> { return observeLedger(this.root); }
  async nextExpiry(session: string): Promise<number> {
    const now = this.clock();
    return withLedger(this.root, false, (tx) => {
      const records = [...tx.presence({ session }, now, true), ...tx.evidence({ session, includeReleased: true }, now, true)];
      let next = Infinity;
      for (const { record } of records) {
        const at = 'updatedAt' in record ? record.updatedAt : 'at' in record ? record.at : undefined;
        if (typeof at === 'number') {
          if (at > now) next = Math.min(next, at);
          if (at + LEDGER_RETENTION + 1 > now && !durableWake(record)) next = Math.min(next, at + LEDGER_RETENTION + 1);
        }
        if ('expiresAt' in record && typeof record.expiresAt === 'number' && record.expiresAt > now) next = Math.min(next, record.expiresAt);
      }
      return next;
    }, Infinity);
  }
  withClaimLock<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withFileLock(path.join(this.root, 'presence-claim.lock'), { ...LOCK, signal }, fn);
  }
  async claimPresence(i: PresenceRecord, signal?: AbortSignal): Promise<PresenceClaimResult> {
    const location = await canonicalPath(i.location);
    const record = { ...i, location, updatedAt: i.updatedAt ?? this.clock(), v: 1 as const };
    try {
      return await this.withClaimLock(() => withLedger<PresenceClaimResult>(this.root, true, (tx) => {
        const existing = tx.presence({ location, participant: record.participant }, this.clock(), true)
          .map(({ record }) => record).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
        if (existing !== undefined) return { status: existing.session === record.session ? 'owned' : 'busy', record: existing };
        tx.publish('presence', this.clock()); tx.insert('presence', record);
        return { status: 'acquired', record };
      }, { status: 'degraded', record, error: new Error('Missing writable host ledger') }, signal), signal);
    } catch (error) { return { status: 'degraded', record, error }; }
  }
  async ensurePresence(i: PresenceRecord): Promise<PresenceResult> {
    const record = { ...i, location: await canonicalPath(i.location), updatedAt: i.updatedAt ?? this.clock(), v: 1 as const };
    try {
      await withLedger(this.root, true, (tx) => {
        const rows = tx.presence({ location: record.location, participant: record.participant, session: record.session, channel: record.channel }, this.clock(), true).filter((row) => identity(row.record) === identity(record));
        const current = rows.at(-1)?.record;
        const cancelledThrough = current?.epoch === record.epoch ? Math.max(current?.cancelledThrough ?? -1, record.cancelledThrough ?? -1) : record.cancelledThrough ?? -1;
        tx.publish('presence', this.clock()); tx.remove('presence', rows);
        tx.insert('presence', { ...record, ...(cancelledThrough < 0 ? {} : { cancelledThrough }) });
      }, undefined);
      return { status: 'ensured', record };
    } catch (error) { return { status: 'degraded', record, error }; }
  }
  async suppressPresence(i: PresenceRecord, through: number): Promise<boolean> {
    const record = { ...i, location: await canonicalPath(i.location) };
    return withLedger(this.root, true, (tx) => {
      const current = tx.presence({ location: record.location, participant: record.participant, session: record.session, channel: record.channel }, this.clock(), true).findLast((row) => identity(row.record) === identity(record) && row.record.epoch === record.epoch);
      if (!current) return false;
      tx.publish('presence', this.clock()); tx.replace('presence', current.seq, { ...current.record, cancelledThrough: Math.max(current.record.cancelledThrough ?? -1, through) });
      return true;
    }, false);
  }
  async removePresence(i: PresenceKey): Promise<void> {
    const record = { ...i, location: await canonicalPath(i.location) };
    await withLedger(this.root, true, (tx) => {
      const rows = tx.presence({ location: record.location, participant: record.participant, session: record.session, channel: record.channel }, this.clock(), true).filter((row) => identity(row.record) === identity(record));
      tx.publish('presence', this.clock()); tx.remove('presence', rows);
    }, undefined);
  }
  async removePresenceIfUnchanged(i: PresenceRecord): Promise<boolean> {
    const record = { ...i, location: await canonicalPath(i.location) };
    return withLedger(this.root, true, (tx) => {
      const current = tx.presence({ location: record.location, participant: record.participant, session: record.session, channel: record.channel }, this.clock(), true).findLast(({ record: row }) => identity(row) === identity(record) && (row.epoch ?? undefined) === (record.epoch ?? undefined) && (row.updatedAt ?? undefined) === (record.updatedAt ?? undefined));
      if (!current) return false;
      tx.publish('presence', this.clock()); tx.remove('presence', [current]); return true;
    }, false);
  }
  async listPresence(i: PresenceLookup = {}): Promise<readonly PresenceRecord[]> {
    const location = i.location === undefined ? undefined : await canonicalPath(i.location);
    return withLedger(this.root, false, (tx) => tx.presence({ ...i, location, participant: i.participant || undefined, session: i.session || undefined }, i.now ?? this.clock()).map(({ record }) => {
      const { scope: _scope, ...row } = record as PresenceRecord & { scope?: unknown }; return row;
    }), []);
  }
  async claimWakeAttempt(i: WakeAttemptClaimInput): Promise<WakeAttemptClaim> {
    const location = await canonicalPath(i.attention.squarePath), activity = formatActivityId(i.attention.actIndex), at = i.now ?? this.clock();
    try {
      return await withLedger<WakeAttemptClaim>(this.root, true, (tx) => {
        const attention = tx.evidence({ location, participant: i.attention.recipient, activity, kind: 'wake', includeReleased: true }, at, true);
        const terminal = attention.findLast(({ record }) => record.outcome === 'accepted') ?? attention.findLast(({ record }) => record.outcome === 'unknown');
        if (terminal) return { status: 'terminal', record: terminal.record };
        const interrupted = attention.filter(({ record }) => record.outcome === 'dispatching');
        const busy = interrupted.find(({ record }) => (record.expiresAt ?? 0) > at && processAlive(record.ownerPid) !== false);
        if (busy) return { status: 'busy', record: busy.record };
        const nextNumber = (session: string) => attention.filter(({ record }) => record.session === session).reduce((highest, { record }) => Math.max(highest, record.attemptN ?? 0), 0) + 1;
        tx.publish('evidence', at);
        if (interrupted.length) {
          const recovered = interrupted.map(({ record }) => ({ ...finishWake(record, 'unknown', {
            unknownSource: 'interrupted', signature: 'worker_interrupted_during_dispatch', message: 'The notification worker ended after dispatch began; transport acceptance is unknown.',
          }), routeKind: record.routeKind ?? i.routeKind, attemptN: record.attemptN ?? nextNumber(record.session), v: 1 as const }));
          interrupted.forEach((row, index) => tx.replace('evidence', row.seq, recovered[index]));
          return { status: 'terminal', record: recovered[0] };
        }
        const attemptN = nextNumber(i.session), claimToken = `${process.pid}-${at}-${randomUUID()}`;
        tx.insert('evidence', { v: 1, at, location, participant: i.attention.recipient, session: i.session, activity, kind: 'wake', outcome: 'dispatching', routeKind: i.routeKind, attemptN, claimToken, ownerPid: process.pid, expiresAt: at + i.leaseMs });
        return { status: 'acquired', claimToken, attemptN };
      }, { status: 'degraded', error: new Error('Missing writable host ledger') });
    } catch (error) { return { status: 'degraded', error }; }
  }
  private async updateWake(input: Pick<EvidenceRecord, 'location' | 'participant' | 'activity' | 'session'> & { claimToken: string }, update: (current: EvidenceRecord) => EvidenceRecord | undefined, at = this.clock()): Promise<boolean> {
    if (!input.claimToken) return false;
    const location = await canonicalPath(input.location);
    return withLedger(this.root, true, (tx) => {
      const current = tx.evidence({ location, participant: input.participant, activity: input.activity, session: input.session, kind: 'wake', claimToken: input.claimToken, includeReleased: true }, at, true).at(-1);
      const next = current && update(current.record);
      if (!next || !current) return false;
      if (next !== current.record) { tx.publish('evidence', at); tx.replace('evidence', current.seq, { ...next, v: 1 }); }
      return true;
    }, false);
  }
  async listWakeAttempts(i: WakeAttemptLookup = {}): Promise<readonly EvidenceRecord[]> {
    const attention = i.attention;
    return this.listEvidence({ kind: 'wake', ...(attention === undefined ? {} : { location: await canonicalPath(attention.squarePath), participant: attention.recipient, activity: formatActivityId(attention.actIndex) }), session: i.session, now: i.now });
  }
  async prepareNativeWake(i: EvidenceRecord & { readonly claimToken: string; readonly routeKind: import('./model.js').WakeRouteKind; readonly nativeDelivery: import('./host-ledger.js').NativeDeliveryEvidence }): Promise<boolean> {
    return this.updateWake(i, (current) => current.outcome === 'dispatching' ? { ...current, nativeDelivery: i.nativeDelivery, routeKind: i.routeKind, attemptN: i.attemptN } : undefined);
  }
  async confirmWakeAdmission(i: EvidenceRecord & { readonly claimToken: string }): Promise<boolean> {
    return this.updateWake(i, (current) => {
      if (!current.nativeDelivery || !['dispatching', 'unknown', 'accepted'].includes(current.outcome)) return undefined;
      return current.outcome === 'accepted' ? current : finishWake(current, 'accepted', { signature: 'native_queue_confirmed', message: undefined, diagnostic: undefined });
    });
  }
  async claimEvidence(i: EvidenceClaim): Promise<ClaimResult> {
    if ((i.kind as string) === 'wake') return { status: 'degraded', error: new Error('wake attempts are claimed with claimWakeAttempt') };
    const at = i.now ?? this.clock(), { leaseMs, ...claim } = i;
    const record = { ...claim, location: await canonicalPath(i.location), outcome: 'dispatching', at, expiresAt: at + leaseMs, v: 1 as const };
    try {
      return await withLedger<ClaimResult>(this.root, true, (tx) => {
        const matching = tx.evidence({ ...record, includeReleased: true }, at, true);
        const old = matching.findLast(({ record }) => record.outcome === 'dispatching');
        if (old && typeof old.record.expiresAt === 'number' && old.record.expiresAt > at) return { status: 'busy', record: old.record };
        const presented = matching.findLast(({ record }) => record.outcome === 'presented');
        if (record.kind === 'presentation' && presented) return { status: 'delivered', record: presented.record };
        const claimToken = `${process.pid}-${at}-${Math.random().toString(36).slice(2)}`;
        tx.publish('evidence', at); tx.remove('evidence', matching.filter(({ record }) => record.outcome === 'dispatching' || record.outcome === 'released'));
        tx.insert('evidence', { ...record, claimToken }); return { status: 'acquired', claimToken };
      }, { status: 'degraded', error: new Error('Missing writable host ledger') });
    } catch (error) { return { status: 'degraded', error }; }
  }
  async releaseEvidence(i: EvidenceRelease): Promise<void> {
    if (i.kind === 'wake') {
      const { signature, message, diagnostic, routeKind, attemptN } = i;
      const details = Object.fromEntries(Object.entries({ signature, message, diagnostic, routeKind, attemptN }).filter(([, value]) => value !== undefined));
      await this.updateWake(i, (current) => current.outcome === 'dispatching' ? finishWake(current, 'released', { ...details, at: i.now ?? this.clock() }) : undefined, i.now);
      return;
    }
    const location = await canonicalPath(i.location), at = i.now ?? this.clock();
    await withLedger(this.root, true, (tx) => {
      const current = tx.evidence({ ...i, location, includeReleased: true, claimToken: undefined }, at, true).findLast(({ record }) => record.outcome === 'dispatching');
      if (!current || current.record.claimToken !== i.claimToken) return;
      const { expiresAt: _expiry, ownerPid: _owner, ...rest } = current.record;
      const details = Object.fromEntries(['routeKind', 'attemptN', 'signature', 'message', 'diagnostic'].filter((field) => i[field as keyof EvidenceRelease] !== undefined).map((field) => [field, i[field as keyof EvidenceRelease]]));
      tx.publish('evidence', at); tx.remove('evidence', [current]); tx.insert('evidence', { ...rest, outcome: 'released', at, ...details });
    }, undefined);
  }
  async appendEvidence(i: EvidenceRecord & { readonly claimToken: string }): Promise<void> {
    const record = { ...i, location: await canonicalPath(i.location), at: i.at ?? this.clock(), v: 1 as const };
    if (typeof i.claimToken !== 'string' || !i.claimToken.length) return;
    if (i.kind === 'wake') {
      if (!['accepted', 'failed', 'unknown'].includes(record.outcome)) return;
      const outcome = record.outcome as 'accepted' | 'failed' | 'unknown';
      await this.updateWake(record, (current) => {
        if (current.outcome !== 'dispatching' && !(current.outcome === 'unknown' && current.unknownSource === 'interrupted' && outcome === 'accepted')) return undefined;
        return finishWake(current, outcome, { at: record.at, routeKind: record.routeKind, attemptN: record.attemptN, signature: record.signature, message: record.message, diagnostic: record.diagnostic });
      }, record.at);
      return;
    }
    await withLedger(this.root, true, (tx) => {
      const matching = tx.evidence({ ...record, claimToken: undefined, includeReleased: true }, record.at, true);
      const source = matching.findLast(({ record }) => record.outcome === 'dispatching');
      if (!source || source.record.claimToken !== record.claimToken) return;
      tx.publish('evidence', record.at);
      tx.remove('evidence', matching.filter((row) => row === source || row.record.attemptN === record.attemptN && row.record.outcome !== 'dispatching' && row.record.outcome !== 'released'));
      tx.insert('evidence', { ...record, ...(source.record.nativeDelivery === undefined ? {} : { nativeDelivery: source.record.nativeDelivery }) });
    }, undefined);
  }
  async listEvidence(i: EvidenceLookup = {}): Promise<readonly EvidenceRecord[]> {
    const location = i.location === undefined ? undefined : await canonicalPath(i.location);
    return withLedger(this.root, false, (tx) => tx.evidence({ ...i, location, participant: i.participant || undefined, session: i.session || undefined, activity: i.activity || undefined, kind: i.kind || undefined }, i.now ?? this.clock()).map(({ record }) => record), []);
  }
}
export function createHostLedgerPort(o: HostLedgerFileAdapterOptions = {}): FileHostLedgerPort { return new FileHostLedgerPort(o); }
