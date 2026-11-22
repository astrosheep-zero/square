import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityQueryFilter, type ActivityQuery } from '../core/activity-query.js';
import { attentionChange, coreDone, coreListening, decideAct, resolveKnownName, validateDoneBody } from '../core/decisions.js';
import { validateMetadataMatch } from '../core/delivery-deferral.js';
import { expressHint } from '../core/hints.js';
import { SquareError, isSquareError, nameKey, validateName, type ActivityMetadata, type Seat, type WatchOptions } from '../core/model.js';
import { checkControl, failure, type ObservationOptions, type OperationControl } from '../core/neutral.js';
import { decidePerceive, observePerceiveSelection, perceiveLimit, selectPerceivePage, type PerceiveOptions, type PerceiveReason, type PerceiveSelection } from '../core/perceive-decisions.js';
import type { FutureAck, SquareArtifactPort, SquareRead } from '../core/ports.js';
import { WATCH_HEARTBEAT_MS, asSeatRef, inSquareCount, participantAuthority } from '../core/runtime.js';
import { formatActivityId, type ActivityId } from '../core/square-core.js';
import { assertCurrentSeat } from '../core/square-domain.js';
import { participantIdentity } from '../core/square-values.js';
import { parseRequiredActivityId, perceivePresence, toPerceivedActivity, toPublicActivity,
  type Activity, type PerceivePresence, type PerceivedActivity, type SquareObservation } from '../core/views.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from '../core/wakes.js';

export interface AckResult { readonly consumed: number }
export interface ExpressOptions extends ObservationOptions {
  readonly metadata?: ActivityMetadata;
  readonly force?: boolean;
  readonly mentions?: readonly string[];
  readonly reply?: ActivityId;
  readonly noMention?: boolean;
  readonly noWait?: boolean;
}
export interface ExpressInput extends ExpressOptions {
  readonly body?: string;
}
export interface ExpressResult {
  readonly activity: Activity;
  /** The replied-to author was not standing when the reply landed. */
  readonly replyAuthorNotHere?: string;
  /** Explicit mentions and body @name tokens with no standing match at landing; never stored on the activity. */
  readonly unmatchedMentions?: readonly string[];
  /** Directed joined targets observed detached before landing, fenced to the same owner/join generation; not delivery or unread evidence. */
  readonly awayRecipients?: readonly string[];
  /** Occasional participant-facing nudge; not part of the activity. */
  readonly hint?: string;
  readonly observation?: ExpressObservation;
}
export interface ListenerChangeResult {
  readonly activity: Activity | null;
  readonly observation?: ListenerObservation;
}
export interface ListeningResult {
  readonly listening: readonly string[];
  readonly observation?: SquareObservation;
}
export interface MuteResult {
  readonly mutedUntil: number | null;
  readonly observation?: SquareObservation;
}

export interface LifecycleResult {
  readonly activity: Activity;
  readonly observation?: SquareObservation;
}
export interface PendingOptions extends ActivityQuery {
  /** Oldest first; defaults to 100, maximum 100. */
  readonly limit?: number;
}
export interface PendingResult {
  readonly activities: readonly PerceivedActivity[];
  /** Matching unconsumed activities outside this page. */
  readonly remaining: number;
}
export interface PerceiveResult {
  readonly activities: readonly PerceivedActivity[];
  readonly remaining: number;
  readonly reason: PerceiveReason;
  /** Occasional participant-facing nudge; not part of any activity. */
  readonly hint?: string;
  readonly observation?: PerceiveObservation;
}
export interface Participant {
  readonly name: string;
  readonly generation: string;
  express(body: string | undefined, options?: ExpressOptions, control?: OperationControl): Promise<ExpressResult>;
  express(input: ExpressInput, control?: OperationControl): Promise<ExpressResult>;
  listen(target: string, options?: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult>;
  ignore(target: string, options?: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult>;
  unlisten(target: string, options?: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult>;
  listening(options?: ObservationOptions, control?: OperationControl): Promise<ListeningResult>;
  mute(input: { readonly durationMs: number }, options?: ObservationOptions, control?: OperationControl): Promise<MuteResult>;
  unmute(options?: ObservationOptions, control?: OperationControl): Promise<MuteResult>;
  perceive(options?: PerceiveOptions, control?: OperationControl): Promise<PerceiveResult>;
  pending(options?: PendingOptions, control?: OperationControl): Promise<PendingResult>;
  /** Local custody only: ledger-only detach/delete is observed on privileged reconciliation. */
  ack(ids: readonly ActivityId[], control?: OperationControl): Promise<AckResult>;
  ack(input: FutureAck, control?: OperationControl): Promise<AckResult>;
  /** Leave without a message. Only an omitted or empty body is accepted. */
  done(body?: string, options?: ObservationOptions, control?: OperationControl): Promise<LifecycleResult>;
}
export interface ExpressionObservation extends Pick<SquareObservation, 'standingCount' | 'now'> {
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
}
export interface ExpressContext {
  readonly activities: readonly { readonly id: ActivityId; readonly actor: string; readonly preview: string; readonly truncated: boolean }[];
  /** Unread activities outside this preview, not a consumption cursor. */
  readonly remaining: number;
}
export interface ExpressObservation extends SquareObservation, ExpressionObservation {
  readonly participant: string;
  readonly context: ExpressContext;
}
export interface PerceiveObservation extends SquareObservation, ExpressionObservation {
  readonly deliveryAvailable: boolean;
  readonly participant: string;
  readonly presence?: PerceivePresence;
  readonly enrichmentUnavailable?: true;
}
export interface ListenerObservation extends SquareObservation {
  readonly participant: string;
  readonly target: string;
}

const CONTEXT_LIMIT = 5;
const PREVIEW_CHARS = 400;

/** A bounded, nonconsuming glimpse; seen rows beyond a cursor hole must not reappear. */
export function expressionContext(facts: SquareRead, name: string): ExpressContext {
  const filter = { kinds: ['say'] as const, afterIndex: facts.participant(name)?.lastJoinIndex ?? -1, unseenOnly: true as const };
  const page = facts.directed(name, filter, { edge: 'newest', limit: CONTEXT_LIMIT });
  const activities = facts.activities(page.items.map(head => head.index)).filter(act => act.kind === 'say')
    .sort((a, b) => a.index - b.index).map(act => {
      const body = act.body ?? '(structured activity)';
      // Keep the boundary between Unicode code points, including non-BMP characters.
      const chars = Array.from(body.slice(0, PREVIEW_CHARS * 2));
      const preview = chars.slice(0, PREVIEW_CHARS).join('');
      return { id: formatActivityId(act.index), actor: act.actor, preview, truncated: preview.length < body.length };
    });
  return { activities, remaining: Math.max(0, facts.directedCount(name, filter) - activities.length) };
}

function rejectUnsentActivity<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) { if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true }; throw error; }
}

export class SeatedParticipant implements Participant {
  constructor(readonly name: string, private readonly seat: Seat,
    private readonly artifact: SquareArtifactPort, private readonly clock: () => number,
    private readonly changeSeatMute: (verb: 'mute' | 'unmute', durationMs: number | undefined, options: ObservationOptions, control?: OperationControl) => Promise<MuteResult>,
    private readonly reconcile: (signal?: AbortSignal) => Promise<readonly Seat[]>,
    private readonly flush: (signal?: AbortSignal) => Promise<void>,
    private readonly observation: (standingCount: number, participant?: string, now?: number) => SquareObservation,
    private readonly withHostPresence: <T>(select: (facts: SquareRead, available: (name: string) => boolean) => T,
      control?: OperationControl) => Promise<T>) {}
  get generation() { return this.seat.generation; }

  async express(bodyOrInput: string | undefined | ExpressInput, optionsOrControl: ExpressOptions | OperationControl = {}, operationControl?: OperationControl): Promise<ExpressResult> {
    const input = typeof bodyOrInput === 'object' && bodyOrInput !== null ? bodyOrInput : undefined;
    const body: string | undefined = typeof bodyOrInput === 'string' || bodyOrInput === undefined ? bodyOrInput : bodyOrInput.body;
    const options = (input ?? optionsOrControl) as ExpressOptions;
    const control = input === undefined ? operationControl : optionsOrControl as OperationControl;
    let name = this.name, effect: 'unsent' | 'unknown' | 'landed' = 'unsent';
    let landedId: ExpressResult['activity']['id'] | undefined;
    try {
      checkControl(control);
      if ('reach' in options || 'bell' in options)
        throw new SquareError('invalid_args', 'Express no longer accepts bell reach. Use named mentions instead.', { activityUnsent: true });
      await this.reconcile(control?.signal);
      name = (await this.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      const seat = this.seat;
      const context = !options.observe ? undefined : (await this.artifact.read(
        facts => expressionContext(facts, name), control?.signal)).value;
      while (true) {
        checkControl(control);
        try {
          const awayByName = new Map((await this.reconcile(control?.signal)).map(seat => [nameKey(seat.participant), seat]));
          effect = 'unknown';
          const now = this.clock();
          const reply = rejectUnsentActivity(() => {
            try { return options.reply === undefined ? undefined : parseRequiredActivityId(options.reply); }
            catch (error) {
              if (isSquareError(error)) error.facts = { ...error.facts, reason: 'invalid_reply', activityId: options.reply };
              throw error;
            }
          });
          const committed = (await this.artifact.transactAs(participantAuthority(seat), facts => {
            // Decoding selected rows is storage work, not proof of safe admission refusal.
            const proposed = decideAct(facts, { name, body, force: options.force ?? false, metadata: options.metadata, now, mentions: options.mentions,
              noMention: options.noMention, reply });
            const decision = rejectUnsentActivity(() => {
              if (proposed.type === 'blocked') throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { activitySummaries: proposed.activitySummaries });
              if (proposed.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`, { spoken: facts.participant(name)!.sayCount, ...(facts.header().hardCap == null ? {} : { hardCap: facts.header().hardCap! }) });
              if (proposed.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: proposed.delayMs });
              return proposed;
            });
            const stored = facts.land(decision.act);
            const awayRecipients: string[] = [];
            const replyAuthor = decision.act.reply === undefined ? undefined : facts.activity(decision.act.reply)?.actor;
            const targets = new Set([...(decision.act.mentions ?? []), ...(replyAuthor === undefined ? [] : [replyAuthor])].map(nameKey));
            for (const target of targets) {
              if (target === nameKey(name)) continue;
              const observed = awayByName.get(target);
              if (observed === undefined) continue;
              const current = facts.seat(target);
              if (facts.participant(target)?.joined && current?.owner === observed.owner && current.generation === observed.generation)
                awayRecipients.push(current.participant);
            }
            return { stored, standingCount: inSquareCount(facts),
              ...(awayRecipients.length === 0 ? {} : { awayRecipients }),
              ownActivityCount: facts.participant(name)!.sayCount, hardCap: facts.header().hardCap,
              ...(decision.unmatchedMentions === undefined ? {} : { unmatchedMentions: decision.unmatchedMentions }),
              ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }) };
          }, control?.signal)).value;
          landedId = formatActivityId(committed.stored.index);
          effect = 'landed';
          await this.flush(control?.signal);
          const { stored, standingCount, ownActivityCount, hardCap, ...metadata } = committed;
          const hint = expressHint(ownActivityCount);
          return { activity: toPublicActivity(stored), ...metadata,
            ...(hint === undefined ? {} : { hint }), ...(context === undefined ? {} : { observation: {
              ...this.observation(standingCount, name, now), ownActivityCount, hardCap, context, participant: name,
            } }) };
        } catch (error) {
          if (effect !== 'landed' && isSquareError(error) && error.facts?.activityUnsent === true) effect = 'unsent';
          if (effect === 'landed' || !isSquareError(error) || options.noWait || error.code !== 'throttled') throw error;
          control?.onProgress?.({ kind: 'waiting', reason: 'throttled', delayMs: error.facts?.retryAfterMs ?? 1 });
          await sleep(error.facts?.retryAfterMs ?? 1, undefined, { signal: control?.signal });
        }
      }
    } catch (error) {
      const recipient = isSquareError(error) && error.facts?.reason === 'not_standing';
      throw failure(error, { operation: 'express', participant: name, subject: recipient ? 'recipient' : 'caller', expressEffect: effect,
        ...(landedId === undefined ? {} : { landedId }) });
    }
  }

  private async listener(verb: 'listen' | 'ignore' | 'unlisten', target: string, options: ObservationOptions, control?: OperationControl): Promise<ListenerChangeResult> {
    checkControl(control);
    await this.reconcile(control?.signal);
    const name = (await this.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
    const seat = this.seat, now = this.clock();
    const result = (await this.artifact.transactAs(participantAuthority(seat), facts => {
      const act = attentionChange(facts, verb, name, target, now);
      const activity = act === undefined ? null : toPublicActivity(facts.land(act));
      return { activity, ...(!options.observe ? {} : { observation: {
        ...this.observation(inSquareCount(facts), name, now), participant: name,
        target: activity?.target ?? target,
      } }) };
    }, control?.signal)).value;
    await this.flush(control?.signal);
    return result;
  }
  listen(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('listen', target, options, control); }
  ignore(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('ignore', target, options, control); }
  unlisten(target: string, options: ObservationOptions = {}, control?: OperationControl) { return this.listener('unlisten', target, options, control); }
  async listening(options: ObservationOptions = {}, control?: OperationControl): Promise<ListeningResult> {
    return (await this.artifact.read(facts => {
      const name = resolveKnownName(facts, this.name);
      return { listening: coreListening(facts, name), ...(!options.observe ? {} : { observation: this.observation(inSquareCount(facts), name) }) };
    }, control?.signal)).value;
  }
  mute(input: { readonly durationMs: number }, options: ObservationOptions = {}, control?: OperationControl): Promise<MuteResult> {
    return this.changeSeatMute('mute', input?.durationMs, options, control);
  }
  unmute(options: ObservationOptions = {}, control?: OperationControl): Promise<MuteResult> {
    return this.changeSeatMute('unmute', undefined, options, control);
  }

  /** Receipt selection rechecks the lease inside the writer, not at its last heartbeat. */
  private async perceivePage(name: string, seat: Seat, options: PerceiveOptions, control?: OperationControl, leaseId?: string): Promise<PerceiveSelection | null> {
    return (await this.artifact.transactAs(participantAuthority(seat), facts => {
      if (leaseId !== undefined && facts.lease(name)?.leaseId !== leaseId) return null;
      return decidePerceive(facts, name, options, this.clock());
    }, control?.signal)).value;
  }
  async perceive(options: PerceiveOptions = {}, control?: OperationControl): Promise<PerceiveResult> {
    let name = this.name, subject: 'caller' | 'filter' = 'caller';
    let leaseId: string | undefined, seat: Seat | undefined;
    let selection = options;
    const idle = options.idle ?? 0;
    const complete = async (perceived: PerceiveSelection | undefined, reason: PerceiveReason = 'drained'): Promise<PerceiveResult> => {
      const view = perceived ?? (await this.artifact.read(facts => observePerceiveSelection(facts, name, [], {
        unseenOnly: true, senders: selection.from, ...(selection.mention === true ? { attentionOnly: true } : {}),
      }, this.clock()))).value;
      if (reason === 'drained') reason = view.terminalStatus ?? reason;
      await this.flush(control?.signal);
      if (leaseId !== undefined) {
        await releaseWatchLease(this.artifact, seat!, leaseId).catch(() => undefined);
        leaseId = undefined;
      }
      let presence, deliveryAvailable = false;
      if (options.observe) {
        try {
          const observed = await this.withHostPresence((facts, available) => {
            const data = perceivePresence(facts, this.clock());
            return { presence: { ...data, participants: data.participants.map(person => ({ ...person, deliveryAvailable: available(person.name) })) },
              deliveryAvailable: available(view.participant) };
          }, control);
          presence = observed.presence;
          deliveryAvailable = observed.deliveryAvailable;
        } catch { /* Optional presence cannot erase the completed selection or receipts. */ }
      }
      return { activities: view.activities, remaining: view.remaining, reason,
        ...(view.hint === undefined ? {} : { hint: view.hint }), ...(!options.observe ? {} : { observation: {
          ...this.observation(view.standingCount, view.participant, view.now), participant: view.participant,
          deliveryAvailable,
          ownActivityCount: view.ownActivityCount, hardCap: view.hardCap,
          ...(presence === undefined ? { enrichmentUnavailable: true as const } : { presence }),
        } }) };
    };
    try {
      checkControl(control);
      await this.reconcile(control?.signal);
      validateName(name);
      if (!Number.isFinite(idle) || idle < 0) throw new SquareError('invalid_args', 'Perceive idle duration must be a non-negative number');
      if (options.id !== undefined && ['idle', 'from', 'mention', 'limit', 'takeover'].some(key => Object.hasOwn(options, key)))
        throw new SquareError('invalid_args', 'Perceive id cannot be combined with idle, from, mention, limit or takeover');
      if (Object.hasOwn(options, 'takeover') && idle === 0) throw new SquareError('invalid_args', 'Perceive takeover requires a positive idle duration');
      perceiveLimit(options.limit);
      const probe = (await this.artifact.read(facts => {
        name = resolveKnownName(facts, this.name);
        seat = this.seat;
        assertCurrentSeat(facts, asSeatRef(seat));
        subject = 'filter';
        const from = options.from?.map(target => resolveKnownName(facts, target));
        selection = { ...options, ...(from === undefined ? {} : { from }) };
        subject = 'caller';
        if (idle !== 0 || options.id !== undefined) return undefined;
        const page = selectPerceivePage(facts, name, selection);
        return page.indexes.length === 0 ? observePerceiveSelection(facts, page.participant, [], page.filter, this.clock()) : undefined;
      }, control?.signal)).value;
      if (idle === 0) {
        const data = probe ?? (await this.perceivePage(name, seat!, selection, control))!;
        return await complete(data);
      }
      const watch: WatchOptions = {
        ...(selection.from === undefined ? {} : { participants: [...selection.from] }), ...(options.mention ? { mention: name } : {}),
        ...(options.takeover === undefined ? {} : { takeover: options.takeover }),
      };
      const start = await acquireWatchLease(this.artifact, seat!, this.clock(), crypto.randomUUID(), watch, control?.signal);
      if (start.type === 'active') return await complete(undefined, 'already-active');
      leaseId = start.leaseId;
      control?.onProgress?.({ kind: 'perceive-started', participant: name, idleMs: idle, replacementRequested: options.takeover ?? false, replaced: start.replaced });
      const quietSince = this.clock();
      let nextHeartbeat = start.heartbeatAt + WATCH_HEARTBEAT_MS;
      while (true) {
        checkControl(control);
        // Arm before selecting: a commit during selection must not be missed.
        const baseline = await this.artifact.revision(control?.signal);
        const pulse = await pulseWatchLease(this.artifact, seat!, this.clock(), leaseId, watch, this.clock() >= nextHeartbeat, control?.signal);
        if (pulse.type === 'replaced') return await complete(undefined, 'replaced');
        if (pulse.type === 'terminal') return await complete(undefined, pulse.status);
        if (pulse.heartbeatAt !== undefined) nextHeartbeat = pulse.heartbeatAt + WATCH_HEARTBEAT_MS;
        await this.reconcile(control?.signal);
        const perceived = await this.perceivePage(name, seat!, selection, control, leaseId);
        if (perceived === null) return await complete(undefined, 'replaced');
        if (perceived.activities.length > 0) return await complete(perceived);
        if (this.clock() - quietSince >= idle) {
          const owns = await ownsWatchLease(this.artifact, seat!, this.clock(), leaseId, control?.signal);
          return await complete(undefined, owns ? 'idle' : 'replaced');
        }
        const deadline = Math.min(nextHeartbeat, quietSince + idle);
        await this.artifact.changed(baseline, Math.max(0, deadline - this.clock()), control?.signal);
      }
    } catch (error) {
      throw failure(error, { operation: 'perceive', subject, participant: name });
    } finally {
      // Cancellation releases only this captured generation and this lease.
      if (leaseId !== undefined) await releaseWatchLease(this.artifact, seat!, leaseId).catch(() => undefined);
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
    return (await this.artifact.read(facts => {
      assertCurrentSeat(facts, asSeatRef(this.seat));
      const heads = facts.directed(this.name, filter, { edge: 'oldest', limit });
      return { activities: facts.activities(heads.items.map(head => head.index)).map(activity => toPerceivedActivity(facts, activity, this.name)),
        remaining: facts.directedCount(this.name, filter) - heads.items.length };
    }, control?.signal)).value;
  }
  ack(ids: readonly ActivityId[], control?: OperationControl): Promise<AckResult>;
  ack(input: FutureAck, control?: OperationControl): Promise<AckResult>;
  ack(input: readonly ActivityId[] | FutureAck, control?: OperationControl): Promise<AckResult> {
    checkControl(control);
    return this.artifact.transactAs(participantAuthority(this.seat), facts => {
      if (!Array.isArray(input)) {
        const exact = input as FutureAck;
        if (exact?.future !== 'exact') throw new SquareError('invalid_args', 'Ack requires an exact future predicate.');
        validateName(exact.from);
        return { consumed: facts.ackMatching(asSeatRef(this.seat), { from: exact.from, match: validateMetadataMatch(exact.match), future: 'exact' }, this.clock()) };
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
      return { consumed: facts.markSeen(this.name, indexes, this.clock()) };
    }, control?.signal).then(result => result.value);
  }
  async done(body?: string, options: ObservationOptions = {}, control?: OperationControl): Promise<LifecycleResult> {
    validateDoneBody(body);
    checkControl(control);
    await this.reconcile(control?.signal);
    const name = (await this.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
    const seat = this.seat, now = this.clock();
    const result = (await this.artifact.transactAs(participantAuthority(seat), facts => {
      const stored = facts.land(coreDone(facts, name, body ?? '', now));
      return { activity: toPublicActivity(stored), ...(!options.observe ? {} : { observation:
        this.observation(inSquareCount(facts), name, now),
      }) };
    }, control?.signal)).value;
    await this.flush(control?.signal);
    return result;
  }
}
