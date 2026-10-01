import { formatActivityId, parseActivityId, type Act } from './square-core.js';
import { coreDone, coreHold, coreIgnore, coreListen, coreListening, coreResume, decideAct, decideImplicitJoin, decideJoin, resolveKnownName, validateDoneBody } from './decisions.js';
import { isSquareError, nameKey, SquareError, validateName, type SquareState, type StoredAct } from './model.js';
import { participantIdentity } from './participant-identity.js';
import type { WakeTransportPort } from './ports.js';
import { deliverPending } from './delivery-operations.js';
import type { Activity, CatchOptions, CatchResult, ExpressOptions, ExpressResult, OperationControl, OwnershipFenceOptions, PerceivedActivity } from './square-facade.js';
import { decideCatch, type CatchDecision, type CatchProjection } from './catch-decisions.js';
import { claimSessionParticipant, claimSessionTakeover, releaseSessionParticipantClaim, readParticipantOwner, withOwnershipClaimLock } from './registry.js';
import { assertLiveOwner, ensureLocalPresence, identityRouteDraft, processIdentity, publishIdentityRoute, retireIdentityRoute, type HostContext } from './participant-host.js';
import { applyWakeRouteToState, dropEndedSessionWakeRoutesFromState, dropParticipantWakeRoutesFromState, dropSessionWakeRoutesFromState, sessionCanEndParticipant } from './routes.js';

export interface OperationContext extends HostContext {
  readonly wakeTransport?: WakeTransportPort;
}

export type { OwnershipFenceOptions };

function throwIfAborted(control?: OperationControl): void { if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Operation aborted'); }

function exposeCaught(activity: StoredAct, perception: 'full' | 'presence'): PerceivedActivity {
  if (activity.kind === 'read' || activity.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(activity.index)}`);
  const result = {
    id: formatActivityId(activity.index), at: activity.at, kind: activity.kind, actor: activity.actor,
    mentions: activity.kind === 'say' ? activity.mentions ?? [] : [],
    ...(activity.kind === 'say' && activity.reach !== undefined ? { reach: activity.reach } : {}),
    ...('body' in activity && activity.body !== undefined ? { body: activity.body } : {}),
    ...('target' in activity ? { target: activity.target } : {}),
    ...(activity.kind === 'say' && activity.reply !== undefined ? { reply: formatActivityId(activity.reply) } : {}),
  } as Activity;
  if (perception === 'full' || !('body' in result)) return { ...result, perception };
  const { body: _body, ...withoutBody } = result;
  return { ...withoutBody, perception };
}

export async function catchUp(square: OperationContext, name: string, options: CatchOptions = {}, project?: (state: SquareState) => CatchProjection, control?: OperationControl): Promise<CatchResult> {
  const idle = options.idle ?? 0;
  if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
  const deadline = Date.now() + idle;
    if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Operation aborted');
  while (true) {
    if (!await assertLiveOwner(square, name)) {
      throw new SquareError('already_joined', `✕ ${participantIdentity(name)} already stands here — another session holds the name`);
    }
    const attempt = await square.artifact.transact<{ version: number; decision: CatchDecision }>((state, version) => {
      const decision = decideCatch(state, name, options, square.clock(), project);
      return { ...(decision.changed ? { state } : {}), result: { version, decision } };
    }, control?.signal);
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
    const baseline = (await square.artifact.read(control?.signal)).version;
    if (baseline !== attempt.version) continue;
    if (!await square.artifact.changed(baseline, remaining, control?.signal)) {
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
    ...(stored.kind === 'say' && stored.reach !== undefined ? { reach: stored.reach } : {}),
    ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}),
  };
}

function parseRequiredActivityId(id: import('./square-core.js').ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

export async function join(square: OperationContext, name: string, control?: OperationControl): Promise<{ readonly name: string; readonly activity: Activity | null }> {
  // Rejected validation must not perform an ownership claim.
  throwIfAborted(control);
  validateName(name);
  const preview = await square.artifact.read(control?.signal);
  const previewDecision = decideJoin(preview.state, name, square.clock());
  if (previewDecision.joinAct === undefined) {
    // An active artifact participant is idempotent only for its current session.
    // A different owner must still pass through the registry CAS so it is refused
    // instead of silently reconnecting as a foreign session.
    if (square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory') {
      const identity = processIdentity(square.env ?? process.env);
      const owner = await readParticipantOwner(square.location, previewDecision.joinedName, square.env ?? process.env);
      if (owner === undefined) {
        // Keep the claim path for an active artifact whose ledger owner is not
        // visible yet; concurrent callers must still serialize through CAS.
      } else if (owner.sessionId !== identity.session) {
        // Continue into the ownership claim below; it will produce the stable
        // already_joined error without mutating the artifact.
      } else {
        return { name: previewDecision.joinedName, activity: null };
      }
    } else {
      return { name: previewDecision.joinedName, activity: null };
    }
  }
  let epoch: number | undefined;
  let ownershipClaim: import('./registry.js').OwnershipClaim;
  if (square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory') {
    const claim = await claimSessionParticipant(square.location, name, square.env ?? process.env, control?.signal);
    ownershipClaim = claim;

    epoch = claim?.epoch;
  }
  let committed: { readonly name: string; readonly stored: StoredAct | null };
  try {
  const now = square.clock();
  const route = await identityRouteDraft(square, name);
  throwIfAborted(control);
  committed = await square.artifact.transact<{ name: string; stored: StoredAct | null }>((state) => {
    const decision = decideJoin(state, name, now);
    if (decision.joinAct === undefined) {
      return { result: { name: decision.joinedName, stored: null } };
    }
    if (square.location !== undefined && square.location !== 'memory') dropParticipantWakeRoutesFromState(state, square.location, decision.joinedName);
    if (route !== undefined) applyWakeRouteToState(state, route, now);
    return { state, result: { name: decision.joinedName, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  }, control?.signal);
  } catch (error) {
    await releaseSessionParticipantClaim(square.location!, name, square.env ?? process.env, ownershipClaim).catch(() => undefined);
    throw error;
  }
  await ensureLocalPresence(square, committed.name, epoch);
  await publishIdentityRoute(square, committed.name, epoch);
  return { name: committed.name, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

/** End the standing participant and immediately let the caller reclaim the name. */
export async function takeover(square: OperationContext, name: string, _oldSessionIds: readonly string[] = [], control?: OperationControl): Promise<{ readonly name: string; readonly activities: readonly Activity[]; readonly epoch?: number }> {
  // Rejected validation must not perform an ownership claim.
  throwIfAborted(control);
  validateName(name);
  const commitLifecycle = async (): Promise<{ name: string; stored: readonly StoredAct[] }> => {

    throwIfAborted(control);
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
    }, control?.signal);
    return committed;
  };
  if (square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory') {
    const env = square.env ?? process.env;
    // Gate the ownership claim on the artifact's authoritative state: a takeover that cannot
    // commit its lifecycle (a name that never joined, or a standing participant that is no
    // longer joined) must not claim or remove presence. The refusals mirror the transaction.
    const { state } = await square.artifact.read(control?.signal);
    const joinedName = resolveKnownName(state, name); // invalid_args when the name never joined
    coreDone(state, joinedName, '', square.clock()); // already_done/not_joined when not standing
    const owner = await readParticipantOwner(square.location, name, env);
    throwIfAborted(control);
    // The claim and the artifact lifecycle are one fenced critical section: a losing or refused
    // takeover never mutates the winner, and no second takeover can interleave mid-commit.
    const outcome = await claimSessionTakeover(square.location, name, env, {
      expectedEpoch: owner?.epoch ?? 0,
      expectedSession: owner?.sessionId ?? '',
    }, async (claim) => {
      throwIfAborted(control);
      const committed = await commitLifecycle();
      await ensureLocalPresence(square, committed.name, claim.epoch);
      await publishIdentityRoute(square, committed.name, claim.epoch);
      return committed;
    }, control?.signal);
    if (outcome.status === 'busy') throw new SquareError('already_joined', `✕ ${participantIdentity(name)} already stands here — another session holds the name`);
    return { name: outcome.result.name, activities: outcome.result.stored.map(exposeActivity), epoch: outcome.epoch };
  }
  const committed = await commitLifecycle();
  await ensureLocalPresence(square, committed.name);
  await publishIdentityRoute(square, committed.name);
  return { name: committed.name, activities: committed.stored.map(exposeActivity) };
}

export async function implicitJoin(square: OperationContext, name: string, control?: OperationControl): Promise<{ readonly name: string; readonly state: 'joined' | 'active' | 'done'; readonly activity: Activity | null }> {
  throwIfAborted(control);
  const now = square.clock();
  const route = await identityRouteDraft(square, name);
  throwIfAborted(control);
  const committed = await square.artifact.transact<{ name: string; state: 'joined' | 'active' | 'done'; stored: StoredAct | null }>((state) => {
    const decision = decideImplicitJoin(state, name, now);
    if (decision.state === 'done') {
      if (square.location !== undefined && square.location !== 'memory') dropSessionWakeRoutesFromState(state, square.location, processIdentity(square.env ?? process.env).session);
      return { state, result: { name: decision.joinedName, state: decision.state, stored: null } };
    }
    if (decision.joinAct === undefined) return { result: { name: decision.joinedName, state: decision.state, stored: null } };
    if (square.location !== undefined && square.location !== 'memory') dropParticipantWakeRoutesFromState(state, square.location, decision.joinedName);
    if (route !== undefined) applyWakeRouteToState(state, { ...route, participant: decision.joinedName }, now);
    return { state, result: { name: decision.joinedName, state: decision.state, stored: committedActivity(storeActs(state, [decision.joinAct]), 'join') } };
  }, control?.signal);
  await ensureLocalPresence(square, committed.name);
  if (committed.state === 'done') await retireIdentityRoute(square, committed.name);
  else if (committed.stored !== null) await publishIdentityRoute(square, committed.name);
  return { name: committed.name, state: committed.state, activity: committed.stored === null ? null : exposeActivity(committed.stored) };
}

/** Only admission failures can advertise a safe retry; storage and post-commit
 * failures must not be mistaken for a rejected send merely by their error code. */
function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true };
    throw error;
  }
}

export async function express(square: OperationContext, name: string, body: string, options: ExpressOptions = {}, control?: OperationControl): Promise<ExpressResult> {
  if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Operation aborted');
  if (!await assertLiveOwner(square, name)) {
    throw new SquareError('already_joined', `✕ ${participantIdentity(name)} already stands here — another session holds the name`, { activityUnsent: true });
  }
  throwIfAborted(control);
  const now = square.clock();
  const reply = rejectUnsentActivity(() => options.reply === undefined ? undefined : parseRequiredActivityId(options.reply));
  const committed = await square.artifact.transact((state) => {
    const decision = rejectUnsentActivity(() => {
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
      return decision;
    });
    const stored = committedActivity(storeActs(state, [decision.act]), 'express');
    return { state, result: { stored } };
  }, control?.signal);
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

async function landListenerChange(square: OperationContext, verb: 'listen' | 'ignore', actor: string, target: string, control?: OperationControl): Promise<ListenerChangeResult> {
  throwIfAborted(control);
  const now = square.clock();
  const stored = await square.artifact.transact<StoredAct | null>((state) => {
    const act = verb === 'listen' ? coreListen(state, actor, target, now) : coreIgnore(state, actor, target, now);
    if (act === undefined) return { result: null };
    return { state, result: committedActivity(storeActs(state, [act]), verb) };
  }, control?.signal);
  return { activity: stored === null ? null : exposeActivity(stored) };
}

export function listen(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerChangeResult> { return landListenerChange(square, 'listen', actor, target, control); }
export function ignore(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerChangeResult> { return landListenerChange(square, 'ignore', actor, target, control); }
export async function listening(square: OperationContext, actor: string, control?: OperationControl): Promise<readonly string[]> { const { state } = await square.artifact.read(control?.signal); return coreListening(state, actor); }

async function landCore(square: OperationContext, verb: 'done' | 'hold' | 'resume', actor: string, body = '', fence: OwnershipFenceOptions = {}, control?: OperationControl): Promise<ExpressResult> {
  if (verb === 'done') validateDoneBody(body);
  // Done completes ownership: the live-owner validation, the artifact commit, the ended
  // session's route retirement, and presence cleanup share one ownership critical section.
  // A takeover finalizing between validation and commit can never be completed by a stale
  // done, and no post-lock cleanup can remove a replacement owner's fresh rows.
  const fenced = verb === 'done' && square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory';
  const session = fenced ? processIdentity(square.env ?? process.env).session : undefined;
  const commitAndCleanup = async (): Promise<StoredAct> => {
    if (verb === 'done' && !await assertLiveOwner(square, actor, fence.expectedEpoch)) {
      throw new SquareError('already_done', `✕ ${participantIdentity(actor)} already stands here — another session holds the name`);
    }
    let ownerRecords: readonly import('./host-ledger.js').PresenceRecord[] = [];
    if (fenced && session !== undefined) {
      ownerRecords = (await square.hostLedger!.listPresence({ location: square.location!, participant: actor }))
        .filter((row) => row.session === session);
    }
    const now = square.clock();
    const stored = await square.artifact.transact((state) => {
      const act = verb === 'done' ? coreDone(state, actor, body, now) : verb === 'hold' ? coreHold(state, actor, body, now) : coreResume(state, actor, now);
      const result = committedActivity(storeActs(state, [act]), verb);
      if (fenced && session !== undefined) {
        dropEndedSessionWakeRoutesFromState(state, square.location!, session, { expectedEpoch: fence.expectedEpoch, force: true, participant: actor });
      }
      return { state, result };
    }, control?.signal);
    for (const ownerRecord of ownerRecords) {
      await square.hostLedger!.removePresenceIfUnchanged(ownerRecord).catch((error) => {
        process.stderr.write(`! host presence cleanup degraded: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    return stored;
  };
  const stored = fenced
    ? await withOwnershipClaimLock(square.env ?? process.env, commitAndCleanup, control?.signal)
    : await commitAndCleanup();
  return { activity: exposeActivity(stored) };
}

export function done(square: OperationContext, name: string, body = '', fence: OwnershipFenceOptions = {}, control?: OperationControl): Promise<ExpressResult> { return landCore(square, 'done', name, body, fence, control); }

function liveClaimedParticipants(rows: readonly import('./host-ledger.js').PresenceRecord[], sessionId: string): ReadonlySet<string> {
  const claimed = new Set<string>();
  const foreign = new Set<string>();
  for (const row of rows) {
    const key = nameKey(row.participant);
    if (row.session === sessionId) claimed.add(key);
    else foreign.add(key);
  }
  for (const key of foreign) claimed.delete(key);
  return claimed;
}

async function readLiveClaimedParticipants(square: OperationContext, location: string, sessionId: string): Promise<ReadonlySet<string> | undefined> {
  if (square.hostLedger === undefined) return new Set<string>();
  try {
    return liveClaimedParticipants(await square.hostLedger.listPresence({ location, now: square.clock() }), sessionId);
  } catch { return undefined; }
}

/**
 * End one session's ownership of a participant inside the ownership claim critical
 * section. The artifact `done` (when this session is still the owner) and retirement of
 * this session's routes share one transaction, and the exact captured presence row is
 * removed only while the lock is still held. A rejoin or takeover therefore lands either
 * before the whole cleanup — and is part of the state being ended — or after it, with
 * fresh presence and route rows that this cleanup can never touch.
 */
export async function endOwnedSession(square: OperationContext, name: string, sessionId: string, expectedEpoch?: number): Promise<ExpressResult | null> {
  const location = square.location;
  const run = async () => {
    const now = square.clock();
    let currentSessionId: string | undefined;
    let ownerMatches = expectedEpoch === undefined;
    let ownerRecords: readonly import('./host-ledger.js').PresenceRecord[] = [];
    let liveParticipants: ReadonlySet<string> | undefined = new Set<string>();
    if (location !== undefined && location !== 'memory' && square.hostLedger !== undefined) {
      try {
        const rows = await square.hostLedger.listPresence({ location, now });
        const bindings = rows.filter((row) => nameKey(row.participant) === nameKey(name));
        currentSessionId = bindings.find((binding) => binding.session !== sessionId)?.session
          ?? bindings.toSorted((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]?.session;
        ownerRecords = rows.filter((row) => row.session === sessionId);
        liveParticipants = liveClaimedParticipants(rows, sessionId);
        if (expectedEpoch !== undefined) {
          const owner = await readParticipantOwner(location, name, square.env ?? process.env);
          ownerMatches = owner?.sessionId === sessionId && owner.epoch === expectedEpoch;
        }
      } catch { liveParticipants = undefined; /* unknown evidence preserves routes; artifact routes still fence ownership */ }
    }
    const stored = await square.artifact.transact<StoredAct | null>((state) => {
      let committed: StoredAct | null = null;
      if (location !== undefined && location !== 'memory' && ownerMatches && sessionCanEndParticipant(state, location, name, sessionId, currentSessionId)) {
        try { committed = committedActivity(storeActs(state, [coreDone(state, name, '', now)]), 'done'); }
        catch (error) { if (!isSquareError(error) || (error.code !== 'already_done' && error.code !== 'not_joined')) throw error; }
      }
      if (location !== undefined && location !== 'memory') {
        dropEndedSessionWakeRoutesFromState(state, location, sessionId, { expectedEpoch, liveParticipants, force: committed !== null });
      }
      return { state, result: committed };
    });
    if (stored !== null) {
      for (const ownerRecord of ownerRecords) {
        await square.hostLedger!.removePresenceIfUnchanged(ownerRecord).catch((error) => {
          process.stderr.write(`! host presence cleanup degraded: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      }
    }
    return stored;
  };
  const fenced = location !== undefined && location !== 'memory' && square.hostLedger !== undefined;
  const stored = fenced
    ? await withOwnershipClaimLock(square.env ?? process.env, run)
    : await run();
  return stored === null ? null : { activity: exposeActivity(stored) };
}

/**
 * Retire an ended session's orphan routes when no participant name is known. The
 * ownership claim lock is held across the ledger read and the artifact transaction, so a
 * rejoin that claims first is seen as a live participant and its route survives.
 */
export async function retireEndedSessionRoutes(square: OperationContext, sessionId: string): Promise<void> {
  const location = square.location;
  if (location === undefined || location === 'memory' || square.hostLedger === undefined) return;
  await withOwnershipClaimLock(square.env ?? process.env, async () => {
    const liveParticipants = await readLiveClaimedParticipants(square, location, sessionId);
    await square.artifact.transact((state) => {
      dropEndedSessionWakeRoutesFromState(state, location, sessionId, { liveParticipants, force: false });
      return { state, result: undefined };
    });
  });
}

export function hold(square: OperationContext, name: string, reason = '', control?: OperationControl): Promise<ExpressResult> { return landCore(square, 'hold', name, reason, {}, control); }
export function resume(square: OperationContext, name: string, control?: OperationControl): Promise<ExpressResult> { return landCore(square, 'resume', name, '', {}, control); }
