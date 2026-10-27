import { formatActivityId } from './square-core.js';
import { validateMetadataMatch, validateDeferralDuration, validateDeferralId } from './delivery-deferral.js';
import type { MetadataMatch, DeliveryDeferral } from './delivery-deferral.js';
import { squareLocation, localSquareLocation } from './square-location.js';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { InternalSquareError, SquareError, isSquareError, nameKey, sameBody, validateName, type Body, type Seat, type WakeAddress, type WatchOptions } from './model.js';
import { coreDone, coreHold, coreIgnore, coreListen, coreListening, coreResume, coreUnlisten, decideAct, decideImplicitJoin, decideJoin, resolveKnownName, validateDoneBody } from './decisions.js';
import { HELD_WAIT_BUDGET_MS, WATCH_HEARTBEAT_MS, inSquareCount, presenceAnchor } from './runtime.js';
import { catchLimit, decideCatch, observeCatchSelection, selectCatchPage, type CatchSelection } from './catch-decisions.js';
import { directedSuffix } from './activity-feed.js';
import { expressHint } from './hints.js';
import { asSeatRef, participantAuthority, requireBody, requireJoinName, requireSeat } from './seats.js';
import { recoveryObservation, entryPresentation, snapshot, queryStatus, queryParticipants, catchPresence,
  parseRequiredActivityId, toPublicActivity, publicActivities, selectHistory, NON_READ, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
import { sessionInboxCounts } from './inbox.js';
import { rememberSquarePath, squareIndexPath } from './square-index.js';
import { createDefaultWakeTransport } from './notifications.js';
import { deliverPending } from './delivery-operations.js';
import { participantIdentity } from './participant-identity.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from './wakes.js';
import { createArtifactPort, createSquare, diagnoseSquareFile, prepareSquareBuild } from './artifact.js';
import type { SquareArtifactPort, WakeTransportPort } from './ports.js';
import { migrateSquareFile } from './square-migration.js';
import { discoverSquares } from './list.js';
import { streamSquare } from './stream.js';
import type {
  ActivityResult, OperationFailureDetail, CatchOptions, CatchResult, CatchStopStatus,
  ExpressOptions, ExpressResult, HistoryQuery, HistoryResult, JoinOptions, JoinResult, ListenerChangeResult,
  ListeningResult, LifecycleResult, ObservationOptions, OperationControl, Participant, SquareAtInput,
  SquareBuildInput, SquareObservation, SquareLocation, StatusOptions, StatusResult, ParticipantsResult,
  RecoveryResult, DiscoveryOptions, InboxOptions, InboxResult, StreamOptions, ExpressInput,
} from './square-facade.js';

export type * from './square-facade.js';
export { createSquareResourceOwner } from './artifact.js';
export { formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
export { CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT } from './catch-decisions.js';
export { HELD_WAIT_BUDGET_MS } from './runtime.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
export { DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './list.js';

function checkControl(control?: OperationControl): void {
  if (control?.signal?.aborted)
    throw control.signal.reason ?? new Error('Square operation was cancelled');
}

export function squareClock(env: NodeJS.ProcessEnv, clock?: () => number): () => number {
  if (clock !== undefined) return clock;
  if (env.SQUARE_NOW_MS === undefined) return Date.now;
  const value = Number.parseInt(env.SQUARE_NOW_MS, 10);
  if (!Number.isFinite(value)) throw new SquareError('invalid_args', 'Invalid SQUARE_NOW_MS: expected integer milliseconds.');
  return () => value;
}

function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}

function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true }; throw error; }
}

/** A generic managed address must not displace the receiver's native registration on reconnect. */
function canRefreshWakeAddress(current: WakeAddress | undefined, proposed: WakeAddress): boolean {
  return proposed.kind !== 'paseo' || current === undefined || current.kind === 'paseo';
}

/** One concrete local resource, including its entry-resolved dependencies and lifetime. */
export class SqliteSquare {
  private constructor(
    readonly location: string,
    private readonly artifact: SquareArtifactPort,
    private readonly clock: () => number,
    private readonly body?: Body,
    private readonly wakeAddress?: WakeAddress,
    private readonly wakeTransport?: WakeTransportPort,
    private readonly indexPath?: string,
    private readonly automaticDelivery = true,
    private readonly ownsArtifact = true,
    private readonly defaultParticipant?: string,
  ) { }

  static async at(input: SquareAtInput, control?: OperationControl, automaticDelivery = true): Promise<SqliteSquare> {
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    const clock = squareClock(env, input.clock);
    const wakeTransport = input.wakeTransport ?? (automaticDelivery
      ? await createDefaultWakeTransport(env).catch(() => undefined) : undefined);
    // A request can abort its own borrowed reads, never the owner's connection lifetime.
    const borrowed = input.resources?.artifact(location);
    const artifact = borrowed ?? createArtifactPort(location, undefined, control?.signal);
    try {
      await artifact.read(facts => facts.header(), control?.signal);
      const resource = new SqliteSquare(location, artifact, clock, input.body, input.wakeAddress,
        wakeTransport, squareIndexPath(env), automaticDelivery, borrowed === undefined, input.participant);
      await resource.publishIdentity();
      return resource;
    } catch (error) {
      if (borrowed === undefined) await artifact.close();
      if (error instanceof InternalSquareError && error.code === 'not_found')
        throw new SquareError('unavailable', `Square is unavailable at ${location}`);
      throw error;
    }
  }
  static async build(input: SquareBuildInput, control?: OperationControl, automaticDelivery = true): Promise<SqliteSquare> {
    checkControl(control);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    await createSquare(location, { hardCap: input.hardCap, throttlePerMinute: input.throttlePerMinute,
      template: input.template, force: input.force ?? false }, input.markdown, control?.signal);
    // Publication already committed; cancellation cannot erase the completed build.
    return SqliteSquare.at({ ...input, path: location, env }, undefined, automaticDelivery);
  }
  static inMemory(input: Omit<SquareBuildInput, 'path' | 'resources'>): SqliteSquare {
    const env = { ...(input.env ?? process.env) };
    return new SqliteSquare('memory', createArtifactPort(':memory:', prepareSquareBuild(input, input.markdown)),
      squareClock(env, input.clock), input.body, input.wakeAddress, input.wakeTransport, undefined, true, true, input.participant);
  }
  /** Discovery is best effort and never grants write authority. Finish it before returning. */
  private async publishIdentity(): Promise<void> {
    if (this.location !== 'memory' && this.body !== undefined && this.indexPath !== undefined)
      await rememberSquarePath(this.location, this.body, this.indexPath).catch(() => undefined);
  }
  private observation(standingCount: number, held: boolean, participant?: string, now = this.clock()): SquareObservation {
    return { location: this.location, standingCount, held, now,
      ...(participant === undefined ? {} : { participant }), automaticDeliveryAvailable: this.automaticDelivery && this.body !== undefined };
  }
  private async contextObservation(participant?: string, control?: OperationControl): Promise<SquareObservation> {
    return (await this.artifact.read(facts => this.observation(inSquareCount(facts), facts.hold().active, participant), control?.signal)).value;
  }
  private handle(name: string, seat?: Seat): Participant { return new SqliteSquare.ParticipantHandle(name, this, seat); }

  // The nested handle can use its resource's private dependencies without widening
  // the concrete-derived backend contract or copying them into a second context.
  private static readonly ParticipantHandle = class implements Participant {
    constructor(readonly name: string, private readonly owner: SqliteSquare, private readonly seat?: Seat) { }

    async express(bodyOrInput: string | undefined | ExpressInput, optionsOrControl: ExpressOptions | OperationControl = {}, operationControl?: OperationControl): Promise<ExpressResult> {
      const square = this.owner;
      const input = typeof bodyOrInput === 'object' && bodyOrInput !== null ? bodyOrInput : undefined;
      const body: string | undefined = typeof bodyOrInput === 'string' || bodyOrInput === undefined ? bodyOrInput : bodyOrInput.body;
      const options = (input ?? optionsOrControl) as ExpressOptions;
      const control = input === undefined ? operationControl : optionsOrControl as OperationControl;
      let name = this.name, effect: 'unsent' | 'unknown' | 'landed' = 'unsent';
      let landedId: ExpressResult['activity']['id'] | undefined;
      let waited = false, heldWaitedMs = 0;
      try {
        checkControl(control);
        name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
        const seat = requireSeat(this.seat, square.body, name);
        const feed = !options.observe ? undefined : (await square.artifact.read(facts => {
          const pendingPublic = directedSuffix(facts, name);
          return { pendingPublic, sayNumbers: facts.sayOrdinals(pendingPublic.map(item => item.index)),
            perceptions: Object.fromEntries(pendingPublic.map(item => [item.index, 'full' as const])) };
        }, control?.signal)).value;
        while (true) {
          checkControl(control);
          try {
            effect = 'unknown';
            const now = square.clock();
            const reply = rejectUnsentActivity(() => {
              try { return options.reply === undefined ? undefined : parseRequiredActivityId(options.reply); }
              catch (error) {
                if (isSquareError(error)) error.facts = { ...error.facts, reason: 'invalid_reply', activityId: options.reply };
                throw error;
              }
            });
            const committed = (await square.artifact.transactAs(participantAuthority(seat), facts => {
              // Decoding selected rows is storage work, not proof of safe admission refusal.
              const proposed = decideAct(facts, { name, body, force: options.force ?? false, metadata: options.metadata, now, mentions: options.mentions,
                ...(options.reach === undefined ? {} : { reach: options.reach }), ...(options.noMention === undefined ? {} : { noMention: options.noMention }), ...(reply === undefined ? {} : { reply }) });
              const holder = proposed.type === 'held' ? facts.hold().actor : undefined;
              const decision = rejectUnsentActivity(() => {
                if (proposed.type === 'blocked') throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending: proposed.activitySummaries.reduce((count, summary) => count + summary.count, 0) });
                if (proposed.type === 'held') throw new SquareError('held', 'The square is held', { ...(holder === undefined ? {} : { holder }), ...(proposed.reason === undefined ? {} : { holdReason: proposed.reason }) });
                if (proposed.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
                if (proposed.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: proposed.delayMs });
                if (proposed.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, proposed.nextAt - now) });
                return proposed;
              });
              return { stored: facts.land(decision.act), standingCount: inSquareCount(facts), held: facts.hold().active,
                ownActivityCount: facts.participant(name)!.sayCount, hardCap: facts.header().hardCap,
                ...(decision.unmatchedMentions === undefined ? {} : { unmatchedMentions: decision.unmatchedMentions }),
                ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }) };
            }, control?.signal)).value;
            landedId = formatActivityId(committed.stored.index);
            effect = 'landed';
            await square.publishIdentity();
            const delivery = square.wakeTransport !== undefined && square.location !== 'memory'
              ? await deliverPending({ artifact: square.artifact, transport: square.wakeTransport, location: square.location, activity: committed.stored.index, now })
                .catch(() => ({ attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 }))
              : { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 };
            const { stored, standingCount, held, ownActivityCount, hardCap, ...metadata } = committed;
            const hint = expressHint(ownActivityCount);
            return { activity: toPublicActivity(stored), delivery, waited, ...metadata,
              ...(hint === undefined ? {} : { hint }), ...(feed === undefined ? {} : { observation: {
                ...square.observation(standingCount, held, name, now), ownActivityCount, hardCap, ...feed, participant: name,
              } }) };
          } catch (error) {
            if (effect !== 'landed' && isSquareError(error) && error.facts?.activityUnsent === true) effect = 'unsent';
            if (effect === 'landed' || !isSquareError(error) || options.noWait || (error.code !== 'held' && error.code !== 'throttled')) throw error;
            if (error.code === 'held' && heldWaitedMs >= HELD_WAIT_BUDGET_MS) throw error;
            waited = true;
            control?.onProgress?.({ kind: 'waiting', reason: error.code,
              ...(error.code === 'throttled' ? { delayMs: error.facts?.retryAfterMs ?? 1 } : {}),
              ...(error.facts?.holder === undefined ? {} : { holder: error.facts.holder }),
              ...(error.facts?.holdReason === undefined ? {} : { holdReason: error.facts.holdReason }) });
            if (error.code === 'throttled') await sleep(error.facts?.retryAfterMs ?? 1, undefined, { signal: control?.signal });
            else {
              const started = Date.now();
              const observation = await square.artifact.read(facts => facts.hold().active, control?.signal);
              if (observation.value) await square.artifact.changed(observation.version, Math.max(1, HELD_WAIT_BUDGET_MS - heldWaitedMs), control?.signal);
              heldWaitedMs += Date.now() - started;
            }
          }
        }
      } catch (error) {
        const recipient = isSquareError(error) && ['not_standing', 'bell_mention_conflict'].includes(error.facts?.reason ?? '');
        throw failure(error, { operation: 'express', participant: name, subject: recipient ? 'recipient' : 'caller', expressEffect: effect,
          ...(landedId === undefined ? {} : { landedId }) });
      }
    }

    private async listener(verb: 'listen' | 'ignore' | 'unlisten', target: string, options: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult> {
      const square = this.owner;
      const name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      checkControl(control);
      const seat = requireSeat(this.seat, square.body, name), now = square.clock();
      return (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const act = verb === 'listen' ? coreListen(facts, name, target, now) : verb === 'ignore' ? coreIgnore(facts, name, target, now) : coreUnlisten(facts, name, target, now);
        const activity = act === undefined ? null : toPublicActivity(facts.land(act));
        return { activity, ...(!options.observe ? {} : { observation: {
          ...square.observation(inSquareCount(facts), facts.hold().active, name, now), participant: name,
          requestedTarget: target, target: activity?.target ?? target,
        } }) };
      }, control?.signal)).value;
    }
    listen(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('listen', target, options, control); }
    ignore(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('ignore', target, options, control); }
    unlisten(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('unlisten', target, options, control); }
    async listening(options: ObservationOptions = {}, control?: OperationControl): Promise<ListeningResult> {
      const square = this.owner;
      return (await square.artifact.read(facts => {
        const name = resolveKnownName(facts, this.name);
        return { listening: coreListening(facts, name), ...(!options.observe ? {} : { observation: square.observation(inSquareCount(facts), facts.hold().active, name) }) };
      }, control?.signal)).value;
    }

    /** Receipt selection rechecks the lease inside the writer, not at its last heartbeat. */
    private async catchPage(name: string, seat: Seat, options: CatchOptions, control?: OperationControl, leaseId?: string): Promise<CatchSelection | null> {
      return (await this.owner.artifact.transactAs(participantAuthority(seat), facts => {
        if (leaseId !== undefined && facts.lease(name)?.leaseId !== leaseId) return null;
        return decideCatch(facts, name, options, this.owner.clock());
      }, control?.signal)).value;
    }
    async catch(options: CatchOptions = {}, control?: OperationControl): Promise<CatchResult> {
      const square = this.owner;
      let name = this.name, subject: 'caller' | 'filter' = 'caller';
      let leaseId: string | undefined, seat: Seat | undefined;
      let waitStarted = false, replaced = false;
      let selection = options;
      const idle = options.idle ?? 0;
      const complete = async (caught: CatchSelection | undefined, stop?: CatchStopStatus): Promise<CatchResult> => {
        const view = caught ?? (await square.artifact.read(facts => observeCatchSelection(facts, name, [], {
          unseenOnly: true, senders: selection.from, ...(selection.mention === true ? { attentionOnly: true } : {}),
        }, square.clock()))).value;
        if (stop === 'empty-now' || stop === undefined) stop = view.terminalStatus ?? stop;
        if (leaseId !== undefined) {
          await releaseWatchLease(square.artifact, seat!, leaseId).catch(() => undefined);
          leaseId = undefined;
        }
        let presence;
        if (options.observe) {
          try { presence = (await square.artifact.read(facts => catchPresence(facts, square.clock()), control?.signal)).value; }
          catch { /* Optional presence cannot erase the completed selection or receipts. */ }
        }
        const status = stop === 'already-active' || stop === 'replaced' || stop === 'capped' || stop === 'quorum' ? stop : undefined;
        return { activities: view.activities.map(activity => ({ ...toPublicActivity(activity), perception: 'full' as const })),
          consumedThrough: view.consumedThrough, remaining: view.remaining, idleExpired: stop === 'stale',
          ...(status === undefined ? {} : { status }), ...(view.hint === undefined ? {} : { hint: view.hint }), ...(!options.observe ? {} : { observation: {
            ...square.observation(view.standingCount, view.held, view.participant, view.now), participant: view.participant,
            sayNumbers: view.sayNumbers, ownActivityCount: view.ownActivityCount, hardCap: view.hardCap, stop,
            ...(presence === undefined ? { enrichmentUnavailable: true as const } : { presence }), waitStarted, replaced,
          } }) };
      };
      try {
        checkControl(control);
        validateName(name);
        if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Catch idle duration must be a non-negative number');
        if (options.id !== undefined && ['idle', 'from', 'mention', 'limit', 'replace'].some(key => Object.hasOwn(options, key)))
          throw new SquareError('invalid_args', 'Catch id cannot be combined with idle, from, mention, limit or replace');
        if (Object.hasOwn(options, 'replace') && idle === 0) throw new SquareError('invalid_args', 'Catch replacement requires a positive idle duration');
        catchLimit(options.limit);
        const probe = (await square.artifact.read(facts => {
          name = resolveKnownName(facts, this.name);
          seat = requireSeat(this.seat, square.body, name);
          subject = 'filter';
          const from = options.from?.map(target => resolveKnownName(facts, target));
          selection = { ...options, ...(from === undefined ? {} : { from }) };
          subject = 'caller';
          if (idle !== 0 || options.id !== undefined) return undefined;
          const page = selectCatchPage(facts, name, selection);
          return page.indexes.length === 0 ? observeCatchSelection(facts, page.participant, [], page.filter, square.clock()) : undefined;
        }, control?.signal)).value;
        if (idle === 0) {
          const data = probe ?? (await this.catchPage(name, seat!, selection, control))!;
          return await complete(data, data.activities.length === 0 ? 'empty-now' : undefined);
        }
        const watch: WatchOptions = {
          ...(selection.from === undefined ? {} : { participants: [...selection.from] }), ...(options.mention ? { mention: name } : {}),
          ...(options.replace === undefined ? {} : { replace: options.replace }),
        };
        const start = await acquireWatchLease(square.artifact, seat!, square.clock(), crypto.randomUUID(), watch, control?.signal);
        if (start.type === 'active') return await complete(undefined, 'already-active');
        leaseId = start.leaseId;
        waitStarted = true;
        replaced = start.replaced;
        control?.onProgress?.({ kind: 'catch-started', participant: name, idleMs: idle, replacementRequested: options.replace ?? false, replaced });
        let quietSince = square.clock(), wasHeld = false, nextHeartbeat = start.heartbeatAt + WATCH_HEARTBEAT_MS;
        while (true) {
          checkControl(control);
          // Arm before selecting: a commit during selection must not be missed.
          const baseline = await square.artifact.revision(control?.signal);
          const pulse = await pulseWatchLease(square.artifact, seat!, square.clock(), leaseId, watch, square.clock() >= nextHeartbeat, control?.signal);
          if (pulse.type === 'replaced') return await complete(undefined, 'replaced');
          if (pulse.type === 'terminal') return await complete(undefined, pulse.status);
          if (pulse.heartbeatAt !== undefined) nextHeartbeat = pulse.heartbeatAt + WATCH_HEARTBEAT_MS;
          if (pulse.type === 'sleep') {
            const caught = await this.catchPage(name, seat!, selection, control, leaseId);
            if (caught === null) return await complete(undefined, 'replaced');
            if (caught.activities.length > 0) return await complete(caught);
          }
          if (pulse.type === 'held' || wasHeld) quietSince = square.clock();
          wasHeld = pulse.type === 'held';
          if (!wasHeld && square.clock() - quietSince >= idle) {
            const owns = await ownsWatchLease(square.artifact, seat!, square.clock(), leaseId, control?.signal);
            return await complete(undefined, owns ? 'stale' : 'replaced');
          }
          const deadline = Math.min(nextHeartbeat, wasHeld ? Infinity : quietSince + idle);
          await square.artifact.changed(baseline, Math.max(0, deadline - square.clock()), control?.signal);
        }
      } catch (error) {
        throw failure(error, { operation: 'catch', subject, participant: name });
      } finally {
        // Cancellation releases only this captured generation and this lease.
        if (leaseId !== undefined) await releaseWatchLease(square.artifact, seat!, leaseId).catch(() => undefined);
      }
    }
    async deferDelivery(input: Readonly<{ match: MetadataMatch; durationMs: number }>, control?: OperationControl): Promise<DeliveryDeferral> {
      checkControl(control);
      const match = validateMetadataMatch(input?.match), duration = validateDeferralDuration(input?.durationMs);
      const square = this.owner, seat = requireSeat(this.seat, square.body, this.name);
      return (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const now = square.clock(), expiresAt = now + duration, id = crypto.randomUUID();
        const result = { id, expiresAt: new Date(expiresAt).toISOString() };
        facts.putDeliveryDeferral(asSeatRef(seat), id, match, expiresAt, now);
        return result;
      }, control?.signal)).value;
    }
    async renewDeliveryDeferral(id: string, durationMs: number, control?: OperationControl): Promise<DeliveryDeferral | null> {
      checkControl(control);
      validateDeferralId(id);
      const duration = validateDeferralDuration(durationMs), square = this.owner;
      const seat = requireSeat(this.seat, square.body, this.name);
      return (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const now = square.clock(), expiresAt = now + duration;
        const result = { id, expiresAt: new Date(expiresAt).toISOString() };
        return facts.renewDeliveryDeferral(asSeatRef(seat), id, expiresAt, now) ? result : null;
      }, control?.signal)).value;
    }
    async releaseDeliveryDeferral(id: string, control?: OperationControl): Promise<boolean> {
      checkControl(control);
      validateDeferralId(id);
      const square = this.owner, seat = requireSeat(this.seat, square.body, this.name);
      return (await square.artifact.transactAs(participantAuthority(seat), facts =>
        facts.releaseDeliveryDeferral(asSeatRef(seat), id, square.clock()), control?.signal)).value;
    }
    history(query?: HistoryQuery, control?: OperationControl) { return this.owner.history(query, control); }
    private async lifecycle(verb: 'done' | 'hold' | 'resume', body: string | undefined, options: ObservationOptions, control?: OperationControl): Promise<LifecycleResult> {
      if (verb === 'done') validateDoneBody(body);
      const square = this.owner;
      const name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      const seat = requireSeat(this.seat, square.body, name), now = square.clock();
      return (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const stored = facts.land(verb === 'done' ? coreDone(facts, name, body ?? '', now) : verb === 'hold' ? coreHold(facts, name, body ?? '', now) : coreResume(facts, name, now));
        return { activity: toPublicActivity(stored), ...(!options.observe ? {} : { observation: {
          ...square.observation(inSquareCount(facts), facts.hold().active, name, now), activity: stored,
        } }) };
      }, control?.signal)).value;
    }
    hold(reason?: string, options: ObservationOptions = {}, control?: OperationControl) { return this.lifecycle('hold', reason, options, control); }
    resume(options: ObservationOptions = {}, control?: OperationControl) { return this.lifecycle('resume', undefined, options, control); }
    done(body?: string, options: ObservationOptions = {}, control?: OperationControl) { return this.lifecycle('done', body, options, control); }
  };

  async participant(requested?: string): Promise<Participant> {
    const selected = requested ?? this.defaultParticipant;
    if (selected !== undefined) {
      validateName(selected);
      const seat = this.body === undefined ? undefined : (await this.artifact.read(facts => facts.seat(selected))).value;
      return this.handle(selected, seat);
    }
    if (this.body !== undefined) {
      const seats = (await this.artifact.read(facts => facts.seatsForBody(this.body!))).value;
      if (seats.length === 1) return this.handle(seats[0].participant, seats[0]);
      if (seats.length > 1) throw new SquareError('invalid_args', 'Square needs an explicit participant name: this body holds multiple names');
    }
    throw new SquareError('invalid_args', 'Square needs one unambiguous participant name');
  }
  async join(requested?: string, options: JoinOptions = {}, control?: OperationControl): Promise<JoinResult> {
    let name = requested;
    try {
      checkControl(control);
      name = requireJoinName(requested);
      const last = options.last ?? HISTORY_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(last) || last < 1 || last > HISTORY_MAX_LIMIT) throw new SquareError('invalid_args', 'Join history limit must be between 1 and 100');
      const body = requireBody(this.body), now = this.clock();
      const initial = !options.takeover ? undefined : (await this.artifact.read(facts => facts.participant(name!)?.joined ? facts.seat(name!) : undefined, control?.signal)).value;
      const authority = initial === undefined ? { kind: 'join' as const, participant: name, body, wakeAddress: this.wakeAddress }
        : { kind: 'takeover' as const, participant: initial.participant, body, expectedGeneration: initial.generation, wakeAddress: this.wakeAddress };
      const committed = (await this.artifact.transactAs(authority, facts => {
        const participant = facts.participant(name!)?.name ?? name!;
        const current = facts.participant(participant), currentSeat = facts.seat(participant);
        let kind: JoinResult['kind'] = 'joined', activity = null;
        if (initial !== undefined) {
          if (!current?.joined) throw new SquareError('already_done', `${participantIdentity(participant)} is no longer standing here`);
          facts.land(coreDone(facts, participant, '', now));
          kind = 'taken-over';
        } else if (current?.joined) {
          if (currentSeat === undefined || !sameBody(currentSeat.body, body))
            throw new SquareError('already_joined', `${participantIdentity(participant)} is held by another body; take it over explicitly`);
          if (this.wakeAddress !== undefined && canRefreshWakeAddress(currentSeat.wakeAddress, this.wakeAddress))
            facts.updateWakeAddress(asSeatRef(currentSeat), this.wakeAddress);
          kind = 'reconnected';
        }
        if (kind !== 'reconnected') {
          const decision = decideJoin(facts, participant, now);
          if (decision.joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(participant)} could not be joined`);
          activity = toPublicActivity(facts.land(decision.joinAct));
        }
        const seat = facts.seat(participant);
        if (seat === undefined) throw new SquareError('invalid_args', 'The join activity did not establish its artifact seat.');
        return { participant: this.handle(seat.participant, seat), activity, kind,
          participantCount: facts.roster().filter(item => item.joined || item.done).length,
          ...(!options.observe ? {} : { observation: this.observation(inSquareCount(facts), facts.hold().active, seat.participant, now) }) };
      }, control?.signal)).value;
      await this.publishIdentity();
      if (!options.observe) return committed;
      let entry;
      try { entry = (await this.artifact.read(facts => entryPresentation(facts, committed.participant.name, last), control?.signal)).value; }
      catch { /* Keep the committed join even when optional history is unavailable. */ }
      return { ...committed, observation: { ...committed.observation!, ...(entry === undefined ? { enrichmentUnavailable: true as const } : { entry }) } };
    } catch (error) {
      throw failure(error, { operation: 'join', subject: 'caller', participant: name });
    }
  }
  async implicitJoin(name: string, control?: OperationControl): Promise<{
    readonly state: 'joined' | 'active' | 'done'; readonly participant?: Participant;
  }> {
    checkControl(control);
    validateName(name);
    const body = requireBody(this.body), now = this.clock();
    const result = (await this.artifact.transactAs({ kind: 'join', participant: name, body, wakeAddress: this.wakeAddress }, facts => {
      const decision = decideImplicitJoin(facts, name, now);
      let seat = facts.seat(decision.joinedName);
      if (decision.joinAct === undefined) {
        if (decision.state === 'active' && (seat === undefined || !sameBody(seat.body, body)))
          throw new SquareError('already_joined', `${participantIdentity(decision.joinedName)} is held by another body`);
        if (decision.state === 'active' && this.wakeAddress !== undefined && canRefreshWakeAddress(seat!.wakeAddress, this.wakeAddress))
          facts.updateWakeAddress(asSeatRef(seat!), this.wakeAddress);
      } else {
        facts.land(decision.joinAct);
        seat = facts.seat(decision.joinedName);
        if (seat === undefined) throw new SquareError('invalid_args', 'The implicit join did not establish its artifact seat.');
      }
      return { state: decision.state, ...(decision.state === 'done' ? {} : { participant: this.handle(decision.joinedName, seat) }) };
    }, control?.signal)).value;
    if (result.participant !== undefined) await this.publishIdentity();
    return result;
  }
  async snapshot(control?: OperationControl) { return (await this.artifact.read(facts => snapshot(facts, this.clock()), control?.signal)).value; }
  async history(query: HistoryQuery = {}, control?: OperationControl): Promise<HistoryResult> {
    if (query.limit !== undefined && query.limit !== null && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > HISTORY_MAX_LIMIT))
      throw new SquareError('invalid_args', `History limit must be a positive integer no greater than ${HISTORY_MAX_LIMIT}`);
    if (query.grep !== undefined && query.fixed !== undefined) throw new SquareError('invalid_args', 'History cannot combine regular-expression and literal search');
    if (query.grep === '' || query.fixed === '') throw new SquareError('invalid_args', 'History search requires non-empty text');
    if (query.since !== undefined && !Number.isFinite(query.since)) throw new SquareError('invalid_args', 'History timestamp must be finite');
    for (const count of [query.contextBefore, query.contextAfter])
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new SquareError('invalid_args', 'History context must be a non-negative safe integer');
    const limit = query.limit === undefined ? (query.at?.length ? null : HISTORY_DEFAULT_LIMIT) : query.limit;
    const contextual = !!query.at?.length || query.contextBefore !== undefined || query.contextAfter !== undefined;
    const kinds = contextual || query.since !== undefined ? undefined : NON_READ;
    return (await this.artifact.read(facts => {
      const selected = selectHistory(facts, query, limit, kinds, query.observe === true);
      if (contextual && limit === null && selected.totalMatches > HISTORY_MAX_LIMIT)
        throw failure(new SquareError('invalid_args', `History context exceeds ${HISTORY_MAX_LIMIT} activities`), { operation: 'history', historyBounds: { maxLimit: HISTORY_MAX_LIMIT, totalMatches: selected.totalMatches } });
      const activities = publicActivities(selected.activities);
      if (!query.observe) return { activities };
      const indexes = selected.activities.map(activity => activity.index), presenceAnchors: Record<number, string[]> = {};
      for (const participant of facts.roster()) {
        const anchor = presenceAnchor(facts, participant.name);
        if (indexes.includes(anchor)) (presenceAnchors[anchor] ??= []).push(participant.name);
      }
      return { activities, observation: { ...this.observation(inSquareCount(facts), facts.hold().active), ...selected,
        sayNumbers: facts.sayOrdinals(indexes), presenceAnchors } };
    }, control?.signal)).value;
  }
  async status(options: StatusOptions = {}, control?: OperationControl): Promise<StatusResult> {
    return (await this.artifact.read(facts => {
      const seats = this.body === undefined ? [] : facts.seatsForBody(this.body);
      const viewer = options.viewer ?? this.defaultParticipant ?? (seats.length === 1 ? seats[0].participant : '');
      return queryStatus(facts, {
        location: this.location, now: this.clock(), automaticDeliveryAvailable: this.automaticDelivery && this.body !== undefined,
      }, viewer, options.observe === true);
    }, control?.signal)).value;
  }
  async participants(options: ObservationOptions = {}, control?: OperationControl): Promise<ParticipantsResult> {
    return (await this.artifact.read(facts => queryParticipants(facts, {
      location: this.location, now: this.clock(), automaticDeliveryAvailable: this.automaticDelivery && this.body !== undefined,
    }, options.observe === true), control?.signal)).value;
  }
  async recovery(requested?: string, control?: OperationControl): Promise<RecoveryResult> {
    const name = (await this.participant(requested).catch(() => undefined))?.name;
    const facts = name === undefined ? undefined : (await this.artifact.read(facts => recoveryObservation(facts, name, this.clock()), control?.signal).catch(() => undefined))?.value;
    return facts ?? await this.contextObservation(name, control);
  }
  stream(options: StreamOptions, control?: OperationControl) {
    // A path stream follows replacements independently of this connection's inode
    // and lifetime. Only explicit artifact readers borrow an existing port.
    return streamSquare(this.location, options, control);
  }
  async recognize(): Promise<readonly Participant[]> {
    if (this.body === undefined) return [];
    const candidates = (await this.artifact.read(facts => facts.seatsForBody(this.body!))).value;
    return candidates.map(seat => this.handle(seat.participant, seat));
  }
  close(): Promise<void> { return this.ownsArtifact ? this.artifact.close() : Promise.resolve(); }
  async cancelDeliveries(name: string, expectedGeneration: import('./square-core.js').ActivityId): Promise<boolean> {
    const body = this.body;
    if (body === undefined) return false;
    const seat = (await this.artifact.read(facts => facts.seat(name))).value;
    if (seat === undefined || seat.generation !== expectedGeneration || !sameBody(seat.body, body)) return false;
    return this.artifact.cancelDeliveries(asSeatRef(seat));
  }
  async endOwnedSession(name: string, sessionId: string, expectedGeneration?: import('./square-core.js').ActivityId, body?: Body): Promise<ActivityResult | null> {
    const captured = (await this.artifact.read(facts => facts.seat(name))).value;
    if (captured === undefined || captured.body.session !== sessionId || (body !== undefined && !sameBody(captured.body, body))
      || (expectedGeneration !== undefined && captured.generation !== expectedGeneration)) return null;
    return (await this.artifact.transactAs(participantAuthority(captured), facts => {
      const current = facts.seat(name);
      if (current === undefined || current.generation !== captured.generation || !sameBody(current.body, captured.body)) return null;
      return { activity: toPublicActivity(facts.land(coreDone(facts, current.participant, '', this.clock()))) };
    })).value;
  }
}

export function diagnoseSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); return diagnoseSquareFile(localSquareLocation(input)); }
export function migrateSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); const env = input.env ?? process.env; return migrateSquareFile(localSquareLocation(input), control?.signal, env); }
export function discover(input: SquareAtInput, options: DiscoveryOptions = {}, control?: OperationControl) {
  if (input.path !== undefined || (input.env ?? process.env).SQUARE_LOCATION) localSquareLocation(input);
  const env = { ...(input.env ?? process.env) };
  return discoverSquares(input.cwd ?? process.cwd(), options, control, { clock: squareClock(env, input.clock) });
}
export async function inbox(input: SquareAtInput, identity: string | Body, options: InboxOptions = {}, control?: OperationControl): Promise<InboxResult> {
  checkControl(control);
  const env = { ...(input.env ?? process.env) }, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SquareError('invalid_args', 'Inbox limit must be between 1 and 100');
  const query = typeof identity === 'string' ? { sessionId: identity, env } : { body: identity, env };
  const rows = await sessionInboxCounts(query, control?.signal);
  checkControl(control);
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  rows.sort((a, b) => compare(a.squarePath, b.squarePath) || compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name));
  return { rows: rows.slice(0, limit), total: rows.length };
}
