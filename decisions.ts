import {
  SquareError, isSquareError, type SquareErrorCode, type SquareErrorFacts, type Act, type StoredAct, type Reach, sameName, nameKey, validateName,
} from './model.js';
import type { ParticipantFact, SquareRead } from './ports.js';
import { participantIdentity } from './participant-identity.js';
import { UNREAD_BLOCK_GRACE_MS, freshWatchLease, readCursor, FACT_PAGE_SIZE, THROTTLE_WINDOW_MS } from './runtime.js';
import { formatActivityId, MAX_IDENTITY_SET_SIZE, type Perception } from './square-core.js';
import { scanMentionCandidates, resolveNameAt, type MentionCandidate } from './mention-parse.js';

type TimedAct<K extends Act['kind'] = Act['kind']> = Extract<Act, { kind: K }> & { at: number };
import type { ParticipantSummary as ParticipantStatus, StatusObservation as StatusResult, UnreadActivitySummary } from './square-facade.js';
export type { ParticipantSummary as ParticipantStatus, ParticipantPresence as CorePresenceState, StatusObservation as StatusResult, UnreadActivitySummary, UnreadActivityPreview } from './square-facade.js';

export function resolveKnownName(facts: SquareRead, name: string): string {
  validateName(name);
  const known = facts.participant(name)?.name;
  if (known === undefined) throw new SquareError('invalid_args', `${participantIdentity(name)} has never stepped into this square`, { reason: 'never_joined' });
  return known;
}
export interface DecideJoinResult { joinedName: string; addParticipant: boolean; joinAct?: TimedAct<'join'> }
export interface DecideImplicitJoinResult { joinedName: string; state: 'joined' | 'active' | 'done'; joinAct?: TimedAct<'join'> }
export function decideJoin(facts: SquareRead, name: string, now: number): DecideJoinResult {
  validateName(name);
  const current = facts.participant(name);
  const joinedName = current?.name ?? name;
  return current?.joined ? { joinedName, addParticipant: false }
    : { joinedName, addParticipant: current === undefined, joinAct: { kind: 'join', actor: joinedName, at: now } };
}
export function decideImplicitJoin(facts: SquareRead, name: string, now: number): DecideImplicitJoinResult {
  validateName(name);
  const current = facts.participant(name);
  return current === undefined ? { joinedName: name, state: 'joined', joinAct: { kind: 'join', actor: name, at: now } }
    : { joinedName: current.name, state: current.joined ? 'active' : 'done' };
}
function validateActivityName(name: string): void {
  try { validateName(name); }
  catch (error) {
    if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true };
    throw error;
  }
}
function activityRefusal(code: SquareErrorCode, message: string, facts?: SquareErrorFacts): SquareError {
  return new SquareError(code, message, { ...facts, activityUnsent: true });
}
function resolveStanding(facts: SquareRead, name: string, activity = false): ParticipantFact {
  if (activity) validateActivityName(name); else validateName(name);
  const current = facts.participant(name);
  if (current === undefined) {
    const message = `${participantIdentity(name)} has not joined this square`;
    throw activity ? activityRefusal('not_joined', message) : new SquareError('not_joined', message);
  }
  return current;
}
function requireStanding(current: ParticipantFact): void {
  if (current.done) throw new SquareError('already_done', `${participantIdentity(current.name)} is already done`);
  if (!current.joined) throw new SquareError('not_joined', `${participantIdentity(current.name)} has not joined this square`);
}
export type ActDecision =
  | { type: 'sent'; act: TimedAct; replyAuthorNotHere?: string }
  | { type: 'blocked'; activitySummaries: UnreadActivitySummary[] }
  | { type: 'capped'; count: number; hardCap: number }
  | { type: 'throttled'; delayMs: number }
  | { type: 'held'; reason: string | undefined }
  | { type: 'bell_quota'; nextAt: number };

/** Count the directed suffix, but hydrate only its last three previews per spelling. */
export function unreadActivitySummaries(facts: SquareRead, name: string, now: number): UnreadActivitySummary[] {
  let afterIndex = readCursor(facts, name);
  const numbers = new Map<string, number>();
  const summaries = new Map<string, { count: number; latestAt: number; previews: { index: number; number: number }[] }>();
  while (true) {
    const page = facts.directed(name, { afterIndex }, { edge: 'oldest', limit: FACT_PAGE_SIZE });
    for (const item of page.items) {
      const key = nameKey(item.actor);
      const number = (numbers.get(key) ?? 0) + 1;
      numbers.set(key, number);
      const summary = summaries.get(item.actor) ?? { count: 0, latestAt: -Infinity, previews: [] };
      summary.count++;
      summary.latestAt = Math.max(summary.latestAt, item.at);
      summary.previews.push({ index: item.index, number });
      if (summary.previews.length > 3) summary.previews.shift();
      summaries.set(item.actor, summary);
    }
    if (!page.hasMore) break;
    afterIndex = page.items.at(-1)!.index;
  }
  const selected = facts.activities([...summaries.values()].flatMap((item) => item.previews.map((preview) => preview.index)));
  const byIndex = new Map(selected.map((item) => [item.index, item]));
  return [...summaries].map(([name, summary]) => ({
    name, count: summary.count, latestActivityAgeMs: Math.max(0, now - summary.latestAt),
    previews: summary.previews.map((preview) => ({ number: preview.number, act: byIndex.get(preview.index) as Extract<StoredAct, { kind: 'say' }>, perception: 'full' as const })),
  })).sort((a, b) => a.latestActivityAgeMs - b.latestActivityAgeMs || a.name.localeCompare(b.name));
}

export function decideAct(facts: SquareRead, input: { name: string; body: string; force: boolean; now: number; mentions?: readonly string[]; reach?: Reach; reply?: number; noMention?: boolean; requireExplicitReach?: boolean }): ActDecision {
  const { now, force, body, reach, reply } = input;
  const current = resolveStanding(facts, input.name, true);
  const name = current.name;
  if (body.trim() === '') throw activityRefusal('invalid_args', 'express body cannot be empty');
  const roster = facts.roster();
  const joinedNames = roster.filter((participant) => participant.joined).map((participant) => participant.name);
  const mentionNames: string[] = [];
  const addMention = (resolved: string) => {
    if (mentionNames.some((existing) => sameName(existing, resolved))) return;
    if (mentionNames.length >= MAX_IDENTITY_SET_SIZE) throw activityRefusal('invalid_args', `An activity can mention at most ${MAX_IDENTITY_SET_SIZE} participants`);
    mentionNames.push(resolved);
  };
  for (const requested of input.mentions ?? []) {
    validateActivityName(requested);
    const resolved = joinedNames.find((candidate) => sameName(candidate, requested));
    if (resolved === undefined) throw activityRefusal('invalid_args', `${participantIdentity(requested)} is not standing in this square`, { reason: 'not_standing', targets: [requested] });
    addMention(resolved);
  }
  if (input.noMention !== true) {
    const unmatched: MentionCandidate[] = [];
    for (const candidate of scanMentionCandidates(body)) {
      const resolved = resolveNameAt(body, candidate, joinedNames);
      if (resolved === undefined) unmatched.push(candidate); else addMention(resolved);
    }
    if (reach !== 'bell' && unmatched.length > 0) {
      const names = roster.map((participant) => participant.name);
      const notStanding = unmatched.filter((candidate) => resolveNameAt(body, candidate, names) !== undefined);
      const unknown = unmatched.filter((candidate) => !notStanding.includes(candidate));
      const lines: string[] = [];
      if (unknown.length > 0) lines.push(`${unknown.map((candidate) => participantIdentity(candidate.token)).join(', ')} ${unknown.length === 1 ? 'does' : 'do'} not match anyone in this square`);
      if (notStanding.length > 0) lines.push(`${notStanding.map((candidate) => participantIdentity(candidate.token)).join(', ')} ${notStanding.length === 1 ? 'is' : 'are'} not standing in this square`);
      throw activityRefusal('invalid_args', lines.join('\n'), { reason: 'unmatched_mention', targets: unmatched.map((candidate) => candidate.token) });
    }
  }
  if (reach === 'bell' && mentionNames.length > 0) throw activityRefusal('invalid_args', 'A bell cannot be combined with a mention', { reason: 'bell_mention_conflict', targets: mentionNames });
  if (input.requireExplicitReach && reach !== 'bell' && mentionNames.length === 0 && reply === undefined && input.noMention !== true) {
    throw activityRefusal('invalid_args', 'Express needs a recipient, reply, bell, or explicit bare reach', { reason: 'explicit_reach_required' });
  }
  const header = facts.header();
  if (reply !== undefined && (!Number.isSafeInteger(reply) || reply < 0 || reply >= header.nextActIndex)) {
    const label = Number.isSafeInteger(reply) && reply >= 0 ? formatActivityId(reply) : String(reply);
    throw activityRefusal('invalid_args', `Unknown reply activity: ${label}`, { reason: 'invalid_reply', activityId: label, activityExists: false });
  }
  const replyAuthor = reply === undefined ? undefined : facts.activity(reply)?.actor;
  const replyAuthorNotHere = replyAuthor === undefined || sameName(replyAuthor, name) || facts.participant(replyAuthor)?.joined ? undefined : replyAuthor;
  // Preserve admission priority after metadata validation.
  if (current.done) throw activityRefusal('already_done', `${name} is already done`);
  if (!current.joined) throw activityRefusal('not_joined', `${name} has not joined this square`);
  const hold = facts.hold();
  if (hold.active) return { type: 'held', reason: hold.reason };
  if (header.hardCap !== null && current.sayCount >= header.hardCap) return { type: 'capped', count: current.sayCount, hardCap: header.hardCap };
  if (reach === 'bell') {
    const recent = facts.recentSayTimes(now - 3600000, 1, name, true);
    if (recent.length > 0) return { type: 'bell_quota', nextAt: recent[0] + 3600000 };
  }
  if (header.throttlePerMinute !== undefined) {
    const recent = facts.recentSayTimes(now - THROTTLE_WINDOW_MS, header.throttlePerMinute);
    if (recent.length >= header.throttlePerMinute) return { type: 'throttled', delayMs: Math.max(1, recent[0] + THROTTLE_WINDOW_MS - now) };
  }
  if (!force) {
    const activitySummaries = unreadActivitySummaries(facts, name, now);
    if (activitySummaries.length > 0 && activitySummaries[0].latestActivityAgeMs > UNREAD_BLOCK_GRACE_MS) return { type: 'blocked', activitySummaries };
  }
  return { type: 'sent', act: { kind: 'say', actor: name, at: now, body, mentions: mentionNames,
    ...(reach === undefined ? {} : { reach }), ...(reply === undefined ? {} : { reply }) },
    ...(replyAuthorNotHere === undefined ? {} : { replyAuthorNotHere }) };
}

export function validateDoneBody(body: unknown): void {
  if (body !== undefined && body !== '') throw new SquareError('invalid_args', 'done only leaves the square and does not accept a message; use express before leaving', { reason: 'invalid_done_body' });
}
export function coreDone(facts: SquareRead, name: string, body: string, now: number): TimedAct<'done'> {
  validateDoneBody(body);
  const current = resolveStanding(facts, name);
  requireStanding(current);
  return { kind: 'done', actor: current.name, at: now };
}
function attentionChange(facts: SquareRead, kind: 'listen' | 'ignore', actor: string, target: string, now: number): TimedAct<'listen' | 'ignore'> | undefined {
  const current = resolveStanding(facts, actor);
  validateName(target);
  requireStanding(current);
  const outgoing = facts.attention(current.name);
  const existing = outgoing.find((item) => sameName(item.target, target));
  if (kind === 'listen' && existing?.kind !== 'listen' && outgoing.filter((item) => item.kind === 'listen').length >= MAX_IDENTITY_SET_SIZE) {
    throw new SquareError('invalid_args', `A participant can listen to at most ${MAX_IDENTITY_SET_SIZE} others`);
  }
  return existing?.kind === kind ? undefined : { kind, actor: current.name, target, at: now };
}
export function coreListen(facts: SquareRead, actor: string, target: string, now: number) { return attentionChange(facts, 'listen', actor, target, now); }
export function coreIgnore(facts: SquareRead, actor: string, target: string, now: number) { return attentionChange(facts, 'ignore', actor, target, now); }
export function coreListening(facts: SquareRead, actor: string): readonly string[] {
  const current = resolveStanding(facts, actor);
  return facts.attention(current.name).filter((item) => item.kind === 'listen').map((item) => item.target);
}
export function coreHold(facts: SquareRead, actor: string, body: string, now: number): TimedAct<'hold'> {
  const current = resolveStanding(facts, actor);
  requireStanding(current);
  return { kind: 'hold', actor: current.name, at: now, body: body.replace(/\r\n/g, '\n').trim() };
}
export function coreResume(facts: SquareRead, actor: string, now: number): TimedAct<'resume'> {
  const current = resolveStanding(facts, actor);
  requireStanding(current);
  return { kind: 'resume', actor: current.name, at: now };
}

export function compareParticipantActivity(a: Pick<ParticipantStatus, 'name' | 'lastActiveAt'>, b: Pick<ParticipantStatus, 'name' | 'lastActiveAt'>): number {
  return (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity) || a.name.localeCompare(b.name);
}
export function coreParticipants(facts: SquareRead, now: number): ParticipantStatus[] {
  return facts.roster().map((current): ParticipantStatus => {
    let lastActiveAt = current.lastActiveAt;
    if (current.joined) {
      const seenAt = facts.receiptFacts(current.name, current.lastJoinIndex ?? -1).latestAt;
      if (seenAt !== undefined) lastActiveAt = Math.max(lastActiveAt ?? -Infinity, seenAt);
    }
    return {
      name: current.name, state: current.done ? 'done' : current.joined ? 'active' : 'not joined',
      listening: facts.attention(current.name).filter((item) => item.kind === 'listen').map((item) => item.target),
      activityCount: current.sayCount, lastActiveAt,
      presence: current.done ? 'done' : !current.joined ? 'never-joined' : freshWatchLease(facts, current.name, now) !== undefined ? 'watching' : 'active',
      unreadActivityCount: current.joined ? facts.directedCount(current.name, { afterIndex: readCursor(facts, current.name) }) : 0,
      pendingMentionCount: current.joined ? facts.directedCount(current.name, { afterIndex: current.lastJoinIndex ?? -1, unseenOnly: true }) : 0,
    };
  }).sort(compareParticipantActivity);
}
export function coreStatus(facts: SquareRead, now: number): StatusResult {
  const header = facts.header(), hold = facts.hold(), roster = facts.roster();
  const latest = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: 1 }).items[0];
  return {
    hardCap: header.hardCap, throttlePerMinute: header.throttlePerMinute,
    activeCount: roster.filter((item) => item.joined).length, doneCount: roster.filter((item) => item.done).length,
    holdActive: hold.active, holdReason: hold.reason, holdActor: hold.actor, holdAt: hold.at,
    participants: coreParticipants(facts, now), latestAct: latest === undefined ? undefined : facts.activity(latest.index), now,
  };
}
