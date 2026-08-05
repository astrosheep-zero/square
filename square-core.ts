export type Participant = string;
export type Reach = { beside: Participant } | 'bell';

export interface Hold {
  active: boolean;
  at?: number;
  reason?: string;
  actor?: Participant;
}

export type Act =
  | { kind: 'join'; actor: Participant; at?: number }
  | { kind: 'done'; actor: Participant; at?: number; body?: string }
  | { kind: 'say'; actor: Participant; at?: number; body: string; reach?: Reach }
  | { kind: 'hold'; actor?: Participant; at?: number; body?: string }
  | { kind: 'resume'; actor?: Participant; at?: number }
  | { kind: 'read'; actor: Participant; at?: number; through: number };

export interface SquareValidationOptions {
  hardCap?: number | null;
  throttlePerMinute?: number;
  throttleWindowMs?: number;
}

export type Perception = 'full' | 'presence' | 'none';

interface ParticipantSnapshot {
  name: Participant;
  key: string;
  joined: boolean;
  done: boolean;
  activityCount: number;
  lastActiveAt?: number;
  lastReadThrough: number;
}

export interface SquareState {
  participants: ParticipantSnapshot[];
  hold: Hold;
  joined: Participant[];
  done: Participant[];
  throttleActivityAts: number[];
  bellSayAtsByActor: Map<string, number[]>;
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

function pushThrottleAt(state: SquareState, at: number | undefined): void {
  if (typeof at === 'number' && Number.isFinite(at)) state.throttleActivityAts.push(at);
}

function currentParticipant(state: SquareState, participant: Participant): ParticipantSnapshot | undefined {
  return state.participants.find((item) => sameName(item.name, participant));
}

function pushBellAt(state: SquareState, actor: Participant, at: number | undefined): void {
  if (typeof at !== 'number' || !Number.isFinite(at)) return;
  const key = nameKey(actor);
  const current = state.bellSayAtsByActor.get(key) ?? [];
  current.push(at);
  state.bellSayAtsByActor.set(key, current);
}

function bellRecentAt(state: SquareState, actor: Participant, at: number, windowMs: number): number | undefined {
  const events = state.bellSayAtsByActor.get(nameKey(actor)) ?? [];
  let latest: number | undefined;
  for (const eventAt of events) {
    if (at - eventAt >= windowMs) continue;
    latest = latest === undefined ? eventAt : Math.max(latest, eventAt);
  }
  return latest;
}

export function fold(acts: readonly Act[]): SquareState {
  const ordered: MutableParticipantSnapshot[] = [];
  const byKey = new Map<string, MutableParticipantSnapshot>();
  const hold: Hold = { active: false };
  const state: SquareState = {
    participants: ordered,
    hold,
    joined: [],
    done: [],
    throttleActivityAts: [],
    bellSayAtsByActor: new Map(),
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
        }
        break;
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

export function validate(state: SquareState, act: Act, options: SquareValidationOptions = {}): ValidationResult {
  const actor = actorOf(act);
  const current = actor === undefined ? undefined : currentParticipant(state, actor);

  switch (act.kind) {
    case 'join':
      return current?.joined ? { ok: false, reason: 'already_joined' } : { ok: true };
    case 'done':
      if (current?.done) return { ok: false, reason: 'done' };
      if (current?.joined !== true) return { ok: false, reason: 'not_joined' };
      return { ok: true };
    case 'say': {
      if (current?.done) return { ok: false, reason: 'done' };
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
    case 'read':
      return { ok: true };
  }
}

export function perceive(
  state: SquareState,
  act: Act,
  viewer: Participant | string
): Perception {
  void state;
  if (act.kind !== 'say') return 'full';
  const actor = act.actor;
  if (sameName(actor, viewer)) return 'full';
  if (act.reach === undefined || act.reach === 'bell') return 'full';
  if (sameName(act.reach.beside, viewer)) return 'full';
  return 'presence';
}
