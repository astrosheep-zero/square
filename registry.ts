/** Machine-local participant discovery cache. */

import path from 'node:path';

import { withFileLock } from './file-lock.js';
import { nameKey, sameName, SquareError, type StoredAct } from './model.js';
import { isCurrentlyJoined } from './runtime.js';
import { harnessSessionSources, squareAssignedParticipantName as computeSquareAssignedParticipantName } from './participant-identity.js';
import { createHostLedgerPort, type FileHostLedgerPort } from './host-ledger-file-adapter.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import type { PresenceRecord } from './host-ledger.js';

export type SessionChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface RegistryBinding { sessionId: string; name: string; squarePath: string; channel: SessionChannel; child: boolean; updatedAt: number; epoch: number; }
export interface RegistryWriteOptions { channel?: SessionChannel; child?: boolean; at?: number; env?: NodeJS.ProcessEnv; }
type PresenceWithEpoch = PresenceRecord & { readonly epoch?: number };

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENCE_CLAIM_LOCK = { retryMs: 10 } as const;

export async function canonicalSquarePath(squarePath: string): Promise<string> { const absolute = path.resolve(squarePath); try { return await (await import('node:fs/promises')).realpath(absolute); } catch { return absolute; } }
function ledgerRoot(env: NodeJS.ProcessEnv): string { return hostLedgerRoot(env); }
function ledger(env: NodeJS.ProcessEnv): FileHostLedgerPort { return createHostLedgerPort({ rootPath: ledgerRoot(env) }); }
export function presenceEpoch(record: PresenceWithEpoch | undefined): number {
  return typeof record?.epoch === 'number' && Number.isSafeInteger(record.epoch) && record.epoch > 0 ? record.epoch : 0;
}
function toBinding(record: PresenceWithEpoch): RegistryBinding {
  return {
    sessionId: record.session,
    name: record.participant,
    squarePath: record.location,
    channel: record.channel,
    child: false,
    updatedAt: record.updatedAt ?? 0,
    epoch: presenceEpoch(record),
  };
}
function presenceClaimLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(ledgerRoot(env), 'presence-claim.lock');
}

/** Runs `fn` inside the ownership claim critical section, under the same lock as claims and finalize. */
export async function withOwnershipClaimLock<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withFileLock(presenceClaimLockPath(env), { ...PRESENCE_CLAIM_LOCK, signal }, fn);
}
async function activeBindings(now: number, env: NodeJS.ProcessEnv): Promise<RegistryBinding[]> { return (await ledger(env).listPresence({ now })).map(toBinding).sort((a, b) => b.updatedAt - a.updatedAt); }
async function writePresence(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions, done: boolean): Promise<void> { if (!sessionId || !name || !squarePath) return; const env = options.env ?? process.env; const channel = options.channel ?? 'unknown'; const port = ledger(env); const location = await canonicalSquarePath(squarePath); if (done) await port.removePresence({ location, participant: name, session: sessionId, channel }); else await port.ensurePresence({ location, participant: name, session: sessionId, channel, updatedAt: options.at ?? Date.now() }); }
export function recordJoin(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> { return writePresence(sessionId, name, squarePath, options, false); }
export async function recordDone(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> {
  await writePresence(sessionId, name, squarePath, options, true);
}
export async function readActiveBindings(now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RegistryBinding[]> { try { return await activeBindings(now, env); } catch { return []; } }
export async function lookupSessionBindings(sessionId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RegistryBinding[]> { return (await readActiveBindings(now, env)).filter((binding) => binding.sessionId === sessionId); }
export async function lookupSession(sessionId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<Array<{ name: string; squarePath: string }>> { return (await lookupSessionBindings(sessionId, now, env)).map(({ name, squarePath }) => ({ name, squarePath })); }
export async function lookupParticipant(squarePath: string, name: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RegistryBinding[]> { const canonicalPath = await canonicalSquarePath(squarePath); return (await readActiveBindings(now, env)).filter((binding) => binding.squarePath === canonicalPath && sameName(binding.name, name)); }
export async function localParticipantOwner(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string | undefined> { const sessionIds = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); if (sessionIds.size === 0) return undefined; return (await lookupParticipant(squarePath, name, now, env)).find((binding) => sessionIds.has(binding.sessionId))?.sessionId; }
export async function localParticipantName(squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> { const canonicalPath = await canonicalSquarePath(squarePath); const names = new Set((await Promise.all(localSessionIdentities(env).map(async (identity) => (await lookupSession(identity.sessionId, Date.now(), env)).filter((item) => item.squarePath === canonicalPath).map((item) => item.name)))).flat()); return names.size === 1 ? [...names][0] : undefined; }
export function squareAssignedParticipantName(env: NodeJS.ProcessEnv = process.env): string | undefined { return computeSquareAssignedParticipantName(env); }
export type CurrentParticipantBinding = Readonly<{ created: boolean; sessionId: string }>;
export type OwnershipClaim =
  | { readonly status: 'acquired' | 'owned'; readonly record: PresenceWithEpoch; readonly sessionId: string; readonly epoch: number }
  | undefined;
export type TakeoverClaimToken = { readonly sessionId: string; readonly epoch: number };
export type TakeoverRunResult<T> =
  | { readonly status: 'acquired'; readonly sessionId: string; readonly epoch: number; readonly result: T }
  | { readonly status: 'busy'; readonly epoch: number };

export async function readParticipantOwner(
  squarePath: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryBinding | undefined> {
  const bindings = await lookupParticipant(squarePath, name, Date.now(), env);
  return bindings.sort((left, right) => right.epoch - left.epoch || right.updatedAt - left.updatedAt)[0];
}

export async function sessionOwnsParticipant(
  squarePath: string,
  name: string,
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  expectedEpoch?: number,
): Promise<boolean> {
  const owner = await readParticipantOwner(squarePath, name, env);
  if (owner === undefined || owner.sessionId !== sessionId) return false;
  return expectedEpoch === undefined || owner.epoch === expectedEpoch;
}


export async function releaseSessionParticipantClaim(squarePath: string, name: string, env: NodeJS.ProcessEnv, claim: OwnershipClaim): Promise<void> {
  if (claim?.status !== 'acquired') return;
  const port = ledger(env);
  await port.removePresenceIfUnchanged(claim.record);
}

export async function claimSessionParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<OwnershipClaim> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return undefined;
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
  const location = await canonicalSquarePath(squarePath);
  const result = await ledger(env).claimPresence({
    location,
    participant: name,
    session: identity.sessionId,
    channel: identity.channel,
    updatedAt: Date.now(),
    epoch: 1,
  } as PresenceWithEpoch, signal);
  if (result.status === 'busy') throw new SquareError('already_joined', `✕ ${name} already stands here — another session holds the name`);
  if (result.status === 'degraded') throw result.error;
  const record = result.record as PresenceWithEpoch;
  return { status: result.status, record, sessionId: record.session, epoch: presenceEpoch(record) };
}

/**
 * Fenced takeover: the ownership claim and the lifecycle run as one critical section under the
 * presence-claim lock, so no second takeover can interleave between claim and commit. The claim
 * persists nothing until the lifecycle commits: standing owner rows stay authoritative through
 * the lifecycle (a self-takeover can therefore never clobber its own standing row). On success
 * the standing rows are replaced by the new owner's row at the claim epoch; on refusal, rows
 * carrying the claim token (session + channel + claim epoch) are withdrawn and the captured
 * standing rows are restored exactly.
 */
export async function claimSessionTakeover<T>(
  squarePath: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { readonly expectedEpoch?: number; readonly expectedSession?: string } = {},
  lifecycle: (claim: TakeoverClaimToken) => Promise<T>,
  signal?: AbortSignal,
): Promise<TakeoverRunResult<T>> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) throw new SquareError('invalid_args', 'No local session identity for takeover');
  const location = await canonicalSquarePath(squarePath);
  return withFileLock(presenceClaimLockPath(env), { ...PRESENCE_CLAIM_LOCK, signal }, async () => {
    const port = ledger(env);
    const standing = await port.listPresence({ location, participant: name }) as PresenceWithEpoch[];
    const owner = standing
      .map((row) => toBinding(row))
      .sort((left, right) => right.epoch - left.epoch || right.updatedAt - left.updatedAt)[0];
    const currentEpoch = owner?.epoch ?? 0;
    const epochMatches = opts.expectedEpoch === undefined || currentEpoch === opts.expectedEpoch;
    const sessionMatches = opts.expectedSession === undefined
      || (opts.expectedSession === '' ? owner === undefined : owner?.sessionId === opts.expectedSession);
    if (!epochMatches || !sessionMatches) {
      return { status: 'busy', epoch: currentEpoch };
    }
    const epoch = currentEpoch + 1;
    let result: T;
    try {
      result = await lifecycle({ sessionId: identity.sessionId, epoch });
    } catch (error) {
      // Withdraw: the claim itself persisted nothing. Remove only rows carrying this exact claim
      // token (session + channel + epoch) — whatever the lifecycle itself ensured — then restore
      // the captured standing rows so the old owner survives byte-consistently. Foreign rows and
      // later owners are never touched.
      const tokenRows = await ledger(env).listPresence({ location, participant: name, session: identity.sessionId }) as PresenceWithEpoch[];
      for (const row of tokenRows) { if (row.channel === identity.channel && presenceEpoch(row) === epoch) await ledger(env).removePresence({ location: row.location, participant: row.participant, session: row.session, channel: row.channel }); }
      for (const row of standing) await ledger(env).ensurePresence(row as unknown as PresenceRecord);
      throw error;
    }
    // Finalize: the lifecycle committed. Replace the standing owner with the new owner's row at
    // the claim epoch where the owner was visible, so exactly one current owner
    // remains — also when the takeover is a self-takeover (same session as the standing owner).
    for (const row of standing) await ledger(env).removePresence({ location: row.location, participant: row.participant, session: row.session, channel: row.channel });
    await ledger(env).ensurePresence({ location, participant: name, session: identity.sessionId, channel: identity.channel, updatedAt: Date.now(), epoch } as PresenceWithEpoch);
    return { status: 'acquired', sessionId: identity.sessionId, epoch, result };
  });
}

export async function releaseSessionParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return;
  await ledger(env).removePresence({ location: squarePath, participant: name, session: identity.sessionId, channel: identity.channel });
}
export async function bindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<CurrentParticipantBinding> { if (squareAssignedParticipantName(env) !== name) throw new SquareError('invalid_args', `The current session is not assigned ${name}`); const sessionId = await localParticipantOwner(squarePath, name, env); if (sessionId !== undefined) return { created: false, sessionId }; if ((await lookupParticipant(squarePath, name, Date.now(), env)).at(0) !== undefined) throw new SquareError('already_joined', `✕ ${name} already stands here — another session holds the name`); await recordLocalJoin(name, squarePath, env); const currentSessionId = await localParticipantOwner(squarePath, name, env); if (currentSessionId === undefined) throw new Error(`Current participant binding did not commit for ${name}`); return { created: true, sessionId: currentSessionId }; }
export async function unbindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name, Date.now(), env)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordSessionDone(binding.sessionId, binding.name, binding.squarePath, binding.channel, env); return current.length > 0; }
export interface RegistryPruneResult { removed: number; kept: number; }
function bindingIsProvablyObsolete(binding: RegistryBinding, acts: StoredAct[] | undefined): boolean { return acts !== undefined && !isCurrentlyJoined(acts, binding.name); }
export async function pruneRegistry(readActs: (squarePath: string) => StoredAct[] | undefined | Promise<StoredAct[] | undefined>, now = Date.now()): Promise<RegistryPruneResult> { const active = await readActiveBindings(now); let removed = 0; for (const binding of active) { if (!bindingIsProvablyObsolete(binding, await readActs(binding.squarePath))) continue; await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at: now }); removed++; } return { removed, kept: active.length - removed }; }
export interface LocalSessionIdentity { sessionId: string; channel: SessionChannel; child: boolean; paseoAgentId?: string; }
function addLocalSession(identities: LocalSessionIdentity[], sessionId: string | undefined, channel: SessionChannel, child: boolean, paseoAgentId: string | undefined): void { if (!sessionId || identities.some((identity) => identity.sessionId === sessionId)) return; identities.push({ sessionId, channel, child, ...(paseoAgentId ? { paseoAgentId } : {}) }); }
export function localSessionIdentities(env: NodeJS.ProcessEnv = process.env): LocalSessionIdentity[] { const paseoAgentId = env.PASEO_AGENT_ID?.trim() || undefined; const identities: LocalSessionIdentity[] = []; for (const source of harnessSessionSources) addLocalSession(identities, env[source.variable]?.trim(), source.channel, source.childVariable !== undefined && env[source.childVariable] === '1', paseoAgentId); return identities; }
export function hasAutomaticDeliveryIdentity(env: NodeJS.ProcessEnv = process.env): boolean { return localSessionIdentities(env).length > 0; }
export async function recordLocalJoin(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = localSessionIdentities(env); const current = await lookupParticipant(squarePath, name, at, env); for (const identity of identities) { for (const binding of current.filter((item) => item.sessionId === identity.sessionId)) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); await recordJoin(identity.sessionId, name, squarePath, { ...identity, at, env }); } }
export async function recordLocalDone(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name, at, env)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); }
export async function recordSessionJoin(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<string> { const at = Date.now(); const current = (await lookupParticipant(squarePath, name, at, env)).filter((binding) => binding.sessionId === sessionId); for (const binding of current) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); await recordJoin(sessionId, name, squarePath, { channel, at, env }); return sessionId; }
export async function recordSessionDone(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const canonicalPath = await canonicalSquarePath(squarePath); const binding = (await lookupSessionBindings(sessionId, Date.now(), env)).find((item) => item.squarePath === canonicalPath && sameName(item.name, name) && item.channel === channel); if (binding === undefined) return false; const options = { channel, at: Date.now(), env }; await recordDone(sessionId, binding.name, binding.squarePath, options); return true; }

/** Bind the host ledger to the caller's captured environment. */
export function hostLedgerForEnv(env: NodeJS.ProcessEnv = process.env): FileHostLedgerPort { return ledger(env); }
