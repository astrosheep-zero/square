import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { withFileLock as acquireFileLock, type FileLockOptions } from './file-lock.js';
import { nameKey } from './model.js';
import { formatActivityId } from './square-core.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import { observeFileMetadata, type VersionObserver } from './file-changes.js';
import type { HostLedgerPort, PresenceRecord, PresenceKey, PresenceLookup, PresenceResult, PresenceClaimResult, EvidenceRecord, EvidenceClaim, EvidenceRelease, EvidenceLookup, EvidenceGc, ClaimResult, WakeAttemptClaim, WakeAttemptClaimInput, WakeAttemptTransitionInput, WakeAttemptLookup } from './host-ledger.js';
const LOCK = { retryMs: 10 } as const; const RETENTION = 7 * 86400000;

// Prepare before locking: lock databases and their journals are local runtime data too.
async function withFileLock<T>(file: string, options: FileLockOptions, fn: () => T | Promise<T>): Promise<T> {
  if (options.signal?.aborted) throw options.signal.reason ?? new Error('File lock acquisition aborted');
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return acquireFileLock(file, options, fn);
}

export interface HostLedgerFileAdapterOptions { rootPath?: string; now?: () => number }
async function canon(value:string):Promise<string>{const absolute=path.resolve(value);try{return await fs.realpath(absolute)}catch{return absolute}}
function canonRoot(value:string):string{let current=path.resolve(value),suffix:string[]=[];for(;;){try{return path.join(fsSync.realpathSync.native(current),...suffix.reverse())}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')return path.resolve(value);const parent=path.dirname(current);if(parent===current)return path.resolve(value);suffix.push(path.basename(current));current=parent}}}
async function read<T extends {v:1;at?:number;updatedAt?:number;kind?:string;outcome?:string;nativeDelivery?:unknown}>(file:string,now:number,includeFuture=false):Promise<T[]>{try{return (await fs.readFile(file,'utf8')).split('\n').flatMap(line=>{try{const row=JSON.parse(line) as T;const at=row.at??row.updatedAt;return row.v===1&&typeof at==='number'&&(durableWake(row)||at>=now-RETENTION)&&(includeFuture||at<=now)?[row]:[]}catch{return[]}})}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return[];throw e}}
/** Accepted and possibly-sent wake attempts stay readable at any age; gcEvidence decides when they are no longer needed. */
function durableWake(row: object): boolean {
  const { kind, outcome } = row as { kind?: string; outcome?: string };
  return kind === 'wake' && (outcome === 'accepted' || outcome === 'unknown' || outcome === 'dispatching');
}
/** Keep the old ledger intact while Windows readers briefly deny replacement.
 * The owning file lock stays held throughout; never unlink the destination. */
async function write<T>(file: string, rows: readonly T[], signal?: AbortSignal): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('Ledger write aborted');
    await fs.writeFile(tmp, rows.length ? rows.map((row) => JSON.stringify(row)).join('\n') + '\n' : '', { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error('Ledger write aborted');
      try { await fs.rename(tmp, file); return; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error;
        await sleep(10 * 2 ** attempt, undefined, { signal });
      }
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}
function k(v:{location:string;participant:string;session:string;channel?:string;activity?:string;kind?:string}){return JSON.stringify([v.location,nameKey(v.participant),v.session,v.channel,v.activity,v.kind])}
function evidenceKey(v:{location:string;participant:string;session:string;activity:string;kind:string;attemptN?:number}){return JSON.stringify([v.location,nameKey(v.participant),v.session,v.activity,v.kind,v.attemptN??null])}
type WakeRow = EvidenceRecord & { v: 1 };
function processAlive(pid:number|undefined):boolean|undefined { if (pid===undefined) return undefined; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : true; } }
function wakeAttemptRows(rows: readonly WakeRow[], location: string, participant: string, activity: string): WakeRow[] {
  const key = nameKey(participant);
  return rows.filter((row) => row.kind === 'wake' && row.location === location && nameKey(row.participant) === key && row.activity === activity);
}
/** Legacy rows carry no owner, so only expiry can make a possibly-sent attempt recoverable. */
function wakeAttemptLive(row: WakeRow, now: number): boolean {
  if (typeof row.expiresAt !== 'number' || row.expiresAt <= now) return false;
  return processAlive(row.ownerPid) !== false;
}
/** A dispatching attempt that was never confirmed unsent may have reached its transport. */
function interruptedWakeAttempt(row: WakeRow, attentionRows: readonly WakeRow[], routeKind: import('./model.js').WakeRouteKind): WakeRow {
  const attemptN = row.attemptN ?? attentionRows.filter((candidate) => candidate.session === row.session).reduce((highest, candidate) => Math.max(highest, candidate.attemptN ?? 0), 0) + 1;
  const { ownerPid: _ownerPid, expiresAt: _expiresAt, ...rest } = row;
  return { ...rest, outcome: 'unknown', routeKind: row.routeKind ?? routeKind, attemptN, signature: 'worker_interrupted_during_dispatch', message: 'The notification worker ended after dispatch began; transport acceptance is unknown.' };
}
export class FileHostLedgerPort implements HostLedgerPort {
  private readonly root: string;
  private readonly clock: () => number;
  constructor(o: HostLedgerFileAdapterOptions = {}) {
    this.root = canonRoot(o.rootPath ?? hostLedgerRoot());
    this.clock = o.now ?? Date.now;
  }
  private file(kind: 'presence' | 'evidence'): string { return path.join(this.root, `${kind}.ndjsonl`); }
  /** Invalidation only: callers still use the ledger projections as their authority. */
  async observeChanges(): Promise<{ presence: VersionObserver<string>; evidence: VersionObserver<string> }> {
    const presence = await observeFileMetadata(this.file('presence'));
    try { return { presence, evidence: await observeFileMetadata(this.file('evidence')) }; }
    catch (error) { presence.close(); throw error; }
  }
  /** Time can expire bindings/evidence even when their files do not change. */
  async nextExpiry(session: string): Promise<number> {
    const now = this.clock();
    const rows = [...await read<PresenceRecord & { v: 1 }>(this.file('presence'), now, true),
      ...await read<EvidenceRecord & { v: 1 }>(this.file('evidence'), now, true)].filter((row) => row.session === session);
    let next = Infinity;
    for (const row of rows) {
      const at = 'updatedAt' in row ? row.updatedAt : 'at' in row ? row.at : undefined;
      if (typeof at === 'number') {
        if (at > now) next = Math.min(next, at);
        if (at + RETENTION + 1 > now && !durableWake(row)) next = Math.min(next, at + RETENTION + 1);
      }
      if ('expiresAt' in row && typeof row.expiresAt === 'number' && row.expiresAt > now) next = Math.min(next, row.expiresAt);
    }
    return next;
  }
  async claimPresence(i: PresenceRecord, signal?: AbortSignal): Promise<PresenceClaimResult> {
    const location = await canon(i.location);
    const record = { ...i, location, updatedAt: i.updatedAt ?? this.clock(), v: 1 as const };
    try {
      return await withFileLock(path.join(this.root, 'presence-claim.lock'), { ...LOCK, signal }, async () => {
        const file = this.file('presence');
        // The authoritative read, ownership check, and write share the presence file lock:
        // a concurrent ensurePresence/removePresence between them must never be overwritten
        // by a stale snapshot.
        return withFileLock(file + '.lock', { ...LOCK, signal }, async () => {
          const rows = await read<any>(file, this.clock(), true);
          const existing = rows.filter((row) => row.location === location && nameKey(row.participant) === nameKey(record.participant)).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
          if (existing !== undefined) return existing.session === record.session ? { status: 'owned', record: existing } : { status: 'busy', record: existing };
          await write(file, [...rows, record], signal);
          return { status: 'acquired', record };
        });
      });
    } catch (error) { return { status: 'degraded', record, error }; }
  }
  async ensurePresence(i: PresenceRecord): Promise<PresenceResult> {
    const record = { ...i, location: await canon(i.location), updatedAt: i.updatedAt ?? this.clock(), v: 1 as const };
    try {
      await withFileLock(this.file('presence') + '.lock', LOCK, async () => {
        const rows = await read<PresenceRecord & {v:1}>(this.file('presence'), this.clock(), true);
        const current = rows.findLast((row) => k(row) === k(record));
        const sameEpoch = current?.epoch === record.epoch;
        const cancelledThrough = sameEpoch ? Math.max(current?.cancelledThrough ?? -1, record.cancelledThrough ?? -1) : record.cancelledThrough ?? -1;
        await write(this.file('presence'), [...rows.filter((row) => k(row) !== k(record)), { ...record, ...(cancelledThrough < 0 ? {} : { cancelledThrough }) }]);
      });
      return { status: 'ensured', record };
    } catch (error) { return { status: 'degraded', record, error }; }
  }
  /** Local batch suppression is monotonic only for the captured host generation. */
  async suppressPresence(i: PresenceRecord, through: number): Promise<boolean> {
    const record = { ...i, location: await canon(i.location) };
    const file = this.file('presence');
    return withFileLock(file + '.lock', LOCK, async () => {
      const rows = await read<PresenceRecord & {v:1}>(file, this.clock(), true);
      const current = rows.findLast((row) => k(row) === k(record) && row.epoch === record.epoch);
      if (!current) return false;
      await write(file, rows.map((row) => row === current ? { ...row, cancelledThrough: Math.max(row.cancelledThrough ?? -1, through) } : row));
      return true;
    });
  }
  async removePresence(i: PresenceKey): Promise<void> {
    const record = { ...i, location: await canon(i.location) };
    await withFileLock(this.file('presence') + '.lock', LOCK, async () => write(this.file('presence'), (await read<any>(this.file('presence'), this.clock(), true)).filter((row) => k(row) !== k(record))));
  }
  async removePresenceIfUnchanged(i: PresenceRecord): Promise<boolean> {
    const record = { ...i, location: await canon(i.location) };
    return withFileLock(this.file('presence') + '.lock', LOCK, async () => {
      const file = this.file('presence');
      const rows = await read<any>(file, this.clock(), true);
      const matches = (row: any) => k(row) === k(record)
        && (row.epoch ?? undefined) === (record.epoch ?? undefined)
        && (row.updatedAt ?? undefined) === (record.updatedAt ?? undefined);
      const current = rows.findLast(matches);
      if (current === undefined) return false;
      await write(file, rows.filter((row) => row !== current));
      return true;
    });
  }
  async listPresence(i: PresenceLookup = {}): Promise<readonly PresenceRecord[]> {
    const location = i.location === undefined ? undefined : await canon(i.location);
    return (await read<any>(this.file('presence'), i.now ?? this.clock())).filter((row) =>
      (!location || row.location === location) && (!i.participant || nameKey(row.participant) === nameKey(i.participant)) && (!i.session || row.session === i.session)
    ).map(({ scope: _scope, ...row }) => row);
  }
  /** One attempt row owns attention-wide exclusion and session-scoped history for a wake. */
  async claimWakeAttempt(i: WakeAttemptClaimInput): Promise<WakeAttemptClaim> {
    const location = await canon(i.attention.squarePath);
    const activity = formatActivityId(i.attention.actIndex);
    const at = i.now ?? this.clock();
    const file = this.file('evidence');
    try {
      return await withFileLock(file + '.lock', LOCK, async () => {
        const all = await read<WakeRow>(file, at, true);
        const rows = wakeAttemptRows(all, location, i.attention.recipient, activity);
        // Accepted and possibly-sent evidence suppresses every session of the attention.
        const terminal = rows.findLast((row) => row.outcome === 'accepted') ?? rows.findLast((row) => row.outcome === 'unknown');
        if (terminal !== undefined) return { status: 'terminal', record: terminal } as WakeAttemptClaim;
        const attempts = rows.filter((row) => row.outcome === 'claimed' || row.outcome === 'dispatching');
        const blocked = attempts.find((row) => wakeAttemptLive(row, at));
        if (blocked !== undefined) return { status: 'busy', record: blocked } as WakeAttemptClaim;
        // A stale claim was never sent and can be replaced; a stale dispatching attempt may have
        // been sent, so it becomes unknown and forbids redispatch.
        const converted = attempts.filter((row) => row.outcome === 'dispatching');
        if (converted.length > 0) {
          const rewrites = new Map(converted.map((row) => [row, interruptedWakeAttempt(row, rows, i.routeKind)]));
          await write(file, all.map((row) => rewrites.get(row) ?? row));
          return { status: 'terminal', record: rewrites.get(converted[0])! } as WakeAttemptClaim;
        }
        const replaced = new Set(attempts);
        const attemptN = rows.filter((row) => row.session === i.session).reduce((highest, row) => Math.max(highest, row.attemptN ?? 0), 0) + 1;
        const claimToken = `${process.pid}-${at}-${randomUUID()}`;
        const claimed: WakeRow = { v: 1, at, location, participant: i.attention.recipient, session: i.session, activity, kind: 'wake', outcome: 'claimed', routeKind: i.routeKind, attemptN, claimToken, ownerPid: process.pid, expiresAt: at + i.leaseMs };
        await write(file, [...all.filter((row) => !replaced.has(row)), claimed]);
        return { status: 'acquired', claimToken, attemptN } as WakeAttemptClaim;
      });
    } catch (error) { return { status: 'degraded', error }; }
  }
  /** Marks the claimed attempt as dispatching before any external send; the token fences successors. */
  async transitionWakeAttempt(i: WakeAttemptTransitionInput): Promise<boolean> {
    const location = await canon(i.attention.squarePath);
    const activity = formatActivityId(i.attention.actIndex);
    const at = i.now ?? this.clock();
    const file = this.file('evidence');
    return withFileLock(file + '.lock', LOCK, async () => {
      const all = await read<WakeRow>(file, at, true);
      const key = nameKey(i.attention.recipient);
      const current = all.findLast((row) => row.kind === 'wake' && row.location === location && nameKey(row.participant) === key && row.activity === activity && row.session === i.session && row.claimToken === i.claimToken && row.outcome === 'claimed');
      if (current === undefined) return false;
      await write(file, all.map((row) => (row === current ? { ...row, outcome: 'dispatching', expiresAt: at + i.leaseMs } : row)));
      return true;
    });
  }

async listWakeAttempts(i:WakeAttemptLookup={}):Promise<readonly EvidenceRecord[]>{const attention=i.attention;return this.listEvidence({ kind:'wake', ...(attention===undefined?{}:{ location:await canon(attention.squarePath), participant:attention.recipient, activity:`act/${attention.actIndex}` }), ...(i.session===undefined?{}:{session:i.session}), now:i.now })}
async prepareNativeWake(i:EvidenceRecord & { readonly claimToken:string; readonly routeKind:import('./model.js').WakeRouteKind; readonly nativeDelivery:import('./host-ledger.js').NativeDeliveryEvidence }):Promise<boolean>{
  const location=await canon(i.location),f=this.file('evidence');
  return withFileLock(f+'.lock',LOCK,async()=>{const all=await read<EvidenceRecord & {v:1}>(f,this.clock(),true); const current=all.findLast(x=>x.kind==='wake'&&x.location===location&&nameKey(x.participant)===nameKey(i.participant)&&x.activity===i.activity&&x.session===i.session&&x.claimToken===i.claimToken&&x.outcome==='dispatching'); if(!current)return false; await write(f,all.map(x=>x===current?{...current,routeKind:i.routeKind,attemptN:i.attemptN,nativeDelivery:i.nativeDelivery}:x));return true;});
}
async confirmWakeAdmission(i:EvidenceRecord & { readonly claimToken:string }):Promise<boolean>{
  const location=await canon(i.location),f=this.file('evidence');
  return withFileLock(f+'.lock',LOCK,async()=>{const all=await read<EvidenceRecord & {v:1}>(f,this.clock(),true);const current=all.findLast(x=>x.kind==='wake'&&x.location===location&&nameKey(x.participant)===nameKey(i.participant)&&x.activity===i.activity&&x.session===i.session&&x.claimToken===i.claimToken&&x.nativeDelivery!==undefined);if(!current||!['dispatching','unknown','accepted'].includes(current.outcome))return false;if(current.outcome==='accepted')return true;await write(f,all.map(x=>x===current?{...current,outcome:'accepted',signature:'native_queue_confirmed',message:undefined,diagnostic:undefined,expiresAt:undefined}:x));return true;});
}
async claimEvidence(i:EvidenceClaim):Promise<ClaimResult>{if((i.kind as string)==='wake')return{status:'degraded',error:new Error('wake attempts are claimed with claimWakeAttempt')};const f=this.file('evidence'),at=i.now??this.clock(),{leaseMs,...claim}=i,r={...claim,location:await canon(i.location),outcome:'dispatching',at,expiresAt:at+leaseMs,v:1 as const};try{return await withFileLock(f+'.lock',LOCK,async()=>{const all=await read<any>(f,at,true),matching=all.filter(x=>x.kind===r.kind&&x.location===r.location&&nameKey(x.participant)===nameKey(r.participant)&&x.activity===r.activity&&x.session===r.session),old=matching.findLast(x=>x.outcome==='dispatching');if(old!==undefined&&typeof old.expiresAt==='number'&&old.expiresAt>at)return{status:'busy',record:old} as ClaimResult;if(r.kind==='presentation'&&matching.some(x=>x.outcome==='presented'))return{status:'delivered',record:matching.findLast(x=>x.outcome==='presented')} as ClaimResult;const claimToken=`${process.pid}-${at}-${Math.random().toString(36).slice(2)}`,row={...r,claimToken};await write(f,[...all.filter(x=>!(x.kind===r.kind&&x.location===r.location&&nameKey(x.participant)===nameKey(r.participant)&&x.activity===r.activity&&x.session===r.session&&(x.outcome==='dispatching'||x.outcome==='released'))),row]);return{status:'acquired',claimToken}})}catch(error){return{status:'degraded',error}}}
async releaseEvidence(i:EvidenceRelease):Promise<void>{const f=this.file('evidence'),location=await canon(i.location),at=i.now??this.clock();await withFileLock(f+'.lock',LOCK,async()=>{const all=await read<any>(f,at,true),same=(x:any)=>x.kind===i.kind&&x.location===location&&nameKey(x.participant)===nameKey(i.participant)&&x.activity===i.activity&&x.session===i.session,current=all.findLast(x=>same(x)&&(x.outcome==='dispatching'||x.outcome==='claimed'));if(current===undefined||current.claimToken!==i.claimToken)return;const tombstone={...current,outcome:'released',at,...(i.routeKind===undefined?{}:{routeKind:i.routeKind}),...(i.attemptN===undefined?{}:{attemptN:i.attemptN}),...(i.signature===undefined?{}:{signature:i.signature}),...(i.message===undefined?{}:{message:i.message}),...(i.diagnostic===undefined?{}:{diagnostic:i.diagnostic}),expiresAt:undefined};delete (tombstone as any).expiresAt;delete (tombstone as any).ownerPid;await write(f,[...all.filter(x=>x!==current),tombstone])})}
  /** Token-fenced terminal write. A token may only finish the attempt it claimed. */
  async appendEvidence(i: EvidenceRecord & { readonly claimToken: string }) {
    const f = this.file('evidence'), r = { ...i, location: await canon(i.location), at: i.at ?? this.clock(), v: 1 as const };
    const token = i.claimToken;
    if (typeof token !== 'string' || token.length === 0) return;
    await withFileLock(f + '.lock', LOCK, async () => {
      const all = await read<any>(f, r.at, true);
      const same = (x: any) => x.kind === r.kind && x.location === r.location && nameKey(x.participant) === nameKey(r.participant) && x.activity === r.activity && x.session === r.session;
      const dispatching = all.findLast((x) => same(x) && x.outcome === 'dispatching');
      // An attempt recovered as unknown while its sender was still in flight can still learn that it
      // was accepted: the same token may promote that recovery, and an accepted attempt is never downgraded.
      const recovered = dispatching === undefined && r.outcome === 'accepted'
        ? all.findLast((x) => same(x) && x.outcome === 'unknown' && x.claimToken === token && x.signature === 'worker_interrupted_during_dispatch')
        : undefined;
      const source = dispatching === undefined ? recovered : dispatching.claimToken === token ? dispatching : undefined;
      if (source === undefined) return;
      const terminalKey = (x: any) => same(x) && x.attemptN === r.attemptN && x.outcome !== 'dispatching' && x.outcome !== 'released';
      await write(f, [...all.filter((x) => x !== source && !terminalKey(x)), { ...r, ...(source.nativeDelivery === undefined ? {} : { nativeDelivery: source.nativeDelivery }) }]);
    });
  }
async listEvidence(i:EvidenceLookup={}):Promise<readonly EvidenceRecord[]>{const loc=i.location===undefined?undefined:await canon(i.location);return(await read<any>(this.file('evidence'),i.now??this.clock())).filter(r=>(i.includeReleased===true||r.outcome!=='released')&&(!loc||r.location===loc)&&(!i.participant||nameKey(r.participant)===nameKey(i.participant))&&(!i.session||r.session===i.session)&&(!i.activity||r.activity===i.activity)&&(!i.kind||r.kind===i.kind))}
async gcEvidence(i:EvidenceGc){const f=this.file('evidence'),pending=new Set(i.pendingWakeActivities??[]);await withFileLock(f+'.lock',LOCK,async()=>write(f,(await read<any>(f,this.clock(),true)).filter(r=>r.at>=i.before||durableWake(r)&&pending.has(r.activity))))}
}
export function createHostLedgerPort(o: HostLedgerFileAdapterOptions = {}): FileHostLedgerPort { return new FileHostLedgerPort(o); }
