import { coreDone, coreHold, coreIgnore, coreListen, coreListening, coreResume, coreUnlisten, decideAct, decideImplicitJoin, decideJoin, resolveKnownName, validateDoneBody } from './decisions.js';
import { isSquareError, sameBody, SquareError, validateName, type Seat, type StoredAct } from './model.js';
import { participantIdentity } from './participant-identity.js';
import type { WakeTransportPort } from './ports.js';
import { deliverPending } from './delivery-operations.js';
import type { Activity, ActivityResult, CatchOptions, ExpressOptions, ExpressResult, ExpressionObservation, OperationControl, SquareObservation } from './square-facade.js';
import { decideCatch, observeCatchSelection, selectCatchPage, type CatchSelection } from './catch-decisions.js';
import { inSquareCount } from './runtime.js';
import { asSeatRef, participantAuthority, publishCommittedIdentity, requireBody, requireSeat, type HostContext } from './seats.js';
import { parseRequiredActivityId, toPublicActivity } from './views.js';

export interface OperationContext extends HostContext { readonly wakeTransport?: WakeTransportPort }

function throwIfAborted(control?: OperationControl): void { if (control?.signal?.aborted) throw control.signal.reason ?? new Error('Operation aborted'); }
export function catchUp(square: OperationContext, name: string, options?: CatchOptions, control?: OperationControl): Promise<CatchSelection>;
export function catchUp(square: OperationContext, name: string, options: CatchOptions, control: OperationControl | undefined, leaseId: string): Promise<CatchSelection | null>;
export async function catchUp(square: OperationContext, name: string, options: CatchOptions = {}, control?: OperationControl, leaseId?: string): Promise<CatchSelection | null> {
  throwIfAborted(control);
  validateName(name);
  requireSeat(square, name);
  let selected: CatchSelection | null | undefined;
  if (leaseId === undefined && options.id === undefined) {
    selected = (await square.artifact.read((facts) => {
      const page = selectCatchPage(facts, name, options);
      return page.indexes.length === 0 ? observeCatchSelection(facts, page.participant, [], page.filter, square.clock()) : undefined;
    }, control?.signal)).value;
  }
  if (selected === undefined) selected = (await square.artifact.transactAs({ kind: 'participant', seat: requireSeat(square, name) }, (facts) => {
    // Replacement and selection share the receipt transaction: an old waiter cannot
    // consume a later activity between its heartbeat and its selection.
    if (leaseId !== undefined && facts.lease(name)?.leaseId !== leaseId) return null;
    return decideCatch(facts, name, options, square.clock());
  }, control?.signal)).value;
  return selected;
}

type LandingContext = Pick<SquareObservation, 'standingCount' | 'held' | 'now'>;

export async function join(square: OperationContext, name: string, control?: OperationControl, admission: { readonly requireKnown?: boolean } = {}): Promise<{ readonly name: string; readonly seat: Seat; readonly activity: Activity | null; readonly participantCount: number; readonly reconnected: boolean; readonly observation: LandingContext }> {
  throwIfAborted(control);
  validateName(name);
  const body = requireBody(square), now = square.clock();
  const committed = (await square.artifact.transactAs({ kind: 'join', participant: name, body, wakeAddress: square.wakeAddress }, facts => {
    const participant = admission.requireKnown ? resolveKnownName(facts, name) : facts.participant(name)?.name ?? name;
    const current = facts.participant(participant), currentSeat = facts.seat(participant);
    if (current?.joined) {
      if (currentSeat === undefined || !sameBody(currentSeat.body, body))
        throw new SquareError('already_joined', `${participantIdentity(participant)} is held by another body; take it over explicitly`);
      if (square.wakeAddress !== undefined) facts.updateWakeAddress(asSeatRef(currentSeat), square.wakeAddress);
      const seat = facts.seat(participant);
      if (seat === undefined) throw new SquareError('already_joined', 'The participant seat changed while reconnecting.');
      return { name: current.name, seat, stored: null, reconnected: true,
        participantCount: facts.roster().filter(item => item.joined || item.done).length,
        observation: { standingCount: inSquareCount(facts), held: facts.hold().active, now } };
    }
    const decision = decideJoin(facts, participant, now);
    if (decision.joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(participant)} could not be joined`);
    const stored = facts.land(decision.joinAct);
    const seat = facts.seat(decision.joinedName);
    if (seat === undefined) throw new SquareError('invalid_args', 'The join activity did not establish its artifact seat.');
    return { name: decision.joinedName, seat, stored, reconnected: false,
      participantCount: facts.roster().filter(item => item.joined || item.done).length,
      observation: { standingCount: inSquareCount(facts), held: facts.hold().active, now } };
  }, control?.signal)).value;
  await publishCommittedIdentity(square);
  return { name: committed.name, seat: committed.seat,
    activity: committed.stored === null ? null : toPublicActivity(committed.stored),
    participantCount: committed.participantCount, reconnected: committed.reconnected, observation: committed.observation };
}

/** A takeover retires the old generation and establishes its replacement atomically. */
export async function takeover(square: OperationContext, name: string, control?: OperationControl): Promise<{ readonly name: string; readonly seat: Seat; readonly activities: readonly Activity[]; readonly participantCount: number; readonly observation: LandingContext }> {
  throwIfAborted(control);
  validateName(name);
  const body = requireBody(square), now = square.clock();
  const initial = (await square.artifact.read(facts => {
    const participant = resolveKnownName(facts, name);
    return { participant, state: facts.participant(participant), seat: facts.seat(participant) };
  }, control?.signal)).value;
  if (!initial.state?.joined || initial.seat === undefined) throw new SquareError('already_done', `${participantIdentity(initial.participant)} is not standing here to take over`);
  const authority = { kind: 'takeover' as const, participant: initial.participant, body,
    expectedGeneration: initial.seat.generation,
    ...(square.wakeAddress === undefined ? {} : { wakeAddress: square.wakeAddress }) };
  const committed = (await square.artifact.transactAs(authority, facts => {
    const participant = resolveKnownName(facts, initial.participant);
    if (!facts.participant(participant)?.joined) throw new SquareError('already_done', `${participantIdentity(participant)} is no longer standing here`);
    const doneAct = facts.land(coreDone(facts, participant, '', now));
    const decision = decideJoin(facts, participant, now);
    if (decision.joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(participant)} could not be reclaimed`);
    const joinAct = facts.land(decision.joinAct);
    const seat = facts.seat(participant);
    if (seat === undefined) throw new SquareError('invalid_args', 'The replacement join did not establish its artifact seat.');
    return { name: participant, seat, stored: [doneAct, joinAct], participantCount: facts.roster().filter(item => item.joined || item.done).length,
      observation: { standingCount: inSquareCount(facts), held: facts.hold().active, now } };
  }, control?.signal)).value;
  await publishCommittedIdentity(square);
  return { name: committed.name, seat: committed.seat, activities: committed.stored.map(toPublicActivity),
    participantCount: committed.participantCount, observation: committed.observation };
}

export async function implicitJoin(square: OperationContext, name: string, control?: OperationControl): Promise<{ readonly name: string; readonly state: 'joined' | 'active' | 'done'; readonly activity: Activity | null; readonly seat?: Seat }> {
  throwIfAborted(control);
  validateName(name);
  const body = requireBody(square), now = square.clock();
  const committed = (await square.artifact.transactAs({ kind: 'join', participant: name, body, wakeAddress: square.wakeAddress }, facts => {
    const decision = decideImplicitJoin(facts, name, now);
    if (decision.joinAct === undefined) {
      const seat = facts.seat(decision.joinedName);
      if (decision.state === 'active' && (seat === undefined || !sameBody(seat.body, body)))
        throw new SquareError('already_joined', `${participantIdentity(decision.joinedName)} is held by another body`);
      if (decision.state === 'active' && square.wakeAddress !== undefined)
        facts.updateWakeAddress(asSeatRef(seat!), square.wakeAddress);
      return { name: decision.joinedName, state: decision.state, stored: null as StoredAct | null,
        ...(decision.state === 'active' && seat !== undefined ? { seat: facts.seat(decision.joinedName) } : {}) };
    }
    const stored = facts.land(decision.joinAct);
    const seat = facts.seat(decision.joinedName);
    if (seat === undefined) throw new SquareError('invalid_args', 'The implicit join did not establish its artifact seat.');
    return { name: decision.joinedName, state: decision.state, stored, seat };
  }, control?.signal)).value;
  if (committed.seat !== undefined) await publishCommittedIdentity(square);
  return { name: committed.name, state: committed.state,
    activity: committed.stored === null ? null : toPublicActivity(committed.stored),
    ...(committed.seat === undefined ? {} : { seat: committed.seat }) };
}

function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true }; throw error; }
}
export interface ExpressCommittedResult extends Omit<ExpressResult, 'waited' | 'observation'> { readonly observation: ExpressionObservation; }
export async function express(square: OperationContext, name: string, body: string, options: ExpressOptions = {}, control?: OperationControl): Promise<ExpressCommittedResult> {
  throwIfAborted(control);
  const seat = requireSeat(square, name);
  throwIfAborted(control);
  const now = square.clock();
  const reply = rejectUnsentActivity(() => {
    try { return options.reply === undefined ? undefined : parseRequiredActivityId(options.reply); }
    catch (error) {
      if (isSquareError(error)) error.facts = {
        ...error.facts, reason: 'invalid_reply', activityId: options.reply,
      };
      throw error;
    }
  });
  const committed = (await square.artifact.transactAs(participantAuthority(seat), (facts) => {
    // Selected-row decoding is storage work, not evidence that admission safely refused.
    const proposed = decideAct(facts, { name, body, force: options.force ?? false, now, mentions: options.mentions,
      ...(options.reach === undefined ? {} : { reach: options.reach }), ...(options.noMention === undefined ? {} : { noMention: options.noMention }), ...(reply === undefined ? {} : { reply }) });
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
      ...(decision.unmatchedMentions === undefined ? {} : { unmatchedMentions: decision.unmatchedMentions }),
      ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }),
    };
  }, control?.signal)).value;
  await publishCommittedIdentity(square);
  const delivery = square.wakeTransport !== undefined && square.location !== undefined && square.location !== 'memory'
    ? await deliverPending({ artifact: square.artifact, transport: square.wakeTransport, location: square.location, activity: committed.stored.index, now })
      .catch(() => ({ attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 }))
    : { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 };
  const { stored, observation, ...metadata } = committed;
  return { activity: toPublicActivity(stored), delivery, observation, ...metadata };
}

export interface ListenerCommittedResult {
  readonly activity: Activity | null;
  readonly observation: LandingContext;
}
async function landListenerChange(square: OperationContext, verb: 'listen' | 'ignore' | 'unlisten', actor: string, target: string, control?: OperationControl): Promise<ListenerCommittedResult> {
  throwIfAborted(control);
  const seat = requireSeat(square, actor);
  const now = square.clock();
  const committed = (await square.artifact.transactAs(participantAuthority(seat), (facts) => {
    const act = verb === 'listen' ? coreListen(facts, actor, target, now) : verb === 'ignore' ? coreIgnore(facts, actor, target, now) : coreUnlisten(facts, actor, target, now);
    const stored = act === undefined ? null : facts.land(act);
    return { stored, observation: { standingCount: inSquareCount(facts), held: facts.hold().active, now } };
  }, control?.signal)).value;
  return { activity: committed.stored === null ? null : toPublicActivity(committed.stored), observation: committed.observation };
}
export function listen(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerCommittedResult> { return landListenerChange(square, 'listen', actor, target, control); }
export function ignore(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerCommittedResult> { return landListenerChange(square, 'ignore', actor, target, control); }
export function unlisten(square: OperationContext, actor: string, target: string, control?: OperationControl): Promise<ListenerCommittedResult> { return landListenerChange(square, 'unlisten', actor, target, control); }
export async function listening(square: OperationContext, actor: string, control?: OperationControl): Promise<readonly string[]> { return (await square.artifact.read((facts) => coreListening(facts, actor), control?.signal)).value; }

export interface LifecycleCommittedResult extends ActivityResult {
  readonly observation: LandingContext & { readonly activity: StoredAct };
}
async function landCore(square: OperationContext, verb: 'done' | 'hold' | 'resume', actor: string, body = '', control?: OperationControl): Promise<LifecycleCommittedResult> {
  if (verb === 'done') validateDoneBody(body);
  const seat = requireSeat(square, actor), now = square.clock();
  const stored = (await square.artifact.transactAs(participantAuthority(seat), facts => {
    const result = facts.land(verb === 'done' ? coreDone(facts, actor, body, now) : verb === 'hold' ? coreHold(facts, actor, body, now) : coreResume(facts, actor, now));
    return { activity: toPublicActivity(result), observation: {
      activity: result, standingCount: inSquareCount(facts), held: facts.hold().active, now,
    } };
  }, control?.signal)).value;
  return stored;
}
export function done(square: OperationContext, name: string, body = '', control?: OperationControl): Promise<LifecycleCommittedResult> { return landCore(square, 'done', name, body, control); }

export async function endOwnedSession(square: OperationContext, name: string, sessionId: string, expectedGeneration?: import('./square-core.js').ActivityId, body?: import('./model.js').Body): Promise<ActivityResult | null> {
  const captured = (await square.artifact.read(facts => facts.seat(name))).value;
  if (captured === undefined || captured.body.session !== sessionId || (body !== undefined && !sameBody(captured.body, body))
    || (expectedGeneration !== undefined && captured.generation !== expectedGeneration)) return null;
  const stored = (await square.artifact.transactAs({ kind: 'participant', seat: asSeatRef(captured) }, facts => {
    const current = facts.seat(name);
    if (current === undefined || current.generation !== captured.generation || !sameBody(current.body, captured.body)) return null;
    const activity = facts.land(coreDone(facts, current.participant, '', square.clock()));
    return activity;
  })).value;
  return stored === null ? null : { activity: toPublicActivity(stored) };
}

export function hold(square: OperationContext, name: string, reason = '', control?: OperationControl): Promise<LifecycleCommittedResult> { return landCore(square, 'hold', name, reason, control); }
export function resume(square: OperationContext, name: string, control?: OperationControl): Promise<LifecycleCommittedResult> { return landCore(square, 'resume', name, '', control); }
