/** Machine-local participant discovery cache. */

import path from 'node:path';
import { homedir } from 'node:os';

import { withFileLock } from './file-lock.js';
import { nameKey, sameName, SquareError, type StoredAct } from './model.js';
import { isCurrentlyJoined } from './runtime.js';
import { squareAssignedParticipantName as computeSquareAssignedParticipantName } from './participant-identity.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { HostLedgerPort, HostLedgerScope, PresenceRecord } from './host-ledger.js';

export type SessionChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface RegistryBinding { sessionId: string; name: string; squarePath: string; channel: SessionChannel; child: boolean; route?: PresenceRecord['route']; updatedAt: number; epoch: number; }
export interface RegistryWriteOptions { channel?: SessionChannel; child?: boolean; route?: PresenceRecord['route']; at?: number; env?: NodeJS.ProcessEnv; }
type PresenceWithEpoch = PresenceRecord & { readonly epoch?: number };

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENCE_CLAIM_LOCK = { retryMs: 10 } as const;
const LOCAL_SESSION_SOURCES: ReadonlyArray<{ variable: 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID' | 'OPENCODE_SESSION_ID' | 'SQUARE_PI_SESSION_ID'; channel: Exclude<SessionChannel, 'paseo' | 'unknown'>; child?: 'CLAUDE_CODE_CHILD_SESSION'; }> = [
  { variable: 'CLAUDE_CODE_SESSION_ID', channel: 'claude-code', child: 'CLAUDE_CODE_CHILD_SESSION' },
  { variable: 'CODEX_THREAD_ID', channel: 'codex' },
  { variable: 'OPENCODE_SESSION_ID', channel: 'opencode' },
  { variable: 'SQUARE_PI_SESSION_ID', channel: 'pi' },
];

export function registryPath(env: NodeJS.ProcessEnv = process.env): string { return env.SQUARE_REGISTRY || path.join(homedir(), '.square', 'sessions.ndjsonl'); }
export async function canonicalSquarePath(squarePath: string): Promise<string> { const absolute = path.resolve(squarePath); try { return await (await import('node:fs/promises')).realpath(absolute); } catch { return absolute; } }
function ledgerRoot(env: NodeJS.ProcessEnv): { userPath: string; localPath: string } {
  const root = path.dirname(registryPath(env));
  return {
    userPath: env.SQUARE_HOST_LEDGER_USER ?? (env.SQUARE_REGISTRY ? root : path.join(homedir(), '.square', 'host-ledger')),
    localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? (env.SQUARE_REGISTRY ? root : path.join(process.cwd(), '.square', 'host-ledger')),
  };
}
function ledger(env: NodeJS.ProcessEnv, writableScope: HostLedgerScope = 'local'): HostLedgerPort {
  return createHostLedgerPort({ ...ledgerRoot(env), writableScope });
}
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
    ...(record.route === undefined ? {} : { route: record.route }),
    updatedAt: record.updatedAt ?? 0,
    epoch: presenceEpoch(record),
  };
}
function presenceClaimLockPath(env: NodeJS.ProcessEnv): string {
  return path.join(ledgerRoot(env).userPath, 'presence-claim.lock');
}

/** Runs `fn` inside the ownership claim critical section, under the same lock as claims and finalize. */
export async function withOwnershipClaimLock<T>(env: NodeJS.ProcessEnv, fn: () => Promise<T>): Promise<T> {
  return withFileLock(presenceClaimLockPath(env), PRESENCE_CLAIM_LOCK, fn);
}
async function activeBindings(now: number, env: NodeJS.ProcessEnv): Promise<RegistryBinding[]> { return (await ledger(env).listPresence({ now, scopes: ['user', 'local'] })).map(toBinding).sort((a, b) => b.updatedAt - a.updatedAt); }
async function writePresence(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions, done: boolean, scope: HostLedgerScope = 'local'): Promise<void> { if (!sessionId || !name || !squarePath) return; const env = options.env ?? process.env; const channel = options.channel ?? 'unknown'; const port = ledger(env, scope); const location = await canonicalSquarePath(squarePath); if (done) await port.removePresence({ location, participant: name, session: sessionId, channel }); else await port.ensurePresence({ location, participant: name, session: sessionId, channel, updatedAt: options.at ?? Date.now() }); }
export function recordJoin(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> { return writePresence(sessionId, name, squarePath, options, false); }
export async function recordDone(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> {
  await writePresence(sessionId, name, squarePath, options, true);
  await writePresence(sessionId, name, squarePath, options, true, 'user');
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
  | { readonly status: 'acquired' | 'owned'; readonly sessionId: string; readonly epoch: number }
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

export async function claimSessionParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<OwnershipClaim> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return undefined;
  const location = await canonicalSquarePath(squarePath);
  const result = await ledger(env).claimPresence({
    location,
    participant: name,
    session: identity.sessionId,
    channel: identity.channel,
    updatedAt: Date.now(),
    epoch: 1,
  } as PresenceWithEpoch, 'local');
  if (result.status === 'busy') throw new SquareError('already_joined', `${name} is already bound to another session`);
  if (result.status === 'degraded') throw result.error;
  const epoch = presenceEpoch(result.record as PresenceWithEpoch) || (result.status === 'acquired' ? 1 : 0);
  return { status: result.status, sessionId: identity.sessionId, epoch };
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
): Promise<TakeoverRunResult<T>> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) throw new SquareError('invalid_args', 'No local session identity for takeover');
  const location = await canonicalSquarePath(squarePath);
  return withFileLock(presenceClaimLockPath(env), PRESENCE_CLAIM_LOCK, async () => {
    const port = ledger(env);
    const standing: Record<'user' | 'local', readonly PresenceWithEpoch[]> = {
      user: await port.listPresence({ location, participant: name, scopes: ['user'] }) as PresenceWithEpoch[],
      local: await port.listPresence({ location, participant: name, scopes: ['local'] }) as PresenceWithEpoch[],
    };
    const owner = [...standing.user, ...standing.local]
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
      for (const scope of ['user', 'local'] as const) {
        const tokenRows = await ledger(env, scope).listPresence({
          location,
          participant: name,
          session: identity.sessionId,
          scopes: [scope],
        }) as PresenceWithEpoch[];
        for (const row of tokenRows) {
          if (row.channel !== identity.channel || presenceEpoch(row) !== epoch) continue;
          await ledger(env, scope).removePresence({
            location: row.location,
            participant: row.participant,
            session: row.session,
            channel: row.channel,
          });
        }
        for (const row of standing[scope]) {
          await ledger(env, scope).ensurePresence(row as unknown as PresenceRecord, scope);
        }
      }
      throw error;
    }
    // Finalize: the lifecycle committed. Replace the standing owner with the new owner's row at
    // the claim epoch in every scope where the owner was visible, so exactly one current owner
    // remains — also when the takeover is a self-takeover (same session as the standing owner).
    for (const scope of ['user', 'local'] as const) {
      for (const row of standing[scope]) {
        await ledger(env, scope).removePresence({
          location: row.location,
          participant: row.participant,
          session: row.session,
          channel: row.channel,
        });
      }
      await ledger(env, scope).ensurePresence({
        location,
        participant: name,
        session: identity.sessionId,
        channel: identity.channel,
        updatedAt: Date.now(),
        epoch,
      } as PresenceWithEpoch, scope);
    }
    return { status: 'acquired', sessionId: identity.sessionId, epoch, result };
  });
}

export async function releaseSessionParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return;
  await ledger(env).removePresence({ location: squarePath, participant: name, session: identity.sessionId, channel: identity.channel });
}
export async function bindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<CurrentParticipantBinding> { if (squareAssignedParticipantName(env) !== name) throw new SquareError('invalid_args', `The current session is not assigned ${name}`); const sessionId = await localParticipantOwner(squarePath, name, env); if (sessionId !== undefined) return { created: false, sessionId }; if ((await lookupParticipant(squarePath, name, Date.now(), env)).at(0) !== undefined) throw new SquareError('already_joined', `${name} is already bound to another session`); await recordLocalJoin(name, squarePath, env); const currentSessionId = await localParticipantOwner(squarePath, name, env); if (currentSessionId === undefined) throw new Error(`Current participant binding did not commit for ${name}`); return { created: true, sessionId: currentSessionId }; }
export async function unbindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name, Date.now(), env)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordSessionDone(binding.sessionId, binding.name, binding.squarePath, binding.channel, env); return current.length > 0; }
export interface RegistryPruneResult { removed: number; kept: number; }
function bindingIsProvablyObsolete(binding: RegistryBinding, acts: StoredAct[] | undefined): boolean { return acts !== undefined && !isCurrentlyJoined(acts, binding.name); }
export async function pruneRegistry(readActs: (squarePath: string) => StoredAct[] | undefined | Promise<StoredAct[] | undefined>, now = Date.now()): Promise<RegistryPruneResult> { const active = await readActiveBindings(now); let removed = 0; for (const binding of active) { if (!bindingIsProvablyObsolete(binding, await readActs(binding.squarePath))) continue; await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at: now }); removed++; } return { removed, kept: active.length - removed }; }
export interface LocalSessionIdentity { sessionId: string; channel: SessionChannel; child: boolean; paseoAgentId?: string; }
function addLocalSession(identities: LocalSessionIdentity[], sessionId: string | undefined, channel: SessionChannel, child: boolean, paseoAgentId: string | undefined): void { if (!sessionId || identities.some((identity) => identity.sessionId === sessionId)) return; identities.push({ sessionId, channel, child, ...(paseoAgentId ? { paseoAgentId } : {}) }); }
export function localSessionIdentities(env: NodeJS.ProcessEnv = process.env): LocalSessionIdentity[] { const paseoAgentId = env.PASEO_AGENT_ID?.trim() || undefined; const identities: LocalSessionIdentity[] = []; for (const source of LOCAL_SESSION_SOURCES) addLocalSession(identities, env[source.variable]?.trim(), source.channel, source.child !== undefined && env[source.child] === '1', paseoAgentId); addLocalSession(identities, paseoAgentId, 'paseo', false, paseoAgentId); return identities; }
export function hasAutomaticDeliveryIdentity(env: NodeJS.ProcessEnv = process.env): boolean { return localSessionIdentities(env).length > 0; }
export async function recordLocalJoin(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = localSessionIdentities(env); const current = await lookupParticipant(squarePath, name, at, env); for (const identity of identities) { for (const binding of current.filter((item) => item.sessionId === identity.sessionId)) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); await recordJoin(identity.sessionId, name, squarePath, { ...identity, at, env }); } }
export async function recordLocalDone(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name, at, env)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); }
export async function recordSessionJoin(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<string> { const at = Date.now(); const current = (await lookupParticipant(squarePath, name, at, env)).filter((binding) => binding.sessionId === sessionId); for (const binding of current) { await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); await writePresence(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }, true, 'user'); } await recordJoin(sessionId, name, squarePath, { channel, at, env }); await writePresence(sessionId, name, squarePath, { channel, at, env }, false, 'user'); return sessionId; }
export async function recordSessionDone(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const canonicalPath = await canonicalSquarePath(squarePath); const binding = (await lookupSessionBindings(sessionId, Date.now(), env)).find((item) => item.squarePath === canonicalPath && sameName(item.name, name) && item.channel === channel); if (binding === undefined) return false; const options = { channel, at: Date.now(), env }; await recordDone(sessionId, binding.name, binding.squarePath, options); await writePresence(sessionId, binding.name, binding.squarePath, options, true, 'user'); return true; }
