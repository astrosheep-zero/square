import { SquareError, nameKey, sameName, validateOwner, validateName, type ActDraft, type Seat, type StoredAct, type WatchLease } from './model.js';
import { newEndpointGeneration, validateEndpointGeneration } from './message.js';
import { resolveAudience } from './attention.js';
import type { ArtifactWriteAuthority, AttentionFact, LandedRecipient, ParticipantFact, SeatRef, SquareRead, SquareWrite } from './ports.js';
import type { ProducerWrite } from './square-post.js';
import { freshWatchLease } from './runtime.js';
import { leaseOwnsNotification } from './catch-selection.js';

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
  readonly seats: ReadonlyMap<string, Seat>;
  readonly incoming: readonly AttentionFact[];
  readonly outgoing: readonly AttentionFact[];
  readonly replyAuthor?: string;
}
export function deriveLanding(activity: ActDraft & { readonly index: number }, facts: LandingFacts): LandingEffect {
  const audience: LandedRecipient[] = activity.kind === 'say' ? resolveAudience({
    actor: activity.actor, recipients: facts.standing.map(item => item.name), mentions: activity.mentions,
    replyAuthor: facts.replyAuthor, reach: activity.reach, incoming: facts.incoming, sameIdentity: sameName,
  }).map(recipient => {
    const seat = facts.seats.get(nameKey(recipient.recipient));
    return { ...recipient, ...(seat === undefined ? {} : { generation: seat.generation, owner: seat.owner }) };
  }) : [];
  const previous = facts.actor ?? { name: activity.actor, firstIndex: activity.index, joined: false, done: false, sayCount: 0 };
  const participant: ParticipantFact = {
    ...previous, lastActiveAt: Math.max(previous.lastActiveAt ?? -Infinity, activity.at),
    ...(activity.kind === 'join' ? { joined: true, done: false, lastJoinIndex: activity.index } : {}),
    ...(activity.kind === 'done' ? { joined: false, done: true } : {}),
    ...(activity.kind === 'say' ? { sayCount: previous.sayCount + 1 } : {}),
  };
  let replaceAttention: AttentionFact | undefined;
  if (activity.kind === 'listen' || activity.kind === 'ignore') {
    const existing = facts.outgoing.find(item => sameName(item.target, activity.target));
    if (existing?.kind !== activity.kind) replaceAttention = { listener: participant.name, target: activity.target, kind: activity.kind, sinceIndex: activity.index };
  }
  const removeListening = activity.kind === 'unlisten' && facts.outgoing.some(item => item.kind === 'listen' && sameName(item.target, activity.target))
    ? { listener: participant.name, target: activity.target } : undefined;
  return { activity, participant, audience, ...(activity.kind === 'done' ? { removeListeningOf: participant.name } : {}),
    ...(removeListening === undefined ? {} : { removeListening }), ...(replaceAttention === undefined ? {} : { replaceAttention }) };
}
export function landingFacts(read: SquareRead, activity: ActDraft): LandingFacts {
  const standing = activity.kind === 'say' ? read.roster().filter(item => item.joined) : [];
  const seats = new Map<string, Seat>();
  for (const participant of standing) {
    const seat = read.seat(participant.name);
    if (seat !== undefined) seats.set(nameKey(participant.name), seat);
  }
  return { actor: read.participant(activity.actor), standing, seats,
    incoming: activity.kind === 'say' ? read.incomingAttention(activity.actor) : [],
    outgoing: activity.kind === 'listen' || activity.kind === 'ignore' || activity.kind === 'unlisten' ? read.attention(activity.actor) : [],
    replyAuthor: activity.kind === 'say' && activity.reply !== undefined ? read.activity(activity.reply)?.actor : undefined };
}
export interface LandingWriter extends Pick<SquareWrite, 'putLease' | 'removeLease' | 'markSeen' | 'setSeatAttachment'>, ProducerWrite {
  storeSeat(seat: Seat): boolean;
  removeSeat(seat: SeatRef): boolean;
  applyLanding(effect: LandingEffect): void;
}
export interface SquareWriteGate { readonly facts: SquareWrite; complete(): void }
export function assertCurrentSeat(read: SquareRead, expected: SeatRef, allowDetached = false): void {
  const current = read.seat(expected.participant);
  if (current === undefined || current.owner !== expected.owner || current.generation !== expected.generation)
    throw new SquareError('already_joined', 'This participant seat has been replaced.');
  if (!allowDetached && current.attachment !== 'attached')
    throw new SquareError('already_joined', 'This participant is away; join again before writing.', { reason: 'needs_seat', activityUnsent: true });
}
export function wrapSquareWrite(read: SquareRead, writes: LandingWriter, authority: ArtifactWriteAuthority): SquareWriteGate {
  if (!authority || typeof authority !== 'object') throw new SquareError('invalid_args', 'Artifact writes require an explicit authority.');
  const denied = () => { throw new SquareError('invalid_args', 'This authority cannot perform that write.'); };
  const deniedWrites = { land: denied, putLease: denied, removeLease: denied, markSeen: denied, setSeatAttachment: denied, insertNotice: denied, ackMatching: denied, acquirePost: denied, settlePost: denied, foldReceipt: denied };
  if (authority.kind === 'producer') {
    return { facts: Object.assign({}, read, deniedWrites, {
      acquirePost(post, token, pid, now, exportAt) {
        if (post.kind === 'activity') {
          const lease = freshWatchLease(read, post.recipient, now);
          const arrival = read.directedAt(post.recipient, post.index);
          if (lease && arrival?.generation === post.generation && leaseOwnsNotification(lease, arrival)) return false;
        }
        return writes.acquirePost(post, token, pid, now, exportAt);
      },
      settlePost: writes.settlePost, foldReceipt: writes.foldReceipt, setSeatAttachment: writes.setSeatAttachment,
    } satisfies Pick<SquareWrite, 'acquirePost' | 'settlePost' | 'foldReceipt' | 'setSeatAttachment'>), complete() {} };
  }
  if (authority.kind === 'send') {
    validateName(authority.actor);
    return { facts: Object.assign({}, read, deniedWrites, { insertNotice(input: Parameters<ProducerWrite['insertNotice']>[0], at: number) {
      if (!sameName(input.from, authority.actor)) throw new SquareError('invalid_args', 'Notice sender does not match its authority.');
      return writes.insertNotice(input, at);
    } }), complete() {} };
  }
  const seated = authority.kind === 'participant' || authority.kind === 'host-cleanup';
  const name = seated ? authority.seat.participant : authority.participant;
  validateName(name);
  if (seated) { validateOwner(authority.seat.owner); validateEndpointGeneration(authority.seat.generation); }
  else { validateOwner(authority.owner); if (authority.kind === 'takeover') validateEndpointGeneration(authority.expectedGeneration); }
  if (authority.kind === 'participant') assertCurrentSeat(read, authority.seat);
  if (authority.kind === 'join' && read.participant(name)?.joined) {
    const seat = read.seat(name);
    if (seat === undefined || seat.owner !== authority.owner) throw new SquareError('already_joined', `${name} is held by another owner; take it over explicitly`);
  }
  if (authority.kind === 'takeover' && read.seat(name)?.generation !== authority.expectedGeneration)
    throw new SquareError('already_joined', 'The participant seat changed before takeover.');
  let takeoverPhase: 'ready' | 'done' | 'joined' = 'ready';
  let establishedSeat: Seat | undefined;
  const participant = (requested: string, generation?: string) => {
    if (authority.kind !== 'participant' || !sameName(requested, name) || generation !== undefined && generation !== authority.seat.generation)
      throw new SquareError('already_joined', 'This write needs the current participant seat.');
    assertCurrentSeat(read, authority.seat);
  };
  const facts: SquareWrite = Object.assign({}, read, deniedWrites, {
    land(activity: ActDraft): StoredAct {
      if (!sameName(activity.actor, name)) throw new SquareError('already_joined', 'Activity actor does not match the artifact authority.');
      if (authority.kind === 'participant') {
        assertCurrentSeat(read, authority.seat);
        if (activity.kind === 'join') throw new SquareError('invalid_args', 'A participant seat can only be established by join.');
      } else if (authority.kind === 'host-cleanup') {
        assertCurrentSeat(read, authority.seat, true);
        if (activity.kind !== 'done') throw new SquareError('invalid_args', 'Host cleanup may only end membership.');
      } else if (authority.kind === 'join') {
        if (activity.kind !== 'join' || read.participant(name)?.joined) throw new SquareError('already_joined', 'A new seat requires a new join.');
      } else if (takeoverPhase === 'ready') {
        if (activity.kind !== 'done' || read.seat(name)?.generation !== authority.expectedGeneration) throw new SquareError('already_joined', 'Takeover must first complete the captured participant.');
      } else if (takeoverPhase === 'done') {
        if (activity.kind !== 'join' || !read.participant(name)?.done) throw new SquareError('already_joined', 'Takeover must join after its captured done activity.');
      } else throw new SquareError('invalid_args', 'Takeover permits only one done followed by one join.');
      const index = read.header().nextActIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index >= Number.MAX_SAFE_INTEGER) throw new SquareError('invalid_args', 'Square activity index is exhausted.');
      const captured = authority.kind === 'takeover' && activity.kind === 'done' ? read.seat(name) : undefined;
      const stored = { ...activity, index } as StoredAct;
      writes.applyLanding(deriveLanding(stored, landingFacts(read, activity)));
      if (stored.kind === 'join') {
        if (authority.kind !== 'join' && authority.kind !== 'takeover') throw new SquareError('invalid_args', 'Seat authority cannot establish another seat.');
        const seat: Seat = { participant: stored.actor, owner: authority.owner, generation: newEndpointGeneration(), attachment: 'attached', ...(authority.wakeAddress === undefined ? {} : { wakeAddress: authority.wakeAddress }) };
        writes.storeSeat(seat); establishedSeat = seat;
        if (authority.kind === 'takeover') takeoverPhase = 'joined';
      } else if (stored.kind === 'done' && seated) {
        if (!writes.removeSeat(authority.seat)) throw new SquareError('already_joined', 'The participant seat changed while completing it.');
      } else if (stored.kind === 'done' && authority.kind === 'takeover') {
        if (captured === undefined || !writes.removeSeat(captured)) throw new SquareError('already_joined', 'The participant seat changed while takeover completed it.');
        takeoverPhase = 'done';
      }
      // Return the persisted, detached fact rather than freezing the caller's draft.
      const landed = read.activity(index);
      if (landed === undefined) throw new SquareError('invalid_args', 'The activity did not land.');
      return landed;
    },
    putLease(name: string, lease: WatchLease, generation?: string) { participant(name, generation); return writes.putLease(name, lease, generation); },
    removeLease(name: string, leaseId: string, generation?: string) { participant(name, generation); return writes.removeLease(name, leaseId, generation); },
    markSeen(name: string, indexes: readonly number[], at: number) { participant(name); return writes.markSeen(name, indexes, at); },
    ackMatching(seat: SeatRef, input: Parameters<ProducerWrite['ackMatching']>[1], at: number) { participant(seat.participant, seat.generation); if (authority.kind !== 'participant' || authority.seat.owner !== seat.owner) throw new SquareError('already_joined', 'Seat owner changed.'); return writes.ackMatching(seat, input, at); },
  });
  return { facts, complete() {
    if (authority.kind !== 'takeover') return;
    const seat = read.seat(name);
    if (takeoverPhase !== 'joined' || seat === undefined || establishedSeat === undefined || seat.owner !== establishedSeat.owner || seat.generation !== establishedSeat.generation)
      throw new SquareError('already_joined', 'Takeover did not complete its replacement join.');
  } };
}
