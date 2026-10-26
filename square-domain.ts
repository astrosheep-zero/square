import { SquareError, formatActivityId, parseActivityId, sameBody, sameName, validateBody, validateName, type Seat, type StoredAct } from './model.js';
import type { ArtifactWriteAuthority, AttentionFact, LandedRecipient, ParticipantFact, SeatRef, SquareRead, SquareWrite } from './ports.js';

export interface LandingEffect {
  readonly activity: StoredAct;
  readonly participant?: ParticipantFact;
  readonly removeListeningOf?: string;
  readonly removeListening?: { readonly listener: string; readonly target: string };
  readonly replaceAttention?: AttentionFact;
  readonly audience: readonly LandedRecipient[];
}
export interface LandingFacts {
  readonly actor?: ParticipantFact;
  readonly standing: readonly ParticipantFact[];
  readonly incoming: readonly AttentionFact[];
  readonly outgoing: readonly AttentionFact[];
  readonly replyAuthor?: string;
}

/** The single landing transition, shared by both adapters and explicit rebuild. */
export function deriveLanding(activity: StoredAct, facts: LandingFacts): LandingEffect {
  const audience: LandedRecipient[] = [];
  if (activity.kind === 'say') {
    const add = (requested: string, route: LandedRecipient['route']) => {
      const recipient = facts.standing.find((item) => sameName(item.name, requested))?.name;
      if (recipient === undefined || sameName(recipient, activity.actor)
        || audience.some((item) => sameName(item.recipient, recipient))) return;
      if (activity.reach !== 'bell' && facts.incoming.some((item) => item.kind === 'ignore' && sameName(item.listener, recipient))) return;
      audience.push({ recipient, route });
    };
    if (activity.reach === 'bell') {
      for (const peer of facts.standing) add(peer.name, 'bell');
    } else {
      for (const mention of activity.mentions ?? []) add(mention, 'mention');
      if (facts.replyAuthor !== undefined) add(facts.replyAuthor, 'reply');
      for (const peer of facts.standing) {
        if (facts.incoming.some((item) => item.kind === 'listen' && sameName(item.listener, peer.name))) add(peer.name, 'attention');
      }
    }
  }
  const actor = activity.actor;
  if (actor === undefined) return { activity, audience };
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

export function landingFacts(read: SquareRead, activity: StoredAct): LandingFacts {
  return {
    actor: activity.actor === undefined ? undefined : read.participant(activity.actor),
    standing: activity.kind === 'say' ? read.roster().filter((item) => item.joined) : [],
    incoming: activity.kind === 'say' ? read.incomingAttention(activity.actor) : [],
    outgoing: activity.kind === 'listen' || activity.kind === 'ignore' || activity.kind === 'unlisten' ? read.attention(activity.actor) : [],
    replyAuthor: activity.kind === 'say' && activity.reply !== undefined ? read.activity(activity.reply)?.actor : undefined,
  };
}

export interface LandingWriter extends Pick<SquareWrite,
  'markSeen' | 'putLease' | 'removeLease' | 'updateWakeAddress' | 'cancelThrough' |
  'claimDelivery' | 'prepareDelivery' | 'completeDelivery' | 'observeNativeDelivery'> {
  /** Artifact-private seat persistence used only by this gate's lifecycle transition. */
  storeSeat(seat: Seat): boolean;
  removeSeat(seat: import('./ports.js').SeatRef): boolean;
  applyLanding(effect: LandingEffect): void;
}
export interface SquareWriteGate {
  readonly facts: SquareWrite;
  complete(): void;
}

function validateGeneration(value: string): void {
  if (typeof value !== 'string' || parseActivityId(value) === undefined)
    throw new SquareError('invalid_args', 'Artifact authority requires a valid join generation.');
}

/** The artifact transaction supplies one captured authority; every mutation checks it here. */
export function wrapSquareWrite(read: SquareRead, writes: LandingWriter, authority: ArtifactWriteAuthority): SquareWriteGate {
  if (authority === undefined || typeof authority !== 'object' || authority === null)
    throw new SquareError('invalid_args', 'Artifact writes require an explicit authority.');
  const { applyLanding, ...mutations } = writes;
  const expectedName = authority.kind === 'participant' ? authority.seat?.participant : authority.participant;
  if (!['participant', 'join', 'takeover'].includes(authority.kind) || typeof expectedName !== 'string')
    throw new SquareError('invalid_args', 'Artifact write authority is malformed.');
  validateName(expectedName);
  if (authority.kind === 'participant') {
    validateBody(authority.seat.body);
    validateGeneration(authority.seat.generation);
  } else {
    validateBody(authority.body);
    if (authority.kind === 'takeover') validateGeneration(authority.expectedGeneration);
  }

  const assertSeat = (seat: SeatRef, expected = authority.kind === 'participant' ? authority.seat : undefined) => {
    if (expected === undefined || !sameName(expected.participant, seat.participant)
      || seat.generation !== expected.generation || !sameBody(seat.body, expected.body))
      throw new SquareError('already_joined', 'This write needs the current participant seat.');
    const current = read.seat(seat.participant);
    if (current === undefined || !sameBody(current.body, expected.body) || current.generation !== expected.generation)
      throw new SquareError('already_joined', 'This participant seat has been replaced.');
  };
  const assertParticipant = (name: string, generation?: import('./square-core.js').ActivityId) => {
    if (authority.kind !== 'participant')
      throw new SquareError('already_joined', 'This write needs the current participant seat.');
    assertSeat({ ...authority.seat, participant: name, generation: generation === undefined ? authority.seat.generation : generation });
  };

  let reconnectSeat: Seat | undefined;
  let takeoverPhase: 'ready' | 'done' | 'joined' | undefined = authority.kind === 'takeover' ? 'ready' : undefined;
  if (authority.kind === 'participant') {
    assertSeat(authority.seat);
  } else if (authority.kind === 'join') {
    const participant = read.participant(expectedName), seat = read.seat(expectedName);
    if (participant?.joined) {
      if (seat === undefined || !sameBody(seat.body, authority.body))
        throw new SquareError('already_joined', `${expectedName} is held by another body; take it over explicitly`);
      reconnectSeat = seat;
    }
  } else {
    const current = read.seat(expectedName);
    if (current === undefined || current.generation !== authority.expectedGeneration)
      throw new SquareError('already_joined', 'The participant seat changed before takeover.');
  }

  let lastActivity: StoredAct | undefined;
  const facts = Object.assign({}, read, {
    land(activity: Parameters<SquareWrite['land']>[0]): StoredAct {
      const actor = 'actor' in activity ? activity.actor : undefined;
      if (actor === undefined) throw new SquareError('invalid_args', 'Participant activities require a named actor.');
      validateName(actor);
      if (!sameName(actor, expectedName))
        throw new SquareError('already_joined', 'Activity actor does not match the artifact authority.');

      if (authority.kind === 'participant') {
        assertSeat(authority.seat);
        if (activity.kind === 'join') throw new SquareError('invalid_args', 'A participant seat can only be re-established by join.');
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
      const captured = authority.kind === 'takeover' && activity.kind === 'done'
        ? read.seat(expectedName) : undefined;
      const stored = { ...activity, index } as StoredAct;
      applyLanding(deriveLanding(stored, landingFacts(read, stored)));

      if (stored.kind === 'join') {
        if (authority.kind === 'participant') throw new SquareError('invalid_args', 'Participant authority cannot establish a seat.');
        const seat: Seat = {
          participant: stored.actor,
          body: authority.body,
          generation: formatActivityId(stored.index),
          ...(authority.wakeAddress === undefined ? {} : { wakeAddress: authority.wakeAddress }),
        };
        mutations.storeSeat(seat);
        const established = read.seat(seat.participant);
        if (established === undefined || !sameBody(established.body, seat.body) || established.generation !== seat.generation)
          throw new SquareError('invalid_args', 'The join activity did not establish its artifact seat.');
        if (authority.kind === 'takeover') takeoverPhase = 'joined';
      } else if (stored.kind === 'done' && authority.kind === 'participant') {
        if (!mutations.removeSeat(authority.seat))
          throw new SquareError('already_joined', 'The participant seat changed while it was being completed.');
      } else if (stored.kind === 'done' && authority.kind === 'takeover') {
        if (captured === undefined || !mutations.removeSeat({ participant: expectedName, body: captured.body, generation: captured.generation }))
          throw new SquareError('already_joined', 'The participant seat changed while takeover was completing it.');
        takeoverPhase = 'done';
      }
      lastActivity = read.activity(index)!;
      return lastActivity;
    },
    updateWakeAddress(seat: import('./ports.js').SeatRef, wakeAddress?: import('./model.js').WakeAddress): boolean {
      assertSeat(seat, authority.kind === 'join' ? reconnectSeat : undefined);
      return mutations.updateWakeAddress(seat, wakeAddress);
    },
    cancelThrough(seat: import('./ports.js').SeatRef, through: number): boolean {
      assertSeat(seat);
      if (!Number.isSafeInteger(through) || through < 0 || through > read.header().lastActIndex || read.activity(through) === undefined)
        throw new SquareError('invalid_args', 'Cancellation boundary must name an existing activity at or below the current head.');
      return mutations.cancelThrough(seat, through);
    },
    markSeen(name: string, indexes: readonly number[], at: number): number {
      assertParticipant(name);
      return mutations.markSeen(name, indexes, at);
    },
    putLease(name: string, lease: import('./model.js').WatchLease, generation?: import('./square-core.js').ActivityId): boolean {
      assertParticipant(name, generation);
      return mutations.putLease(name, lease, generation);
    },
    removeLease(name: string, leaseId: string, generation?: import('./square-core.js').ActivityId): boolean {
      assertParticipant(name, generation);
      return mutations.removeLease(name, leaseId, generation);
    },
    claimDelivery(input: import('./ports.js').DeliveryClaimInput): import('./ports.js').DeliveryClaimResult {
      assertSeat(input.seat);
      return mutations.claimDelivery(input);
    },
    prepareDelivery(input: import('./ports.js').DeliveryPreparation): boolean {
      assertSeat(input.seat);
      return mutations.prepareDelivery(input);
    },
    completeDelivery(input: import('./ports.js').DeliveryCompletion): boolean {
      assertSeat(input.seat);
      return mutations.completeDelivery(input);
    },
    observeNativeDelivery(input: Parameters<SquareWrite['observeNativeDelivery']>[0]): boolean {
      assertSeat(input.seat);
      return mutations.observeNativeDelivery(input);
    },
  }) as SquareWrite;

  return {
    facts,
    complete() {
      if (authority.kind !== 'takeover') return;
      const seat = read.seat(expectedName);
      if (takeoverPhase !== 'joined' || lastActivity?.kind !== 'join' || seat === undefined
        || !sameBody(seat.body, authority.body) || seat.generation !== formatActivityId(lastActivity.index))
        throw new SquareError('already_joined', 'Takeover did not complete its replacement join.');
    },
  };
}
