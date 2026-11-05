import { formatActivityId } from './square-core.js';
import { assertCurrentSeat } from './square-domain.js';
import { canonicalPath } from './canonical-path.js';
import { squareLocation } from './square-location.js';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { InternalSquareError, SquareError, isSquareError, nameKey, validateName, type Owner, type Seat, type WatchOptions } from './model.js';
import { checkControl, failure, squareClock } from './operation-control.js';
import { validateMetadataMatch } from './delivery-deferral.js';
import { flushSquarePosts, reconcileSquareDelivery, readSquareSessions, ensureInitialDeliverySession } from './square-posting.js';
import { attentionChange, coreDone, coreListening, decideAct, decideJoin, resolveKnownName, validateDoneBody } from './decisions.js';
import { WATCH_HEARTBEAT_MS, inSquareCount, presenceAnchor } from './runtime.js';
import { perceiveLimit, decidePerceive, observePerceiveSelection, selectPerceivePage, type PerceiveSelection } from './perceive-decisions.js';
import { expressionContext } from './activity-feed.js';
import { expressHint } from './hints.js';
import { asSeatRef, participantAuthority, requireJoinName, requireOwner } from './seats.js';
import { recoveryObservation, entryPresentation, queryStatus, queryParticipants, perceivePresence,
  parseRequiredActivityId, toPublicActivity, toPerceivedActivity, publicActivities, selectHistory, NON_READ, HISTORY_MAX_LIMIT, HISTORY_DEFAULT_LIMIT } from './views.js';
import { sessionInboxCounts } from './inbox.js';
import { participantIdentity } from './participant-identity.js';
import { joinRecoveryCommand } from './presentation.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from './wakes.js';
import { createArtifactPort, createSquare, diagnoseSquareFile, prepareSquareBuild } from './artifact.js';
import type { SquareArtifactPort, SquareRead } from './ports.js';
import { activityQueryFilter } from './activity-query.js';
import { discoverSquares } from './list.js';
import { streamSquare } from './stream.js';
import type {
  PerceiveOptions, PerceiveResult, PerceiveReason,
  ExpressOptions, ExpressResult, HistoryQuery, HistoryResult, JoinOptions, JoinResult, ListenerChangeResult,
  ListeningResult, LifecycleResult, ObservationOptions, OperationControl, Participant, SquareAtInput,
  SquareBuildInput, SquareObservation, SquareLocation, StatusOptions, StatusResult, ParticipantsResult,
  RecoveryResult, DiscoveryOptions, InboxOptions, InboxResult, StreamOptions, StreamRecord, Activity, PerceivedActivity, ExpressInput,
  SendInput, SendResult, FutureAck, PendingOptions, PendingResult, AckResult, ActivityId,
} from './square-facade.js';

export type * from './square-facade.js';
export { squareClock } from './operation-control.js';
export { formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
export { PERCEIVE_DEFAULT_LIMIT, PERCEIVE_MAX_LIMIT } from './perceive-decisions.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
export { DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './list.js';

function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true }; throw error; }
}

/** One concrete local resource, including its entry-resolved dependencies and lifetime. */
export class SqliteSquare {
  private constructor(
    readonly location: string,
    private readonly artifact: SquareArtifactPort,
    private readonly clock: () => number,
    private readonly env: NodeJS.ProcessEnv,
    private readonly deliveryLocation = location,
  ) {}
  private reconcile(signal?: AbortSignal): Promise<void> { return reconcileSquareDelivery(this.artifact, this.deliveryLocation, this.env, this.clock, signal); }
  // Posting is retryable after commit; a delivery failure cannot make a landed write unsent.
  private async flush(signal?: AbortSignal): Promise<void> { await flushSquarePosts(this.artifact, this.deliveryLocation, this.env, this.clock, signal).catch(() => undefined); }

  static async at(input: SquareAtInput, control?: OperationControl): Promise<SqliteSquare> {
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    const clock = squareClock(env, input.clock);
    const artifact = createArtifactPort(location, undefined, control?.signal);
    try {
      await artifact.read(facts => facts.header(), control?.signal);
      return new SqliteSquare(location, artifact, clock, env, await canonicalPath(location));
    } catch (error) {
      await artifact.close();
      if (error instanceof InternalSquareError && error.code === 'not_found')
        throw new SquareError('unavailable', `Square is unavailable at ${location}`);
      throw error;
    }
  }
  static async build(input: SquareBuildInput, control?: OperationControl): Promise<SqliteSquare> {
    checkControl(control);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    await createSquare(location, { hardCap: input.hardCap, throttlePerMinute: input.throttlePerMinute,
      template: input.template, force: input.force ?? false }, input.markdown, control?.signal);
    // Publication already committed; cancellation cannot erase the completed build.
    return SqliteSquare.at({ ...input, path: location, env });
  }
  static inMemory(input: Omit<SquareBuildInput, 'path'>): SqliteSquare {
    const env = { ...(input.env ?? process.env) };
    return new SqliteSquare(`memory://${crypto.randomUUID()}`, createArtifactPort(':memory:', prepareSquareBuild(input, input.markdown)),
      squareClock(env, input.clock), env);
  }
  /** Join establishes membership and local producer custody in one transaction. */
  private async joinSeat(name: string, options: JoinOptions, control?: OperationControl): Promise<{ readonly seat: Seat; readonly kind: JoinResult['kind']; readonly activity: Activity | null; readonly observation?: import('./square-facade.js').JoinObservation }> {
    checkControl(control);
    const owner = requireOwner(options?.owner), now = this.clock();
    const initial = !options.takeover ? undefined : (await this.artifact.read(facts => facts.participant(name)?.joined ? facts.seat(name) : undefined, control?.signal)).value;
    const authority = initial === undefined ? { kind: 'join' as const, participant: name, owner }
      : { kind: 'takeover' as const, participant: initial.participant, owner, expectedGeneration: initial.generation };
    const committed = (await this.artifact.transactAs(authority, facts => {
      const participant = facts.participant(name)?.name ?? name;
      const current = facts.participant(participant), currentSeat = facts.seat(participant);
      let kind: JoinResult['kind'] = 'joined', activity = null;
      if (initial !== undefined) {
        if (!current?.joined) throw new SquareError('already_done', `${participantIdentity(participant)} is no longer standing here`);
        facts.land(coreDone(facts, participant, '', now));
        kind = 'taken-over';
      } else if (current?.joined) {
        if (currentSeat === undefined || currentSeat.owner !== owner)
          throw new SquareError('already_joined', `${participantIdentity(participant)} is held by another owner; take it over explicitly`);
        if (currentSeat.attachment !== 'attached') throw new SquareError('already_joined', `${participantIdentity(participant)} is away; resume the host session first`);
        kind = 'reconnected';
      }
      if (kind !== 'reconnected') {
        const joinAct = decideJoin(facts, participant, now);
        if (joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(participant)} could not be joined`);
        activity = toPublicActivity(facts.land(joinAct));
      }
      const seat = facts.seat(participant);
      if (seat === undefined) throw new SquareError('invalid_args', 'The join activity did not establish participant custody.');
      return { seat, activity, kind,
        ...(!options.observe ? {} : { observation: { ...this.observation(inSquareCount(facts), seat.participant, now),
          deliveryAvailable: false } }) };
    }, control?.signal)).value;
    return committed;
  }
  private async requiredSeat(name: string, { owner }: { readonly owner: Owner }): Promise<Seat> {
    validateName(name);
    requireOwner(owner);
    return (await this.artifact.read(facts => {
      const participant = facts.participant(name), seat = facts.seat(name);
      if (!participant?.joined || seat === undefined || seat.owner !== owner || seat.attachment !== 'attached') {
        const reason = participant === undefined ? 'has never stepped into this square'
          : !participant.joined ? 'needs to join first'
          : seat !== undefined && seat.owner !== owner ? 'is not held by this owner; join before writing'
          : seat?.attachment === 'detached' ? 'is away; resume the host session first'
          : 'needs a current participant seat; join first';
        throw new SquareError('already_joined', `${participantIdentity(participant?.name ?? name)} ${reason}`, {
          reason: 'needs_seat', join: joinRecoveryCommand(this.location, participant?.name ?? name),
        });
      }
      return seat;
    })).value;
  }
  private observation(standingCount: number, participant?: string, now = this.clock()): SquareObservation {
    return { location: this.location, standingCount, now,
      ...(participant === undefined ? {} : { participant }) };
  }
  private async contextObservation(participant?: string, control?: OperationControl): Promise<SquareObservation> {
    return (await this.artifact.read(facts => this.observation(inSquareCount(facts), participant), control?.signal)).value;
  }
  /** Host liveness is a read-only, non-atomic overlay; it never changes membership. */
  private async withHostPresence<T>(select: (facts: SquareRead, deliveryAvailable: (name: string) => boolean) => T, control?: OperationControl): Promise<T> {
    const seats = (await this.artifact.read(facts => facts.roster().filter(person => person.joined)
      .flatMap(person => { const seat = facts.seat(person.name); return seat === undefined ? [] : [seat]; }), control?.signal)).value;
    const sessions = await readSquareSessions(seats, this.env, control?.signal);
    const captured = new Map(seats.map(seat => [nameKey(seat.participant), seat]));
    return (await this.artifact.read(facts => {
      const seat = (name: string): Seat | undefined => {
        const current = facts.seat(name);
        if (current === undefined) return undefined;
        const before = captured.get(nameKey(current.participant));
        const attached = before?.owner === current.owner && before.generation === current.generation
          && sessions.get(current.owner)?.state === 'attached';
        return { ...current, attachment: attached ? 'attached' : 'detached' };
      };
      return select(Object.assign({}, facts, { seat }), name => {
        const current = seat(name);
        return current?.attachment === 'attached' && (sessions.get(current.owner)?.routes.length ?? 0) > 0;
      });
    }, control?.signal)).value;
  }
  private handle(seat: Seat): Participant { return new SqliteSquare.ParticipantHandle(seat.participant, this, seat); }

  // The nested handle uses its resource's private dependencies without copying
  // them into a second context.
  private static readonly ParticipantHandle = class implements Participant {
    constructor(readonly name: string, private readonly owner: SqliteSquare, private readonly seat: Seat) {}
    get generation() { return this.seat.generation; }

    async express(bodyOrInput: string | undefined | ExpressInput, optionsOrControl: ExpressOptions | OperationControl = {}, operationControl?: OperationControl): Promise<ExpressResult> {
      const square = this.owner;
      const input = typeof bodyOrInput === 'object' && bodyOrInput !== null ? bodyOrInput : undefined;
      const body: string | undefined = typeof bodyOrInput === 'string' || bodyOrInput === undefined ? bodyOrInput : bodyOrInput.body;
      const options = (input ?? optionsOrControl) as ExpressOptions;
      const control = input === undefined ? operationControl : optionsOrControl as OperationControl;
      let name = this.name, effect: 'unsent' | 'unknown' | 'landed' = 'unsent';
      let landedId: ExpressResult['activity']['id'] | undefined;
      try {
        checkControl(control);
        await square.reconcile(control?.signal);
        name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
        const seat = this.seat;
        const context = !options.observe ? undefined : (await square.artifact.read(
          facts => expressionContext(facts, name), control?.signal)).value;
        while (true) {
          checkControl(control);
          try {
            await square.reconcile(control?.signal);
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
              const decision = rejectUnsentActivity(() => {
                if (proposed.type === 'blocked') throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending: proposed.activitySummaries.reduce((count, summary) => count + summary.count, 0) });
                if (proposed.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
                if (proposed.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: proposed.delayMs });
                if (proposed.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, proposed.nextAt - now) });
                return proposed;
              });
              const stored = facts.land(decision.act);
              return { stored, standingCount: inSquareCount(facts),
                ownActivityCount: facts.participant(name)!.sayCount, hardCap: facts.header().hardCap,
                ...(decision.unmatchedMentions === undefined ? {} : { unmatchedMentions: decision.unmatchedMentions }),
                ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }) };
            }, control?.signal)).value;
            landedId = formatActivityId(committed.stored.index);
            effect = 'landed';
            await square.flush(control?.signal);
            const { stored, standingCount, ownActivityCount, hardCap, ...metadata } = committed;
            const hint = expressHint(ownActivityCount);
            return { activity: toPublicActivity(stored), ...metadata,
              ...(hint === undefined ? {} : { hint }), ...(context === undefined ? {} : { observation: {
                ...square.observation(standingCount, name, now), ownActivityCount, hardCap, context, participant: name,
              } }) };
          } catch (error) {
            if (effect !== 'landed' && isSquareError(error) && error.facts?.activityUnsent === true) effect = 'unsent';
            if (effect === 'landed' || !isSquareError(error) || options.noWait || error.code !== 'throttled') throw error;
            control?.onProgress?.({ kind: 'waiting', reason: 'throttled', delayMs: error.facts?.retryAfterMs ?? 1 });
            await sleep(error.facts?.retryAfterMs ?? 1, undefined, { signal: control?.signal });
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
      checkControl(control);
      await square.reconcile(control?.signal);
      const name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      const seat = this.seat, now = square.clock();
      const result = (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const act = attentionChange(facts, verb, name, target, now);
        const activity = act === undefined ? null : toPublicActivity(facts.land(act));
        return { activity, ...(!options.observe ? {} : { observation: {
          ...square.observation(inSquareCount(facts), name, now), participant: name,
          target: activity?.target ?? target,
        } }) };
      }, control?.signal)).value;
      await square.flush(control?.signal);
      return result;
    }
    listen(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('listen', target, options, control); }
    ignore(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('ignore', target, options, control); }
    unlisten(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('unlisten', target, options, control); }
    async listening(options: ObservationOptions = {}, control?: OperationControl): Promise<ListeningResult> {
      const square = this.owner;
      return (await square.artifact.read(facts => {
        const name = resolveKnownName(facts, this.name);
        return { listening: coreListening(facts, name), ...(!options.observe ? {} : { observation: square.observation(inSquareCount(facts), name) }) };
      }, control?.signal)).value;
    }

    /** Receipt selection rechecks the lease inside the writer, not at its last heartbeat. */
    private async perceivePage(name: string, seat: Seat, options: PerceiveOptions, control?: OperationControl, leaseId?: string): Promise<PerceiveSelection | null> {
      await this.owner.reconcile(control?.signal);
      return (await this.owner.artifact.transactAs(participantAuthority(seat), facts => {
        if (leaseId !== undefined && facts.lease(name)?.leaseId !== leaseId) return null;
        return decidePerceive(facts, name, options, this.owner.clock());
      }, control?.signal)).value;
    }
    async perceive(options: PerceiveOptions = {}, control?: OperationControl): Promise<PerceiveResult> {
      const square = this.owner;
      let name = this.name, subject: 'caller' | 'filter' = 'caller';
      let leaseId: string | undefined, seat: Seat | undefined;
      let selection = options;
      const idle = options.idle ?? 0;
      const complete = async (perceived: PerceiveSelection | undefined, reason: PerceiveReason = 'drained'): Promise<PerceiveResult> => {
        const view = perceived ?? (await square.artifact.read(facts => observePerceiveSelection(facts, name, [], {
          unseenOnly: true, senders: selection.from, ...(selection.mention === true ? { attentionOnly: true } : {}),
        }, square.clock()))).value;
        if (reason === 'drained') reason = view.terminalStatus ?? reason;
        await square.flush(control?.signal);
        if (leaseId !== undefined) {
          await releaseWatchLease(square.artifact, seat!, leaseId).catch(() => undefined);
          leaseId = undefined;
        }
        let presence, deliveryAvailable = false;
        if (options.observe) {
          try {
            const observed = await square.withHostPresence((facts, available) => {
              const data = perceivePresence(facts, square.clock());
              return { presence: { ...data, participants: data.participants.map(person => ({ ...person, deliveryAvailable: available(person.name) })) },
                deliveryAvailable: available(view.participant) };
            }, control);
            presence = observed.presence;
            deliveryAvailable = observed.deliveryAvailable;
          } catch { /* Optional presence cannot erase the completed selection or receipts. */ }
        }
        return { activities: view.activities, remaining: view.remaining, reason,
          ...(view.hint === undefined ? {} : { hint: view.hint }), ...(!options.observe ? {} : { observation: {
            ...square.observation(view.standingCount, view.participant, view.now), participant: view.participant,
            deliveryAvailable,
            ownActivityCount: view.ownActivityCount, hardCap: view.hardCap,
            ...(presence === undefined ? { enrichmentUnavailable: true as const } : { presence }),
          } }) };
      };
      try {
        checkControl(control);
        await square.reconcile(control?.signal);
        validateName(name);
        if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Perceive idle duration must be a non-negative number');
        if (options.id !== undefined && ['idle', 'from', 'mention', 'limit', 'replace'].some(key => Object.hasOwn(options, key)))
          throw new SquareError('invalid_args', 'Perceive id cannot be combined with idle, from, mention, limit or replace');
        if (Object.hasOwn(options, 'replace') && idle === 0) throw new SquareError('invalid_args', 'Perceive replacement requires a positive idle duration');
        perceiveLimit(options.limit);
        const probe = (await square.artifact.read(facts => {
          name = resolveKnownName(facts, this.name);
          seat = this.seat;
          assertCurrentSeat(facts, asSeatRef(seat));
          subject = 'filter';
          const from = options.from?.map(target => resolveKnownName(facts, target));
          selection = { ...options, ...(from === undefined ? {} : { from }) };
          subject = 'caller';
          if (idle !== 0 || options.id !== undefined) return undefined;
          const page = selectPerceivePage(facts, name, selection);
          return page.indexes.length === 0 ? observePerceiveSelection(facts, page.participant, [], page.filter, square.clock()) : undefined;
        }, control?.signal)).value;
        if (idle === 0) {
          const data = probe ?? (await this.perceivePage(name, seat!, selection, control))!;
          return await complete(data);
        }
        const watch: WatchOptions = {
          ...(selection.from === undefined ? {} : { participants: [...selection.from] }), ...(options.mention ? { mention: name } : {}),
          ...(options.replace === undefined ? {} : { replace: options.replace }),
        };
        const start = await acquireWatchLease(square.artifact, seat!, square.clock(), crypto.randomUUID(), watch, control?.signal);
        if (start.type === 'active') return await complete(undefined, 'already-active');
        leaseId = start.leaseId;
        control?.onProgress?.({ kind: 'perceive-started', participant: name, idleMs: idle, replacementRequested: options.replace ?? false, replaced: start.replaced });
        const quietSince = square.clock();
        let nextHeartbeat = start.heartbeatAt + WATCH_HEARTBEAT_MS;
        while (true) {
          checkControl(control);
          // Arm before selecting: a commit during selection must not be missed.
          const baseline = await square.artifact.revision(control?.signal);
          const pulse = await pulseWatchLease(square.artifact, seat!, square.clock(), leaseId, watch, square.clock() >= nextHeartbeat, control?.signal);
          if (pulse.type === 'replaced') return await complete(undefined, 'replaced');
          if (pulse.type === 'terminal') return await complete(undefined, pulse.status);
          if (pulse.heartbeatAt !== undefined) nextHeartbeat = pulse.heartbeatAt + WATCH_HEARTBEAT_MS;
          const perceived = await this.perceivePage(name, seat!, selection, control, leaseId);
          if (perceived === null) return await complete(undefined, 'replaced');
          if (perceived.activities.length > 0) return await complete(perceived);
          if (square.clock() - quietSince >= idle) {
            const owns = await ownsWatchLease(square.artifact, seat!, square.clock(), leaseId, control?.signal);
            return await complete(undefined, owns ? 'idle' : 'replaced');
          }
          const deadline = Math.min(nextHeartbeat, quietSince + idle);
          await square.artifact.changed(baseline, Math.max(0, deadline - square.clock()), control?.signal);
        }
      } catch (error) {
        throw failure(error, { operation: 'perceive', subject, participant: name });
      } finally {
        // Cancellation releases only this captured generation and this lease.
        if (leaseId !== undefined) await releaseWatchLease(square.artifact, seat!, leaseId).catch(() => undefined);
      }
    }
    async pending(options: PendingOptions = {}, control?: OperationControl): Promise<PendingResult> {
      checkControl(control);
      const limit = options.limit === undefined ? 100 : options.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new SquareError('invalid_args', 'Pending limit must be a positive integer no greater than 100.');
      // Pending follows the shared archive cursor: act/N with before/after.
      const shared = activityQueryFilter(options);
      const filter = { kinds: ['say'] as const, unseenOnly: true as const,
        ...(shared.indexes === undefined ? {} : { indexes: shared.indexes }),
        ...(shared.actors === undefined ? {} : { senders: shared.actors }),
        ...(shared.metadataMatch === undefined ? {} : { metadataMatch: shared.metadataMatch }),
        ...(shared.search === undefined ? {} : { search: shared.search }),
        ...(shared.afterIndex === undefined ? {} : { afterIndex: shared.afterIndex }),
        ...(shared.beforeIndex === undefined ? {} : { beforeIndex: shared.beforeIndex }) };
      return (await this.owner.artifact.read(facts => {
        assertCurrentSeat(facts, asSeatRef(this.seat));
        const heads = facts.directed(this.name, filter, { edge: 'oldest', limit });
        return { activities: facts.activities(heads.items.map(head => head.index)).map(activity => toPerceivedActivity(facts, activity, this.name)),
          remaining: facts.directedCount(this.name, filter) - heads.items.length };
      }, control?.signal)).value;
    }
    ack(ids: readonly ActivityId[], control?: OperationControl): Promise<AckResult>;
    ack(input: FutureAck, control?: OperationControl): Promise<AckResult>;
    ack(input: readonly ActivityId[] | FutureAck, control?: OperationControl): Promise<AckResult> {
      const square = this.owner;
      checkControl(control);
      return square.artifact.transactAs(participantAuthority(this.seat), facts => {
        if (!Array.isArray(input)) {
          const exact = input as FutureAck;
          if (exact?.future !== 'exact') throw new SquareError('invalid_args', 'Ack requires an exact future predicate.');
          validateName(exact.from);
          return { consumed: facts.ackMatching(asSeatRef(this.seat), { from: exact.from, match: validateMetadataMatch(exact.match), future: 'exact' }, square.clock()) };
        }
        const indexes: number[] = [];
        for (const id of input) {
          const activity = facts.activity(parseRequiredActivityId(id));
          if (activity?.kind !== 'say')
            throw new SquareError('invalid_args', `${id} is not addressed to you.`, { reason: 'not_addressed', activityId: id });
          const head = facts.directed(this.name, { indexes: [activity.index], kinds: ['say'] }, { edge: 'oldest', limit: 1 }).items[0];
          if (head === undefined) throw new SquareError('invalid_args', `${id} is not addressed to you.`, { reason: 'not_addressed', activityId: id });
          indexes.push(activity.index);
        }
        return { consumed: facts.markSeen(this.name, indexes, square.clock()) };
      }, control?.signal).then(result => result.value);
    }
    async done(body?: string, options: ObservationOptions = {}, control?: OperationControl): Promise<LifecycleResult> {
      validateDoneBody(body);
      checkControl(control);
      const square = this.owner;
      await square.reconcile(control?.signal);
      const name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      const seat = this.seat, now = square.clock();
      const result = (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const stored = facts.land(coreDone(facts, name, body ?? '', now));
        return { activity: toPublicActivity(stored), ...(!options.observe ? {} : { observation:
          square.observation(inSquareCount(facts), name, now),
        }) };
      }, control?.signal)).value;
      await square.flush(control?.signal);
      return result;
    }
  };

  async send(input: SendInput, control?: OperationControl): Promise<SendResult> {
    checkControl(control);
    await this.reconcile(control?.signal);
    const result = (await this.artifact.transactAs({ kind: 'send', actor: input.from }, facts => facts.insertNotice(input, this.clock()), control?.signal)).value;
    await this.flush(control?.signal);
    return result;
  }

  async participant(name: string, options: { readonly owner: Owner }): Promise<Participant> {
    return this.handle(await this.requiredSeat(name, options));
  }
  async join(requested: string, options: JoinOptions, control?: OperationControl): Promise<JoinResult> {
    let name = requested;
    try {
      checkControl(control);
      name = requireJoinName(requested);
      const last = options.last ?? HISTORY_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(last) || last < 1 || last > HISTORY_MAX_LIMIT) throw new SquareError('invalid_args', 'Join history limit must be between 1 and 100');
      if (!await ensureInitialDeliverySession(requireOwner(options.owner), this.env, options.wakeAddress, control?.signal))
        throw new SquareError('already_joined', `${participantIdentity(name)} is away; resume the host session first`, { reason: 'needs_seat' });
      await this.reconcile(control?.signal);
      const committed = await this.joinSeat(name, options, control);
      await this.flush(control?.signal);
      const participant = this.handle(committed.seat);
      const result = { participant, activity: committed.activity, kind: committed.kind,
        ...(committed.observation === undefined ? {} : { observation: committed.observation }) };
      if (!options.observe) return result;
      let entry, deliveryAvailable = false;
      try {
        const observed = await this.withHostPresence((facts, available) => ({
          entry: entryPresentation(facts, participant.name, options.last ?? HISTORY_DEFAULT_LIMIT),
          deliveryAvailable: available(participant.name),
        }), control);
        entry = observed.entry;
        deliveryAvailable = observed.deliveryAvailable;
      } catch { /* Keep the committed join even when optional history is unavailable. */ }
      return { ...result, observation: { ...committed.observation!, deliveryAvailable,
        ...(entry === undefined ? { enrichmentUnavailable: true as const } : { entry }) } };
    } catch (error) {
      throw failure(error, { operation: 'join', subject: 'caller', participant: name });
    }
  }
  async history(query: HistoryQuery = {}, control?: OperationControl): Promise<HistoryResult> {
    if (query.limit !== undefined && query.limit !== null && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > HISTORY_MAX_LIMIT))
      throw new SquareError('invalid_args', `History limit must be a positive integer no greater than ${HISTORY_MAX_LIMIT}`);
    if (query.order !== undefined && query.order !== 'asc' && query.order !== 'desc')
      throw new SquareError('invalid_args', 'History order must be asc or desc.');
    if (query.since !== undefined && !Number.isFinite(query.since)) throw new SquareError('invalid_args', 'History timestamp must be finite');
    for (const count of [query.contextBefore, query.contextAfter])
      if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new SquareError('invalid_args', 'History context must be a non-negative safe integer');
    const limit = query.limit === undefined ? (query.at?.length ? null : HISTORY_DEFAULT_LIMIT) : query.limit;
    const contextual = !!query.at?.length || query.contextBefore !== undefined || query.contextAfter !== undefined;
    const kinds = contextual || query.since !== undefined ? [...NON_READ, 'read' as const] : NON_READ;
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
      return { activities, observation: { ...this.observation(inSquareCount(facts)), ...selected,
        sayNumbers: facts.sayOrdinals(indexes), presenceAnchors } };
    }, control?.signal)).value;
  }
  async status(options: StatusOptions = {}, control?: OperationControl): Promise<StatusResult> {
    return this.withHostPresence((facts, available) => {
      const result = queryStatus(facts, { location: this.location, now: this.clock() }, options.viewer, options.observe === true);
      return { ...result, participants: result.participants.map(person => ({ ...person, deliveryAvailable: available(person.name) })) };
    }, control);
  }
  /** Local mode reads only World-known facts; it does not verify host attachment. */
  async participants(options: ObservationOptions & { readonly local?: boolean } = {}, control?: OperationControl): Promise<ParticipantsResult> {
    if (options.local) return (await this.artifact.read(facts => {
      const result = queryParticipants(facts, { location: this.location, now: this.clock() }, options.observe === true);
      return { ...result, participants: result.participants.map(person => ({ ...person, deliveryAvailable: false })) };
    }, control?.signal)).value;
    return this.withHostPresence((facts, available) => {
      const result = queryParticipants(facts, { location: this.location, now: this.clock() }, options.observe === true);
      return { ...result, participants: result.participants.map(person => ({ ...person, deliveryAvailable: available(person.name) })) };
    }, control);
  }
  async recovery(requested?: string, control?: OperationControl): Promise<RecoveryResult> {
    const facts = requested === undefined ? undefined : (await this.artifact.read(facts => recoveryObservation(facts, requested, this.clock()), control?.signal).catch(() => undefined))?.value;
    return facts ?? await this.contextObservation(requested, control);
  }
  stream(options: StreamOptions & { readonly recipient: string }, control?: OperationControl): AsyncIterable<PerceivedActivity>;
  stream(options: StreamOptions & { readonly recipient?: undefined }, control?: OperationControl): AsyncIterable<Activity>;
  stream(options: StreamOptions, control?: OperationControl): AsyncIterable<StreamRecord>;
  stream(options: StreamOptions, control?: OperationControl): AsyncIterable<StreamRecord> {
    // A path stream follows replacements independently of this connection's inode
    // and lifetime. Only explicit artifact readers borrow an existing port.
    return streamSquare(this.location, options, control);
  }
  async seatsOf(owner: Owner): Promise<readonly import('./square-facade.js').HeldSeat[]> {
    requireOwner(owner);
    return (await this.artifact.read(facts => facts.seatsForOwner(owner)
      .filter(seat => facts.participant(seat.participant)?.joined && seat.attachment === 'attached')
      .map(seat => ({ name: seat.participant, generation: seat.generation })))).value;
  }
  close(): Promise<void> { return this.artifact.close(); }
}

export function diagnoseSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); return diagnoseSquareFile(squareLocation(input)); }
export function discover(input: SquareAtInput, options: DiscoveryOptions = {}, control?: OperationControl) {
  if (input.path !== undefined) squareLocation(input);
  return discoverSquares(input.cwd ?? process.cwd(), options, control);
}
export async function inbox(input: SquareAtInput, owner: Owner, options: InboxOptions = {}, control?: OperationControl): Promise<InboxResult> {
  checkControl(control);
  requireOwner(owner);
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SquareError('invalid_args', 'Inbox limit must be between 1 and 100');
  const rows = await sessionInboxCounts({ owner, cwd: input.cwd }, control?.signal);
  checkControl(control);
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  rows.sort((a, b) => compare(a.squarePath, b.squarePath) || compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name));
  return { rows: rows.slice(0, limit), total: rows.length };
}
