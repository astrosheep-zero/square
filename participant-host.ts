import type { HostLedgerPort, PresenceChannel, PresenceRecord, SquareArtifactPort } from './ports.js';
import { currentOwner, presenceEpoch, sessionOwnsParticipant } from './registry.js';
import { firstHarnessSession } from './participant-identity.js';
import { canonicalPath } from './canonical-path.js';
import { defaultWakeRouteCapabilities, publishWakeRoute, retireWakeRouteFromArtifact, resolvePrimaryWakeRoute, ROUTE_FRESH_MS, type WakeBoundaryProvider, type WakeRoute } from './routes.js';

export interface HostContext {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location?: string;
  readonly hostLedger?: HostLedgerPort;
  readonly env?: NodeJS.ProcessEnv;
}

export function processIdentity(env: NodeJS.ProcessEnv): { session: string; channel: PresenceChannel } {
  const found = firstHarnessSession(env);
  return found === undefined ? { session: `process:${process.pid}`, channel: 'unknown' } : { session: found.sessionId, channel: found.channel };
}

export async function identityRouteDraft(context: HostContext, participant: string): Promise<Omit<WakeRoute, 'updatedAt'> | undefined> {
  if (context.location === undefined || context.location === 'memory') return undefined;
  const identity = processIdentity(context.env ?? process.env);
  if (identity.channel === 'unknown') return undefined;
  const provider = identity.channel === 'claude-code' ? 'claude' : identity.channel === 'opencode' ? 'opencode' : identity.channel === 'pi' ? 'pi' : identity.channel === 'paseo' ? 'paseo' : 'codex' as WakeBoundaryProvider;
  const boundary = { location: context.location, participant, sessionId: identity.session, provider };
  const env = context.env ?? process.env;
  // No adapter can add a route when the host has no candidate in the first place.
  if (context.hostLedger === undefined || resolvePrimaryWakeRoute(boundary, env, { canUse: () => true }) === undefined) return undefined;
  return resolvePrimaryWakeRoute(boundary, env, await defaultWakeRouteCapabilities(context.hostLedger));
}

/** One postcommit host observation; presence and route publication fail independently. */
export async function publishCommittedIdentity(context: HostContext, participant: string, epoch?: number): Promise<void> {
  const observed = await ensureLocalPresence(context, participant, epoch).catch(() => undefined);
  if (observed === undefined) return;
  try {
    const route = await identityRouteDraft(context, participant);
    if (route !== undefined) await publishWakeRoute(context.artifact, { ...route, ...observed }, { at: context.clock(), requireCurrentSession: true });
  } catch { /* Optional route enrichment cannot undo the committed activity. */ }
}

export async function retireIdentityRoute(context: HostContext, participant: string, expectedEpoch?: number): Promise<void> {
  if (context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  await retireWakeRouteFromArtifact(
    context.artifact,
    { location: context.location, participant, sessionId: identity.session },
    expectedEpoch === undefined ? {} : { expectedEpoch },
  ).catch(() => undefined);
}

export async function assertLiveOwner(context: HostContext, participant: string, expectedEpoch?: number): Promise<boolean> {
  const hostLedger = context.hostLedger;
  if (hostLedger === undefined || context.location === undefined || context.location === 'memory') return true;
  const identity = processIdentity(context.env ?? process.env);
  // Library callers without a harness session are not ownership-fenced unless an epoch was supplied.
  if (identity.channel === 'unknown' && expectedEpoch === undefined) return true;
  return sessionOwnsParticipant(context.location, participant, identity.session, hostLedger, expectedEpoch);
}

/** Best-effort postcommit presence; a returned epoch also witnesses a readable host observation. */
export async function ensureLocalPresence(context: HostContext, participant: string, epoch?: number): Promise<{ readonly epoch?: number } | undefined> {
  if (context.hostLedger === undefined || context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  // Sessionless library operations do not establish host presence or ownership.
  if (identity.channel === 'unknown') return;
  const now = Date.now();
  let existing: readonly PresenceRecord[];
  try {
    existing = await context.hostLedger.listPresence({ location: await canonicalPath(context.location), participant, now });
  } catch (error) {
    process.stderr.write(`! host presence degraded: ${error instanceof Error ? error.message : String(error)}\n`);
    return;
  }
  const owner = currentOwner(existing);
  const ownerEpoch = epoch ?? (owner === undefined ? undefined : presenceEpoch(owner));
  const observed = ownerEpoch === undefined ? {} : { epoch: ownerEpoch };
  // A fresh exact local binding at the observed (or explicit claim) generation already stands.
  if (existing.some((row) => row.session === identity.session && row.channel === identity.channel
    && now - (row.updatedAt ?? 0) < ROUTE_FRESH_MS
    && (ownerEpoch === undefined || presenceEpoch(row) === ownerEpoch))) return observed;
  try {
    const result = await context.hostLedger.ensurePresence({
      location: context.location,
      participant,
      session: identity.session,
      channel: identity.channel,
      updatedAt: Date.now(),
      ...(ownerEpoch === undefined || ownerEpoch <= 0 ? {} : { epoch: ownerEpoch }),
    });
    if (result.status === 'degraded') throw result.error;
  } catch (error) {
    process.stderr.write(`! host presence degraded: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return observed;
}
