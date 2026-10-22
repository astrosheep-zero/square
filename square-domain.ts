import { SquareError, sameName, type StoredAct } from './model.js';
import type { AttentionFact, LandedRecipient, ParticipantFact, SquareRead, SquareWrite } from './ports.js';

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

export interface LandingWriter extends Pick<SquareWrite, 'markSeen' | 'putLease' | 'removeLease' | 'replaceRoutes'> {
  applyLanding(effect: LandingEffect): void;
}

/** Driver-owned methods validate rows/writes and track changes; the domain owns allocation. */
export function wrapSquareWrite(read: SquareRead, writes: LandingWriter): SquareWrite {
  const { applyLanding, ...mutations } = writes;
  return Object.assign({}, read, mutations, {
    land(activity: Parameters<SquareWrite['land']>[0]): StoredAct {
      const index = read.header().nextActIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index >= Number.MAX_SAFE_INTEGER) {
        throw new SquareError('invalid_args', 'Square activity index is exhausted.');
      }
      const stored = { ...activity, index } as StoredAct;
      applyLanding(deriveLanding(stored, landingFacts(read, stored)));
      return read.activity(index)!;
    },
  });
}
