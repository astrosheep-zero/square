/** Participant ownership and local session identity on the host ledger. */

import { SquareError } from './model.js';
import { harnessSessionSources, squareAssignedParticipantName as computeSquareAssignedParticipantName } from './participant-identity.js';
import { createHostLedgerPort, type FileHostLedgerPort } from './host-ledger-file-adapter.js';
import { hostLedgerRoot } from './host-ledger-root.js';
import type { HostLedgerPort, PresenceChannel, PresenceRecord } from './host-ledger.js';
import { canonicalPath } from './canonical-path.js';

export function presenceEpoch(record: PresenceRecord | undefined): number {
  return typeof record?.epoch === 'number' && Number.isSafeInteger(record.epoch) && record.epoch > 0 ? record.epoch : 0;
}
/** The current owner: the highest epoch wins, then the most recently updated row. */
function currentOwner(rows: readonly PresenceRecord[]): PresenceRecord | undefined {
  return [...rows].sort((left, right) => presenceEpoch(right) - presenceEpoch(left) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
}
export async function localParticipantName(squarePath: string, hostLedger: HostLedgerPort, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> { const canonical = await canonicalPath(squarePath); const names = new Set((await Promise.all(localSessionIdentities(env).map(async (identity) => (await hostLedger.listPresence({ location: canonical, session: identity.sessionId })).map((row) => row.participant)))).flat()); return names.size === 1 ? [...names][0] : undefined; }
export function squareAssignedParticipantName(env: NodeJS.ProcessEnv = process.env): string | undefined { return computeSquareAssignedParticipantName(env); }
export type OwnershipClaim =
  | { readonly status: 'acquired' | 'owned'; readonly record: PresenceRecord; readonly sessionId: string; readonly epoch: number }
  | undefined;
export type TakeoverClaimToken = { readonly sessionId: string; readonly epoch: number };
export type TakeoverRunResult<T> =
  | { readonly status: 'acquired'; readonly sessionId: string; readonly epoch: number; readonly result: T }
  | { readonly status: 'busy'; readonly epoch: number };

export async function readParticipantOwner(
  squarePath: string,
  name: string,
  hostLedger: HostLedgerPort,
): Promise<PresenceRecord | undefined> {
  // The registry cache this read replaces reported an unreadable cache as "no visible owner";
  // an ownership read stays equally tolerant so a degraded ledger cannot fail an operation.
  const rows = await participantPresence(squarePath, name, hostLedger).catch(() => []);
  return currentOwner(rows);
}

async function participantPresence(squarePath: string, name: string, hostLedger: HostLedgerPort): Promise<readonly PresenceRecord[]> {
  const canonical = await canonicalPath(squarePath);
  return hostLedger.listPresence({ location: canonical, participant: name, now: Date.now() });
}

export async function sessionOwnsParticipant(
  squarePath: string,
  name: string,
  sessionId: string,
  hostLedger: HostLedgerPort,
  expectedEpoch?: number,
): Promise<boolean> {
  const owner = await readParticipantOwner(squarePath, name, hostLedger);
  if (owner === undefined || owner.session !== sessionId) return false;
  return expectedEpoch === undefined || presenceEpoch(owner) === expectedEpoch;
}


export async function releaseSessionParticipantClaim(hostLedger: HostLedgerPort, claim: OwnershipClaim): Promise<void> {
  if (claim?.status !== 'acquired') return;
  await hostLedger.removePresenceIfUnchanged(claim.record);
}

export async function claimSessionParticipant(squarePath: string, name: string, hostLedger: HostLedgerPort, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<OwnershipClaim> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return undefined;
  if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted');
  const location = await canonicalPath(squarePath);
  const result = await hostLedger.claimPresence({
    location,
    participant: name,
    session: identity.sessionId,
    channel: identity.channel,
    updatedAt: Date.now(),
    epoch: 1,
  }, signal);
  if (result.status === 'busy') throw new SquareError('already_joined', `✕ ${name} already stands here — another session holds the name`);
  if (result.status === 'degraded') throw result.error;
  const record = result.record;
  return { status: result.status, record, sessionId: record.session, epoch: presenceEpoch(record) };
}

/**
 * Fenced takeover: the ownership claim and the lifecycle run as one critical section under the
 * claim lock, so no second takeover can interleave between claim and commit. The claim
 * persists nothing until the lifecycle commits: standing owner rows stay authoritative through
 * the lifecycle (a self-takeover can therefore never clobber its own standing row). On success
 * the standing rows are replaced by the new owner's row at the claim epoch; on refusal, rows
 * carrying the claim token (session + channel + claim epoch) are withdrawn and the captured
 * standing rows are restored exactly.
 */
export async function claimSessionTakeover<T>(
  squarePath: string,
  name: string,
  hostLedger: HostLedgerPort,
  env: NodeJS.ProcessEnv = process.env,
  opts: { readonly expectedEpoch?: number; readonly expectedSession?: string } = {},
  lifecycle: (claim: TakeoverClaimToken) => Promise<T>,
  signal?: AbortSignal,
): Promise<TakeoverRunResult<T>> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) throw new SquareError('invalid_args', 'No local session identity for takeover');
  const location = await canonicalPath(squarePath);
  return hostLedger.withClaimLock(async () => {
    const standing = await hostLedger.listPresence({ location, participant: name });
    const owner = currentOwner(standing);
    const currentEpoch = presenceEpoch(owner);
    const epochMatches = opts.expectedEpoch === undefined || currentEpoch === opts.expectedEpoch;
    const sessionMatches = opts.expectedSession === undefined
      || (opts.expectedSession === '' ? owner === undefined : owner?.session === opts.expectedSession);
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
      const tokenRows = await hostLedger.listPresence({ location, participant: name, session: identity.sessionId });
      for (const row of tokenRows) { if (row.channel === identity.channel && presenceEpoch(row) === epoch) await hostLedger.removePresence({ location: row.location, participant: row.participant, session: row.session, channel: row.channel }); }
      for (const row of standing) await hostLedger.ensurePresence(row);
      throw error;
    }
    // Finalize: the lifecycle committed. Replace the standing owner with the new owner's row at
    // the claim epoch where the owner was visible, so exactly one current owner
    // remains — also when the takeover is a self-takeover (same session as the standing owner).
    for (const row of standing) await hostLedger.removePresence({ location: row.location, participant: row.participant, session: row.session, channel: row.channel });
    await hostLedger.ensurePresence({ location, participant: name, session: identity.sessionId, channel: identity.channel, updatedAt: Date.now(), epoch });
    return { status: 'acquired', sessionId: identity.sessionId, epoch, result };
  }, signal);
}

export async function releaseSessionParticipant(squarePath: string, name: string, hostLedger: HostLedgerPort, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return;
  await hostLedger.removePresence({ location: squarePath, participant: name, session: identity.sessionId, channel: identity.channel });
}
export interface LocalSessionIdentity { sessionId: string; channel: PresenceChannel; child: boolean; paseoAgentId?: string; }
function addLocalSession(identities: LocalSessionIdentity[], sessionId: string | undefined, channel: PresenceChannel, child: boolean, paseoAgentId: string | undefined): void { if (!sessionId || identities.some((identity) => identity.sessionId === sessionId)) return; identities.push({ sessionId, channel, child, ...(paseoAgentId ? { paseoAgentId } : {}) }); }
export function localSessionIdentities(env: NodeJS.ProcessEnv = process.env): LocalSessionIdentity[] { const paseoAgentId = env.PASEO_AGENT_ID?.trim() || undefined; const identities: LocalSessionIdentity[] = []; for (const source of harnessSessionSources) addLocalSession(identities, env[source.variable]?.trim(), source.channel, source.childVariable !== undefined && env[source.childVariable] === '1', paseoAgentId); return identities; }
export function hasAutomaticDeliveryIdentity(env: NodeJS.ProcessEnv = process.env): boolean { return localSessionIdentities(env).length > 0; }

/** Bind the host ledger to the caller's captured environment. */
export function hostLedgerForEnv(env: NodeJS.ProcessEnv = process.env): FileHostLedgerPort { return createHostLedgerPort({ rootPath: hostLedgerRoot(env) }); }
