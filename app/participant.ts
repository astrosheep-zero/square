import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { activityQueryFilter, type ActivityQuery } from '../core/activity-query.js';
import { attentionChange, coreDone, coreListening, decideAct, resolveKnownName } from '../core/decisions.js';
import { validateMetadataMatch } from '../core/delivery-deferral.js';
import { expressHint } from '../core/hints.js';
import { SquareError, isSquareError, nameKey, validateName, type Seat, type WatchOptions } from '../core/model.js';
import { checkControl, failure, type OperationControl } from '../core/neutral.js';
import { decidePerceive, observePerceiveSelection, perceiveFilter, selectPerceivePage, type PerceiveReason, type PerceiveSelection } from '../core/perceive-decisions.js';
import type { FutureAck, SquareRead } from '../core/ports.js';
import { WATCH_HEARTBEAT_MS, asSeatRef, inSquareCount, participantAuthority } from '../core/runtime.js';
import { formatActivityId, parseActivityId, PAGE_CAP, type ActivityId } from '../core/square-core.js';
import { assertCurrentSeat } from '../core/square-domain.js';
import { participantIdentity } from '../core/square-values.js';
import { parseRequiredActivityId, toPerceivedActivity, toPublicActivity, type Activity, type PerceivedActivity } from '../core/observations.js';
import { muteDeadline, parseDurationMs } from '../core/time.js';
import { parseOperation, type AttentionInput, type ExpressInput, type ExpressOptions, type MuteInput, type PerceiveOptions } from '../surfaces/operations.js';
import { DeliveryLedger } from '../ledger/delivery-ledger.js';
import { seatMuteId, seatMutePrefix } from './square-notification-mute.js';
import { flush, reconcile, type SquareResource } from './square-posting.js';
import { acquireWatchLease, ownsWatchLease, pulseWatchLease, releaseWatchLease } from '../core/wakes.js';

export interface AckResult { readonly consumed: number }
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
  readonly location: string;
  readonly standingCount: number;
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
  readonly context: ExpressContext;
}
export interface ListenerChangeResult {
  readonly activity: Activity | null;
  readonly standingCount: number;
  readonly participant: string;
  readonly target: string;
}
export interface ListeningResult {
  readonly listening: readonly string[];
  readonly standingCount: number;
}
export interface MuteResult {
  readonly mutedUntil: number | null;
  readonly participant: string;
  readonly standingCount: number;
}
export interface LifecycleResult {
  readonly activity: Activity;
  readonly location: string;
  readonly standingCount: number;
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
  readonly location: string;
  readonly participant: string;
  readonly standingCount: number;
  readonly now: number;
  readonly ownActivityCount: number;
  readonly hardCap: number | null;
}
export interface Participant {
  readonly name: string;
  readonly generation: string;
  express(body: string | undefined, options?: ExpressOptions, control?: OperationControl): Promise<ExpressResult>;
  express(input: ExpressInput, control?: OperationControl): Promise<ExpressResult>;
  attention(input: AttentionInput, control?: OperationControl): Promise<ListenerChangeResult>;
  listening(control?: OperationControl): Promise<ListeningResult>;
  mute(input: MuteInput, control?: OperationControl): Promise<MuteResult>;
  perceive(options?: PerceiveOptions, control?: OperationControl): Promise<PerceiveResult>;
  pending(options?: PendingOptions, control?: OperationControl): Promise<PendingResult>;
  /** Local custody only: ledger-only detach/delete is observed on privileged reconciliation. */
  ack(ids: readonly ActivityId[], control?: OperationControl): Promise<AckResult>;
  ack(input: FutureAck, control?: OperationControl): Promise<AckResult>;
  /** Leave without a message. Only an omitted or empty body is accepted. */
  done(body?: string, control?: OperationControl): Promise<LifecycleResult>;
}
export interface ExpressContext {
  readonly activities: readonly { readonly id: ActivityId; readonly actor: string; readonly preview: string; readonly truncated: boolean }[];
  /** Unread activities outside this preview, not a consumption cursor. */
  readonly remaining: number;
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
  constructor(private readonly seat: Seat, private readonly resource: SquareResource) {}
  get name() { return this.seat.participant; }
  get generation() { return this.seat.generation; }

  async express(bodyOrInput: string | undefined | ExpressInput, optionsOrControl: ExpressOptions | OperationControl = {}, operationControl?: OperationControl): Promise<ExpressResult> {
    const input = typeof bodyOrInput === 'object' && bodyOrInput !== null ? bodyOrInput : undefined;
    const control = input === undefined ? operationControl : optionsOrControl as OperationControl;
    let name = this.name, effect: 'unsent' | 'unknown' | 'landed' = 'unsent';
    let landedId: ExpressResult['activity']['id'] | undefined;
    try {
      checkControl(control);
      const { body, ...options } = parseOperation('express', input ?? { ...optionsOrControl, body: bodyOrInput });
      const reply = options.reply === undefined ? undefined : parseActivityId(options.reply);
      await reconcile(this.resource, control?.signal);
      name = (await this.resource.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
      const seat = this.seat;
      while (true) {
        checkControl(control);
        try {
          const awayByName = new Map((await reconcile(this.resource, control?.signal)).map(seat => [nameKey(seat.participant), seat]));
          effect = 'unknown';
          const now = this.resource.clock();

          const committed = (await this.resource.artifact.transactAs(participantAuthority(seat), facts => {
            // Decoding selected rows is storage work, not proof of safe admission refusal.
            const proposed = decideAct(facts, { name, body, force: options.force ?? false, metadata: options.metadata, now, mentions: options.mentions, reply });
            const decision = rejectUnsentActivity(() => {
              if (proposed.type === 'blocked') throw new SquareError('behind', `${participantIdentity(name)} has pending activity`, { activitySummaries: proposed.activitySummaries });
              if (proposed.type === 'capped') throw new SquareError('capped', `${participantIdentity(name)} reached the activity cap`, { spoken: facts.participant(name)!.sayCount, ...(facts.header().hardCap == null ? {} : { hardCap: facts.header().hardCap! }) });
              if (proposed.type === 'throttled') throw new SquareError('throttled', `${name} is throttled`, { retryAfterMs: proposed.delayMs });
              return proposed;
            });
            const context = expressionContext(facts, name);
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
            const ownActivityCount = facts.participant(name)!.sayCount;
            const hint = expressHint(ownActivityCount);
            return { stored, standingCount: inSquareCount(facts),
              ownActivityCount, hardCap: facts.header().hardCap, context,
              ...(hint === undefined ? {} : { hint }), ...(awayRecipients.length === 0 ? {} : { awayRecipients }),
              ...(decision.unmatchedMentions === undefined ? {} : { unmatchedMentions: decision.unmatchedMentions }),
              ...(decision.replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere: decision.replyAuthorNotHere }) };
          }, control?.signal)).value;
          const { stored, ...result } = committed;
          landedId = formatActivityId(stored.index);
          effect = 'landed';
          await flush(this.resource, control?.signal);
          return { ...result, activity: toPublicActivity(stored), location: this.resource.location };
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

  async attention(input: AttentionInput, control?: OperationControl): Promise<ListenerChangeResult> {
    checkControl(control);
    const { state, target } = parseOperation('attention', input);
    await reconcile(this.resource, control?.signal);
    const name = (await this.resource.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
    const seat = this.seat, now = this.resource.clock();
    const result = (await this.resource.artifact.transactAs(participantAuthority(seat), facts => {
      const act = attentionChange(facts, state === 'neutral' ? 'unlisten' : state, name, target, now);
      const activity = act === undefined ? null : toPublicActivity(facts.land(act));
      return { activity, standingCount: inSquareCount(facts), participant: name, target: activity?.target ?? target };
    }, control?.signal)).value;
    await flush(this.resource, control?.signal);
    return result;
  }
  async listening(control?: OperationControl): Promise<ListeningResult> {
    return (await this.resource.artifact.read(facts => ({
      listening: coreListening(facts, resolveKnownName(facts, this.name)), standingCount: inSquareCount(facts),
    }), control?.signal)).value;
  }
  /** Install or release only this captured seat generation's named hold. */
  async mute(input: MuteInput, control?: OperationControl): Promise<MuteResult> {
    const seat = this.seat;
    checkControl(control);
    const { duration } = parseOperation('mute', input);
    const now = this.resource.clock();
    const expiresAt = duration === 'off' ? undefined : muteDeadline(now, parseDurationMs(duration)!);
    const prefix = seatMutePrefix(this.resource.canonicalLocation, seat);
    const id = seatMuteId(seat.owner, prefix);
    const readCaptured = <T>(select: (facts: SquareRead) => T) => this.resource.artifact.read(facts => {
      assertCurrentSeat(facts, asSeatRef(seat));
      if (!facts.participant(seat.participant)?.joined)
        throw new SquareError('already_joined', 'This participant is no longer standing here.', { reason: 'needs_seat' });
      return select(facts);
    }, control?.signal);
    await readCaptured(() => undefined);
    const ledger = await DeliveryLedger.open({ location: this.resource.ledgerLocation, clock: this.resource.clock, signal: control?.signal });
    try {
      if (expiresAt !== undefined) await ledger.setSuppression({ owner: seat.owner, id, key: prefix, scope: 'prefix', expiresAt }, control?.signal);
      else await ledger.releaseSuppression({ owner: seat.owner, id }, control?.signal);
      try { return { mutedUntil: expiresAt ?? null, participant: seat.participant, standingCount: (await readCaptured(inSquareCount)).value }; }
      catch (error) {
        if (expiresAt !== undefined && isSquareError(error) && error.code === 'already_joined')
          await ledger.releaseSuppression({ owner: seat.owner, id }, control?.signal).catch(() => undefined);
        throw error;
      }
    } finally { await ledger.close(); }
  }

  /** Receipt selection rechecks the lease inside the writer, not at its last heartbeat. */
  private async perceivePage(name: string, seat: Seat, options: PerceiveOptions, control?: OperationControl, leaseId?: string): Promise<PerceiveSelection | null> {
    return (await this.resource.artifact.transactAs(participantAuthority(seat), facts => {
      if (leaseId !== undefined && facts.lease(name)?.leaseId !== leaseId) return null;
      return decidePerceive(facts, name, options, this.resource.clock());
    }, control?.signal)).value;
  }
  async perceive(options: PerceiveOptions = {}, control?: OperationControl): Promise<PerceiveResult> {
    let name = this.name, subject: 'caller' | 'filter' = 'caller';
    let leaseId: string | undefined, seat: Seat | undefined;
    let selection = options;
    const complete = async (perceived: PerceiveSelection | undefined, reason: PerceiveReason = 'drained'): Promise<PerceiveResult> => {
      const view = perceived ?? (await this.resource.artifact.read(facts =>
        observePerceiveSelection(facts, name, [], perceiveFilter(selection), this.resource.clock()))).value;
      if (reason === 'drained') reason = view.terminalStatus ?? reason;
      await flush(this.resource, control?.signal);
      if (leaseId !== undefined) {
        await releaseWatchLease(this.resource.artifact, seat!, leaseId).catch(() => undefined);
        leaseId = undefined;
      }
      const { terminalStatus: _terminalStatus, ...result } = view;
      return { ...result, reason, location: this.resource.location };
    };
    try {
      checkControl(control);
      options = parseOperation('perceive', options);
      const wait = options.wait === undefined ? 0 : parseDurationMs(options.wait)!;
      await reconcile(this.resource, control?.signal);
      validateName(name);
      const probe = (await this.resource.artifact.read(facts => {
        name = resolveKnownName(facts, this.name);
        seat = this.seat;
        assertCurrentSeat(facts, asSeatRef(seat));
        subject = 'filter';
        const from = options.from?.map(target => resolveKnownName(facts, target));
        selection = { ...options, ...(from === undefined ? {} : { from }) };
        subject = 'caller';
        if (wait !== 0) return undefined;
        const page = selectPerceivePage(facts, name, selection);
        return page.indexes.length === 0 ? observePerceiveSelection(facts, page.participant, [], page.filter, this.resource.clock()) : undefined;
      }, control?.signal)).value;
      if (wait === 0) {
        const data = probe ?? (await this.perceivePage(name, seat!, selection, control))!;
        return await complete(data);
      }
      const watch: WatchOptions = {
        // The stored lease can reserve by sender, not by ID. Do not reserve unrelated deliveries.
        participants: selection.ids === undefined ? selection.from : [], mention: options.mention ? name : undefined, replace: options.replace,
      };
      const start = await acquireWatchLease(this.resource.artifact, seat!, this.resource.clock(), crypto.randomUUID(), watch, control?.signal);
      if (start.type === 'active') return await complete(undefined, 'already-active');
      leaseId = start.leaseId;
      control?.onProgress?.({ kind: 'perceive-started', participant: name, waitMs: wait, replacementRequested: options.replace ?? false, replaced: start.replaced });
      const quietSince = this.resource.clock();
      let nextHeartbeat = start.heartbeatAt + WATCH_HEARTBEAT_MS;
      while (true) {
        checkControl(control);
        // Arm before selecting: a commit during selection must not be missed.
        const baseline = await this.resource.artifact.revision(control?.signal);
        const pulse = await pulseWatchLease(this.resource.artifact, seat!, this.resource.clock(), leaseId, watch, this.resource.clock() >= nextHeartbeat, control?.signal);
        if (pulse.type === 'replaced') return await complete(undefined, 'replaced');
        if (pulse.type === 'terminal') return await complete(undefined, pulse.status);
        if (pulse.heartbeatAt !== undefined) nextHeartbeat = pulse.heartbeatAt + WATCH_HEARTBEAT_MS;
        await reconcile(this.resource, control?.signal);
        const perceived = await this.perceivePage(name, seat!, selection, control, leaseId);
        if (perceived === null) return await complete(undefined, 'replaced');
        if (perceived.activities.length > 0) return await complete(perceived);
        if (this.resource.clock() - quietSince >= wait) {
          const owns = await ownsWatchLease(this.resource.artifact, seat!, this.resource.clock(), leaseId, control?.signal);
          return await complete(undefined, owns ? 'idle' : 'replaced');
        }
        const deadline = Math.min(nextHeartbeat, quietSince + wait);
        await this.resource.artifact.changed(baseline, Math.max(0, deadline - this.resource.clock()), control?.signal);
      }
    } catch (error) {
      throw failure(error, { operation: 'perceive', subject, participant: name });
    } finally {
      // Cancellation releases only this captured generation and this lease.
      if (leaseId !== undefined) await releaseWatchLease(this.resource.artifact, seat!, leaseId).catch(() => undefined);
    }
  }
  async pending(options: PendingOptions = {}, control?: OperationControl): Promise<PendingResult> {
    checkControl(control);
    const limit = options.limit ?? PAGE_CAP;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_CAP)
      throw new SquareError('invalid_args', `Pending limit must be a positive integer no greater than ${PAGE_CAP}.`);
    // Pending follows the shared archive cursor: act/N with before/after.
    const shared = activityQueryFilter(options);
    const filter = { kinds: ['say'] as const, unseenOnly: true as const,
      ...(shared.indexes === undefined ? {} : { indexes: shared.indexes }),
      ...(shared.actors === undefined ? {} : { senders: shared.actors }),
      ...(shared.metadataMatch === undefined ? {} : { metadataMatch: shared.metadataMatch }),
      ...(shared.search === undefined ? {} : { search: shared.search }),
      ...(shared.afterIndex === undefined ? {} : { afterIndex: shared.afterIndex }),
      ...(shared.beforeIndex === undefined ? {} : { beforeIndex: shared.beforeIndex }) };
    return (await this.resource.artifact.read(facts => {
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
    return this.resource.artifact.transactAs(participantAuthority(this.seat), facts => {
      if (!Array.isArray(input)) {
        const exact = input as FutureAck;
        if (exact?.future !== 'exact') throw new SquareError('invalid_args', 'Ack requires an exact future predicate.');
        validateName(exact.from);
        return { consumed: facts.ackMatching(asSeatRef(this.seat), { from: exact.from, match: validateMetadataMatch(exact.match), future: 'exact' }, this.resource.clock()) };
      }
      const indexes: number[] = [];
      for (const id of input) {
        const index = parseRequiredActivityId(id);
        if (facts.activity(index)?.kind !== 'say' || facts.directedAt(this.name, index) === undefined)
          throw new SquareError('invalid_args', `${id} is not addressed to you.`);
        indexes.push(index);
      }
      return { consumed: facts.markSeen(this.name, indexes, this.resource.clock()) };
    }, control?.signal).then(result => result.value);
  }
  async done(body?: string, control?: OperationControl): Promise<LifecycleResult> {
    parseOperation('done', { body });
    checkControl(control);
    await reconcile(this.resource, control?.signal);
    const name = (await this.resource.artifact.read(facts => resolveKnownName(facts, this.name), control?.signal)).value;
    const seat = this.seat, now = this.resource.clock();
    const result = (await this.resource.artifact.transactAs(participantAuthority(seat), facts => {
      const stored = facts.land(coreDone(facts, name, now));
      return { activity: toPublicActivity(stored), location: this.resource.location, standingCount: inSquareCount(facts) };
    }, control?.signal)).value;
    await flush(this.resource, control?.signal);
    return result;
  }
}
