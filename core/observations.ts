import { formatActivityId, PAGE_CAP, parseActivityId, type ActivityId, type Perception, type Reach } from './square-core.js';
import { compareParticipantActivity, coreParticipants, resolveKnownName, unreadActivitySummaries, type ParticipantSummary } from './decisions.js';
import { SquareError, nameKey, sameName, type ActivityMetadata, type DirectedNotificationRoute, type HydratedAct, type Owner, type StoredAct } from './model.js';
import { truncateChars } from './neutral.js';
import type { ActivityFilter, SquareRead } from './ports.js';
import { inSquareCount } from './runtime.js';
import { historySearch } from './search.js';
import { parseTimeOrRelative } from './time.js';
import type { HistoryQuery } from './operation-inputs.js';

export interface Activity {
  readonly id: ActivityId;
  readonly at: number;
  readonly kind: StoredAct['kind'];
  readonly actor: string;
  readonly body?: string;
  readonly metadata?: ActivityMetadata;
  readonly mentions: readonly string[];
  readonly reach?: Reach;
  readonly target?: string;
  readonly reply?: ActivityId;
  readonly through?: ActivityId;
}
export interface PerceivedActivity extends Activity {
  readonly perception: Perception;
  readonly via?: DirectedNotificationRoute;
}
export interface EntryPresentation {
  readonly joinedBefore: boolean;
  readonly scene: string;
  readonly joinContext: string;
  readonly recentActivities: readonly PerceivedActivity[];
}
export interface PresenceClassification {
  readonly orderedHereNames: readonly string[];
  readonly lingeringCount: number;
  readonly classificationByName: Readonly<Record<string, 'here' | 'lingering' | 'away' | 'done' | 'not-joined'>>;
}
export interface StatusResult extends ParticipantsResult {
  /** Present when a viewer resolves; an empty list means they listen to nobody. */
  readonly listening?: readonly string[];
  readonly hardCap: number | null;
  readonly now: number;
  readonly throttlePerMinute?: number;
  readonly latestActivity?: Activity;
  readonly latestPerception?: Perception;
  /** Active all-owner delivery hold; seats may still have independent holds. */
  readonly ledgerMutedUntil?: number;
  readonly knownParticipantCount: number;
  readonly joins: readonly { readonly activity: Activity; readonly rejoined: boolean }[];
  readonly joinCount: number;
  readonly attentionNames: readonly string[];
  readonly viewer: string;
}
export interface ParticipantsResult extends PresenceClassification {
  readonly participants: readonly ParticipantSummary[];
  readonly standingCount: number;
}
export interface HistoryContinuation {
  readonly direction: 'before' | 'after';
  readonly cursor: ActivityId;
  readonly limit: number;
}

export const HISTORY_DEFAULT_LIMIT = 10;
const HISTORY_DEFAULT_MAX_CHARS = 1000;
const STATUS_HERE_WINDOW_MS = 30 * 60_000;
const NON_READ = ['join', 'done', 'say', 'listen', 'ignore', 'unlisten'] as const;

export function directedTo(facts: SquareRead, activity: StoredAct, name: string): boolean {
  return activity.kind === 'say' && facts.directedAt(name, activity.index) !== undefined;
}

/** Audience is settled at landing, never reconstructed from a partial history. */
export function perceiveActivity(facts: SquareRead, activity: StoredAct, name: string): Perception {
  return activity.kind !== 'say' || sameName(activity.actor, name) || directedTo(facts, activity, name) ? 'full' : 'presence';
}

/** The one stored-to-public Activity field mapping. */
export function toPublicActivity(stored: HydratedAct): Activity {
  return { id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor,
    ...(stored.kind === 'say' && stored.reach !== undefined ? { reach: stored.reach } : {}),
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    ...('metadata' in stored && stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
    mentions: stored.kind === 'say' ? stored.mentions ?? [] : [], ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}),
    ...(stored.kind === 'read' ? { through: formatActivityId(stored.through) } : {}) };
}
export function toPerceivedActivity(facts: SquareRead, stored: HydratedAct, viewer: string): PerceivedActivity {
  const via = facts.directedAt(viewer, stored.index)?.route;
  return { ...toPublicActivity(stored), perception: perceiveActivity(facts, stored, viewer),
    ...(via === undefined ? {} : { via }) };
}
export function parseRequiredActivityId(id: ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

function archiveBound(bound: string | undefined, now: number): [index?: number, time?: number] {
  if (bound === undefined) return [];
  const index = parseActivityId(bound);
  return index === undefined ? [undefined, parseTimeOrRelative(bound, now)] : [index];
}

export function selectHistory(facts: SquareRead, query: HistoryQuery, now: number) {
  const [afterIndex, afterAt] = archiveBound(query.after, now);
  const [beforeIndex, beforeAt] = archiveBound(query.before, now);
  const range = { afterIndex, afterAt, beforeIndex, beforeAt };
  const indexes = query.ids?.map(id => parseActivityId(id)!);
  const filter: ActivityFilter = { ...range, indexes, actors: query.from,
    search: query.search === undefined ? undefined : historySearch(query.search),
    kinds: query.ids !== undefined ? undefined : query.search === undefined ? NON_READ : ['say', 'done'] };
  const recipient = query.to === undefined ? undefined : resolveKnownName(facts, query.to);
  const limit = query.limit ?? HISTORY_DEFAULT_LIMIT;
  const direction = query.after === undefined ? 'before' : 'after';
  const page = { edge: direction === 'before' ? 'newest' as const : 'oldest' as const, limit: Math.max(1, indexes?.length ?? limit) };
  const directedFilter = { ...filter, senders: filter.actors };
  const selected = recipient === undefined ? facts.activityHeads(filter, page) : facts.directed(recipient, directedFilter, page);
  const matches = selected.items.map(head => head.index);
  const context = query.context ?? 0;
  const expanded = context === 0 ? matches : facts.contextIndexes(matches, context, context);
  const activities = facts.activities(expanded).filter(activity => (query.ids !== undefined || activity.kind !== 'read')
    && (afterIndex === undefined || activity.index > afterIndex) && (beforeIndex === undefined || activity.index < beforeIndex)
    && (afterAt === undefined || activity.at > afterAt) && (beforeAt === undefined || activity.at < beforeAt))
    .map(activity => clipHistoryBody(activity, query.maxChars ?? HISTORY_DEFAULT_MAX_CHARS));
  const anchor = direction === 'before' ? matches[0] : matches.at(-1);
  const continuation: HistoryContinuation | undefined = selected.hasMore && indexes === undefined && anchor !== undefined
    ? { direction, cursor: formatActivityId(anchor), limit } : undefined;
  const totalMatches = recipient === undefined ? facts.activityCount(filter) : facts.directedCount(recipient, directedFilter);
  return { activities, totalMatches, ...(continuation === undefined ? {} : { continuation }) };
}

function clipHistoryBody(activity: HydratedAct, maxChars: number): HydratedAct {
  if (!('body' in activity) || activity.body === undefined || activity.body.length <= maxChars) return activity;
  const clipped = truncateChars(activity.body, maxChars);
  return clipped.remaining === 0 ? activity : { ...activity, body: `${clipped.text}\n… ${maxChars + clipped.remaining} characters total` };
}
export function recoveryObservation(facts: SquareRead, name: string, now: number) {
  const known = resolveKnownName(facts, name);
  return { participant: known, activitySummaries: unreadActivitySummaries(facts, known, now), standingCount: inSquareCount(facts),
    ownActivityCount: facts.participant(known)!.sayCount, hardCap: facts.header().hardCap };
}
export function entryPresentation(facts: SquareRead, name: string): EntryPresentation {
  const header = facts.header();
  const heads = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: HISTORY_DEFAULT_LIMIT }).items;
  return { joinedBefore: facts.activityCount({ kinds: ['join'], actors: [name] }) > 1,
    scene: header.warmup.join('\n').trim(),
    joinContext: header.preamble.join('\n').trim(),
    recentActivities: facts.activities(heads.map((head) => head.index)).map((activity) => ({ ...toPublicActivity(activity), perception: perceiveActivity(facts, activity, name) })) };
}
function classifyPresence(participants: readonly ParticipantSummary[], now: number): PresenceClassification {
  const standing = (participant: ParticipantSummary) => participant.presence === 'active' || participant.presence === 'watching';
  const here = participants.filter((participant) => standing(participant) && (participant.presence === 'watching'
    || (participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= STATUS_HERE_WINDOW_MS)));
  const hereNames = new Set(here.map((participant) => participant.name));
  return { orderedHereNames: [...here.filter((participant) => participant.presence === 'watching'), ...here.filter((participant) => participant.presence !== 'watching')].map((participant) => participant.name),
    lingeringCount: participants.filter((participant) => standing(participant) && !hereNames.has(participant.name)).length,
    classificationByName: Object.fromEntries(participants.map((participant) => [participant.name, participant.presence === 'done' ? 'done'
      : participant.presence === 'never-joined' ? 'not-joined' : participant.presence === 'away' ? 'away' : hereNames.has(participant.name) ? 'here' : 'lingering'])) };
}
export function queryParticipants(facts: SquareRead, now: number): ParticipantsResult {
  const participants = coreParticipants(facts, now);
  return { participants, ...classifyPresence(participants, now), standingCount: inSquareCount(facts) };
}
export function listPresentation(facts: SquareRead, owner?: Owner) {
  const participants = facts.roster().filter((p) => p.joined).map((p) => {
    const receiptAt = facts.receiptFacts(p.name, p.lastJoinIndex ?? -1).latestAt;
    return { name: p.name, lastActiveAt: receiptAt === undefined ? p.lastActiveAt : Math.max(p.lastActiveAt ?? -Infinity, receiptAt) };
  }).sort(compareParticipantActivity).map((p) => p.name);
  return { context: facts.header().preamble, participants, activities: facts.activityCount({ kinds: ['say'] }),
    ...(owner === undefined ? {} : { joined: facts.seatsForOwner(owner)
      .filter(seat => facts.participant(seat.participant)?.joined)
      .map(seat => ({ name: seat.participant, pending: facts.directedCount(seat.participant, { unseenOnly: true, currentGeneration: true }),
        seat: { owner: seat.owner, generation: seat.generation } })) }) };
}
export function queryStatus(facts: SquareRead, now: number, viewer = ''): StatusResult {
  const { participants, ...presence } = queryParticipants(facts, now);
  const header = facts.header();
  const listener = participants.find((p) => p.presence !== 'never-joined' && nameKey(p.name) === nameKey(viewer));
  const latest = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: 1 }).items[0];
  const afterIndex = latest?.index ?? -1;
  const joinHeads = facts.activityHeads({ kinds: ['join'], afterIndex }, { edge: 'newest', limit: 3 }).items;
  const indexes = [...(latest === undefined ? [] : [latest.index]), ...joinHeads.map(head => head.index)];
  const hydrated = new Map(facts.activities(indexes).map(activity => [activity.index, activity]));
  const latestAct = latest === undefined ? undefined : hydrated.get(latest.index);
  const joins = joinHeads.flatMap(head => {
    const activity = hydrated.get(head.index);
    return activity === undefined ? [] : [{
      rejoined: facts.activityCount({ kinds: ['done'], actors: [activity.actor!], actorMatch: 'exact', beforeIndex: activity.index }) > 0,
      activity: toPublicActivity(activity) }];
  });
  const canonicalViewer = facts.participant(viewer)?.name ?? viewer;
  return {
    ...presence, now, hardCap: header.hardCap,
    ...(header.throttlePerMinute === undefined ? {} : { throttlePerMinute: header.throttlePerMinute }),
    ...(listener === undefined ? {} : { listening: listener.listening }),
    participants: participants.filter((p) => p.presence !== 'never-joined'),
    knownParticipantCount: participants.length, viewer: canonicalViewer,
    joins, joinCount: facts.activityCount({ kinds: ['join'], afterIndex }),
    attentionNames: participants.filter((p) => canonicalViewer === '' || nameKey(p.name) === nameKey(canonicalViewer)).map((p) => p.name),
    ...(latestAct === undefined || latestAct.kind === 'read' ? {} : {
      latestActivity: toPublicActivity(latestAct), latestPerception: perceiveActivity(facts, latestAct, canonicalViewer),
    }),
  };
}
export function streamProjection(facts: SquareRead, cursor: number, recipient?: string) {
  const page = facts.activityHeads({ afterIndex: cursor, kinds: NON_READ }, { edge: 'oldest', limit: PAGE_CAP });
  const heads = recipient === undefined ? page.items : page.items.filter((head) => facts.directedAt(recipient, head.index) !== undefined);
  const activities = facts.activities(heads.map((head) => head.index)).map((activity) => recipient === undefined
    ? toPublicActivity(activity) : toPerceivedActivity(facts, activity, recipient));
  return { activities, cursor: page.items.at(-1)?.index ?? cursor, hasMore: page.hasMore };
}
export function streamTailProjection(facts: SquareRead, last = HISTORY_DEFAULT_LIMIT, recipient?: string) {
  if (!Number.isSafeInteger(last) || last < 0 || last > PAGE_CAP) throw new SquareError('invalid_args', `Invalid stream tail: expected a non-negative safe integer no greater than ${PAGE_CAP}.`);
  const heads = last === 0 ? [] : recipient === undefined
    ? facts.activityHeads({ kinds: NON_READ }, { edge: 'newest', limit: last }).items
    : facts.directed(recipient, { kinds: ['say'] }, { edge: 'newest', limit: last }).items;
  const activities = facts.activities(heads.map((head) => head.index)).map((activity) => recipient === undefined
    ? toPublicActivity(activity) : toPerceivedActivity(facts, activity, recipient));
  return { activities, cursor: facts.header().lastActIndex, hasMore: false };
}
