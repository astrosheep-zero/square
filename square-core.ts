export type Participant = string;
export type Reach = 'bell';
export type Audience =
  | { readonly kind: 'bell' }
  | { readonly kind: 'mentions'; readonly names: readonly string[] };
export type ActivityId = `act/${number}`;

export function formatActivityId(index: number): ActivityId {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid activity index: ${index}`);
  }
  return `act/${index}`;
}

export function parseActivityId(value: string): number | undefined {
  if (value === 'act/0') return 0;
  if (typeof value !== 'string' || !/^act\/[1-9]\d*$/.test(value)) return undefined;
  const index = Number(value.slice(4));
  return Number.isSafeInteger(index) ? index : undefined;
}

export interface Hold {
  active: boolean;
  at?: number;
  reason?: string;
  actor?: Participant;
}

export type Act =
  | { kind: 'join'; actor: Participant; at?: number }
  | { kind: 'done'; actor: Participant; at?: number; body?: string }
  | { kind: 'say'; actor: Participant; at?: number; body: string; reach?: Reach; reply?: number }
  | { kind: 'hold'; actor?: Participant; at?: number; body?: string }
  | { kind: 'resume'; actor?: Participant; at?: number }
  | { kind: 'read'; actor: Participant; at?: number; through: number }
  | { kind: 'listen'; actor: Participant; target: Participant; at?: number }
  | { kind: 'ignore'; actor: Participant; target: Participant; at?: number };

export interface SquareValidationOptions {
  hardCap?: number | null;
  throttlePerMinute?: number;
  throttleWindowMs?: number;
}

export type Perception = 'full' | 'presence';

interface ParticipantSnapshot {
  name: Participant;
  key: string;
  joined: boolean;
  done: boolean;
  activityCount: number;
  lastActiveAt?: number;
  lastReadThrough: number;
}

export interface FoldedSquareState {
  participants: ParticipantSnapshot[];
  hold: Hold;
  joined: Participant[];
  done: Participant[];
  throttleActivityAts: number[];
  bellSayAtsByActor: Map<string, number[]>;
  listening: Map<string, Participant[]>;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: 'already_joined' }
  | { ok: false; reason: 'not_joined' }
  | { ok: false; reason: 'done' }
  | { ok: false; reason: 'held'; hold: Hold }
  | { ok: false; reason: 'hard_cap'; count: number; hardCap: number }
  | { ok: false; reason: 'throttled'; delayMs: number }
  | { ok: false; reason: 'bell_quota'; nextAt: number };

interface MutableParticipantSnapshot extends ParticipantSnapshot {}

function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

export function extractMentions(body: string): string[] {
  const matches = [];
  const re = /@([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;
  let match;
  while ((match = re.exec(body)) !== null) matches.push(match[1]);
  return matches;
}

function uniqueMentionNames(names: readonly string[]): string[] {
  const unique: string[] = [];
  for (const name of names) {
    if (unique.some((existing) => sameName(existing, name))) continue;
    unique.push(name);
  }
  return unique;
}

export function audienceOf(say: { body: string; reach?: Reach }): Audience {
  if (say.reach === 'bell') return { kind: 'bell' };
  return { kind: 'mentions', names: uniqueMentionNames(extractMentions(say.body)) };
}

export function audienceIncludes(audience: Audience, name: string): boolean {
  if (audience.kind === 'bell') return true;
  return audience.names.some((mentioned) => sameName(mentioned, name));
}

export function resolveAudience(audience: Audience, candidateNames: readonly string[]): string[] {
  if (audience.kind === 'bell') return [...candidateNames];
  const resolved: string[] = [];
  for (const mention of audience.names) {
    const known = candidateNames.find((candidate) => sameName(candidate, mention));
    if (known !== undefined && !resolved.some((existing) => sameName(existing, known))) {
      resolved.push(known);
    }
  }
  return resolved;
}

export function activeListeners(state: FoldedSquareState, sender: string): string[] {
  return state.participants
    .filter((participant) => participant.joined && (state.listening.get(nameKey(participant.name)) ?? []).some((target) => sameName(target, sender)))
    .map((participant) => participant.name);
}

export function audienceBefore(acts: readonly Act[], say: Extract<Act, { kind: 'say' }>): string[] {
  const position = acts.findIndex((act) => act === say || (
    'index' in act && 'index' in say && act.index === say.index
  ));
  const before = fold(position < 0 ? acts : acts.slice(0, position));
  const mentionTargets = resolveAudience(audienceOf(say), before.joined);
  const listeners = activeListeners(before, say.actor);
  const recipients: string[] = [];
  for (const name of [...mentionTargets, ...listeners]) {
    if (sameName(name, say.actor) || recipients.some((existing) => sameName(existing, name))) continue;
    recipients.push(name);
  }
  return recipients;
}

/** Whether a peer say was directed to this participant when it landed. */
export function landedAudienceIncludes(
  acts: readonly Act[],
  activity: Act,
  viewer: string,
): boolean {
  if (activity.kind !== 'say' || sameName(activity.actor, viewer)) return false;
  return audienceBefore(acts, activity).some((recipient) => sameName(recipient, viewer));
}

export function listeningTo(state: FoldedSquareState, listener: string): string[] {
  return [...(state.listening.get(nameKey(listener)) ?? [])];
}

export function isListening(state: FoldedSquareState, listener: string, sender: string): boolean {
  return listeningTo(state, listener).some((target) => sameName(target, sender));
}

function actorOf(act: Act): Participant | undefined {
  if ('actor' in act && typeof act.actor === 'string') return act.actor;
  return undefined;
}

function touchParticipant(
  byKey: Map<string, MutableParticipantSnapshot>,
  ordered: MutableParticipantSnapshot[],
  actor: Participant
): MutableParticipantSnapshot {
  const key = nameKey(actor);
  const existing = byKey.get(key);
  if (existing !== undefined) return existing;
  const created: MutableParticipantSnapshot = {
    name: actor,
    key,
    joined: false,
    done: false,
    activityCount: 0,
    lastReadThrough: -1,
  };
  byKey.set(key, created);
  ordered.push(created);
  return created;
}

function pushThrottleAt(state: FoldedSquareState, at: number | undefined): void {
  if (typeof at === 'number' && Number.isFinite(at)) state.throttleActivityAts.push(at);
}

function currentParticipant(state: FoldedSquareState, participant: Participant): ParticipantSnapshot | undefined {
  return state.participants.find((item) => sameName(item.name, participant));
}

function pushBellAt(state: FoldedSquareState, actor: Participant, at: number | undefined): void {
  if (typeof at !== 'number' || !Number.isFinite(at)) return;
  const key = nameKey(actor);
  const current = state.bellSayAtsByActor.get(key) ?? [];
  current.push(at);
  state.bellSayAtsByActor.set(key, current);
}

function bellRecentAt(state: FoldedSquareState, actor: Participant, at: number, windowMs: number): number | undefined {
  const events = state.bellSayAtsByActor.get(nameKey(actor)) ?? [];
  let latest: number | undefined;
  for (const eventAt of events) {
    if (at - eventAt >= windowMs) continue;
    latest = latest === undefined ? eventAt : Math.max(latest, eventAt);
  }
  return latest;
}

export function fold(acts: readonly Act[]): FoldedSquareState {
  const ordered: MutableParticipantSnapshot[] = [];
  const byKey = new Map<string, MutableParticipantSnapshot>();
  const hold: Hold = { active: false };
  const state: FoldedSquareState = {
    participants: ordered,
    hold,
    joined: [],
    done: [],
    throttleActivityAts: [],
    bellSayAtsByActor: new Map(),
    listening: new Map(),
  };

  for (const act of acts) {
    const actor = actorOf(act);
    const snapshot = actor === undefined ? undefined : touchParticipant(byKey, ordered, actor);

    switch (act.kind) {
      case 'join':
        if (snapshot !== undefined) {
          snapshot.joined = true;
          snapshot.done = false;
          snapshot.lastActiveAt = act.at ?? snapshot.lastActiveAt;
        }
        break;
      case 'done':
        if (snapshot !== undefined) {
          snapshot.joined = false;
          snapshot.done = true;
          snapshot.lastActiveAt = act.at ?? snapshot.lastActiveAt;
          state.listening.delete(nameKey(snapshot.name));
        }
        break;
      case 'listen': {
        const key = nameKey(act.actor);
        const targets = state.listening.get(key) ?? [];
        if (!targets.some((target) => sameName(target, act.target))) targets.push(act.target);
        state.listening.set(key, targets);
        break;
      }
      case 'ignore': {
        const key = nameKey(act.actor);
        const targets = (state.listening.get(key) ?? []).filter((target) => !sameName(target, act.target));
        if (targets.length === 0) state.listening.delete(key); else state.listening.set(key, targets);
        break;
      }
      case 'say':
        if (snapshot !== undefined) {
          snapshot.activityCount += 1;
          snapshot.lastActiveAt = act.at ?? snapshot.lastActiveAt;
        }
        pushThrottleAt(state, act.at);
        if (act.reach === 'bell') pushBellAt(state, act.actor, act.at);
        break;
      case 'hold':
        hold.active = true;
        hold.at = act.at;
        hold.reason = act.body;
        hold.actor = act.actor;
        break;
      case 'resume':
        hold.active = false;
        delete hold.at;
        delete hold.reason;
        delete hold.actor;
        break;
      case 'read':
        if (snapshot !== undefined) {
          snapshot.lastReadThrough = Math.max(snapshot.lastReadThrough, act.through);
        }
        break;
    }
  }

  state.joined = ordered.filter((item) => item.joined).map((item) => item.name);
  state.done = ordered.filter((item) => item.done).map((item) => item.name);
  return state;
}

export function validate(state: FoldedSquareState, act: Act, options: SquareValidationOptions = {}): ValidationResult {
  const actor = actorOf(act);
  const current = actor === undefined ? undefined : currentParticipant(state, actor);

  switch (act.kind) {
    case 'join':
      return current?.joined ? { ok: false, reason: 'already_joined' } : { ok: true };
    case 'done':
      if (current?.done) return { ok: false, reason: 'done' };
      if (current?.joined !== true) return { ok: false, reason: 'not_joined' };
      return { ok: true };
    case 'listen':
    case 'ignore':
      if (current?.done) return { ok: false, reason: 'done' };
      if (current?.joined !== true) return { ok: false, reason: 'not_joined' };
      return { ok: true };
    case 'say': {
      if (current?.done) return { ok: false, reason: 'done' };
      if (current?.joined !== true) return { ok: false, reason: 'not_joined' };
      if (state.hold.active) return { ok: false, reason: 'held', hold: state.hold };
      const activityCount = current?.activityCount ?? 0;
      if (options.hardCap !== undefined && options.hardCap !== null && activityCount >= options.hardCap) {
        return { ok: false, reason: 'hard_cap', count: activityCount, hardCap: options.hardCap };
      }
      const limit = options.throttlePerMinute;
      const at = act.at;
      if (act.reach === 'bell' && typeof at === 'number' && Number.isFinite(at)) {
        const bellWindowMs = 60 * 60 * 1000;
        const latestBellAt = bellRecentAt(state, act.actor, at, bellWindowMs);
        if (latestBellAt !== undefined) {
          return { ok: false, reason: 'bell_quota', nextAt: latestBellAt + bellWindowMs };
        }
      }
      if (limit !== undefined && typeof at === 'number' && Number.isFinite(at)) {
        const windowMs = options.throttleWindowMs ?? 60000;
        const recent = state.throttleActivityAts.filter((eventAt) => at - eventAt < windowMs).sort((a, b) => a - b);
        if (recent.length >= limit) {
          const releaseAt = recent[recent.length - limit] + windowMs;
          const delayMs = Math.max(1, releaseAt - at);
          return { ok: false, reason: 'throttled', delayMs };
        }
      }
      return { ok: true };
    }
    case 'hold':
    case 'resume':
      if (current?.done) return { ok: false, reason: 'done' };
      if (current?.joined !== true) return { ok: false, reason: 'not_joined' };
      return { ok: true };
    case 'read':
      return { ok: true };
  }
}

export function perceive(act: Act, viewer: Participant | string): Perception {
  if (act.kind !== 'say') return 'full';
  if (sameName(act.actor, viewer)) return 'full';
  return audienceIncludes(audienceOf(act), viewer) ? 'full' : 'presence';
}
