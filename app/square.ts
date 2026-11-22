import crypto from 'node:crypto';
import path from 'node:path';
import { createArtifactPort, createSquare, diagnoseSquareFile, prepareSquareBuild } from '../artifact/artifact.js';
import { coreDone, decideJoin } from '../core/decisions.js';
import { InternalSquareError, SquareError, validateName, type Owner, type Seat, type WakeAddress } from '../core/model.js';
import { checkControl, failure, squareLocation, type ObservationOptions, type OperationControl, type SquareLocation, type UnreadActivitySummary } from '../core/neutral.js';
import type { SendInput, SendResult } from '../core/ports.js';
import { inSquareCount, presenceAnchor, requireJoinName, requireOwner } from '../core/runtime.js';
import { participantIdentity } from '../core/square-values.js';
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, NON_READ, entryPresentation, publicActivities, queryParticipants, queryStatus,
  recoveryObservation, selectHistory, toPublicActivity, type Activity, type EntryPresentation, type HistoryObservation,
  type HistoryQuery, type ParticipantsResult, type PerceivedActivity, type SquareObservation, type StatusOptions, type StatusResult } from '../core/observations.js';
import { deliveryLedgerLocation } from '../ledger/delivery-ledger.js';
import { canonicalPath } from '../storage/canonical-path.js';
import { SeatedParticipant, type Participant } from './participant.js';
import { ensureInitialDeliverySession, flush, observation, reconcile, withHostPresence, type DispatchPostedCard, type SquareResource } from './square-posting.js';
import { streamSquare, type StreamOptions, type StreamRecord } from './stream.js';

export interface HeldSeat { readonly name: string; readonly generation: string }
export interface OpenOptions {
  readonly clock?: () => number;
  readonly ledgerLocation?: string;
}
export interface SquareAtInput extends SquareLocation, OpenOptions {}
export interface SquareBuildInput extends SquareAtInput {
  readonly markdown: string;
  readonly hardCap?: number | null;
  readonly throttlePerMinute?: number;
  readonly template?: string;
  readonly force?: boolean;
}
export interface JoinOptions extends ObservationOptions {
  readonly owner: Owner;
  readonly wakeAddress?: WakeAddress;
  readonly takeover?: boolean;
  readonly last?: number;
}
export interface JoinResult {
  readonly participant: Participant;
  readonly activity: Activity | null;
  readonly kind: 'joined' | 'reconnected' | 'taken-over';
  readonly observation?: JoinObservation;
}
export interface RecoveryResult {
  readonly participant?: string;
  readonly standingCount?: number;
  readonly ownActivityCount?: number;
  readonly hardCap?: number | null;
  readonly activitySummaries?: readonly UnreadActivitySummary[];
}
export interface HistoryResult {
  readonly activities: readonly Activity[];
  readonly observation?: HistoryObservation;
}
export interface JoinObservation extends SquareObservation {
  readonly deliveryAvailable: boolean;
  readonly entry?: EntryPresentation;
  /** The receipt succeeded, but optional recent-history/context enrichment was unavailable. */
  readonly enrichmentUnavailable?: true;
}
/** Resolve once at the resource entry; internal operations never choose a ledger. */
function resolveLedgerLocation(input: { readonly ledgerLocation?: string }): string {
  const location = input.ledgerLocation ?? deliveryLedgerLocation();
  if (typeof location !== 'string' || !path.isAbsolute(location)) throw new TypeError('Delivery location must be absolute');
  return location;
}

/** One concrete local resource, including its entry-resolved dependencies and lifetime. */
export class Square {
  readonly location: string;
  private constructor(private readonly resource: SquareResource) { this.location = resource.location; }

  static async at(input: SquareAtInput, dispatch: DispatchPostedCard, control?: OperationControl): Promise<Square> {
    const ledgerLocation = resolveLedgerLocation(input);
    const location = squareLocation(input);
    const clock = input.clock ?? Date.now;
    const artifact = createArtifactPort(location, undefined, control?.signal);
    try {
      await artifact.read(facts => facts.header(), control?.signal);
      return new Square({ location, artifact, clock, canonicalLocation: await canonicalPath(location), ledgerLocation, dispatch });
    } catch (error) {
      await artifact.close();
      if (error instanceof InternalSquareError && error.code === 'not_found')
        throw new SquareError('unavailable', `Square is unavailable at ${location}`);
      throw error;
    }
  }
  static async build(input: SquareBuildInput, dispatch: DispatchPostedCard, control?: OperationControl): Promise<Square> {
    checkControl(control);
    const ledgerLocation = resolveLedgerLocation(input);
    const location = squareLocation(input);
    await createSquare(location, { hardCap: input.hardCap, throttlePerMinute: input.throttlePerMinute,
      template: input.template, force: input.force ?? false }, input.markdown, control?.signal);
    // Publication already committed; cancellation cannot erase the completed build.
    return Square.at({ ...input, path: location, ledgerLocation }, dispatch);
  }
  static inMemory(input: Omit<SquareBuildInput, 'path'>, dispatch: DispatchPostedCard): Square {
    const clock = input.clock ?? Date.now;
    const location = `memory://${crypto.randomUUID()}`;
    const ledgerLocation = resolveLedgerLocation(input);
    return new Square({ location, artifact: createArtifactPort(':memory:', prepareSquareBuild(input, input.markdown)), clock, canonicalLocation: location, ledgerLocation, dispatch });
  }
  /** Join establishes membership and local producer custody in one transaction. */
  private async joinSeat(name: string, options: JoinOptions, control?: OperationControl): Promise<{ readonly seat: Seat; readonly kind: JoinResult['kind']; readonly activity: Activity | null; readonly observation?: JoinObservation }> {
    checkControl(control);
    const owner = requireOwner(options?.owner), now = this.resource.clock();
    const initial = !options.takeover ? undefined : (await this.resource.artifact.read(facts => facts.participant(name)?.joined ? facts.seat(name) : undefined, control?.signal)).value;
    const authority = initial === undefined ? { kind: 'join' as const, participant: name, owner }
      : { kind: 'takeover' as const, participant: initial.participant, owner, expectedGeneration: initial.generation };
    return (await this.resource.artifact.transactAs(authority, facts => {
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
        ...(!options.observe ? {} : { observation: { ...observation(this.resource, inSquareCount(facts), seat.participant, now),
          deliveryAvailable: false } }) };
    }, control?.signal)).value;
  }
  async participant(name: string, { owner }: { readonly owner: Owner }): Promise<Participant> {
    validateName(name);
    requireOwner(owner);
    const seat = (await this.resource.artifact.read(facts => {
      const participant = facts.participant(name), seat = facts.seat(name);
      if (!participant?.joined || seat === undefined || seat.owner !== owner || seat.attachment !== 'attached') {
        const reason = participant === undefined ? 'has never stepped into this square'
          : !participant.joined ? 'needs to join first'
          : seat !== undefined && seat.owner !== owner ? 'is not held by this owner; join before writing'
          : seat?.attachment === 'detached' ? 'is away; resume the host session first'
          : 'needs a current participant seat; join first';
        throw new SquareError('already_joined', `${participantIdentity(participant?.name ?? name)} ${reason}`, {
          reason: 'needs_seat',
        });
      }
      return seat;
    })).value;
    return new SeatedParticipant(seat, this.resource);
  }
  async send(input: SendInput, control?: OperationControl): Promise<SendResult> {
    checkControl(control);
    await reconcile(this.resource, control?.signal);
    const result = (await this.resource.artifact.transactAs({ kind: 'send', actor: input.from }, facts => facts.insertNotice(input, this.resource.clock()), control?.signal)).value;
    await flush(this.resource, control?.signal);
    return result;
  }

  async join(requested: string, options: JoinOptions, control?: OperationControl): Promise<JoinResult> {
    let name = requested;
    try {
      checkControl(control);
      name = requireJoinName(requested);
      const last = options.last ?? HISTORY_DEFAULT_LIMIT;
      if (!Number.isSafeInteger(last) || last < 1 || last > HISTORY_MAX_LIMIT) throw new SquareError('invalid_args', 'Join history limit must be between 1 and 100');
      if (!await ensureInitialDeliverySession(requireOwner(options.owner), options.wakeAddress, control?.signal, this.resource.ledgerLocation, this.resource.clock))
        throw new SquareError('already_joined', `${participantIdentity(name)} is away; resume the host session first`, { reason: 'needs_seat' });
      await reconcile(this.resource, control?.signal);
      const committed = await this.joinSeat(name, options, control);
      await flush(this.resource, control?.signal);
      const participant = new SeatedParticipant(committed.seat, this.resource);
      const result = { participant, activity: committed.activity, kind: committed.kind,
        ...(committed.observation === undefined ? {} : { observation: committed.observation }) };
      if (!options.observe) return result;
      let entry, deliveryAvailable = false;
      try {
        const observed = await withHostPresence(this.resource, (facts, available) => ({
          entry: entryPresentation(facts, participant.name, last),
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
    if (query.context !== undefined && (!Number.isSafeInteger(query.context) || query.context < 0 || query.context > HISTORY_MAX_LIMIT))
      throw new SquareError('invalid_args', `History context must be a non-negative integer no greater than ${HISTORY_MAX_LIMIT}`);
    const limit = query.limit === undefined ? (query.at?.length ? null : HISTORY_DEFAULT_LIMIT) : query.limit;
    const contextual = !!query.at?.length || query.context !== undefined;
    const kinds = contextual || query.since !== undefined ? [...NON_READ, 'read' as const] : NON_READ;
    return (await this.resource.artifact.read(facts => {
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
      return { activities, observation: { ...observation(this.resource, inSquareCount(facts)), ...selected,
        sayNumbers: facts.sayOrdinals(indexes), presenceAnchors } };
    }, control?.signal)).value;
  }
  async status(options: StatusOptions = {}, control?: OperationControl): Promise<StatusResult> {
    return withHostPresence(this.resource, (facts, available, mutes) => {
      const result = queryStatus(facts, { location: this.location, now: this.resource.clock() }, options.viewer, options.observe === true);
      return {
        ...result,
        ...(mutes.ledgerMutedUntil === undefined ? {} : { ledgerMutedUntil: mutes.ledgerMutedUntil }),
        participants: result.participants.map(person => {
          const mutedUntil = mutes.seat(person.name);
          return { ...person, deliveryAvailable: available(person.name), ...(mutedUntil === undefined ? {} : { mutedUntil }) };
        }),
      };
    }, control, true);
  }
  /** Local mode reads only World-known facts; it does not verify host attachment. */
  async participants(options: ObservationOptions & { readonly local?: boolean } = {}, control?: OperationControl): Promise<ParticipantsResult> {
    if (options.local) return (await this.resource.artifact.read(facts => {
      const result = queryParticipants(facts, { location: this.location, now: this.resource.clock() }, options.observe === true);
      return { ...result, participants: result.participants.map(person => ({ ...person, deliveryAvailable: false })) };
    }, control?.signal)).value;
    return withHostPresence(this.resource, (facts, available, mutes) => {
      const result = queryParticipants(facts, { location: this.location, now: this.resource.clock() }, options.observe === true);
      return { ...result, participants: result.participants.map(person => {
        const mutedUntil = mutes.seat(person.name);
        return { ...person, deliveryAvailable: available(person.name), ...(mutedUntil === undefined ? {} : { mutedUntil }) };
      }) };
    }, control, true);
  }
  async recovery(requested?: string, control?: OperationControl): Promise<RecoveryResult> {
    const facts = requested === undefined ? undefined : (await this.resource.artifact.read(facts => recoveryObservation(facts, requested, this.resource.clock()), control?.signal).catch(() => undefined))?.value;
    return facts ?? (await this.resource.artifact.read(facts => observation(this.resource, inSquareCount(facts), requested), control?.signal)).value;
  }
  stream(options: StreamOptions & { readonly recipient: string }, control?: OperationControl): AsyncIterable<PerceivedActivity>;
  stream(options: StreamOptions & { readonly recipient?: undefined }, control?: OperationControl): AsyncIterable<Activity>;
  stream(options: StreamOptions, control?: OperationControl): AsyncIterable<StreamRecord>;
  stream(options: StreamOptions, control?: OperationControl): AsyncIterable<StreamRecord> {
    // A path stream follows replacements independently of this connection's inode
    // and lifetime. Only explicit artifact readers borrow an existing port.
    return streamSquare(this.location, options, control);
  }
  async seatsOf(owner: Owner): Promise<readonly HeldSeat[]> {
    requireOwner(owner);
    return (await this.resource.artifact.read(facts => facts.seatsForOwner(owner)
      .filter(seat => facts.participant(seat.participant)?.joined && seat.attachment === 'attached')
      .map(seat => ({ name: seat.participant, generation: seat.generation })))).value;
  }
  close(): Promise<void> { return this.resource.artifact.close(); }
}

export function diagnoseSquare(input: SquareLocation, control?: OperationControl) { checkControl(control); return diagnoseSquareFile(squareLocation(input)); }
