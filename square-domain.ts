import { SquareError, nameKey, sameName, validateOwner, validateName, type ActDraft, type Seat, type StoredAct } from './model.js';
import { wrapChannelWrite } from './channel-domain.js';
import { newEndpointGeneration, type EndpointGeneration } from './message.js';
import { resolveAudience } from './attention.js';
import type { ArtifactWriteAuthority, AttentionFact, LandedRecipient, ParticipantFact, SeatRef, SquareRead, SquareWrite } from './ports.js';
import type { ChannelWrite, EndpointRef } from './channel-ports.js';
import { validateEndpointGeneration as endpointGeneration } from './message.js';
import { leaseOwnsNotification } from './catch-selection.js';
import type { WatchLease } from './model.js';

/** Pending messages the live catch currently owns; the lower pipeline only needs this coverage. */
export function catchCoverage(read: SquareRead, name: string, lease: WatchLease): number[] {
  const covered: number[] = [];
  let cursor = -1;
  for (;;) {
    const page = read.channel.directed(name, { afterIndex: cursor, unseenOnly: true, currentGeneration: true }, { edge: 'oldest', limit: 100 });
    for (const head of page.items) {
      const relation = read.activityByMessage(head.index);
      const route = relation === undefined ? undefined : read.directedAt(name, relation.index)?.route;
      if (route !== undefined && leaseOwnsNotification(lease, { actor: head.from, route, recipient: name })) covered.push(head.index);
    }
    if (!page.hasMore || page.items.length === 0) break;
    cursor = page.items[page.items.length - 1].index;
  }
  return covered;
}

/** Artifact-private landing effect; sender capabilities never expose another recipient's claim. */
export function extendLandingCatchCoverage(read: SquareRead, putClaim: ChannelWrite['putReceiveClaim'], activity: StoredAct, audience: readonly LandedRecipient[]): void {
  if (activity.kind !== 'say') return;
  const index = activity.messageIndex;
  for (const recipient of audience) {
    const claim = read.channel.claimLease(recipient.recipient, 'agora');
    if (claim === undefined || claim.expiresAt <= activity.at || recipient.generation !== undefined && claim.generation !== recipient.generation) continue;
    const lease = read.lease(recipient.recipient);
    if (lease === undefined || lease.leaseId !== claim.id
      || !leaseOwnsNotification(lease, { actor: activity.actor, route: recipient.route, recipient: recipient.recipient })) continue;
    if (!claim.suppressed.includes(index)) putClaim({ ...claim, suppressed: [...claim.suppressed, index] });
  }
}

export interface LandingEffect {
  readonly activity: ActDraft & { readonly index: number };
  readonly participant?: ParticipantFact;
  readonly removeListeningOf?: string;
  readonly removeListening?: { readonly listener: string; readonly target: string };
  readonly replaceAttention?: AttentionFact;
  readonly audience: readonly LandedRecipient[];
}
export interface LandingFacts {
  readonly actor?: ParticipantFact;
  readonly standing: readonly ParticipantFact[];
  /** Endpoint custody at landing time, so an address fences the generation it was written for. */
  readonly generations: ReadonlyMap<string, EndpointGeneration>;
  readonly incoming: readonly AttentionFact[];
  readonly outgoing: readonly AttentionFact[];
  readonly replyAuthor?: string;
}

/** The single landing transition, shared by both adapters and explicit rebuild. */
export function deriveLanding(activity: ActDraft & { readonly index: number }, facts: LandingFacts): LandingEffect {
  const audience: LandedRecipient[] = activity.kind === 'say' ? resolveAudience({
    actor: activity.actor, recipients: facts.standing.map((item) => item.name),
    mentions: activity.mentions, replyAuthor: facts.replyAuthor, reach: activity.reach,
    incoming: facts.incoming, sameIdentity: sameName,
  }).map(recipient => ({ ...recipient, generation: facts.generations.get(nameKey(recipient.recipient)) })) : [];
  const actor = activity.actor;
  const previous = facts.actor ?? { name: actor, firstIndex: activity.index, joined: false, done: false, sayCount: 0 };
  const participant: ParticipantFact = {
    ...previous,
    lastActiveAt: Math.max(previous.lastActiveAt ?? -Infinity, activity.at),
    ...(activity.kind === 'join' ? { joined: true, done: false, lastJoinIndex: activity.index } : {}),
    ...(activity.kind === 'done' ? { joined: false, done: true } : {}),
    ...(activity.kind === 'say' ? { sayCount: previous.sayCount + 1 } : {}),
  };
  let replaceAttention: AttentionFact | undefined;
  if (activity.kind === 'listen' || activity.kind === 'ignore') {
    const existing = facts.outgoing.find((item) => sameName(item.target, activity.target));
    if (existing?.kind !== activity.kind) {
      replaceAttention = { listener: participant.name, target: activity.target, kind: activity.kind, sinceIndex: activity.index };
    }
  }
  const removeListening = activity.kind === 'unlisten'
    && facts.outgoing.some((item) => item.kind === 'listen' && sameName(item.target, activity.target))
    ? { listener: participant.name, target: activity.target } : undefined;
  return {
    activity, participant, audience,
    ...(activity.kind === 'done' ? { removeListeningOf: participant.name } : {}),
    ...(removeListening === undefined ? {} : { removeListening }),
    ...(replaceAttention === undefined ? {} : { replaceAttention }),
  };
}

export function landingFacts(read: SquareRead, activity: ActDraft): LandingFacts {
  return {
    actor: read.participant(activity.actor),
    generations: new Map(read.channel.endpoints().map(endpoint => [nameKey(endpoint.participant), endpoint.generation])),
    standing: activity.kind === 'say' ? read.roster().filter((item) => item.joined) : [],
    incoming: activity.kind === 'say' ? read.incomingAttention(activity.actor) : [],
    outgoing: activity.kind === 'listen' || activity.kind === 'ignore' || activity.kind === 'unlisten' ? read.attention(activity.actor) : [],
    replyAuthor: activity.kind === 'say' && activity.reply !== undefined ? read.activity(activity.reply)?.actor : undefined,
  };
}

export interface LandingWriter extends Pick<SquareWrite,
  'putLease' | 'removeLease' | 'updateWakeAddress' | 'reattachSeat' | 'detachSeat'> {
  /** Artifact-private endpoint persistence used only by this gate's lifecycle transition. */
  storeSeat(seat: Seat): boolean;
  removeSeat(seat: EndpointRef): boolean;
  applyLanding(effect: LandingEffect): void;
  readonly channel: ChannelWrite;
}
export interface SquareWriteGate {
  readonly facts: SquareWrite;
  complete(): void;
}

function validateGeneration(value: string): void {
  endpointGeneration(value);
}

/** Read probes and writes share the same captured-coordinate and attachment fence. */
export function assertCurrentSeat(read: SquareRead, expected: SeatRef, allowDetached = false): void {
  const current = read.seat(expected.participant);
  if (current === undefined || current.owner !== expected.owner || current.generation !== expected.generation)
    throw new SquareError('already_joined', 'This participant seat has been replaced.');
  if (!allowDetached && current.attachment !== 'attached')
    throw new SquareError('already_joined', 'This participant is away; join again before writing.', { reason: 'needs_seat', activityUnsent: true });
}

function immutableAct(activity: StoredAct): StoredAct {
  const copy = { ...activity, ...(activity.kind === 'say' && activity.mentions !== undefined ? { mentions: [...activity.mentions] } : {}) };
  if (copy.kind === 'say' && copy.mentions !== undefined) Object.freeze(copy.mentions);
  return Object.freeze(copy);
}

/** The artifact transaction supplies one captured authority; every mutation checks it here. */
export function wrapSquareWrite(read: SquareRead, writes: LandingWriter, authority: ArtifactWriteAuthority): SquareWriteGate {
  if (authority === undefined || typeof authority !== 'object' || authority === null)
    throw new SquareError('invalid_args', 'Artifact writes require an explicit authority.');
  const { applyLanding, channel, ...mutations } = writes;
  const seated = authority.kind === 'participant' || authority.kind === 'host-cleanup' || authority.kind === 'endpoint-cleanup';
  const expectedName = seated ? authority.seat?.participant : authority.kind === 'send' ? authority.actor
    : authority.kind === 'endpoint' ? authority.participant : authority.participant;
  if (!['participant', 'host-cleanup', 'endpoint-cleanup', 'endpoint', 'join', 'takeover', 'send'].includes(authority.kind) || typeof expectedName !== 'string')
    throw new SquareError('invalid_args', 'Artifact write authority is malformed.');
  validateName(expectedName);
  if (seated) {
    validateOwner(authority.seat.owner);
    validateGeneration(authority.seat.generation);
  } else if (authority.kind !== 'send') {
    validateOwner(authority.owner);
    if (authority.kind === 'takeover') validateGeneration(authority.expectedGeneration);
  }

  const assertSeat = (seat: EndpointRef, expected = authority.kind === 'participant' || authority.kind === 'host-cleanup' || authority.kind === 'endpoint-cleanup' ? authority.seat : undefined, allowDetached = false) => {
    if (expected === undefined || !sameName(expected.participant, seat.participant)
      || seat.generation !== expected.generation || seat.owner !== expected.owner)
      throw new SquareError('already_joined', 'This write needs the current participant seat.');
    assertCurrentSeat(read, expected, allowDetached);
  };
  const assertParticipant = (name: string, generation?: string) => {
    if (authority.kind !== 'participant')
      throw new SquareError('already_joined', 'This write needs the current participant seat.');
    assertSeat({ ...authority.seat, participant: name, generation: generation ?? authority.seat.generation });
  };
  let reconnectSeat: EndpointRef | undefined;
  let takeoverPhase: 'ready' | 'done' | 'joined' | undefined = authority.kind === 'takeover' ? 'ready' : undefined;
  let establishedSeat: Seat | undefined;
  if (authority.kind === 'participant') {
    assertSeat(authority.seat);
  } else if (authority.kind === 'host-cleanup' || authority.kind === 'endpoint-cleanup') {
    // A late host cleanup is allowed to inspect a stale coordinate and return a no-op.
  } else if (authority.kind === 'endpoint') {
    // Endpoint attach/takeover owns no activity.
  } else if (authority.kind === 'join') {
    const participant = read.participant(expectedName), seat = read.seat(expectedName);
    if (participant?.joined) {
      if (seat === undefined || seat.owner !== authority.owner)
        throw new SquareError('already_joined', `${expectedName} is held by another owner; take it over explicitly`);
      reconnectSeat = seat;
    }
  } else if (authority.kind === 'takeover') {
    const current = read.seat(expectedName);
    if (current === undefined || current.generation !== authority.expectedGeneration)
      throw new SquareError('already_joined', 'The participant seat changed before takeover.');
  }

  let lastActivity: StoredAct | undefined;
  const lowerAuthority = authority.kind === 'join' || authority.kind === 'takeover'
    ? { kind: 'endpoint' as const, participant: authority.participant, owner: authority.owner }
    : authority.kind === 'host-cleanup' ? { kind: 'endpoint-cleanup' as const, seat: authority.seat } : authority;
  const gatedChannel = wrapChannelWrite(read.channel, channel, lowerAuthority);
  const facts = Object.assign({}, read, {
    channel: gatedChannel,
    land(activity: Parameters<SquareWrite['land']>[0]): StoredAct {
      const actor = 'actor' in activity ? activity.actor : undefined;
      if (actor === undefined) throw new SquareError('invalid_args', 'Participant activities require a named actor.');
      validateName(actor);
      if (!sameName(actor, expectedName))
        throw new SquareError('already_joined', 'Activity actor does not match the artifact authority.');

      if (authority.kind === 'send' || authority.kind === 'endpoint' || authority.kind === 'endpoint-cleanup') {
        throw new SquareError('invalid_args', 'This authority may not publish Agora activities.');
      } else if (authority.kind === 'participant') {
        assertSeat(authority.seat);
        if (activity.kind === 'join') throw new SquareError('invalid_args', 'A participant seat can only be re-established by join.');
      } else if (authority.kind === 'host-cleanup') {
        assertSeat(authority.seat, authority.seat, true);
        if (activity.kind !== 'done') throw new SquareError('invalid_args', 'Host cleanup may only end membership.');
      } else if (authority.kind === 'join') {
        if (activity.kind !== 'join') throw new SquareError('invalid_args', 'A new seat must be established by its join activity.');
        if (read.participant(expectedName)?.joined)
          throw new SquareError('already_joined', `${expectedName} is already standing; join cannot replace an existing seat.`);
      } else if (takeoverPhase === 'ready') {
        const current = read.seat(expectedName);
        if (activity.kind !== 'done' || current === undefined || current.generation !== authority.expectedGeneration)
          throw new SquareError('already_joined', 'Takeover must first complete the captured participant.');
      } else if (authority.kind === 'takeover' && takeoverPhase === 'done') {
        if (activity.kind !== 'join' || !read.participant(expectedName)?.done)
          throw new SquareError('already_joined', 'Takeover must join after its captured done activity.');
      } else {
        throw new SquareError('invalid_args', 'Takeover permits only one done followed by one join.');
      }

      const index = read.header().nextActIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index >= Number.MAX_SAFE_INTEGER)
        throw new SquareError('invalid_args', 'Square activity index is exhausted.');
      const captured = authority.kind === 'takeover' && activity.kind === 'done' ? read.seat(expectedName) : undefined;
      const effect = deriveLanding({ ...activity, index }, landingFacts(read, activity));
      let stored: StoredAct;
      if (activity.kind === 'say') {
        const published = gatedChannel.publishMessage({ from: activity.actor, at: activity.at,
          body: activity.body ?? '', ...(activity.metadata === undefined ? {} : { metadata: activity.metadata }),
          to: effect.audience.map(({ recipient, generation }) => ({ recipient, ...(generation === undefined ? {} : { generation }) })) });
        // The published content lives in the message; only the relation is stored above it.
        const { body: _body, metadata: _metadata, ...relation } = activity;
        stored = { ...relation, index, messageIndex: published.index };
      } else {
        stored = { ...activity, index };
      }
      applyLanding({ ...effect, activity: stored });

      if (stored.kind === 'join') {
        if (authority.kind !== 'join' && authority.kind !== 'takeover') throw new SquareError('invalid_args', 'Seat authority cannot establish another seat.');
        const seat: Seat = {
          participant: stored.actor,
          owner: authority.owner,
          generation: newEndpointGeneration(),
          attachment: 'attached',
          ...(authority.wakeAddress === undefined ? {} : { wakeAddress: authority.wakeAddress }),
        };
        mutations.storeSeat(seat);
        establishedSeat = seat;
        const established = read.seat(seat.participant);
        if (established === undefined || established.owner !== seat.owner || established.generation !== seat.generation)
          throw new SquareError('invalid_args', 'The join activity did not establish its artifact endpoint.');
        if (authority.kind === 'takeover') takeoverPhase = 'joined';
      } else if (stored.kind === 'done' && seated) {
        if (!mutations.removeSeat(authority.seat))
          throw new SquareError('already_joined', 'The participant endpoint changed while it was being completed.');
      } else if (stored.kind === 'done' && authority.kind === 'takeover') {
        if (captured === undefined || !mutations.removeSeat({ participant: expectedName, owner: captured.owner, generation: captured.generation }))
          throw new SquareError('already_joined', 'The participant endpoint changed while takeover was completing it.');
        takeoverPhase = 'done';
      }
      // The persisted fact is the relation; callers that present a say resolve its message content.
      lastActivity = immutableAct(stored);
      return lastActivity;
    },
    updateWakeAddress(seat: SeatRef, wakeAddress?: import('./model.js').WakeAddress): boolean {
      if (authority.kind !== 'join' && authority.kind !== 'participant')
        throw new SquareError('already_joined', 'This write needs the current participant seat.');
      assertSeat(seat, authority.kind === 'join' ? reconnectSeat : authority.seat);
      return mutations.updateWakeAddress(seat, wakeAddress);
    },
    reattachSeat(seat: SeatRef, wakeAddress?: import('./model.js').WakeAddress): boolean {
      if (authority.kind !== 'join') throw new SquareError('already_joined', 'Reattachment requires a same-owner join.');
      assertSeat(seat, reconnectSeat, true);
      return mutations.reattachSeat(seat, wakeAddress);
    },
    detachSeat(seat: SeatRef): boolean {
      if (authority.kind !== 'host-cleanup') throw new SquareError('already_joined', 'Detach requires captured host cleanup authority.');
      const current = read.seat(seat.participant), expected = authority.seat;
      if (!sameName(seat.participant, expected.participant) || seat.owner !== expected.owner || seat.generation !== expected.generation)
        throw new SquareError('already_joined', 'Host cleanup does not match its captured seat.');
      if (current === undefined || current.attachment !== 'attached' || current.owner !== expected.owner
        || current.generation !== expected.generation) return false;
      return mutations.detachSeat(seat);
    },
    putLease(name: string, lease: WatchLease, generation?: string): boolean {
      assertParticipant(name, generation);
      return mutations.putLease(name, lease, generation, catchCoverage(read, name, lease));
    },
    removeLease(name: string, leaseId: string, generation?: string): boolean {
      assertParticipant(name, generation);
      return mutations.removeLease(name, leaseId, generation);
    },
  }) as SquareWrite;

  return {
    facts,
    complete() {
      if (authority.kind !== 'takeover') return;
      const seat = read.seat(expectedName);
      if (takeoverPhase !== 'joined' || lastActivity?.kind !== 'join' || seat === undefined || establishedSeat === undefined
        || seat.owner !== establishedSeat.owner || seat.generation !== establishedSeat.generation)
        throw new SquareError('already_joined', 'Takeover did not complete its replacement join.');
    },
  };
}
