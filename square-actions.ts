import { coreDone, coreHold, coreIgnore, coreListen, coreListening, coreResume, decideAct, decideImplicitJoin, decideJoin, resolveKnownName, validateDoneBody } from './decisions.js';
import { isSquareError, nameKey, SquareError, validateName, type StoredAct } from './model.js';
import { participantIdentity } from './participant-identity.js';
import type { WakeTransportPort } from './ports.js';
import { deliverPending } from './delivery-operations.js';
import type { Activity, CatchOptions, ExpressOptions, ExpressResult, ExpressionObservation, ListenerChangeResult, OperationControl, OwnershipFenceOptions } from './square-facade.js';
import { decideCatch, type CatchSelection } from './catch-decisions.js';
import { inSquareCount } from './runtime.js';
import { claimSessionParticipant, claimSessionTakeover, presenceEpoch, releaseSessionParticipantClaim, readParticipantOwner } from './registry.js';
import type { HostLedgerPort } from './host-ledger.js';
import { assertLiveOwner, ensureLocalPresence, identityRouteDraft, processIdentity, publishCommittedIdentity, retireIdentityRoute, type HostContext } from './participant-host.js';
import { applyWakeRoute, dropEndedSessionWakeRoutes, dropParticipantWakeRoutes, dropSessionWakeRoutes, sessionCanEndParticipant } from './routes.js';
import { parseRequiredActivityId, toPublicActivity } from './views.js';

export interface OperationContext extends HostContext { readonly wakeTransport?: WakeTransportPort }
export type { OwnershipFenceOptions };

function throwIfAborted(control?: OperationControl): void { if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Operation aborted'); }
export function catchUp(square: OperationContext, name: string, options?: CatchOptions, control?: OperationControl): Promise<CatchSelection>;
export function catchUp(square: OperationContext, name: string, options: CatchOptions, control: OperationControl | undefined, leaseId: string): Promise<CatchSelection | null>;
export async function catchUp(square: OperationContext, name: string, options: CatchOptions = {}, control?: OperationControl, leaseId?: string): Promise<CatchSelection | null> {
  throwIfAborted(control);
  if (!await assertLiveOwner(square, name)) throw new SquareError('already_joined', `${participantIdentity(name)} already stands here — another session holds the name`);
  const selected = (await square.artifact.transact((facts) => {
    // Replacement and selection share the receipt transaction: an old waiter cannot
    // consume a later activity between its heartbeat and its selection.
    if (leaseId !== undefined && facts.lease(name)?.leaseId !== leaseId) return null;
    return decideCatch(facts, name, options, square.clock());
  }, control?.signal)).value;
  if (selected !== null) await publishCommittedIdentity(square, selected.participant);
  return selected;
}

export async function join(square: OperationContext, name: string, control?: OperationControl): Promise<{ readonly name: string; readonly activity: Activity | null; readonly participantCount: number; readonly reconnected: boolean }> {
  throwIfAborted(control);
  validateName(name);
  const hostLedger = square.hostLedger;
  const preview = (await square.artifact.read((facts) => ({
    ...decideJoin(facts, name, square.clock()),
    participantCount: facts.roster().filter((p) => p.joined || p.done).length,
  }), control?.signal)).value;
  if (preview.joinAct === undefined) {
    if (hostLedger === undefined) return { name: preview.joinedName, activity: null, participantCount: preview.participantCount, reconnected: false };
    const identity = processIdentity(square.env ?? process.env);
    const owner = await readParticipantOwner(square.location!, preview.joinedName, hostLedger);
    if (owner?.session === identity.session) return {
      name: preview.joinedName, activity: null, participantCount: preview.participantCount,
      reconnected: identity.channel !== 'unknown',
    };
    // Missing or foreign owner must pass CAS, not become a silent reconnect.
  }
  let epoch: number | undefined;
  let ownershipClaim: import('./registry.js').OwnershipClaim;
  if (hostLedger !== undefined) {
    ownershipClaim = await claimSessionParticipant(square.location!, name, hostLedger, square.env ?? process.env, control?.signal);
    epoch = ownershipClaim?.epoch;
  }
  let committed: { name: string; stored: StoredAct | null; participantCount: number };
  try {
    const now = square.clock(), route = await identityRouteDraft(square, name);
    throwIfAborted(control);
    committed = (await square.artifact.transact((facts) => {
      const decision = decideJoin(facts, name, now);
      if (decision.joinAct !== undefined) {
        if (square.location !== undefined && square.location !== 'memory') dropParticipantWakeRoutes(facts, square.location, decision.joinedName);
        if (route !== undefined) applyWakeRoute(facts, route, now);
      }
      const stored = decision.joinAct === undefined ? null : facts.land(decision.joinAct);
      return {
        name: decision.joinedName, stored,
        participantCount: facts.roster().filter((p) => p.joined || p.done).length,
      };
    }, control?.signal)).value;
  } catch (error) {
    if (hostLedger !== undefined) await releaseSessionParticipantClaim(hostLedger, ownershipClaim).catch(() => undefined);
    throw error;
  }
  await publishCommittedIdentity(square, committed.name, epoch);
  return {
    name: committed.name, activity: committed.stored === null ? null : toPublicActivity(committed.stored),
    participantCount: committed.participantCount, reconnected: false,
  };
}

/** Takeover holds the host CAS fence across the single done+join artifact transaction. */
export async function takeover(square: OperationContext, name: string, _oldSessionIds: readonly string[] = [], control?: OperationControl): Promise<{ readonly name: string; readonly activities: readonly Activity[]; readonly participantCount: number; readonly epoch?: number }> {
  throwIfAborted(control);
  validateName(name);
  const hostLedger = square.hostLedger;
  const commitLifecycle = async () => {
    throwIfAborted(control);
    const now = square.clock();
    return (await square.artifact.transact((facts) => {
      const joinedName = resolveKnownName(facts, name);
      const storedDone = facts.land(coreDone(facts, joinedName, '', now));
      const decision = decideJoin(facts, joinedName, now);
      if (decision.joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(joinedName)} could not be reclaimed`);
      const storedJoin = facts.land(decision.joinAct);
      facts.replaceRoutes(facts.routes().filter((route) => nameKey(route.participant) !== nameKey(joinedName)));
      return {
        name: joinedName, stored: [storedDone, storedJoin],
        participantCount: facts.roster().filter((p) => p.joined || p.done).length,
      };
    }, control?.signal)).value;
  };
  if (hostLedger !== undefined) {
    // Gate the claim on authoritative admission, so a refused takeover never claims presence.
    await square.artifact.read((facts) => coreDone(facts, resolveKnownName(facts, name), '', square.clock()), control?.signal);
    const owner = await readParticipantOwner(square.location!, name, hostLedger);
    throwIfAborted(control);
    const outcome = await claimSessionTakeover(square.location!, name, hostLedger, square.env ?? process.env, {
      expectedEpoch: presenceEpoch(owner), expectedSession: owner?.session ?? '',
    }, async (claim) => {
      throwIfAborted(control);
      const committed = await commitLifecycle();
      await publishCommittedIdentity(square, committed.name, claim.epoch);
      return committed;
    }, control?.signal);
    if (outcome.status === 'busy') throw new SquareError('already_joined', `${participantIdentity(name)} already stands here — another session holds the name`);
    return { name: outcome.result.name, activities: outcome.result.stored.map(toPublicActivity), participantCount: outcome.result.participantCount, epoch: outcome.epoch };
  }
  const committed = await commitLifecycle();
  await publishCommittedIdentity(square, committed.name);
  return { name: committed.name, activities: committed.stored.map(toPublicActivity), participantCount: committed.participantCount };
}

export async function implicitJoin(square: OperationContext, name: string, control?: OperationControl): Promise<{ readonly name: string; readonly state: 'joined' | 'active' | 'done'; readonly activity: Activity | null }> {
  throwIfAborted(control);
  const now = square.clock(), route = await identityRouteDraft(square, name);
  throwIfAborted(control);
  const committed = (await square.artifact.transact((facts) => {
    const decision = decideImplicitJoin(facts, name, now);
    if (decision.state === 'done') {
      if (square.location !== undefined && square.location !== 'memory') dropSessionWakeRoutes(facts, square.location, processIdentity(square.env ?? process.env).session);
    } else if (decision.joinAct !== undefined) {
      if (square.location !== undefined && square.location !== 'memory') dropParticipantWakeRoutes(facts, square.location, decision.joinedName);
      if (route !== undefined) applyWakeRoute(facts, { ...route, participant: decision.joinedName }, now);
    }
    return { name: decision.joinedName, state: decision.state, stored: decision.joinAct === undefined ? null : facts.land(decision.joinAct) };
  }, control?.signal)).value;
  if (committed.stored !== null) await publishCommittedIdentity(square, committed.name);
  else await ensureLocalPresence(square, committed.name);
  if (committed.state === 'done') await retireIdentityRoute(square, committed.name);
  return { name: committed.name, state: committed.state, activity: committed.stored === null ? null : toPublicActivity(committed.stored) };
}

function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true }; throw error; }
}
export interface ExpressCommittedResult extends ExpressResult { readonly observation: ExpressionObservation; }
export async function express(square: OperationContext, name: string, body: string, options: ExpressOptions = {}, control?: OperationControl): Promise<ExpressCommittedResult> {
  throwIfAborted(control);
  if (!await assertLiveOwner(square, name)) throw new SquareError('already_joined', `${participantIdentity(name)} already stands here — another session holds the name`, { activityUnsent: true });
  throwIfAborted(control);
  const now = square.clock();
  const reply = rejectUnsentActivity(() => {
    try { return options.reply === undefined ? undefined : parseRequiredActivityId(options.reply); }
    catch (error) {
      if (isSquareError(error)) error.facts = { ...error.facts, reason: 'invalid_reply', activityId: options.reply };
      throw error;
    }
  });
  const committed = (await square.artifact.transact((facts) => {
    // Selected-row decoding is storage work, not evidence that admission safely refused.
    const proposed = decideAct(facts, { name, body, force: options.force ?? false, now, mentions: options.mentions,
      ...(options.reach === undefined ? {} : { reach: options.reach }), ...(options.noMention === undefined ? {} : { noMention: options.noMention }), ...('requireExplicitReach' in options ? { requireExplicitReach: options.requireExplicitReach === true } : {}), ...(reply === undefined ? {} : { reply }) });
    const holder = proposed.type === 'held' ? facts.hold().actor : undefined;
    const decision = rejectUnsentActivity(() => {
      const decision = proposed;
      if (decision.type === 'blocked') throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending: decision.activitySummaries.reduce((count, summary) => count + summary.count, 0) });
      if (decision.type === 'held') {
        throw new SquareError('held', 'The square is held', { ...(holder === undefined ? {} : { holder }), ...(decision.reason === undefined ? {} : { holdReason: decision.reason }) });
      }
      if (decision.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
      if (decision.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: decision.delayMs });
      if (decision.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, decision.nextAt - now) });
      return decision;
    });
    const stored = facts.land(decision.act);
    return {
      stored,
      observation: {
        standingCount: inSquareCount(facts), held: facts.hold().active, now,
        ownActivityCount: facts.participant(name)!.sayCount, hardCap: facts.header().hardCap,
      },
      ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }),
    };
  }, control?.signal)).value;
  await publishCommittedIdentity(square, name);
  const delivery = square.wakeTransport !== undefined && square.hostLedger !== undefined && square.location !== undefined && square.location !== 'memory'
    ? await deliverPending({ artifact: square.artifact, hostLedger: square.hostLedger, transport: square.wakeTransport, location: square.location, activity: committed.stored.index, now })
      .catch(() => ({ attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 }))
    : { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 };
  return {
    activity: toPublicActivity(committed.stored), delivery, observation: committed.observation,
    ...(committed.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: committed.replyAuthorNotHere }),
  };
}

async function landListenerChange(square: OperationContext, verb: 'listen' | 'ignore', actor: string, target: string, control?: OperationControl): Promise<ListenerChangeResult> {
  throwIfAborted(control);
  const now = square.clock();
  const stored = (await square.artifact.transact((facts) => {
    const act = verb === 'listen' ? coreListen(facts, actor, target, now) : coreIgnore(facts, actor, target, now);
    return act === undefined ? null : facts.land(act);
  }, control?.signal)).value;
  return { activity: stored === null ? null : toPublicActivity(stored) };
}
export function listen(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerChangeResult> { return landListenerChange(square, 'listen', actor, target, control); }
export function ignore(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerChangeResult> { return landListenerChange(square, 'ignore', actor, target, control); }
export async function listening(square: OperationContext, actor: string, control?: OperationControl): Promise<readonly string[]> { return (await square.artifact.read((facts) => coreListening(facts, actor), control?.signal)).value; }

async function landCore(square: OperationContext, verb: 'done' | 'hold' | 'resume', actor: string, body = '', fence: OwnershipFenceOptions = {}, control?: OperationControl): Promise<ExpressResult> {
  if (verb === 'done') validateDoneBody(body);
  const hostLedger = verb === 'done' ? square.hostLedger : undefined;
  const session = hostLedger === undefined ? undefined : processIdentity(square.env ?? process.env).session;
  const commitAndCleanup = async (): Promise<StoredAct> => {
    // Owner admission, commit and route/presence cleanup share the host claim critical section.
    if (verb === 'done' && !await assertLiveOwner(square, actor, fence.expectedEpoch)) throw new SquareError('already_done', `${participantIdentity(actor)} already stands here — another session holds the name`);
    const owners = hostLedger === undefined ? [] : (await hostLedger.listPresence({ location: square.location!, participant: actor })).filter((row) => row.session === session);
    const now = square.clock();
    const stored = (await square.artifact.transact((facts) => {
      const result = facts.land(verb === 'done' ? coreDone(facts, actor, body, now) : verb === 'hold' ? coreHold(facts, actor, body, now) : coreResume(facts, actor, now));
      if (session !== undefined) dropEndedSessionWakeRoutes(facts, square.location!, session, { expectedEpoch: fence.expectedEpoch, force: true, participant: actor });
      return result;
    }, control?.signal)).value;
    for (const row of owners) await hostLedger!.removePresenceIfUnchanged(row).catch((error) => {
      process.stderr.write(`! host presence cleanup degraded: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return stored;
  };
  const stored = hostLedger === undefined ? await commitAndCleanup() : await hostLedger.withClaimLock(commitAndCleanup, control?.signal);
  return { activity: toPublicActivity(stored) };
}
export function done(square: OperationContext, name: string, body = '', fence: OwnershipFenceOptions = {}, control?: OperationControl): Promise<ExpressResult> { return landCore(square, 'done', name, body, fence, control); }

function liveClaimedParticipants(rows: readonly import('./host-ledger.js').PresenceRecord[], sessionId: string): ReadonlySet<string> {
  const claimed = new Set<string>(), foreign = new Set<string>();
  for (const row of rows) (row.session === sessionId ? claimed : foreign).add(nameKey(row.participant));
  for (const key of foreign) claimed.delete(key);
  return claimed;
}
async function readLiveClaimedParticipants(hostLedger: HostLedgerPort, location: string, sessionId: string, now: number): Promise<ReadonlySet<string> | undefined> {
  try { return liveClaimedParticipants(await hostLedger.listPresence({ location, now }), sessionId); } catch { return undefined; }
}

export async function endOwnedSession(square: OperationContext, name: string, sessionId: string, expectedEpoch?: number): Promise<ExpressResult | null> {
  const { location, hostLedger } = square;
  const run = async () => {
    const now = square.clock();
    let currentSessionId: string | undefined, ownerMatches = expectedEpoch === undefined;
    let ownerRecords: readonly import('./host-ledger.js').PresenceRecord[] = [];
    let liveParticipants: ReadonlySet<string> | undefined = new Set<string>();
    if (location !== undefined && location !== 'memory' && hostLedger !== undefined) {
      try {
        const rows = await hostLedger.listPresence({ location, now });
        const bindings = rows.filter((row) => nameKey(row.participant) === nameKey(name));
        currentSessionId = bindings.find((row) => row.session !== sessionId)?.session ?? bindings.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]?.session;
        ownerRecords = bindings.filter((row) => row.session === sessionId);
        liveParticipants = liveClaimedParticipants(rows, sessionId);
        if (expectedEpoch !== undefined) {
          const owner = await readParticipantOwner(location, name, hostLedger);
          ownerMatches = owner !== undefined && owner.session === sessionId && presenceEpoch(owner) === expectedEpoch;
        }
      } catch { liveParticipants = undefined; }
    }
    const stored = (await square.artifact.transact((facts) => {
      let committed: StoredAct | null = null;
      if (location !== undefined && location !== 'memory' && ownerMatches && sessionCanEndParticipant(facts, location, name, sessionId, currentSessionId)) {
        try { committed = facts.land(coreDone(facts, name, '', now)); }
        catch (error) { if (!isSquareError(error) || (error.code !== 'already_done' && error.code !== 'not_joined')) throw error; }
      }
      if (location !== undefined && location !== 'memory') dropEndedSessionWakeRoutes(facts, location, sessionId, { expectedEpoch, liveParticipants, force: committed !== null, participant: name });
      return committed;
    })).value;
    if (stored !== null) for (const row of ownerRecords) await hostLedger!.removePresenceIfUnchanged(row).catch((error) => {
      process.stderr.write(`! host presence cleanup degraded: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    return stored;
  };
  const stored = hostLedger === undefined ? await run() : await hostLedger.withClaimLock(run);
  return stored === null ? null : { activity: toPublicActivity(stored) };
}
export async function retireEndedSessionRoutes(square: OperationContext, sessionId: string): Promise<void> {
  const { location, hostLedger } = square;
  if (location === undefined || hostLedger === undefined) return;
  await hostLedger.withClaimLock(async () => {
    const liveParticipants = await readLiveClaimedParticipants(hostLedger, location, sessionId, square.clock());
    await square.artifact.transact((facts) => { dropEndedSessionWakeRoutes(facts, location, sessionId, { liveParticipants, force: false }); });
  });
}
export function hold(square: OperationContext, name: string, reason = '', control?: OperationControl): Promise<ExpressResult> { return landCore(square, 'hold', name, reason, {}, control); }
export function resume(square: OperationContext, name: string, control?: OperationControl): Promise<ExpressResult> { return landCore(square, 'resume', name, '', {}, control); }
