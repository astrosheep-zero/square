import {
  SquareError, isSquareError, type SquareErrorCode, type SquareErrorFacts, type Act, type StoredAct, type Reach, type ActivityMetadata, sameName, nameKey, validateName, validateActivityMetadata, activityMetadataHasContent,
} from './model.js';
import type { ParticipantFact, SquareRead } from './ports.js';
import { participantIdentity } from './participant-identity.js';
import { UNREAD_BLOCK_GRACE_MS, freshWatchLease, readCursor, FACT_PAGE_SIZE, THROTTLE_WINDOW_MS } from './runtime.js';
import { formatActivityId, MAX_IDENTITY_SET_SIZE } from './square-core.js';
import { scanMentionCandidates, resolveMention } from './mention-parse.js';

type TimedAct<K extends Act['kind'] = Act['kind']> = Extract<Act, { kind: K }> & { at: number };
import type { ExpressResult, ParticipantSummary, UnreadActivitySummary } from './square-facade.js';

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
  | ({ type: 'sent'; act: TimedAct } & Pick<ExpressResult, 'replyAuthorNotHere' | 'unmatchedMentions'>)
  | { type: 'blocked'; activitySummaries: UnreadActivitySummary[] }
  | { type: 'capped'; count: number; hardCap: number }
  | { type: 'throttled'; delayMs: number }
  | { type: 'held'; reason: string | undefined }
  | { type: 'bell_quota'; nextAt: number };

/** Count the directed suffix and hydrate only its last activity by index per spelling. */
export function unreadActivitySummaries(facts: SquareRead, name: string, now: number): UnreadActivitySummary[] {
  let afterIndex = readCursor(facts, name);
  const summaries = new Map<string, { count: number; latestAt: number; lastIndex: number }>();
  while (true) {
    const page = facts.directed(name, { afterIndex }, { edge: 'oldest', limit: FACT_PAGE_SIZE });
    for (const item of page.items) {
      const summary = summaries.get(item.actor) ?? { count: 0, latestAt: -Infinity, lastIndex: item.index };
      summary.count++;
      summary.latestAt = Math.max(summary.latestAt, item.at);
      summary.lastIndex = item.index;
      summaries.set(item.actor, summary);
    }
    if (!page.hasMore) break;
    afterIndex = page.items.at(-1)!.index;
  }
  const selected = facts.activities([...summaries.values()].map((item) => item.lastIndex));
  const byIndex = new Map(selected.map((item) => [item.index, item]));
  return [...summaries].map(([name, summary]) => ({
    name, count: summary.count, latestActivityAgeMs: Math.max(0, now - summary.latestAt),
    preview: byIndex.get(summary.lastIndex) as Extract<StoredAct, { kind: 'say' }>,
  })).sort((a, b) => a.latestActivityAgeMs - b.latestActivityAgeMs || a.name.localeCompare(b.name));
}

export function decideAct(facts: SquareRead, input: { name: string; body?: string; force: boolean; now: number; metadata?: ActivityMetadata; mentions?: readonly string[]; reach?: Reach; reply?: number; noMention?: boolean }): ActDecision {
  const { now, force, reach, reply } = input;
  let metadata: ActivityMetadata | undefined;
  try { metadata = validateActivityMetadata(input.metadata); }
  catch (error) {
    if (isSquareError(error)) error.facts = { ...error.facts, activityUnsent: true };
    throw error;
  }
  if (input.body !== undefined && typeof input.body !== 'string') throw activityRefusal('invalid_args', 'express body must be a string');
  const body = input.body?.trim() === '' ? undefined : input.body;
  if (body === undefined && !activityMetadataHasContent(metadata)) throw activityRefusal('invalid_args', 'express requires a non-empty body or metadata');
  const current = resolveStanding(facts, input.name, true);
  const name = current.name;
  const roster = facts.roster();
  const joinedNames = roster.filter((participant) => participant.joined).map((participant) => participant.name);
  if (reach === 'bell' && input.mentions?.length) throw activityRefusal('invalid_args', 'A bell cannot be combined with a mention', { reason: 'bell_mention_conflict', targets: [...input.mentions] });
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
  const bodyMentions = reach === 'bell' || input.noMention === true ? [] : scanMentionCandidates(body ?? '');
  const unmatchedMentions: string[] = [];
  for (const token of bodyMentions) {
    const resolved = resolveMention(token, joinedNames);
    if (resolved !== undefined) addMention(resolved);
    else unmatchedMentions.push(token);
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
  return { type: 'sent', act: { kind: 'say', actor: name, at: now, ...(body === undefined ? {} : { body }), ...(metadata === undefined ? {} : { metadata }), mentions: mentionNames,
    ...(reach === undefined ? {} : { reach }), ...(reply === undefined ? {} : { reply }) },
    ...(unmatchedMentions.length === 0 ? {} : { unmatchedMentions }),
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
function attentionChange(facts: SquareRead, kind: 'listen' | 'ignore' | 'unlisten', actor: string, target: string, now: number): TimedAct<'listen' | 'ignore' | 'unlisten'> | undefined {
  const current = resolveStanding(facts, actor);
  validateName(target);
  requireStanding(current);
  const outgoing = facts.attention(current.name);
  const existing = outgoing.find((item) => sameName(item.target, target));
  if (kind === 'unlisten') return existing?.kind === 'listen' ? { kind, actor: current.name, target, at: now } : undefined;
  if (kind === 'listen' && existing?.kind !== 'listen' && outgoing.filter((item) => item.kind === 'listen').length >= MAX_IDENTITY_SET_SIZE) {
    throw new SquareError('invalid_args', `A participant can listen to at most ${MAX_IDENTITY_SET_SIZE} others`);
  }
  return existing?.kind === kind ? undefined : { kind, actor: current.name, target, at: now };
}
export function coreListen(facts: SquareRead, actor: string, target: string, now: number) { return attentionChange(facts, 'listen', actor, target, now); }
export function coreIgnore(facts: SquareRead, actor: string, target: string, now: number) { return attentionChange(facts, 'ignore', actor, target, now); }
export function coreUnlisten(facts: SquareRead, actor: string, target: string, now: number) { return attentionChange(facts, 'unlisten', actor, target, now); }
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

export function compareParticipantActivity(a: Pick<ParticipantSummary, 'name' | 'lastActiveAt'>, b: Pick<ParticipantSummary, 'name' | 'lastActiveAt'>): number {
  return (b.lastActiveAt ?? -Infinity) - (a.lastActiveAt ?? -Infinity) || a.name.localeCompare(b.name);
}
export function coreParticipants(facts: SquareRead, now: number): ParticipantSummary[] {
  return facts.roster().map((current): ParticipantSummary => {
    let lastActiveAt = current.lastActiveAt;
    if (current.joined) {
      const seenAt = facts.receiptFacts(current.name, current.lastJoinIndex ?? -1).latestAt;
      if (seenAt !== undefined) lastActiveAt = Math.max(lastActiveAt ?? -Infinity, seenAt);
    }
    return {
      name: current.name,
      listening: facts.attention(current.name).filter((item) => item.kind === 'listen').map((item) => item.target),
      activityCount: current.sayCount, lastActiveAt,
      presence: current.done ? 'done' : !current.joined ? 'never-joined' : freshWatchLease(facts, current.name, now) !== undefined ? 'watching' : 'active',
      unreadActivityCount: current.joined ? facts.directedCount(current.name, { afterIndex: readCursor(facts, current.name) }) : 0,
      pendingMentionCount: current.joined ? facts.directedCount(current.name, { afterIndex: current.lastJoinIndex ?? -1, unseenOnly: true }) : 0,
    };
  }).sort(compareParticipantActivity);
}
