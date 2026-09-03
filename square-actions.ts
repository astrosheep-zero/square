import { formatActivityId, parseActivityId, type Act } from './square-core.js';
import { coreDone, coreHold, coreIgnore, coreListen, coreListening, coreResume, decideAct, decideImplicitJoin, decideJoin, resolveKnownName } from './decisions.js';
import { nameKey, SquareError, validateName, type SquareState, type StoredAct } from './model.js';
import { participantIdentity } from './participant-identity.js';
import type { HostLedgerPort, PresenceChannel, SquareArtifactPort } from './ports.js';
import { deliverPending } from './delivery-operations.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, OwnershipFenceOptions, PerceivedActivity } from './square-facade.js';
import { decideCatch, type CatchDecision, type CatchProjection } from './catch-decisions.js';
import { claimSessionParticipant, claimSessionTakeover, readParticipantOwner, sessionOwnsParticipant, withOwnershipClaimLock } from './registry.js';
import { publishWakeRoute, retireWakeRouteFromArtifact, resolvePrimaryWakeRoute, defaultWakeRouteCapabilities, ROUTE_FRESH_MS, type WakeBoundaryProvider } from './routes.js';

export interface OperationContext {
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly location?: string;
  readonly hostLedger?: HostLedgerPort;
  readonly wakeTransport?: import('./ports.js').WakeTransportPort;
  readonly env?: NodeJS.ProcessEnv;
}

export type { OwnershipFenceOptions };

function processIdentity(env: NodeJS.ProcessEnv): { session: string; channel: PresenceChannel } {
  const choices: readonly [string | undefined, PresenceChannel][] = [
    [env.CLAUDE_CODE_SESSION_ID, 'claude-code'], [env.CODEX_THREAD_ID, 'codex'],
    [env.OPENCODE_SESSION_ID, 'opencode'], [env.SQUARE_PI_SESSION_ID, 'pi'], [env.PASEO_AGENT_ID, 'paseo'],
  ];
  const found = choices.find(([session]) => session?.trim());
  return found === undefined ? { session: `process:${process.pid}`, channel: 'unknown' } : { session: found[0]!.trim(), channel: found[1] };
}

async function currentOwnerEpoch(context: OperationContext, participant: string): Promise<number | undefined> {
  if (context.location === undefined || context.location === 'memory') return undefined;
  const owner = await readParticipantOwner(context.location, participant, context.env ?? process.env);
  return owner?.epoch;
}

async function publishIdentityRoute(context: OperationContext, participant: string, epoch?: number): Promise<void> {
  if (context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  if (context.hostLedger === undefined) return;
  const provider = identity.channel === 'claude-code' ? 'claude' : identity.channel === 'opencode' ? 'opencode' : identity.channel === 'pi' ? 'pi' : identity.channel === 'paseo' ? 'paseo' : 'codex' as WakeBoundaryProvider;
  const capabilities = await defaultWakeRouteCapabilities(context.hostLedger);
  const route = await resolvePrimaryWakeRoute({ location: context.location, participant, sessionId: identity.session, provider }, context.env ?? process.env, capabilities);
  if (route === undefined) return;
  const ownerEpoch = epoch ?? await currentOwnerEpoch(context, participant);
  await publishWakeRoute(context.artifact, { ...route, ...(ownerEpoch === undefined ? {} : { epoch: ownerEpoch }) }, { at: context.clock() }).catch(() => undefined);
}

async function retireIdentityRoute(context: OperationContext, participant: string, expectedEpoch?: number): Promise<void> {
  if (context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  await retireWakeRouteFromArtifact(
    context.artifact,
    { location: context.location, participant, sessionId: identity.session },
    expectedEpoch === undefined ? {} : { expectedEpoch },
  ).catch(() => undefined);
}

async function assertLiveOwner(context: OperationContext, participant: string, expectedEpoch?: number): Promise<boolean> {
  if (context.hostLedger === undefined || context.location === undefined || context.location === 'memory') return true;
  const identity = processIdentity(context.env ?? process.env);
  // Library callers without a harness session are not ownership-fenced unless an epoch was supplied.
  if (identity.channel === 'unknown' && expectedEpoch === undefined) return true;
  return sessionOwnsParticipant(context.location, participant, identity.session, context.env ?? process.env, expectedEpoch);
}

/** Presence is best effort and runs only after the artifact mutation commits. */
async function ensureLocalPresence(context: OperationContext, participant: string, epoch?: number): Promise<void> {
  if (context.hostLedger === undefined || context.location === undefined || context.location === 'memory') return;
  const identity = processIdentity(context.env ?? process.env);
  const ownerEpoch = epoch ?? await currentOwnerEpoch(context, participant);
  const now = context.clock();
  // Semantic publish: an unexpired presence row already stands when it carries the same owner epoch.
  try {
    const existing = await context.hostLedger.listPresence({ location: context.location, participant, session: identity.session, scopes: ['local'], now });
    if (existing.some((row) => row.channel === identity.channel
      && now - (row.updatedAt ?? 0) < ROUTE_FRESH_MS
      && (ownerEpoch === undefined || (row as import('./ports.js').PresenceRecord & { epoch?: number }).epoch === ownerEpoch))) return;
  } catch { /* fall through to the best-effort ensure below */ }
  const result = await context.hostLedger.ensurePresence({
    location: context.location,
    participant,
    session: identity.session,
    channel: identity.channel,
    // Presence rows are host-ledger wall-time evidence; the square clock belongs to artifact activities.
    updatedAt: Date.now(),
    ...(ownerEpoch === undefined || ownerEpoch <= 0 ? {} : { epoch: ownerEpoch }),
  } as import('./ports.js').PresenceRecord & { epoch?: number }, 'local').catch((error) => ({
    status: 'degraded' as const,
    record: { location: context.location!, participant, session: identity.session, channel: identity.channel },
    error,
  }));
  if (result.status === 'degraded') process.stderr.write(`! host presence degraded: ${result.error instanceof Error ? result.error.message : String(result.error)}\n`);
}

function exposeCaught(activity: StoredAct, perception: 'full' | 'presence'): PerceivedActivity {
  if (activity.kind === 'read' || activity.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(activity.index)}`);
  const result = {
    id: formatActivityId(activity.index), at: activity.at, kind: activity.kind, actor: activity.actor,
    mentions: activity.kind === 'say' ? activity.mentions ?? [] : [],
    ...('body' in activity && activity.body !== undefined ? { body: activity.body } : {}),
    ...('target' in activity ? { target: activity.target } : {}),
    ...(activity.kind === 'say' && activity.reply !== undefined ? { reply: formatActivityId(activity.reply) } : {}),
  } as Activity;
  if (perception === 'full' || !('body' in result)) return { ...result, perception };
  const { body: _body, ...withoutBody } = result;
  return { ...withoutBody, perception };
}

export async function catchUp(square: OperationContext, name: string, options: CatchOptions = {}, project?: (state: SquareState) => CatchProjection): Promise<CatchResult> {
  const idle = options.idle ?? 0;
  if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
  const deadline = Date.now() + idle;
  while (true) {
    const attempt = await square.artifact.transact<{ version: number; decision: CatchDecision }>((state, version) => {
      const decision = decideCatch(state, name, options, square.clock(), project);
      return { ...(decision.changed ? { state } : {}), result: { version, decision } };
    });
    await ensureLocalPresence(square, name);
    await publishIdentityRoute(square, name);
    if (attempt.decision.delivered.length > 0 || idle === 0) {
      return {
        activities: attempt.decision.delivered.map((activity) => exposeCaught(activity, attempt.decision.perceptions.get(activity.index) ?? 'full')),
        consumedThrough: attempt.decision.consumedThrough as CatchResult['consumedThrough'],
        idleExpired: false,
        remaining: attempt.decision.remaining,
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { activities: [], consumedThrough: attempt.decision.consumedThrough as CatchResult['consumedThrough'], idleExpired: true, remaining: 0 };
    }
    // Publication above is a semantic no-op while the route and presence stay unchanged and
    // unexpired, so only a real external change can move the artifact version. Establish the
    // wait baseline after those self-side effects; if the version moved anyway (own refresh or
    // a racing external commit), re-snapshot instead of waiting on a stale baseline.
    const baseline = (await square.artifact.read()).version;
    if (baseline !== attempt.version) continue;
    if (!await square.artifact.changed(baseline, remaining)) {
      return { activities: [], consumedThrough: attempt.decision.consumedThrough as CatchResult['consumedThrough'], idleExpired: true, remaining: 0 };
    }
  }
}

function storeActs(state: SquareState, acts: readonly Act[]): StoredAct[] {
  const stored: StoredAct[] = [];
  for (const act of acts) {
    const item = { ...act, index: state.runtime.nextActIndex } as StoredAct;
    state.runtime.nextActIndex += 1;
    state.acts.push(item);
    stored.push(item);
  }
  return stored;
}

function committedActivity(stored: readonly StoredAct[], verb: string): StoredAct {
  const activity = stored[0];
  if (activity === undefined) throw new Error(`${verb} activity did not commit`);
  return activity;
}

function exposeActivity(stored: StoredAct): Activity {
  if (stored.kind === 'read' || stored.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  return {
    id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor,
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    mentions: stored.kind === 'say' ? stored.mentions ?? [] : [],
    ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}),
  };
}

function parseRequiredActivityId(id: import('./square-core.js').ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

export async function join(square: OperationContext, name: string): Promise<{ readonly name: string; readonly activity: Activity | null }> {
  // Rejected validation must not perform an ownership claim.
  validateName(name);
  let epoch: number | undefined;
  if (square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory') {
    const claim = await claimSessionParticipant(square.location, name, square.env ?? process.env);
    epoch = claim?.epoch;
  }
  const now = square.clock();
  const committed = await square.artifact.transact<{ name: string; stored: StoredAct | null }>((state) => {
    const decision = decideJoin(state, name, now);
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, stored: null } };
    return { state, result: { name: decision.joinedName, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  });
  await ensureLocalPresence(square, committed.name, epoch);
  await publishIdentityRoute(square, committed.name, epoch);
  return { name: committed.name, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

/** End the standing participant and immediately let the caller reclaim the name. */
export async function takeover(square: OperationContext, name: string): Promise<{ readonly name: string; readonly activities: readonly Activity[]; readonly epoch?: number }> {
  // Rejected validation must not perform an ownership claim.
  validateName(name);
  const commitLifecycle = async (): Promise<{ name: string; stored: readonly StoredAct[] }> => {
    const now = square.clock();
    const committed = await square.artifact.transact<{ name: string; stored: readonly StoredAct[] }>((state) => {
      const joinedName = resolveKnownName(state, name);
      const done = coreDone(state, joinedName, '', now);
      const storedDone = committedActivity(storeActs(state, [done]), 'kick');
      const decision = decideJoin(state, joinedName, now);
      if (decision.joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(joinedName)} could not be reclaimed`);
      const storedJoin = committedActivity(storeActs(state, [decision.joinAct]), 'join');
      state.routes = (state.routes ?? []).filter((route) => nameKey(route.participant) !== nameKey(joinedName));
      return { state, result: { name: joinedName, stored: [storedDone, storedJoin] } };
    });
    return committed;
  };
  if (square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory') {
    const env = square.env ?? process.env;
    // Gate the ownership claim on the artifact's authoritative state: a takeover that cannot
    // commit its lifecycle (a name that never joined, or a standing participant that is no
    // longer joined) must not claim or remove presence. The refusals mirror the transaction.
    const { state } = await square.artifact.read();
    const joinedName = resolveKnownName(state, name); // invalid_args when the name never joined
    coreDone(state, joinedName, '', square.clock()); // already_done/not_joined when not standing
    const owner = await readParticipantOwner(square.location, name, env);
    // The claim and the artifact lifecycle are one fenced critical section: a losing or refused
    // takeover never mutates the winner, and no second takeover can interleave mid-commit.
    const outcome = await claimSessionTakeover(square.location, name, env, {
      expectedEpoch: owner?.epoch ?? 0,
      expectedSession: owner?.sessionId ?? '',
    }, async (claim) => {
      const committed = await commitLifecycle();
      await ensureLocalPresence(square, committed.name, claim.epoch);
      await publishIdentityRoute(square, committed.name, claim.epoch);
      return committed;
    });
    if (outcome.status === 'busy') throw new SquareError('already_joined', `${participantIdentity(name)} is already bound to another session`);
    return { name: outcome.result.name, activities: outcome.result.stored.map(exposeActivity), epoch: outcome.epoch };
  }
  const committed = await commitLifecycle();
  await ensureLocalPresence(square, committed.name);
  await publishIdentityRoute(square, committed.name);
  return { name: committed.name, activities: committed.stored.map(exposeActivity) };
}

export async function implicitJoin(square: OperationContext, name: string): Promise<{ readonly name: string; readonly state: 'joined' | 'active' | 'done'; readonly activity: Activity | null }> {
  const now = square.clock();
  const committed = await square.artifact.transact<{ name: string; state: 'joined' | 'active' | 'done'; stored: StoredAct | null }>((state) => {
    const decision = decideImplicitJoin(state, name, now);
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, state: decision.state, stored: null } };
    return { state, result: { name: decision.joinedName, state: decision.state, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  });
  await ensureLocalPresence(square, committed.name);
  if (committed.state === 'done') await retireIdentityRoute(square, committed.name);
  else await publishIdentityRoute(square, committed.name);
  return { name: committed.name, state: committed.state, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

export async function express(square: OperationContext, name: string, body: string, options: ExpressOptions = {}): Promise<ExpressResult> {
  const now = square.clock();
  const reply = options.reply === undefined ? undefined : parseRequiredActivityId(options.reply);
  const committed = await square.artifact.transact((state) => {
    const decision = decideAct(state, { name, body, force: options.force ?? false, now, mentions: options.mentions, ...(options.reach === undefined ? {} : { reach: options.reach }), ...(reply === undefined ? {} : { reply }) });
    if (decision.type === 'blocked') {
      const pending = decision.activitySummaries.reduce((count, summary) => count + summary.count, 0) + decision.unreadRoomChanges.length;
      throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending });
    }
    if (decision.type === 'held') {
      const holder = state.acts.filter((activity) => activity.kind === 'hold').at(-1)?.actor;
      throw new SquareError('held', 'The square is held', holder === undefined ? undefined : { holder });
    }
    if (decision.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
    if (decision.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: decision.delayMs });
    if (decision.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, decision.nextAt - now) });
    const stored = committedActivity(storeActs(state, [decision.act]), 'express');
    return { state, result: { stored } };
  });
  await ensureLocalPresence(square, name);
  await publishIdentityRoute(square, name);
  let delivery: import('./ports.js').DeliveryResult;
  if (square.wakeTransport !== undefined && square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory') {
    delivery = await deliverPending({ artifact: square.artifact, hostLedger: square.hostLedger, transport: square.wakeTransport, location: square.location, activity: committed.stored.index, now }).catch(() => ({ attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 }));
  } else {
    delivery = { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 };
  }
  return { activity: exposeActivity(committed.stored), delivery };
}

export interface ListenerChangeResult { readonly activity: Activity | null }

async function landListenerChange(square: OperationContext, verb: 'listen' | 'ignore', actor: string, target: string): Promise<ListenerChangeResult> {
  const now = square.clock();
  const stored = await square.artifact.transact<StoredAct | null>((state) => {
    const act = verb === 'listen' ? coreListen(state, actor, target, now) : coreIgnore(state, actor, target, now);
    if (act === undefined) return { result: null };
    return { state, result: committedActivity(storeActs(state, [act]), verb) };
  });
  return { activity: stored === null ? null : exposeActivity(stored) };
}

export function listen(square: OperationContext, actor: string, target: string): Promise<ListenerChangeResult> { return landListenerChange(square, 'listen', actor, target); }
export function ignore(square: OperationContext, actor: string, target: string): Promise<ListenerChangeResult> { return landListenerChange(square, 'ignore', actor, target); }
export async function listening(square: OperationContext, actor: string): Promise<readonly string[]> { const { state } = await square.artifact.read(); return coreListening(state, actor); }

async function landCore(square: OperationContext, verb: 'done' | 'hold' | 'resume', actor: string, body = '', fence: OwnershipFenceOptions = {}): Promise<ExpressResult> {
  // Done completes ownership: the live-owner validation and the artifact commit share one
  // ownership critical section, so a takeover finalizing between validation and commit can never
  // be completed by a stale done — an old expected epoch refuses instead of appending.
  const commit = async (): Promise<StoredAct> => {
    if (verb === 'done' && !await assertLiveOwner(square, actor, fence.expectedEpoch)) {
      throw new SquareError('already_done', `${participantIdentity(actor)} is no longer owned by this session`);
    }
    const now = square.clock();
    return square.artifact.transact((state) => {
      const act = verb === 'done' ? coreDone(state, actor, body, now) : verb === 'hold' ? coreHold(state, actor, body, now) : coreResume(state, actor, now);
      return { state, result: committedActivity(storeActs(state, [act]), verb) };
    });
  };
  const fenced = verb === 'done' && square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory';
  const stored = fenced
    ? await withOwnershipClaimLock(square.env ?? process.env, commit)
    : await commit();
  if (verb === 'done') await retireIdentityRoute(square, actor, fence.expectedEpoch);
  return { activity: exposeActivity(stored) };
}

export function done(square: OperationContext, name: string, body = '', fence: OwnershipFenceOptions = {}): Promise<ExpressResult> {
  return landCore(square, 'done', name, body, fence);
}
export function hold(square: OperationContext, name: string, reason = ''): Promise<ExpressResult> { return landCore(square, 'hold', name, reason); }
export function resume(square: OperationContext, name: string): Promise<ExpressResult> { return landCore(square, 'resume', name); }
