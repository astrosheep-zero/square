import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { SquareError, isSquareError, nameKey, validateName, type WatchOptions } from './model.js';
import { resolveKnownName, validateDoneBody } from './decisions.js';
import { HELD_WAIT_BUDGET_MS, WATCH_HEARTBEAT_MS, inSquareCount, presenceAnchor } from './runtime.js';
import { catchLimit, observeCatchSelection, type CatchSelection } from './catch-decisions.js';
import { directedSuffix } from './activity-feed.js';
import { assertLiveOwner } from './participant-host.js';
import type { WakeTransportPort } from './ports.js';
import { buildMemorySquare, openSquare, closeOpenSquare, type OpenSquare } from './open-square.js';
import { catchUp, done, endOwnedSession, express, hold, ignore, implicitJoin, join, takeover, listen, listening, unlisten, resume, retireEndedSessionRoutes, type ExpressCommittedResult } from './square-actions.js';
import { recoveryObservation, currentParticipant, entryPresentation, resolveParticipant, snapshot, queryStatus,
  queryParticipants, catchPresence, toPublicActivity, publicActivities, selectHistory, NON_READ,
  HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
import { hasAutomaticDeliveryIdentity, hostLedgerForEnv, localParticipantName, localSessionIdentities, presenceEpoch, readParticipantOwner } from './registry.js';
import { projectSessionBindings } from './square-projections.js';
import { sessionIdsFromEnvironment } from './participant-identity.js';
import { createDefaultWakeTransport } from './notifications.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from './wakes.js';
import { createSquare, diagnoseSquareFile } from './artifact.js';
import { migrateSquareFile } from './square-migration.js';
import { discoverSquares } from './list.js';
import { streamSquare } from './stream.js';
import type {
  ActivityResult, OperationFailureDetail, OperationError, CatchOptions, CatchResult, CatchStopStatus,
  ExpressOptions, ExpressResult, HistoryQuery, HistoryResult, JoinOptions, JoinResult, ListenerChangeResult,
  ListeningResult, LifecycleResult, ObservationOptions, OperationControl, Participant, SquareAtInput,
  SquareBuildInput, SquareObservation, SquareLocation, StatusOptions, StatusResult, ParticipantsResult,
  RecoveryResult, DiscoveryOptions, InboxOptions, InboxResult, StreamOptions,
} from './square-facade.js';

export type * from './square-facade.js';
export { createSquareResourceOwner } from './open-square.js';
export { formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
export { CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT } from './catch-decisions.js';
export { HELD_WAIT_BUDGET_MS } from './runtime.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
export { DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './list.js';

export function squareLocation(input: SquareLocation): string {
  const selected = input.path ?? (input.env ?? process.env).SQUARE_LOCATION;
  if (selected === undefined || selected.trim() === '')
    throw new SquareError('invalid_args', 'Square needs a location');
  return path.resolve(input.cwd ?? process.cwd(), selected);
}

function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted)
    throw control.signal.reason ?? new Error('Square operation was cancelled');
}

export function squareClock(env: NodeJS.ProcessEnv, clock?: () => number): () => number {
  if (clock !== undefined)
    return clock;
  if (env.SQUARE_NOW_MS === undefined)
    return Date.now;
  return () => {
    const value = Number.parseInt(env.SQUARE_NOW_MS!, 10);
    if (!Number.isFinite(value))
      throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
    return value;
  };
}

function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}

function defaultTransport(square: OpenSquare): () => Promise<WakeTransportPort | undefined> {
  let transport: Promise<WakeTransportPort | undefined> | undefined;
  return () => transport ??= square.wakeTransport !== undefined ? Promise.resolve(square.wakeTransport)
    : square.location === 'memory' || square.hostLedger === undefined ? Promise.resolve(undefined)
      : createDefaultWakeTransport(square.hostLedger, square.clock, square.env).catch(() => undefined);
}

function observedContext(square: OpenSquare, standingCount: number, held: boolean, participant?: string, now = square.clock()): SquareObservation {
  return { location: square.location, standingCount, held, now,
    ...(participant === undefined ? {} : { participant }), automaticDeliveryAvailable: hasAutomaticDeliveryIdentity(square.env) };
}

async function contextObservation(square: OpenSquare, participant?: string, control?: OperationControl): Promise<SquareObservation> {
  const observation = (await square.artifact.read((facts) => ({ standingCount: inSquareCount(facts), held: facts.hold().active }), control?.signal)).value;
  return observedContext(square, observation.standingCount, observation.held, participant);
}

async function prepareExpression(square: OpenSquare, requested: string, control?: OperationControl) {
  try {
    checkControl(control);
    const result = await join(square, requested, control, { requireKnown: true });
    return { participant: result.name, activity: result.activity };
  }
  catch (error) {
    throw failure(error, { operation: 'express', subject: 'caller', participant: requested, expressEffect: 'unsent' });
  }
}

/** One retry/commit owner for every participant, regardless of transport. */
async function landExpression(square: OpenSquare, name: string, body: string, options: ExpressOptions, transport: () => Promise<WakeTransportPort | undefined>, control?: OperationControl): Promise<ExpressCommittedResult & {
  readonly waited: boolean;
}> {
  let effect: 'unsent' | 'unknown' = 'unsent';
  let waited = false, heldWaitedMs = 0;
  try {
    const wakeTransport = await transport();
    while (true) {
      checkControl(control);
      try {
        effect = 'unknown';
        return { ...await express({ ...square, wakeTransport }, name, body, options, control), waited };
      }
      catch (error) {
        if (isSquareError(error) && error.facts?.activityUnsent === true)
          effect = 'unsent';
        if (!isSquareError(error) || options.noWait || (error.code !== 'held' && error.code !== 'throttled'))
          throw error;
        if (error.code === 'held' && heldWaitedMs >= HELD_WAIT_BUDGET_MS)
          throw error;
        waited = true;
        control?.onProgress?.({ kind: 'waiting', reason: error.code,
          ...(error.code === 'throttled' ? { delayMs: error.facts?.retryAfterMs ?? 1 } : {}),
          ...(error.facts?.holder === undefined ? {} : { holder: error.facts.holder }),
          ...(error.facts?.holdReason === undefined ? {} : { holdReason: error.facts.holdReason }),
        });
        if (error.code === 'throttled')
          await sleep(error.facts?.retryAfterMs ?? 1, undefined, { signal: control?.signal });
        else {
          const started = Date.now();
          const observation = await square.artifact.read((facts) => facts.hold().active, control?.signal);
          if (observation.value)
            await square.artifact.changed(observation.version, Math.max(1, HELD_WAIT_BUDGET_MS - heldWaitedMs), control?.signal);
          heldWaitedMs += Date.now() - started;
        }
      }
    }
  }
  catch (error) {
    const recipient = isSquareError(error) && ['not_standing', 'bell_mention_conflict'].includes(error.facts?.reason ?? '');
    throw failure(error, { operation: 'express', participant: name, subject: recipient ? 'recipient' : 'caller', expressEffect: effect });
  }
}

interface CatchCompletion {
  readonly selection: CatchSelection;
  readonly stop: CatchStopStatus | undefined;
  readonly waitStarted: boolean;
  readonly replaced: boolean;
}

/** Leases, quiet waiting and receipt selection share one lifecycle. */
async function catchOwned(square: OpenSquare, requested: string, options: CatchOptions = {}, control?: OperationControl): Promise<CatchCompletion> {
  let name = requested, subject: 'caller' | 'filter' = 'caller';
  let leaseId: string | undefined;
  let waitStarted = false, replaced = false;
  let selection = options;
  const idle = options.idle ?? 0;
  async function complete(caught: CatchSelection | undefined, stop?: CatchStopStatus): Promise<CatchCompletion> {
    const selected = caught ?? (await square.artifact.read((facts) => observeCatchSelection(facts, name, [], {
      unseenOnly: true, senders: selection.from, ...(selection.mention === true ? { attentionOnly: true } : {}),
    }, square.clock()))).value;
    const terminal = stop === 'empty-now' || stop === undefined ? selected.terminalStatus ?? stop : stop;
    if (leaseId !== undefined) {
      await releaseWatchLease(square, name, leaseId).catch(() => undefined);
      leaseId = undefined;
    }
    return { selection: selected, stop: terminal, waitStarted, replaced };
  }
  const empty = (stop: CatchStopStatus) => complete(undefined, stop);
  try {
    checkControl(control);
    if (!Number.isFinite(idle) || idle < 0)
      throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
    if (options.id !== undefined && ['idle', 'from', 'mention', 'limit', 'replace'].some((key) => Object.hasOwn(options, key)))
      throw new SquareError('invalid_args', 'Catch id cannot be combined with idle, from, mention, limit or replace');
    if (Object.hasOwn(options, 'replace') && idle === 0)
      throw new SquareError('invalid_args', 'Catch replacement requires a positive idle duration');
    catchLimit(options.limit);
    const from = (await square.artifact.read((facts) => {
      name = resolveKnownName(facts, requested);
      subject = 'filter';
      return options.from?.map((target) => resolveKnownName(facts, target));
    }, control?.signal)).value;
    selection = { ...options, ...(from === undefined ? {} : { from }) };
    subject = 'caller';
    if (idle === 0) {
      const data = await catchUp(square, name, selection, control);
      return await complete(data, data.activities.length === 0 ? 'empty-now' : undefined);
    }
    if (!await assertLiveOwner(square, name))
      throw new SquareError('already_joined', `${name} already stands here — another session holds the name`);
    const watch: WatchOptions = {
      ...(from === undefined ? {} : { participants: [...from] }), ...(options.mention ? { mention: name } : {}),
      ...(options.replace === undefined ? {} : { replace: options.replace }),
    };
    const start = await acquireWatchLease(square, name, crypto.randomUUID(), watch, control?.signal);
    if (start.type === 'active')
      return await empty('already-active');
    leaseId = start.leaseId;
    waitStarted = true;
    replaced = start.replaced;
    control?.onProgress?.({ kind: 'catch-started', participant: name, idleMs: idle, replacementRequested: options.replace ?? false, replaced });
    let quietSince = square.clock(), wasHeld = false, nextHeartbeat = start.heartbeatAt + WATCH_HEARTBEAT_MS;
    while (true) {
      checkControl(control);
      // Capture before evaluation so a commit during selection cannot be missed.
      const baseline = await square.artifact.revision(control?.signal);
      const pulse = await pulseWatchLease(square, name, leaseId, watch, square.clock() >= nextHeartbeat, control?.signal);
      if (pulse.type === 'replaced')
        return await empty('replaced');
      if (pulse.type === 'terminal')
        return await empty(pulse.status);
      if (pulse.heartbeatAt !== undefined)
        nextHeartbeat = pulse.heartbeatAt + WATCH_HEARTBEAT_MS;
      if (pulse.type === 'sleep') {
        const caught = await catchUp(square, name, selection, control, leaseId);
        if (caught === null)
          return await empty('replaced');
        if (caught.activities.length > 0)
          return await complete(caught);
      }
      if (pulse.type === 'held' || wasHeld)
        quietSince = square.clock();
      wasHeld = pulse.type === 'held';
      if (!wasHeld && square.clock() - quietSince >= idle) {
        const owns = await ownsWatchLease(square, name, leaseId, control?.signal);
        return await empty(owns ? 'stale' : 'replaced');
      }
      const deadline = Math.min(nextHeartbeat, wasHeld ? Infinity : quietSince + idle);
      await square.artifact.changed(baseline, Math.max(0, deadline - square.clock()), control?.signal);
    }
  }
  catch (error) {
    throw failure(error, { operation: 'catch', subject, participant: name });
  }
  finally {
    // An aborted request still releases its own lease, never its replacement's.
    if (leaseId !== undefined)
      await releaseWatchLease(square, name, leaseId).catch(() => undefined);
  }
}

class ParticipantHandle implements Participant {
  constructor(readonly name: string, private readonly owner: Square, private readonly square: OpenSquare, private readonly transport: () => Promise<WakeTransportPort | undefined>) { }
  async express(body: string, options: ExpressOptions = {}, control?: OperationControl): Promise<ExpressResult> {
    const entry = await prepareExpression(this.square, this.name, control);
    const name = entry.participant;
    let result: (ExpressCommittedResult & {
      readonly waited: boolean;
    }) | undefined;
    try {
      const feed = !options.observe ? undefined : (await this.square.artifact.read((facts) => {
        const pendingPublic = directedSuffix(facts, name);
        return { pendingPublic, sayNumbers: facts.sayOrdinals(pendingPublic.map((item) => item.index)),
          perceptions: Object.fromEntries(pendingPublic.map((item) => [item.index, 'full' as const])) };
      }, control?.signal)).value;
      result = await landExpression(this.square, name, body, options, this.transport, control);
      const { observation: committed, ...data } = result;
      return { ...data, ...(feed === undefined ? {} : { observation: {
            ...observedContext(this.square, committed.standingCount, committed.held, name, committed.now), ...committed, ...feed, participant: name,
            ...(entry.activity === null ? {} : { reentry: entry.activity }),
          } }) };
    }
    catch (error) {
      if (result === undefined && (error as OperationError)?.operation?.operation === 'express')
        throw error;
      throw failure(error, { operation: 'express', participant: name, subject: 'caller', expressEffect: result === undefined ? 'unsent' : 'landed',
        ...(result === undefined ? {} : { landedId: result.activity.id }) });
    }
  }
  private async listener(verb: 'listen' | 'ignore' | 'unlisten', target: string, options: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult> {
    const name = (await resolveParticipant(this.square, this.name, control)).name;
    const { observation: committed, ...result } = await (verb === 'listen' ? listen : verb === 'ignore' ? ignore : unlisten)(this.square, name, target, control);
    return { ...result, ...(!options.observe ? {} : { observation: {
          ...observedContext(this.square, committed.standingCount, committed.held, name, committed.now),
          participant: name, requestedTarget: target, target: result.activity?.target ?? target,
        } }) };
  }
  listen(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('listen', target, options, control); }
  ignore(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('ignore', target, options, control); }
  unlisten(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('unlisten', target, options, control); }
  async listening(options: ObservationOptions = {}, control?: OperationControl): Promise<ListeningResult> {
    const name = (await resolveParticipant(this.square, this.name, control)).name;
    return { listening: await listening(this.square, name, control),
      ...(!options.observe ? {} : { observation: await contextObservation(this.square, name, control) }) };
  }
  async catch(options: CatchOptions = {}, control?: OperationControl): Promise<CatchResult> {
    const result = await catchOwned(this.square, this.name, options, control), view = result.selection, stop = result.stop;
    const presence = !options.observe ? undefined : await catchPresence(this.square, control).catch(() => undefined);
    const status = stop === 'already-active' || stop === 'replaced' || stop === 'capped' || stop === 'quorum' ? stop : undefined;
    return { activities: view.activities.map((activity) => ({ ...toPublicActivity(activity), perception: 'full' as const })),
      consumedThrough: view.consumedThrough, remaining: view.remaining, idleExpired: stop === 'stale',
      ...(status === undefined ? {} : { status }), ...(!options.observe ? {} : { observation: {
          ...observedContext(this.square, view.standingCount, view.held, view.participant, view.now), participant: view.participant,
          sayNumbers: view.sayNumbers, ownActivityCount: view.ownActivityCount, hardCap: view.hardCap, stop,
          ...(presence === undefined ? { enrichmentUnavailable: true as const } : { presence }), waitStarted: result.waitStarted, replaced: result.replaced,
        } }) };
  }
  history(query?: HistoryQuery, control?: OperationControl) { return this.owner.history(query, control); }
  private async lifecycle(verb: 'done' | 'hold' | 'resume', body: string | undefined, options: ObservationOptions, control?: OperationControl): Promise<LifecycleResult> {
    if (verb === 'done')
      validateDoneBody(body);
    const identity = localSessionIdentities(this.square.env ?? {})[0];
    const owner = verb !== 'done' || identity === undefined || this.square.hostLedger === undefined ? undefined
      : await readParticipantOwner(this.square.location, this.name, this.square.hostLedger);
    const fenced = identity !== undefined && owner?.session === identity.sessionId && presenceEpoch(owner) > 0;
    const name = fenced ? this.name : (await join(this.square, this.name, control)).name;
    const result = verb === 'done' ? await done(this.square, name, body ?? '', fenced ? { expectedEpoch: presenceEpoch(owner) } : {}, control)
      : verb === 'hold' ? await hold(this.square, name, body, control) : await resume(this.square, name, control);
    const { observation: committed, ...receipt } = result;
    return { ...receipt, ...(!options.observe ? {} : { observation: {
          ...observedContext(this.square, committed.standingCount, committed.held, name, committed.now), ...committed,
        } }) };
  }
  hold(reason?: string, options: ObservationOptions = {}, control?: OperationControl) { return this.lifecycle('hold', reason, options, control); }
  resume(options: ObservationOptions = {}, control?: OperationControl) { return this.lifecycle('resume', undefined, options, control); }
  done(body?: string, options: ObservationOptions = {}, control?: OperationControl) { return this.lifecycle('done', body, options, control); }
}

/** One concrete square resource. Request handles may borrow a server-owned connection. */
export class Square {
  private readonly transport: () => Promise<WakeTransportPort | undefined>;
  private constructor(readonly location: string, private readonly square: OpenSquare, private readonly defaultParticipant?: string) { this.transport = defaultTransport(square); }
  static async at(input: SquareAtInput, control?: OperationControl): Promise<Square> {
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    return new Square(location, await openSquare(location, { ...input, env, clock: squareClock(env, input.clock), artifact: input.resources?.artifact(location) }, control), input.participant);
  }
  static async build(input: SquareBuildInput, control?: OperationControl): Promise<Square> {
    checkControl(control);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    await createSquare(location, { hardCap: input.hardCap, throttlePerMinute: input.throttlePerMinute,
      template: input.template, force: input.force ?? false }, input.markdown, control?.signal);
    // A completed build survives cancellation arriving after its commit.
    return Square.at({ ...input, path: location, env });
  }
  static inMemory(input: Omit<SquareBuildInput, 'path' | 'resources'>): Square {
    const env = { ...(input.env ?? process.env) };
    return new Square('memory', buildMemorySquare({ ...input, env, clock: squareClock(env, input.clock) }), input.participant);
  }
  private handle(name: string): Participant { return new ParticipantHandle(name, this, this.square, this.transport); }
  async participant(requested?: string): Promise<Participant> {
    const selected = requested ?? this.defaultParticipant ?? this.square.env?.SQUARE_PARTICIPANT_NAME;
    if (requested !== undefined || this.defaultParticipant !== undefined || selected?.trim()) {
      validateName(selected!);
      return this.handle(selected!);
    }
    const discovered = this.square.hostLedger === undefined ? undefined : await localParticipantName(this.location, this.square.hostLedger, this.square.env);
    if (discovered !== undefined)
      return this.handle(discovered);
    throw new SquareError('invalid_args', 'Square needs one unambiguous participant name');
  }
  async join(requested?: string, options: JoinOptions = {}, control?: OperationControl): Promise<JoinResult> {
    let name = requested;
    try {
      checkControl(control);
      name = (await this.participant(requested)).name;
      const last = options.last ?? HISTORY_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(last) || last < 1 || last > HISTORY_MAX_LIMIT)
        throw new SquareError('invalid_args', 'Join history limit must be between 1 and 100');
      let committed: {
        standingCount: number;
        held: boolean;
        now: number;
      };
      let result: Omit<JoinResult, 'participant'> & {
        participant: string;
      };
      if (options.takeover && await currentParticipant(this.square, name, control) !== undefined) {
        const taken = await takeover(this.square, name, control);
        result = { participant: taken.name, activity: taken.activities.at(-1) ?? null, kind: 'taken-over', participantCount: taken.participantCount };
        committed = taken.observation;
      }
      else {
        const joined = await join(this.square, name, control);
        result = { participant: joined.name, activity: joined.activity, kind: joined.reconnected ? 'reconnected' : 'joined', participantCount: joined.participantCount };
        committed = joined.observation;
      }
      const entry = !options.observe ? undefined : await entryPresentation(this.square, result.participant, last, control).catch(() => undefined);
      return { ...result, participant: this.handle(result.participant), ...(!options.observe ? {} : {
          observation: {
            ...observedContext(this.square, committed.standingCount, committed.held, result.participant, committed.now),
            ...(entry === undefined ? { enrichmentUnavailable: true as const } : { entry }),
          },
        }) };
    }
    catch (error) {
      throw failure(error, { operation: 'join', subject: 'caller', participant: name });
    }
  }
  doneOwnedSession(name: string, body: string, expectedEpoch: number, control?: OperationControl): Promise<ActivityResult> { return done(this.square, name, body, { expectedEpoch }, control); }
  async implicitJoin(name: string, control?: OperationControl): Promise<{
    readonly state: 'joined' | 'active' | 'done';
    readonly participant?: Participant;
  }> {
    const result = await implicitJoin(this.square, name, control);
    return { state: result.state, ...(result.state === 'done' ? {} : { participant: this.handle(result.name) }) };
  }
  snapshot(control?: OperationControl) { return snapshot(this.square, control); }
  async history(query: HistoryQuery = {}, control?: OperationControl): Promise<HistoryResult> {
    if (query.limit !== undefined && query.limit !== null && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > HISTORY_MAX_LIMIT))
      throw new SquareError('invalid_args', `History limit must be a positive integer no greater than ${HISTORY_MAX_LIMIT}`);
    if (query.grep !== undefined && query.fixed !== undefined)
      throw new SquareError('invalid_args', 'History cannot combine regular-expression and literal search');
    if (query.grep === '' || query.fixed === '')
      throw new SquareError('invalid_args', 'History search requires non-empty text');
    if (query.since !== undefined && !Number.isFinite(query.since))
      throw new SquareError('invalid_args', 'History timestamp must be finite');
    for (const count of [query.contextBefore, query.contextAfter])
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
        throw new SquareError('invalid_args', 'History context must be a non-negative safe integer');
    const limit = query.limit === undefined ? (query.at?.length ? null : HISTORY_DEFAULT_LIMIT) : query.limit;
    const contextual = !!query.at?.length || query.contextBefore !== undefined || query.contextAfter !== undefined;
    const kinds = contextual || query.since !== undefined ? undefined : NON_READ;
    return (await this.square.artifact.read((facts) => {
      const selected = selectHistory(facts, query, limit, kinds, query.observe === true);
      if (contextual && limit === null && selected.totalMatches > HISTORY_MAX_LIMIT)
        throw failure(new SquareError('invalid_args', `History context exceeds ${HISTORY_MAX_LIMIT} activities`), { operation: 'history', historyBounds: { maxLimit: HISTORY_MAX_LIMIT, totalMatches: selected.totalMatches } });
      const activities = publicActivities(selected.activities);
      if (!query.observe)
        return { activities };
      const indexes = selected.activities.map((activity) => activity.index), presenceAnchors: Record<number, string[]> = {};
      for (const participant of facts.roster()) {
        const anchor = presenceAnchor(facts, participant.name);
        if (indexes.includes(anchor))
          (presenceAnchors[anchor] ??= []).push(participant.name);
      }
      return { activities, observation: { ...observedContext(this.square, inSquareCount(facts), facts.hold().active), ...selected,
          sayNumbers: facts.sayOrdinals(indexes), presenceAnchors } };
    }, control?.signal)).value;
  }
  async status(options: StatusOptions = {}, control?: OperationControl): Promise<StatusResult> {
    const viewer = !options.observe ? '' : options.viewer ?? (await this.participant().catch(() => undefined))?.name ?? '';
    return (await this.square.artifact.read((facts) => queryStatus(facts, {
      location: this.location, now: this.square.clock(), automaticDeliveryAvailable: hasAutomaticDeliveryIdentity(this.square.env),
    }, viewer, options.observe === true), control?.signal)).value;
  }
  async participants(options: ObservationOptions = {}, control?: OperationControl): Promise<ParticipantsResult> {
    return (await this.square.artifact.read((facts) => queryParticipants(facts, {
      location: this.location, now: this.square.clock(), automaticDeliveryAvailable: hasAutomaticDeliveryIdentity(this.square.env),
    }, options.observe === true), control?.signal)).value;
  }
  async recovery(requested?: string, control?: OperationControl): Promise<RecoveryResult> {
    const name = (await this.participant(requested).catch(() => undefined))?.name;
    const facts = name === undefined ? undefined : await recoveryObservation(this.square, name, control).catch(() => undefined);
    return facts ?? await contextObservation(this.square, name, control);
  }
  stream(options: StreamOptions, control?: OperationControl) { return streamSquare(this.location, options, control, this.square); }
  async recognize(env: NodeJS.ProcessEnv): Promise<Participant | null> {
    if (this.square.hostLedger === undefined)
      return null;
    const candidates = (await Promise.all(sessionIdsFromEnvironment(env).map((sessionId) => projectSessionBindings({ hostLedger: this.square.hostLedger!, location: this.location, sessionId })))).flat();
    if (candidates.length !== 1)
      return null;
    const name = await currentParticipant(this.square, candidates[0].participant);
    return name === undefined ? null : this.handle(name);
  }
  close(): Promise<void> { return closeOpenSquare(this.square); }
  endOwnedSession(name: string, sessionId: string, expectedEpoch?: number) { return endOwnedSession(this.square, name, sessionId, expectedEpoch); }
  retireEndedSessionRoutes(sessionId: string): Promise<void> { return retireEndedSessionRoutes(this.square, sessionId); }
}

export function diagnoseSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); return diagnoseSquareFile(squareLocation(input)); }
export function migrateSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); return migrateSquareFile(squareLocation(input), control?.signal); }
export function discover(input: SquareAtInput, options: DiscoveryOptions = {}, control?: OperationControl) {
  const env = { ...(input.env ?? process.env) };
  return discoverSquares(input.cwd ?? process.cwd(), options, control, { ...input, env, clock: squareClock(env, input.clock) });
}
export async function inbox(input: SquareAtInput, sessionId: string, options: InboxOptions = {}, control?: OperationControl): Promise<InboxResult> {
  checkControl(control);
  const env = { ...(input.env ?? process.env) }, hostLedger = input.hostLedger ?? hostLedgerForEnv(env), limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new SquareError('invalid_args', 'Inbox limit must be between 1 and 100');
  const rows: {
    name: string;
    squarePath: string;
    pending: number;
  }[] = [];
  for (const binding of await projectSessionBindings({ hostLedger, sessionId })) {
    checkControl(control);
    let square: OpenSquare | undefined;
    try {
      square = await openSquare(binding.location, { ...input, env, hostLedger, clock: squareClock(env, input.clock) }, control);
      const row = (await square.artifact.read((facts) => {
        const participant = facts.participant(binding.participant);
        return !participant?.joined ? undefined : { name: participant.name, squarePath: binding.location,
          pending: facts.directedCount(participant.name, { unseenOnly: true }) };
      }, control?.signal)).value;
      if (row !== undefined)
        rows.push(row);
    }
    catch (error) {
      if (control?.signal?.aborted)
        throw error;
    }
    finally {
      if (square !== undefined)
        await closeOpenSquare(square);
    }
  }
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  rows.sort((a, b) => compare(a.squarePath, b.squarePath) || compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name));
  return { rows: rows.slice(0, limit), total: rows.length };
}
