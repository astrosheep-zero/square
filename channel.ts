import crypto from 'node:crypto';

import { activityQueryFilter } from './activity-query.js';
import { createArtifactPort, createSquare, prepareSquareBuild } from './artifact.js';
import { canonicalPath } from './canonical-path.js';
import { codexWakeAddress } from './codex-address.js';
import { coreDone, decideJoin, resolveKnownName } from './decisions.js';
import { validateDeferralDuration, validateDeferralId, validateMetadataMatch } from './delivery-deferral.js';
import { deliverPending } from './delivery-operations.js';
import { InternalSquareError, activityMetadataHasContent, sameName, SquareError,
  validateActivityMetadata, validateName, type Owner, type Seat, type WakeAddress, type StoredAct } from './model.js';
import { createDefaultWakeTransport } from './notifications.js';
import { harnessOwner } from './owner.js';
import { harnessSessionSources, participantIdentity, type HarnessSessionChannel } from './participant-identity.js';
import { assertCurrentSeat } from './square-domain.js';
import type { SquareArtifactPort, WakeTransportPort, SquareResourceOwner, SquareRead, SquareWrite, ArtifactWriteAuthority, DirectedFilter } from './ports.js';
import { joinRecoveryCommand } from './presentation.js';
import { consumeReceived, selectReceivedHeads } from './receive.js';
import { inSquareCount } from './runtime.js';
import { asSeatRef, participantAuthority, requireJoinName, requireOwner } from './seats.js';
import { squareReceiveRead } from './square-receive.js';
import { formatActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
import { squareLocation } from './square-location.js';
import { rememberSquarePath, squareIndexPath } from './square-index.js';
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, parseRequiredActivityId, toPublicActivity } from './views.js';
import type { AckResult, Activity, ActivityId, ChannelEndpointSummary, ChannelMessage, ChannelReceiveResult, ChannelPendingResult, ChannelHistoryResult,
  ChannelSendInput, ChannelSendResult, DeliveryDeferral, HeldSeat, ChannelHistoryQuery,
  JoinOptions, JoinObservation, JoinResult, LifecycleResult, MetadataMatch, OperationControl, OperationFailureDetail,
  PendingOptions, SquareObservation } from './square-facade.js';

export { harnessOwner, decodeHarnessOwner, localUserOwner } from './owner.js';
export type { ActivityMetadata, ActivityQuery, ActivitySearch, ActivityCursor,
  ChannelTruncate, PendingOptions, ChannelPendingResult, ChannelHistoryResult, ChannelHistoryQuery, AckResult,
  ChannelEndpointSummary, ChannelMessage, ChannelReceiveResult } from './square-facade.js';
export type { ActivityId, ChannelSendInput, ChannelSendResult, DeliveryDeferral, HeldSeat, MetadataMatch,
  OperationControl, Owner, WakeAddress, SquareResourceOwner, WakeTransportPort, HarnessSessionChannel };

export interface ResolvedHarnessSession {
  readonly channel: HarnessSessionChannel;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly owner: Owner;
  readonly wakeAddress?: WakeAddress;
}

export function resolveHarnessSession(env: NodeJS.ProcessEnv = process.env): ResolvedHarnessSession | undefined {
  for (const { variable, channel } of harnessSessionSources) {
    const sessionId = env[variable]?.trim();
    if (!sessionId) continue;
    const agentId = channel === 'claude-code' && env.CLAUDE_CODE_CHILD_SESSION?.trim() === '1'
      ? env.CLAUDE_CODE_AGENT_ID?.trim() || undefined : undefined;
    const wakeAddress = channel === 'codex' ? codexWakeAddress(sessionId, env)
      : channel === 'paseo' ? { kind: 'paseo' as const, address: { agentId: sessionId } } : undefined;
    return { channel, sessionId, ...(agentId === undefined ? {} : { agentId }),
      owner: harnessOwner({ channel, session: sessionId, ...(agentId === undefined ? {} : { agent: agentId }) }),
      ...(wakeAddress === undefined ? {} : { wakeAddress }) };
  }
  return undefined;
}

export interface ChannelOpenInput {
  readonly path: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => number;
  readonly wakeTransport?: WakeTransportPort | false;
  readonly resources?: SquareResourceOwner;
}
export interface ChannelCreateInput extends ChannelOpenInput {
  readonly force?: boolean;
  readonly description?: string;
}
/** Every dependency one Channel needs; the artifact is already opened. */
export interface ChannelPortInit {
  readonly location: string;
  readonly artifact: SquareArtifactPort;
  readonly clock: () => number;
  readonly wakeTransport?: WakeTransportPort;
  readonly indexPath?: string;
  readonly closesArtifact?: boolean;
  readonly deliveryLocation?: string;
}
export interface ChannelJoinResult {
  readonly seat: Seat;
  readonly kind: JoinResult['kind'];
  readonly activity: Activity | null;
  readonly observation?: JoinObservation;
}

type EndpointOptions = { readonly owner: Owner; readonly wakeAddress?: WakeAddress };
type EndpointIdentity = { readonly owner: Owner; readonly generation: ActivityId };

export function checkControl(control?: OperationControl): void {
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

export function failure(error: unknown, detail: OperationFailureDetail): Error {
  const normalized = error instanceof Error ? error : new Error(String(error), { cause: error });
  Object.assign(normalized, { operation: detail });
  return normalized;
}

function explicitLocation(input: ChannelOpenInput): string {
  if (typeof input?.path !== 'string' || input.path.trim() === '')
    throw new SquareError('invalid_args', 'Channel path is required.');
  return squareLocation(input);
}

/** A generic managed address must not displace the receiver's native registration on reconnect. */
function canRefreshWakeAddress(current: WakeAddress | undefined, proposed: WakeAddress): boolean {
  return proposed.kind !== 'paseo' || current === undefined || current.kind === 'paseo';
}

/** Foundational point-to-point endpoint and messaging resource over one artifact port. */
export class Channel {
  private constructor(
    readonly location: string,
    readonly artifact: SquareArtifactPort,
    readonly clock: () => number,
    private readonly wakeTransport?: WakeTransportPort,
    private readonly indexPath?: string,
    private readonly closesArtifact = true,
    private readonly deliveryLocation = location,
  ) { }

  /** Internal composition point for the Agora resource; no wrapping square is involved. */
  static fromPort(init: ChannelPortInit): Channel {
    return new Channel(init.location, init.artifact, init.clock, init.wakeTransport,
      init.indexPath, init.closesArtifact ?? true, init.deliveryLocation ?? init.location);
  }

  static async open(input: ChannelOpenInput, control?: OperationControl): Promise<Channel> {
    const path = explicitLocation(input);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env, path });
    const clock = squareClock(env, input.clock);
    // A request can abort its own borrowed reads, never the owner's connection lifetime.
    const borrowed = input.resources?.artifact(location);
    const artifact = borrowed ?? createArtifactPort(location, undefined, control?.signal);
    const wakeTransport = input.wakeTransport !== undefined
      ? input.wakeTransport || undefined
      : await createDefaultWakeTransport(env).catch(() => undefined);
    try {
      await artifact.read(facts => facts.header(), control?.signal);
      return Channel.fromPort({ location, artifact, clock,
        ...(wakeTransport === undefined ? {} : { wakeTransport }),
        indexPath: squareIndexPath(env), closesArtifact: borrowed === undefined,
        deliveryLocation: await canonicalPath(location) });
    } catch (error) {
      if (borrowed === undefined) await artifact.close();
      if (error instanceof InternalSquareError && error.code === 'not_found')
        throw new SquareError('unavailable', `Square is unavailable at ${location}`);
      throw error;
    }
  }
  static async create(input: ChannelCreateInput, control?: OperationControl): Promise<Channel> {
    const path = explicitLocation(input);
    const env = { ...(input.env ?? process.env) }, location = squareLocation({ ...input, env, path });
    // Endpoints and messages carry no Agora chatroom warmup.
    await createSquare(location, { hardCap: null, throttlePerMinute: undefined, force: input.force ?? false },
      input.description ?? '# Channel\n', control?.signal, false);
    return Channel.open({ ...input, path: location, env }, control);
  }
  static inMemory(input: Omit<ChannelCreateInput, 'path' | 'resources' | 'force'> = {}): Channel {
    const env = { ...(input.env ?? process.env) };
    return Channel.fromPort({
      location: `memory://${crypto.randomUUID()}`,
      artifact: createArtifactPort(':memory:', prepareSquareBuild({ hardCap: null }, input.description ?? '# Channel\n', false)),
      clock: squareClock(env, input.clock),
      ...(input.wakeTransport ? { wakeTransport: input.wakeTransport } : {}),
    });
  }

  private observation(standingCount: number, participant?: string, now = this.clock()): SquareObservation {
    return { location: this.location, standingCount, now,
      ...(participant === undefined ? {} : { participant }) };
  }
  private async publishSeat(owner: Owner): Promise<void> {
    if (this.indexPath !== undefined)
      await rememberSquarePath(this.location, owner, this.indexPath).catch(() => undefined);
  }

  async attach(name: string, options: EndpointOptions & { readonly takeover?: boolean }, control?: OperationControl): Promise<ChannelEndpoint> {
    return new ChannelEndpoint(this, (await this.joinSeat(requireJoinName(name), options, control)).seat);
  }
  async reattach(name: string, { owner, wakeAddress }: Pick<JoinOptions, 'owner' | 'wakeAddress'>, control?: OperationControl): Promise<ChannelEndpoint | null> {
    const seat = await this.reattachSeat(name, { owner, wakeAddress }, control);
    return seat === null ? null : new ChannelEndpoint(this, seat);
  }
  async endpoint(name: string, { owner }: { readonly owner: Owner }): Promise<ChannelEndpoint> {
    return new ChannelEndpoint(this, await this.requiredSeat(name, { owner }));
  }
  async endpointsOf(owner: Owner): Promise<readonly HeldSeat[]> {
    requireOwner(owner);
    return (await this.artifact.read(facts => facts.seatsForOwner(owner).map(({ participant: name, generation, attachment }) =>
      ({ name, generation, attachment })))).value;
  }
  async listEndpoints(control?: OperationControl): Promise<readonly ChannelEndpointSummary[]> {
    checkControl(control);
    return (await this.artifact.read(facts => facts.roster().filter(participant => participant.joined)
      .flatMap(participant => {
        const seat = facts.seat(participant.name);
        if (seat === undefined) return [];
        return [{
          name: participant.name,
          generation: seat.generation,
          attachment: seat.attachment,
          deliveryAvailable: seat.wakeAddress !== undefined,
          unreadCount: facts.directedCount(participant.name, { unseenOnly: true, currentGeneration: true }),
          ...(participant.lastActiveAt === undefined ? {} : { lastActiveAt: participant.lastActiveAt }),
        }];
      }), control?.signal)).value;
  }

  /** Internal composition point for the Agora resource: join, reconnect or take over one seat. */
  async joinSeat(name: string, options: JoinOptions, control?: OperationControl): Promise<ChannelJoinResult> {
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
        else if (wakeAddress !== undefined && canRefreshWakeAddress(currentSeat.wakeAddress, wakeAddress))
          facts.updateWakeAddress(asSeatRef(currentSeat), wakeAddress);
        kind = 'reconnected';
      }
      if (kind !== 'reconnected') {
        const joinAct = decideJoin(facts, participant, now);
        if (joinAct === undefined) throw new SquareError('already_joined', `${participantIdentity(participant)} could not be joined`);
        activity = toPublicActivity(facts.land(joinAct));
      }
      const seat = facts.seat(participant);
      if (seat === undefined) throw new SquareError('invalid_args', 'The join activity did not establish its artifact seat.');
      return { seat, activity, kind,
        ...(!options.observe ? {} : { observation: { ...this.observation(inSquareCount(facts), seat.participant, now),
          deliveryAvailable: seat.wakeAddress !== undefined } }) };
    }, control?.signal)).value;
    await this.publishSeat(owner);
    return committed;
  }
  /** Internal composition point: restore only a standing seat; a concurrent departure or takeover cannot be revived. */
  async reattachSeat(name: string, { owner, wakeAddress }: Pick<JoinOptions, 'owner' | 'wakeAddress'>, control?: OperationControl): Promise<Seat | null> {
    checkControl(control);
    validateName(name);
    requireOwner(owner);
    const captured = (await this.artifact.read(facts => facts.seat(name), control?.signal)).value;
    if (captured === undefined || captured.owner !== owner) return null;
    const seat = (await this.artifact.transactAs({ kind: 'join', participant: name, owner, wakeAddress }, facts => {
      const current = facts.seat(name);
      if (!facts.participant(name)?.joined || current === undefined || current.generation !== captured.generation || current.owner !== owner) return null;
      if (current.attachment === 'detached') facts.reattachSeat(asSeatRef(current), wakeAddress);
      else if (wakeAddress !== undefined && canRefreshWakeAddress(current.wakeAddress, wakeAddress)) facts.updateWakeAddress(asSeatRef(current), wakeAddress);
      return facts.seat(name)!;
    }, control?.signal)).value;
    if (seat !== null) await this.publishSeat(owner);
    return seat;
  }
  /** Internal composition point: select one attached standing seat held by an exact owner. */
  async requiredSeat(name: string, { owner }: { readonly owner: Owner }): Promise<Seat> {
    validateName(name);
    requireOwner(owner);
    return (await this.artifact.read(facts => {
      const participant = facts.participant(name), seat = facts.seat(name);
      if (!participant?.joined || seat === undefined || seat.owner !== owner || seat.attachment !== 'attached') {
        const reason = participant === undefined ? 'has never stepped into this square'
          : !participant.joined ? 'needs a current attached seat; join first'
          : seat !== undefined && seat.owner !== owner ? 'is not held by this owner; join before writing'
          : seat?.attachment === 'detached' ? 'is away — join again before writing'
          : 'needs a current attached seat; join first';
        throw new SquareError('already_joined', `${participantIdentity(participant?.name ?? name)} ${reason}`, {
          reason: 'needs_seat', join: joinRecoveryCommand(this.location, participant?.name ?? name),
        });
      }
      return seat;
    })).value;
  }

  private async heldSeat(name: string, { owner, generation }: EndpointIdentity): Promise<Seat | undefined> {
    requireOwner(owner);
    const seat = (await this.artifact.read(facts => facts.seat(name))).value;
    return seat?.generation === generation && seat.owner === owner ? seat : undefined;
  }
  async cancelDeliveries(name: string, identity: EndpointIdentity): Promise<boolean> {
    const seat = await this.heldSeat(name, identity);
    return seat === undefined ? false : this.artifact.cancelDeliveries(asSeatRef(seat));
  }
  async detach(name: string, identity: EndpointIdentity): Promise<true | null> {
    const captured = await this.heldSeat(name, identity);
    if (captured === undefined) return null;
    const seat = asSeatRef(captured);
    return (await this.artifact.transactAs({ kind: 'host-cleanup', seat }, facts => facts.detachSeat(seat) ? true : null)).value;
  }
  async endHeld(name: string, identity: EndpointIdentity): Promise<LifecycleResult | null> {
    const captured = await this.heldSeat(name, identity);
    if (captured === undefined) return null;
    return (await this.artifact.transactAs({ kind: 'host-cleanup', seat: asSeatRef(captured) }, facts => {
      const current = facts.seat(name);
      if (current === undefined || current.generation !== captured.generation || current.owner !== captured.owner) return null;
      return { activity: toPublicActivity(facts.land(coreDone(facts, current.participant, '', this.clock()))) };
    })).value;
  }
  async remove(name: string, identity: EndpointIdentity): Promise<boolean> {
    return await this.endHeld(name, identity) !== null;
  }

  /** Shared transaction/publication effect boundary; upper layers supply admission and addressing facts. */
  async publish<T extends { readonly stored: StoredAct }>(authority: ArtifactWriteAuthority,
    admit: (facts: SquareWrite) => T, control?: OperationControl): Promise<T> {
    const committed = (await this.artifact.transactAs(authority, admit, control?.signal)).value;
    if (this.wakeTransport !== undefined)
      await deliverPending({ artifact: this.artifact, transport: this.wakeTransport, location: this.deliveryLocation,
        activity: committed.stored.index, now: committed.stored.at }).catch(() => undefined);
    return committed;
  }

  /** Messages resolve only explicit addresses, without social admission or body attention. */
  async send(input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> {
    checkControl(control);
    const { from } = input;
    if (typeof from !== 'string') throw new SquareError('invalid_args', 'Channel sender must be a name.');
    validateName(from);
    return this.sendAs({ kind: 'send', actor: from }, input, control);
  }

  /** Internal composition point: a captured endpoint publishes under its own seat authority. */
  async sendAs(authority: ArtifactWriteAuthority, input: ChannelSendInput, control?: OperationControl): Promise<ChannelSendResult> {
    checkControl(control);
    const { from, to, body, truncate = false } = input;
    const targets = typeof to === 'string' ? [to] : to;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > MAX_IDENTITY_SET_SIZE)
      throw new SquareError('invalid_args', `Channel needs between 1 and ${MAX_IDENTITY_SET_SIZE} recipients.`);
    const unique: string[] = [];
    for (const target of targets) {
      if (typeof target !== 'string') throw new SquareError('invalid_args', 'Channel recipients must be names.');
      validateName(target);
      if (!unique.some(name => sameName(name, target))) unique.push(target);
    }
    if (typeof body !== 'string' || body.trim() === '') throw new SquareError('invalid_args', 'Channel body must be non-empty.');
    if (truncate !== false && (!Number.isSafeInteger(truncate) || truncate < 1))
      throw new SquareError('invalid_args', 'Channel truncate must be false or a positive integer.');
    const fullBody = body.replace(/\r\n/g, '\n');
    const preview = truncate !== false && fullBody.length > truncate
      ? `${fullBody.slice(0, truncate).trimEnd()}… (truncated ${fullBody.length - truncate} chars)`
      : undefined;
    const metadata = validateActivityMetadata(input.metadata);
    const { stored, resolvedTo } = await this.publish(authority, facts => {
      // Landing owns the one explicit-address resolution; its actual audience is the result.
      const landed = facts.land({ kind: 'message', actor: from, at: this.clock(), body: fullBody,
        ...(activityMetadataHasContent(metadata) ? { metadata } : {}), ...(preview === undefined ? {} : { preview }), to: unique });
      const audience = facts.audience(landed.index), missing = unique.filter(target => !audience.some(address => sameName(address.recipient, target)));
      if (missing.length > 0) throw new SquareError('invalid_args', `Channel recipients are not standing: ${missing.join(', ')}`, {
        reason: 'not_standing', targets: missing, activityUnsent: true,
      });
      return { stored: landed, resolvedTo: audience.map(address => address.recipient) };
    }, control);
    return { id: formatActivityId(stored.index), at: stored.at, from: stored.actor, to: resolvedTo, body: fullBody,
      ...(stored.kind !== 'message' || stored.metadata === undefined ? {} : { metadata: stored.metadata }) };
  }

  async history(query: ChannelHistoryQuery = {}, control?: OperationControl): Promise<ChannelHistoryResult> {
    checkControl(control);
    const limit = query.limit === undefined ? 100 : query.limit;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      throw new SquareError('invalid_args', 'History limit must be a positive integer no greater than 100.');
    if (query.order !== undefined && query.order !== 'asc' && query.order !== 'desc')
      throw new SquareError('invalid_args', 'History order must be asc or desc.');
    const filter = { ...activityQueryFilter(query, ['order']), kinds: ['message', 'say'] as const };
    return (await this.artifact.read(facts => {
      const heads = facts.activityHeads(filter, { edge: query.cursor?.direction === 'after' ? 'oldest' : 'newest',
        limit: limit ?? Math.max(1, facts.activityCount(filter)) }).items;
      const messages = facts.activities(heads.map(head => head.index)).map(activity => channelMessage(facts, activity));
      if (query.order === 'desc') messages.reverse();
      return { messages };
    }, control?.signal)).value;
  }

  async close(): Promise<void> {
    if (this.closesArtifact) await this.artifact.close();
  }
}

/** One validated page selection shared by pending and receive. */
function channelPendingSelection(options: PendingOptions, kinds: NonNullable<DirectedFilter['kinds']>) {
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new SquareError('invalid_args', 'Pending limit must be a positive integer no greater than 100.');
  const { actors, ...query } = activityQueryFilter(options);
  return { limit, filter: { ...query, kinds, senders: actors, unseenOnly: true as const, currentGeneration: true as const } };
}

/** Shared current-address page selection and hydration for Channel and the Agora projection. */
export function pendingPage<M>(facts: SquareRead, participant: string, options: PendingOptions,
  kinds: NonNullable<DirectedFilter['kinds']>, hydrate: (facts: SquareRead, activity: StoredAct) => M,
): { readonly items: readonly M[]; readonly remaining: number } {
  const { limit, filter } = channelPendingSelection(options, kinds);
  const heads = selectReceivedHeads(squareReceiveRead(facts), participant, { kind: 'page', query: filter, limit });
  const items = facts.activities(heads.map(head => head.key)).map(activity => hydrate(facts, activity));
  return { items, remaining: facts.directedCount(participant, filter) - items.length };
}

/** Hydration is shared by all Channel reads; recipients are the actual landed addresses. */
function channelMessage(facts: SquareRead, activity: StoredAct): ChannelMessage {
  if (activity.kind !== 'message' && activity.kind !== 'say') throw new Error('Not a channel content record');
  return { id: formatActivityId(activity.index), at: activity.at, from: activity.actor,
    to: facts.audience(activity.index).map(address => address.recipient), body: activity.body ?? '',
    ...(activity.metadata === undefined ? {} : { metadata: activity.metadata }) };
}

/** Captures one recipient seat through the channel's own storage, never a wrapped square. */
export class ChannelEndpoint {
  constructor(private readonly channel: Channel, private readonly seat: Seat) { }
  get name(): string { return this.seat.participant; }
  get generation(): ActivityId { return this.seat.generation; }

  private get storage(): SquareArtifactPort { return this.channel.artifact; }
  private get participant(): string { return this.seat.participant; }

  async pending(options: PendingOptions = {}, control?: OperationControl): Promise<ChannelPendingResult> {
    checkControl(control);
    return (await this.storage.read(facts => {
      assertCurrentSeat(facts, asSeatRef(this.seat));
      const page = pendingPage(facts, this.participant, options, ['message', 'say'], channelMessage);
      return { messages: page.items, remaining: page.remaining };
    }, control?.signal)).value;
  }
  async ack(ids: readonly ActivityId[], control?: OperationControl): Promise<AckResult> {
    checkControl(control);
    if (!Array.isArray(ids)) throw new SquareError('invalid_args', 'Ack requires an array of activity IDs.');
    const indexes = [...new Set(Array.from(ids, parseRequiredActivityId))];
    return (await this.storage.transactAs(participantAuthority(this.seat), facts => {
      for (const index of indexes) {
        if (facts.directed(this.participant, { afterIndex: index - 1, throughIndex: index, currentGeneration: true }, { edge: 'oldest', limit: 1 }).items.length === 0)
          throw new SquareError('invalid_args', `${formatActivityId(index)} is not addressed to you.`, {
            reason: 'not_addressed', activityId: formatActivityId(index),
          });
      }
      return { consumed: facts.markSeen(this.participant, indexes, this.channel.clock()) };
    }, control?.signal)).value;
  }
  /** Select and consume matching unconsumed messages in one transaction. */
  async receive(options: PendingOptions = {}, control?: OperationControl): Promise<ChannelReceiveResult> {
    checkControl(control);
    const { limit, filter } = channelPendingSelection(options, ['message', 'say']);
    return (await this.storage.transactAs(participantAuthority(this.seat), facts => {
      const consumed = consumeReceived({ ...squareReceiveRead(facts),
        insertReceipt: (ref, at) => facts.markSeen(ref.recipient, [ref.item], at) > 0,
      }, this.participant, { kind: 'page', query: filter, limit }, this.channel.clock());
      return { messages: consumed.items.map(item => channelMessage(facts, item.data)),
        consumed: consumed.newlyConsumed, remaining: consumed.remaining };
    }, control?.signal)).value;
  }
  async leave(control?: OperationControl): Promise<void> {
    const seat = this.seat;
    const name = (await this.storage.read(facts => resolveKnownName(facts, this.participant), control?.signal)).value;
    await this.storage.transactAs(participantAuthority(seat), facts =>
      facts.land(coreDone(facts, name, '', this.channel.clock())), control?.signal);
  }
  async deferDelivery(input: Readonly<{ match: MetadataMatch; durationMs: number }>, control?: OperationControl): Promise<DeliveryDeferral> {
    checkControl(control);
    const match = validateMetadataMatch(input?.match), duration = validateDeferralDuration(input?.durationMs);
    const seat = this.seat;
    return (await this.storage.transactAs(participantAuthority(seat), facts => {
      const now = this.channel.clock(), expiresAt = now + duration, id = crypto.randomUUID();
      const result = { id, expiresAt: new Date(expiresAt).toISOString() };
      facts.putDeliveryDeferral(asSeatRef(seat), id, match, expiresAt, now);
      return result;
    }, control?.signal)).value;
  }
  async renewDeliveryDeferral(id: string, durationMs: number, control?: OperationControl): Promise<DeliveryDeferral | null> {
    checkControl(control);
    validateDeferralId(id);
    const duration = validateDeferralDuration(durationMs), seat = this.seat;
    return (await this.storage.transactAs(participantAuthority(seat), facts => {
      const now = this.channel.clock(), expiresAt = now + duration;
      const result = { id, expiresAt: new Date(expiresAt).toISOString() };
      return facts.renewDeliveryDeferral(asSeatRef(seat), id, expiresAt, now) ? result : null;
    }, control?.signal)).value;
  }
  async releaseDeliveryDeferral(id: string, control?: OperationControl): Promise<boolean> {
    checkControl(control);
    validateDeferralId(id);
    const seat = this.seat;
    return (await this.storage.transactAs(participantAuthority(seat), facts =>
      facts.releaseDeliveryDeferral(asSeatRef(seat), id, this.channel.clock()), control?.signal)).value;
  }
  send(input: Omit<ChannelSendInput, 'from'>, control?: OperationControl): Promise<ChannelSendResult> {
    return this.channel.sendAs(participantAuthority(this.seat), { ...input, from: this.participant }, control);
  }
}
