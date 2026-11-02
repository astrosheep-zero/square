import { formatActivityId } from './square-core.js';
import { assertCurrentSeat } from './square-domain.js';
import { canonicalPath } from './canonical-path.js';
import type { MetadataMatch, DeliveryDeferral } from './delivery-deferral.js';
import { squareLocation } from './square-location.js';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { InternalSquareError, SquareError, isSquareError, nameKey, validateName, type Owner, type Seat, type WatchOptions } from './model.js';
import { Channel, ChannelEndpoint, checkControl, failure, squareClock } from './channel-internal.js';
import { channelArtifact } from './artifact.js';
import { deliverPending } from './delivery-operations.js';
import { attentionChange, coreDone, coreListening, decideAct, decideJoin, resolveKnownName, validateDoneBody } from './decisions.js';
import { WATCH_HEARTBEAT_MS, inSquareCount, presenceAnchor } from './runtime.js';
import { catchLimit, decideCatch, observeCatchSelection, selectCatchPage, type CatchSelection } from './catch-decisions.js';
import { expressionContext } from './activity-feed.js';
import { expressHint } from './hints.js';
import { asSeatRef, participantAuthority, requireJoinName, requireOwner } from './seats.js';
import { recoveryObservation, entryPresentation, queryStatus, queryParticipants, catchPresence,
  parseRequiredActivityId, toPublicActivity, toPerceivedActivity, publicActivities, selectHistory, NON_READ, HISTORY_MAX_LIMIT, HISTORY_DEFAULT_LIMIT } from './views.js';
import { sessionInboxCounts } from './inbox.js';
import { squareIndexPath } from './square-index.js';
import { participantIdentity } from './participant-identity.js';
import { joinRecoveryCommand } from './presentation.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from './wakes.js';
import { squareWakeProjection } from './wake-preview.js';
import { createArtifactPort, createSquare, diagnoseSquareFile, prepareSquareBuild } from './artifact.js';
import type { SquareArtifactPort, WakeTransportPort } from './ports.js';
import { activityQueryFilter } from './activity-query.js';
import { discoverSquares } from './list.js';
import { streamSquare } from './stream.js';
import type {
  CatchOptions, CatchResult, CatchReason,
  ExpressOptions, ExpressResult, HistoryQuery, HistoryResult, JoinOptions, JoinResult, ListenerChangeResult,
  ListeningResult, LifecycleResult, ObservationOptions, OperationControl, Participant, SquareAtInput,
  SquareBuildInput, SquareObservation, SquareLocation, StatusOptions, StatusResult, ParticipantsResult,
  RecoveryResult, DiscoveryOptions, InboxOptions, InboxResult, StreamOptions, StreamRecord, Activity, PerceivedActivity, ExpressInput,
  ChannelSendInput, ChannelSendResult, PendingOptions, PendingResult, AckResult, ActivityId,
} from './square-facade.js';

export type * from './square-facade.js';
export { createSquareResourceOwner } from './artifact.js';
export { squareClock } from './channel-internal.js';
export { formatActivityId, parseActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
export { CATCH_DEFAULT_LIMIT, CATCH_MAX_LIMIT } from './catch-decisions.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './views.js';
export { DEFAULT_LIST_DEPTH, MAX_LIST_DEPTH, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './list.js';

function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true }; throw error; }
}

/** One concrete local resource, including its entry-resolved dependencies and lifetime. */
export class SqliteSquare {
  private readonly channel: Channel;
  private constructor(
    readonly location: string,
    private readonly artifact: SquareArtifactPort,
    private readonly clock: () => number,
    private readonly wakeTransport?: WakeTransportPort,
    indexPath?: string,
    closesArtifact = true,
    private readonly deliveryLocation = location,
  ) {
    this.channel = Channel.fromPort({ location, artifact: channelArtifact(artifact), clock,
      ...(wakeTransport === undefined ? {} : { deliverEffect: message => deliverPending({ artifact: channelArtifact(artifact),
        preparePresentation: squareWakeProjection(artifact), transport: wakeTransport, location: deliveryLocation,
        ...(message === undefined ? {} : { message }), now: clock() }) }),
      ...(indexPath === undefined ? {} : { indexPath }), closesArtifact });
  }

  static async at(input: SquareAtInput, control?: OperationControl): Promise<SqliteSquare> {
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env });
    const clock = squareClock(env, input.clock);
    // A request can abort its own borrowed reads, never the owner's connection lifetime.
    const borrowed = input.resources?.artifact(location);
    const artifact = borrowed ?? createArtifactPort(location, undefined, control?.signal);
    try {
      await artifact.read(facts => facts.header(), control?.signal);
      return new SqliteSquare(location, artifact, clock,
        input.wakeTransport || undefined, squareIndexPath(env), borrowed === undefined, await canonicalPath(location));
    } catch (error) {
      if (borrowed === undefined) await artifact.close();
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
  static inMemory(input: Omit<SquareBuildInput, 'path' | 'resources'>): SqliteSquare {
    const env = { ...(input.env ?? process.env) };
    return new SqliteSquare(`memory://${crypto.randomUUID()}`, createArtifactPort(':memory:', prepareSquareBuild(input, input.markdown)),
      squareClock(env, input.clock), input.wakeTransport || undefined);
  }
  /** Agora join composes membership and endpoint custody in one transaction. */
  private async joinSeat(name: string, options: JoinOptions, control?: OperationControl): Promise<{ readonly seat: Seat; readonly kind: JoinResult['kind']; readonly activity: Activity | null; readonly observation?: import('./square-facade.js').JoinObservation }> {
    checkControl(control);
    const last = options?.last ?? HISTORY_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(last) || last < 1 || last > HISTORY_MAX_LIMIT) throw new SquareError('invalid_args', 'Join history limit must be between 1 and 100');
    const owner = requireOwner(options?.owner), wakeAddress = options.wakeAddress, now = this.clock();
    const initial = !options.takeover ? undefined : (await this.artifact.read(facts => facts.participant(name)?.joined ? facts.seat(name) : undefined, control?.signal)).value;
    const authority = initial === undefined ? { kind: 'join' as const, participant: name, owner, wakeAddress }
      : { kind: 'takeover' as const, participant: initial.participant, owner, expectedGeneration: initial.generation, wakeAddress };
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
        if (currentSeat.attachment === 'detached') facts.reattachSeat(asSeatRef(currentSeat), wakeAddress);
        else if (wakeAddress !== undefined && (wakeAddress.kind !== 'paseo' || currentSeat.wakeAddress === undefined || currentSeat.wakeAddress.kind === 'paseo'))
          facts.updateWakeAddress(asSeatRef(currentSeat), wakeAddress);
        kind = 'reconnected';
      }
      if (kind !== 'reconnected') {
        const joinAct = decideJoin(facts, participant, now);
        if (joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(participant)} could not be joined`);
        activity = toPublicActivity(facts.land(joinAct));
      }
      const seat = facts.seat(participant);
      if (seat === undefined) throw new SquareError('invalid_args', 'The join activity did not establish its artifact endpoint.');
      return { seat, activity, kind,
        ...(!options.observe ? {} : { observation: { ...this.observation(inSquareCount(facts), seat.participant, now),
          deliveryAvailable: seat.wakeAddress !== undefined } }) };
    }, control?.signal)).value;
    await this.channel.remember(owner);
    return committed;
  }
  private async requiredSeat(name: string, { owner }: { readonly owner: Owner }): Promise<Seat> {
    validateName(name);
    requireOwner(owner);
    return (await this.artifact.read(facts => {
      const participant = facts.participant(name), seat = facts.seat(name);
      if (!participant?.joined || seat === undefined || seat.owner !== owner || seat.attachment !== 'attached') {
        const reason = participant === undefined ? 'has never stepped into this square'
          : !participant.joined ? 'needs a current attached endpoint; join first'
          : seat !== undefined && seat.owner !== owner ? 'is not held by this owner; join before writing'
          : seat?.attachment === 'detached' ? 'is away — join again before writing'
          : 'needs a current attached endpoint; join first';
        throw new SquareError('already_joined', `${participantIdentity(participant?.name ?? name)} ${reason}`, {
          reason: 'needs_seat', join: joinRecoveryCommand(this.location, participant?.name ?? name),
        });
      }
      return seat;
    })).value;
  }
  private async reattachSeat(name: string, { owner, wakeAddress }: Pick<JoinOptions, 'owner' | 'wakeAddress'>, control?: OperationControl): Promise<Seat | null> {
    checkControl(control);
    validateName(name); requireOwner(owner);
    const captured = (await this.artifact.read(facts => facts.seat(name), control?.signal)).value;
    if (captured === undefined || captured.owner !== owner) return null;
    const seat = (await this.artifact.transactAs({ kind: 'join', participant: name, owner, wakeAddress }, facts => {
      const current = facts.seat(name);
      if (!facts.participant(name)?.joined || current === undefined || current.generation !== captured.generation || current.owner !== owner) return null;
      if (current.attachment === 'detached') facts.reattachSeat(asSeatRef(current), wakeAddress);
      else if (wakeAddress !== undefined && (wakeAddress.kind !== 'paseo' || current.wakeAddress === undefined || current.wakeAddress.kind === 'paseo'))
        facts.updateWakeAddress(asSeatRef(current), wakeAddress);
      return facts.seat(name)!;
    }, control?.signal)).value;
    if (seat !== null) await this.channel.remember(owner);
    return seat;
  }
  private async endHeldSeat(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<LifecycleResult | null> {
    const captured = (await this.artifact.read(facts => {
      const seat = facts.seat(name);
      return seat?.generation === identity.generation && seat.owner === identity.owner ? seat : undefined;
    })).value;
    if (captured === undefined) return null;
    return (await this.artifact.transactAs({ kind: 'host-cleanup', seat: captured }, facts => {
      const current = facts.seat(name);
      if (current === undefined || current.generation !== captured.generation || current.owner !== captured.owner) return null;
      return { activity: toPublicActivity(facts.land(coreDone(facts, current.participant, '', this.clock()))) };
    })).value;
  }
  private async cancelHeld(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<boolean> {
    const captured = (await this.artifact.read(facts => {
      const seat = facts.seat(name);
      return seat?.generation === identity.generation && seat.owner === identity.owner ? seat : undefined;
    })).value;
    if (captured === undefined) return false;
    return (await this.artifact.transactAs({ kind: 'participant', seat: captured }, facts => {
      const boundary = facts.channel.header().lastMessageIndex;
      return boundary < 0 ? false : facts.channel.cancelThrough(captured, boundary);
    })).value;
  }

  private observation(standingCount: number, participant?: string, now = this.clock()): SquareObservation {
    return { location: this.location, standingCount, now,
      ...(participant === undefined ? {} : { participant }) };
  }
  private async contextObservation(participant?: string, control?: OperationControl): Promise<SquareObservation> {
    return (await this.artifact.read(facts => this.observation(inSquareCount(facts), participant), control?.signal)).value;
  }
  private handle(seat: Seat): Participant { return new SqliteSquare.ParticipantHandle(seat.participant, this, seat); }

  // The nested handle uses its resource's private dependencies without copying
  // them into a second context.
  private static readonly ParticipantHandle = class implements Participant {
    private readonly endpoint: ChannelEndpoint;
    constructor(readonly name: string, private readonly owner: SqliteSquare, private readonly seat: Seat) {
      this.endpoint = new ChannelEndpoint(owner.channel, seat);
    }
    get generation() { return this.endpoint.generation; }

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
        name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
        const seat = this.seat;
        const context = !options.observe ? undefined : (await square.artifact.read(
          facts => expressionContext(facts, name), control?.signal)).value;
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
              const decision = rejectUnsentActivity(() => {
                if (proposed.type === 'blocked') throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { pending: proposed.activitySummaries.reduce((count, summary) => count + summary.count, 0) });
                if (proposed.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`);
                if (proposed.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: proposed.delayMs });
                if (proposed.type === 'bell_quota') throw new SquareError('bell_quota', `${participantIdentity(name)} cannot ring the bell yet`, { retryAfterMs: Math.max(1, proposed.nextAt - now) });
                return proposed;
              });
              const stored = facts.land(decision.act);
              // One explicit projection: a landed say resolves its own Channel content in this transaction.
              const activity = stored.kind === 'say' ? facts.activities([stored.index])[0] : stored;
              if (activity === undefined) throw new SquareError('io', 'The landed activity is missing.');
              return { stored, activity, standingCount: inSquareCount(facts),
                ownActivityCount: facts.participant(name)!.sayCount, hardCap: facts.header().hardCap,
                ...(decision.unmatchedMentions === undefined ? {} : { unmatchedMentions: decision.unmatchedMentions }),
                ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }) };
            }, control?.signal)).value;
            landedId = formatActivityId(committed.stored.index);
            effect = 'landed';
            await square.channel.deliver(committed.stored.kind === 'say' ? committed.stored.messageIndex : undefined);
            const { stored, activity, standingCount, ownActivityCount, hardCap, ...metadata } = committed;
            const hint = expressHint(ownActivityCount);
            return { activity: toPublicActivity(activity), ...metadata,
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
      const name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      checkControl(control);
      const seat = this.seat, now = square.clock();
      return (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const act = attentionChange(facts, verb, name, target, now);
        const activity = act === undefined ? null : toPublicActivity(facts.land(act));
        return { activity, ...(!options.observe ? {} : { observation: {
          ...square.observation(inSquareCount(facts), name, now), participant: name,
          target: activity?.target ?? target,
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
        return { listening: coreListening(facts, name), ...(!options.observe ? {} : { observation: square.observation(inSquareCount(facts), name) }) };
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
      let selection = options;
      const idle = options.idle ?? 0;
      const complete = async (caught: CatchSelection | undefined, reason: CatchReason = 'drained'): Promise<CatchResult> => {
        const view = caught ?? (await square.artifact.read(facts => observeCatchSelection(facts, name, [], {
          unseenOnly: true, senders: selection.from, ...(selection.mention === true ? { attentionOnly: true } : {}),
        }, square.clock()))).value;
        if (reason === 'drained') reason = view.terminalStatus ?? reason;
        if (leaseId !== undefined) {
          await releaseWatchLease(square.artifact, seat!, leaseId).catch(() => undefined);
          leaseId = undefined;
        }
        let presence;
        if (options.observe) {
          try { presence = (await square.artifact.read(facts => catchPresence(facts, square.clock()), control?.signal)).value; }
          catch { /* Optional presence cannot erase the completed selection or receipts. */ }
        }
        return { activities: view.activities, remaining: view.remaining, reason,
          ...(view.hint === undefined ? {} : { hint: view.hint }), ...(!options.observe ? {} : { observation: {
            ...square.observation(view.standingCount, view.participant, view.now), participant: view.participant,
            deliveryAvailable: view.deliveryAvailable,
            ownActivityCount: view.ownActivityCount, hardCap: view.hardCap,
            ...(presence === undefined ? { enrichmentUnavailable: true as const } : { presence }),
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
          seat = this.seat;
          assertCurrentSeat(facts, asSeatRef(seat));
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
          return await complete(data);
        }
        const watch: WatchOptions = {
          ...(selection.from === undefined ? {} : { participants: [...selection.from] }), ...(options.mention ? { mention: name } : {}),
          ...(options.replace === undefined ? {} : { replace: options.replace }),
        };
        const start = await acquireWatchLease(square.artifact, seat!, square.clock(), crypto.randomUUID(), watch, control?.signal);
        if (start.type === 'active') return await complete(undefined, 'already-active');
        leaseId = start.leaseId;
        control?.onProgress?.({ kind: 'catch-started', participant: name, idleMs: idle, replacementRequested: options.replace ?? false, replaced: start.replaced });
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
          const caught = await this.catchPage(name, seat!, selection, control, leaseId);
          if (caught === null) return await complete(undefined, 'replaced');
          if (caught.activities.length > 0) return await complete(caught);
          if (square.clock() - quietSince >= idle) {
            const owns = await ownsWatchLease(square.artifact, seat!, square.clock(), leaseId, control?.signal);
            return await complete(undefined, owns ? 'idle' : 'replaced');
          }
          const deadline = Math.min(nextHeartbeat, quietSince + idle);
          await square.artifact.changed(baseline, Math.max(0, deadline - square.clock()), control?.signal);
        }
      } catch (error) {
        throw failure(error, { operation: 'catch', subject, participant: name });
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
      // Pending follows the shared archive cursor: act/N with before/after, never a Channel msg/N cursor.
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
    ack(ids: readonly ActivityId[], control?: OperationControl): Promise<AckResult> {
      const square = this.owner;
      return square.artifact.transactAs(participantAuthority(this.seat), facts => {
        const indexes: number[] = [];
        for (const id of ids) {
          const activity = facts.activity(parseRequiredActivityId(id));
          if (activity?.kind !== 'say' || activity.messageIndex === undefined)
            throw new SquareError('invalid_args', `${id} is not addressed to you.`, { reason: 'not_addressed', activityId: id });
          const head = facts.directed(this.name, { indexes: [activity.index], kinds: ['say'] }, { edge: 'oldest', limit: 1 }).items[0];
          if (head === undefined) throw new SquareError('invalid_args', `${id} is not addressed to you.`, { reason: 'not_addressed', activityId: id });
          indexes.push(activity.messageIndex);
        }
        return { consumed: facts.channel.markSeen(this.name, indexes, square.clock()) };
      }, control?.signal).then(result => result.value);
    }
    deferDelivery(input: Readonly<{ match: MetadataMatch; durationMs: number }>, control?: OperationControl): Promise<DeliveryDeferral> {
      return this.endpoint.deferDelivery(input, control);
    }
    renewDeliveryDeferral(id: string, durationMs: number, control?: OperationControl): Promise<DeliveryDeferral | null> {
      return this.endpoint.renewDeliveryDeferral(id, durationMs, control);
    }
    releaseDeliveryDeferral(id: string, control?: OperationControl): Promise<boolean> {
      return this.endpoint.releaseDeliveryDeferral(id, control);
    }
    async done(body?: string, options: ObservationOptions = {}, control?: OperationControl): Promise<LifecycleResult> {
      validateDoneBody(body);
      const square = this.owner;
      const name = (await square.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      const seat = this.seat, now = square.clock();
      return (await square.artifact.transactAs(participantAuthority(seat), facts => {
        const stored = facts.land(coreDone(facts, name, body ?? '', now));
        return { activity: toPublicActivity(stored), ...(!options.observe ? {} : { observation:
          square.observation(inSquareCount(facts), name, now),
        }) };
      }, control?.signal)).value;
    }
  };

  send(input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> {
    return this.channel.send(input, control);
  }

  async participant(name: string, options: { readonly owner: Owner }): Promise<Participant> {
    return this.handle(await this.requiredSeat(name, options));
  }
  async join(requested: string, options: JoinOptions, control?: OperationControl): Promise<JoinResult> {
    let name = requested;
    try {
      checkControl(control);
      name = requireJoinName(requested);
      const committed = await this.joinSeat(name, options, control);
      const participant = this.handle(committed.seat);
      const result = { participant, activity: committed.activity, kind: committed.kind,
        ...(committed.observation === undefined ? {} : { observation: committed.observation }) };
      if (!options.observe) return result;
      let entry;
      try { entry = (await this.artifact.read(facts => entryPresentation(facts, participant.name, options.last ?? HISTORY_DEFAULT_LIMIT), control?.signal)).value; }
      catch { /* Keep the committed join even when optional history is unavailable. */ }
      return { ...result, observation: { ...committed.observation!,
        ...(entry === undefined ? { enrichmentUnavailable: true as const } : { entry }) } };
    } catch (error) {
      throw failure(error, { operation: 'join', subject: 'caller', participant: name });
    }
  }
  async reattach(name: string, { owner, wakeAddress }: Pick<JoinOptions, 'owner' | 'wakeAddress'>, control?: OperationControl): Promise<Participant | null> {
    const seat = await this.reattachSeat(name, { owner, wakeAddress }, control);
    return seat === null ? null : this.handle(seat);
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
    return (await this.artifact.read(facts =>
      queryStatus(facts, { location: this.location, now: this.clock() }, options.viewer, options.observe === true), control?.signal)).value;
  }
  async participants(options: ObservationOptions = {}, control?: OperationControl): Promise<ParticipantsResult> {
    return (await this.artifact.read(facts => queryParticipants(facts, {
      location: this.location, now: this.clock(),
    }, options.observe === true), control?.signal)).value;
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
    return this.channel.endpointsOf(owner);
  }
  close(): Promise<void> { return this.channel.close(); }
  cancelDeliveries(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<boolean> {
    return this.cancelHeld(name, identity);
  }
  detach(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<true | null> {
    return this.channel.detach(name, identity);
  }
  endHeld(name: string, identity: { readonly owner: Owner; readonly generation: string }): Promise<LifecycleResult | null> {
    return this.endHeldSeat(name, identity);
  }
}

export function diagnoseSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); return diagnoseSquareFile(squareLocation(input)); }
export function discover(input: SquareAtInput, options: DiscoveryOptions = {}, control?: OperationControl) {
  if (input.path !== undefined || (input.env ?? process.env).SQUARE_LOCATION) squareLocation(input);
  const env = { ...(input.env ?? process.env) };
  return discoverSquares(input.cwd ?? process.cwd(), options, control, { clock: squareClock(env, input.clock) });
}
export async function inbox(input: SquareAtInput, owner: Owner, options: InboxOptions = {}, control?: OperationControl): Promise<InboxResult> {
  checkControl(control);
  requireOwner(owner);
  const env = { ...(input.env ?? process.env) }, limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SquareError('invalid_args', 'Inbox limit must be between 1 and 100');
  const rows = await sessionInboxCounts({ owner, env }, control?.signal);
  checkControl(control);
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  rows.sort((a, b) => compare(a.squarePath, b.squarePath) || compare(nameKey(a.name), nameKey(b.name)) || compare(a.name, b.name));
  return { rows: rows.slice(0, limit), total: rows.length };
}
