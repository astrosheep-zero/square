import type { HostLedgerPort, PresenceChannel, PresenceRecord, SquareArtifactPort } from './ports.js';
import { readParticipantOwner, sessionOwnsParticipant } from './registry.js';
import { defaultWakeRouteCapabilities, publishWakeRoute, retireWakeRouteFromArtifact, resolvePrimaryWakeRoute, ROUTE_FRESH_MS, type WakeBoundaryProvider, type WakeRoute } from './routes.js';

export interface HostContext {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location?: string;
  readonly hostLedger?: HostLedgerPort;
  readonly env?: NodeJS.ProcessEnv;
}

export function processIdentity(env: NodeJS.ProcessEnv): { session: string; channel: PresenceChannel } {
  const choices: readonly [string | undefined, PresenceChannel][] = [
    [env.CLAUDE_CODE_SESSION_ID, 'claude-code'], [env.CODEX_THREAD_ID, 'codex'],
    [env.OPENCODE_SESSION_ID, 'opencode'], [env.SQUARE_PI_SESSION_ID, 'pi'], [env.PASEO_AGENT_ID, 'paseo'],
  ];
  const found = choices.find(([session]) => session?.trim());
  return found === undefined ? { session: `process:${process.pid}`, channel: 'unknown' } : { session: found[0]!.trim(), channel: found[1] };
}

export async function identityRouteDraft(context: HostContext, participant: string): Promise<Omit<WakeRoute, 'updatedAt'> | undefined> {
  if (context.location === undefined || context.location === 'memory') return undefined;
  const identity = processIdentity(context.env ?? process.env);
  const provider = identity.channel === 'claude-code' ? 'claude' : identity.channel === 'opencode' ? 'opencode' : identity.channel === 'pi' ? 'pi' : identity.channel === 'paseo' ? 'paseo' : 'codex' as WakeBoundaryProvider;
  const capabilities = context.hostLedger === undefined ? { canUse: () => false } : await defaultWakeRouteCapabilities(context.hostLedger);
  return resolvePrimaryWakeRoute({ location: context.location, participant, sessionId: identity.session, provider }, context.env ?? process.env, capabilities);
}

async function currentOwnerEpoch(context: HostContext, participant: string): Promise<number | undefined> {
  if (context.location === undefined || context.location === 'memory') return undefined;
  const owner = await readParticipantOwner(context.location, participant, context.env ?? process.env);
  return owner?.epoch;
}

export async function publishIdentityRoute(context: HostContext, participant: string, epoch?: number): Promise<void> {
  const route = await identityRouteDraft(context, participant);
  if (route === undefined) return;
  const ownerEpoch = epoch ?? await currentOwnerEpoch(context, participant);
  await publishWakeRoute(context.artifact, { ...route, ...(ownerEpoch === undefined ? {} : { epoch: ownerEpoch }) }, { at: context.clock(), requireCurrentSession: true }).catch(() => undefined);
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
  if (context.hostLedger === undefined || context.location === undefined || context.location === 'memory') return true;
  const identity = processIdentity(context.env ?? process.env);
  // Library callers without a harness session are not ownership-fenced unless an epoch was supplied.
  if (identity.channel === 'unknown' && expectedEpoch === undefined) return true;
  return sessionOwnsParticipant(context.location, participant, identity.session, context.env ?? process.env, expectedEpoch);
}

/** Presence is best effort and runs only after the artifact mutation commits. */
export async function ensureLocalPresence(context: HostContext, participant: string, epoch?: number): Promise<void> {
  if (context.hostLedger === undefined || context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  const ownerEpoch = epoch ?? await currentOwnerEpoch(context, participant);
  const now = context.clock();
  // Semantic publish: an unexpired presence row already stands when it carries the same owner epoch.
  try {
    const existing = await context.hostLedger.listPresence({ location: context.location, participant, session: identity.session, scopes: ['local'], now });
    if (existing.some((row) => row.channel === identity.channel
      && now - (row.updatedAt ?? 0) < ROUTE_FRESH_MS
      && (ownerEpoch === undefined || (row as PresenceRecord & { epoch?: number }).epoch === ownerEpoch))) return;
  } catch { /* fall through to the best-effort ensure below */ }
  const result = await context.hostLedger.ensurePresence({
    location: context.location,
    participant,
    session: identity.session,
    channel: identity.channel,
    // Presence rows are host-ledger wall-time evidence; the square clock belongs to artifact activities.
    updatedAt: Date.now(),
    ...(ownerEpoch === undefined || ownerEpoch <= 0 ? {} : { epoch: ownerEpoch }),
  } as PresenceRecord & { epoch?: number }, 'local').catch((error) => ({
    status: 'degraded' as const,
    record: { location: context.location!, participant, session: identity.session, channel: identity.channel },
    error,
  }));
  if (result.status === 'degraded') process.stderr.write(`! host presence degraded: ${result.error instanceof Error ? result.error.message : String(result.error)}\n`);
}
