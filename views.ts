import { formatActivityId, isNarratedActivity, NARRATED_ACTIVITY_KINDS, parseActivityId, type ActivityId, type Perception, type Reach } from './square-core.js';
import { compareParticipantActivity, coreParticipants, resolveKnownName, unreadActivitySummaries, type ParticipantSummary } from './decisions.js';
import { SquareError, nameKey, sameName, type ActivityMetadata, type DirectedNotificationRoute, type HydratedAct, type Owner, type StoredAct } from './model.js';
import type { ObservationOptions } from './neutral.js';
import type { ActivityFilter, ActivityHead, SquareRead } from './ports.js';
import { inSquareCount } from './runtime.js';
import { activityQueryFilter, type ActivityQuery } from './activity-query.js';

/** Indexed archive event, including read bookkeeping and a say's linked content. */
export type ArchiveRecord = Readonly<HydratedAct>;
export interface Activity {
  readonly id: ActivityId;
  readonly at: number;
  readonly kind: 'join' | 'say' | 'done' | 'listen' | 'ignore' | 'unlisten';
  readonly actor: string;
  readonly body?: string;
  readonly metadata?: ActivityMetadata;
  readonly mentions: readonly string[];
  readonly reach?: Reach;
  readonly target?: string;
  readonly reply?: ActivityId;
}
export interface PerceivedActivity extends Activity {
  readonly perception: Perception;
  readonly via?: DirectedNotificationRoute;
}
export interface SquareObservation {
  readonly location: string;
  readonly standingCount: number;
  readonly now: number;
  readonly participant?: string;
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
export interface PerceivePresence {
  readonly participants: readonly ParticipantSummary[];
  readonly now: number;
}
export interface StatusOptions extends ObservationOptions {
  readonly viewer?: string;
}
export interface StatusResult {
  /** Present when a viewer resolves; an empty list means they listen to nobody. */
  readonly listening?: readonly string[];
  readonly hardCap: number | null;
  readonly participants: readonly ParticipantSummary[];
  readonly now: number;
  readonly throttlePerMinute?: number;
  readonly latestActivity?: Activity;
  /** Active all-owner delivery hold; seats may still have independent holds. */
  readonly ledgerMutedUntil?: number;
  readonly observation?: StatusObservation;
}
export interface ParticipantsResult {
  readonly participants: readonly ParticipantSummary[];
  readonly observation?: ParticipantsObservation;
}
export interface HistoryQuery extends ActivityQuery, ObservationOptions {
  /** Ten by default; null explicitly reads the full archive. */
  readonly limit?: number | null;
  readonly order?: 'asc' | 'desc';
  readonly mention?: string;
  readonly since?: number;
  readonly context?: number;
}
export interface HistoryContinuation {
  readonly direction: 'before' | 'after';
  readonly cursor: ActivityId;
  readonly limit: number;
}
export interface HistoryObservation extends SquareObservation {
  readonly activities: readonly ArchiveRecord[];
  readonly sayNumbers: Readonly<Record<number, number>>;
  readonly presenceAnchors: Readonly<Record<number, readonly string[]>>;
  readonly totalMatches: number;
  readonly continuation?: HistoryContinuation;
}
export interface StatusObservation extends Omit<SquareObservation, 'now'>, PresenceClassification {
  readonly knownParticipantCount: number;
  readonly latestPerception?: Perception;
  readonly joins: readonly { readonly activity: Activity; readonly rejoined: boolean }[];
  readonly joinCount: number;
  readonly attentionNames: readonly string[];
  readonly viewer: string;
}
export interface ParticipantsObservation extends SquareObservation, PresenceClassification {}

const PAGE_SIZE = 100;
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 100;
const STATUS_HERE_WINDOW_MS = 30 * 60_000;
const PRESENCE_WINDOW_MS = 8 * 60 * 60_000;
export const NON_READ = ['join', 'done', 'say', 'listen', 'ignore', 'unlisten'] as const;

export function directedTo(facts: SquareRead, activity: StoredAct, name: string): boolean {
  return activity.kind === 'say' && facts.directedAt(name, activity.index) !== undefined;
}

/** Audience is settled at landing, never reconstructed from a partial history. */
export function perceiveActivity(facts: SquareRead, activity: StoredAct, name: string): Perception {
  return activity.kind !== 'say' || sameName(activity.actor, name) || directedTo(facts, activity, name) ? 'full' : 'presence';
}

/** The one stored-to-public Activity field mapping. Rejects read bookkeeping. */
export function toPublicActivity(stored: HydratedAct): Activity {
  if (stored.kind === 'read') throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  return { id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor,
    ...(stored.kind === 'say' && stored.reach !== undefined ? { reach: stored.reach } : {}),
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    ...('metadata' in stored && stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
    mentions: stored.kind === 'say' ? stored.mentions ?? [] : [], ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}) };
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

/** The narrated page's cursor head: first for older paging, last for newer. */
function narratedAnchor(heads: readonly ActivityHead[], direction: 'before' | 'after'): ActivityHead | undefined {
  const narrated = heads.filter((head) => isNarratedActivity(head.kind));
  return direction === 'before' ? narrated[0] : narrated.at(-1);
}
/** History adds archive context and ordering to the shared storage-side query predicates. */
export function selectHistory(facts: SquareRead, query: HistoryQuery, limit: number | null, kinds: ActivityFilter['kinds'], presentation = true) {
  const shared = activityQueryFilter(query, ['observe', 'order', 'mention', 'since', 'context']);
  const { afterIndex } = shared;
  const recipient = query.mention == null ? undefined : resolveKnownName(facts, query.mention);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new SquareError('invalid_args', 'History limit must be a positive integer');
  const filter: ActivityFilter = {
    ...shared, afterAt: query.since,
    ...(shared.indexes === undefined ? {} : { indexes: facts.contextIndexes(shared.indexes, query.context ?? 0, query.context ?? 0) }),
    kinds: query.search === undefined ? kinds : ['say', 'done'],
  };
  const direction = afterIndex === undefined ? 'before' : 'after';
  let selected: readonly ActivityHead[], totalMatches: number, more = false, extreme: number | undefined;
  if (recipient === undefined && limit !== null && limit <= PAGE_SIZE) {
    selected = facts.activityHeads(filter, { edge: afterIndex === undefined ? 'newest' : 'oldest', limit }).items;
    totalMatches = facts.activityCount(filter);
    const anchor = presentation ? narratedAnchor(selected, direction) : undefined;
    if (anchor !== undefined) more = facts.activityCount({ ...filter,
      kinds: filter.kinds === undefined ? NARRATED_ACTIVITY_KINDS : filter.kinds.filter(isNarratedActivity),
      [direction === 'before' ? 'beforeIndex' : 'afterIndex']: anchor.index }) > 0;
  } else {
    const page: ActivityHead[] = [];
    totalMatches = 0;
    let cursor = afterIndex ?? -1;
    while (true) {
      const source = recipient === undefined
        ? facts.activityHeads({ ...filter, afterIndex: cursor }, { edge: 'oldest', limit: PAGE_SIZE })
        : facts.directed(recipient, { ...filter, senders: filter.actors, afterIndex: cursor }, { edge: 'oldest', limit: PAGE_SIZE });
      const heads = recipient === undefined ? source.items as readonly ActivityHead[] : source.items.length === 0 ? []
        : facts.activityHeads({ ...filter, indexes: source.items.map((head) => head.index).filter((index) => filter.indexes === undefined || filter.indexes.includes(index)) }, { edge: 'oldest', limit: PAGE_SIZE }).items;
      for (const head of heads) {
        totalMatches++;
        if (presentation && isNarratedActivity(head.kind)) extreme = extreme === undefined ? head.index
          : direction === 'before' ? Math.min(extreme, head.index) : Math.max(extreme, head.index);
        if (limit === null || afterIndex === undefined || page.length < limit) page.push(head);
        if (limit !== null && page.length > limit) page.shift();
      }
      if (!source.hasMore) break;
      cursor = source.items.at(-1)!.index;
    }
    selected = page;
    const anchor = presentation ? narratedAnchor(selected, direction) : undefined;
    more = anchor !== undefined && extreme !== undefined
      && (direction === 'before' ? extreme < anchor.index : extreme > anchor.index);
  }
  const anchor = presentation ? narratedAnchor(selected, direction) : undefined;
  const continuation: HistoryContinuation | undefined = limit === null || anchor === undefined || !more
    ? undefined : { direction, cursor: formatActivityId(anchor.index), limit };
  const activities = [...facts.activities(selected.map((head) => head.index))];
  if (query.order === 'desc') activities.reverse();
  return { activities, totalMatches, ...(continuation === undefined ? {} : { continuation }) };
}
export function publicActivities(activities: readonly ArchiveRecord[]): Activity[] {
  return activities.flatMap((activity) => activity.kind === 'read' ? [] : [toPublicActivity(activity)]);
}
export function recoveryObservation(facts: SquareRead, name: string, now: number) {
  const known = resolveKnownName(facts, name);
  return { participant: known, activitySummaries: unreadActivitySummaries(facts, known, now), standingCount: inSquareCount(facts),
    ownActivityCount: facts.participant(known)!.sayCount, hardCap: facts.header().hardCap };
}
export function entryPresentation(facts: SquareRead, name: string, lastN: number = HISTORY_DEFAULT_LIMIT): EntryPresentation {
  const header = facts.header();
  const heads = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: lastN }).items;
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
type ParticipantQueryContext = Pick<SquareObservation, 'location' | 'now'>;
export function queryParticipants(facts: SquareRead, context: ParticipantQueryContext, observe = false): ParticipantsResult {
  const participants = coreParticipants(facts, context.now);
  return { participants, ...(!observe ? {} : { observation: { ...context, ...classifyPresence(participants, context.now),
    standingCount: inSquareCount(facts) } }) };
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
export function queryStatus(facts: SquareRead, context: ParticipantQueryContext, viewer = '', observe = false): StatusResult {
  const participants = coreParticipants(facts, context.now);
  const header = facts.header(), standingCount = inSquareCount(facts);
  const listener = participants.find((p) => p.presence !== 'never-joined' && nameKey(p.name) === nameKey(viewer));
  const latest = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: 1 }).items[0];
  const joinHeads = observe ? facts.activityHeads({ kinds: ['join'], afterIndex: latest?.index ?? -1 }, { edge: 'newest', limit: 3 }).items : [];
  const indexes = [...new Set([...(latest === undefined ? [] : [latest.index]), ...joinHeads.map(head => head.index)])];
  const hydrated = new Map(facts.activities(indexes).map(activity => [activity.index, activity]));
  const latestAct = latest === undefined ? undefined : hydrated.get(latest.index);
  const data: StatusResult = {
    hardCap: header.hardCap,
    ...(header.throttlePerMinute === undefined ? {} : { throttlePerMinute: header.throttlePerMinute }),
    ...(listener === undefined ? {} : { listening: listener.listening }),
    participants: participants.filter((p) => p.presence !== 'never-joined'), now: context.now,
    ...(latestAct === undefined || latestAct.kind === 'read' ? {} : { latestActivity: toPublicActivity(latestAct) }),
  };
  if (!observe) return data;
  const afterIndex = latestAct?.index ?? -1;
  const joins = joinHeads.flatMap(head => {
    const activity = hydrated.get(head.index);
    return activity === undefined ? [] : [{
      rejoined: facts.activityCount({ kinds: ['done'], actors: [activity.actor!], actorMatch: 'exact', beforeIndex: activity.index }) > 0,
      activity: toPublicActivity(activity) }];
  });
  const canonicalViewer = facts.participant(viewer)?.name ?? viewer;
  return {
    ...data,
    observation: {
      location: context.location,
      ...classifyPresence(participants, context.now), standingCount,
      knownParticipantCount: participants.length, viewer: canonicalViewer,
      ...(canonicalViewer === '' ? {} : { participant: canonicalViewer }),
      joins, joinCount: facts.activityCount({ kinds: ['join'], afterIndex }),
      attentionNames: participants.filter((p) => canonicalViewer === '' || nameKey(p.name) === nameKey(canonicalViewer)).map((p) => p.name),
      ...(latestAct === undefined ? {} : { latestPerception: perceiveActivity(facts, latestAct, canonicalViewer) }),
    },
  };
}
export function perceivePresence(facts: SquareRead, now: number): PerceivePresence {
  const participants = coreParticipants(facts, now).filter((participant) => participant.presence === 'done' || participant.presence === 'away' || participant.presence === 'watching'
    || (participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= PRESENCE_WINDOW_MS));
  return { participants, now };
}
export function streamProjection(facts: SquareRead, cursor: number, recipient?: string) {
  const page = facts.activityHeads({ afterIndex: cursor, kinds: NON_READ }, { edge: 'oldest', limit: PAGE_SIZE });
  const heads = recipient === undefined ? page.items : page.items.filter((head) => facts.directedAt(recipient, head.index) !== undefined);
  const activities = facts.activities(heads.map((head) => head.index)).map((activity) => recipient === undefined
    ? toPublicActivity(activity) : toPerceivedActivity(facts, activity, recipient));
  return { activities, cursor: page.items.at(-1)?.index ?? cursor, hasMore: page.hasMore };
}
export function streamTailProjection(facts: SquareRead, last = HISTORY_DEFAULT_LIMIT, recipient?: string) {
  if (!Number.isSafeInteger(last) || last < 0 || last > PAGE_SIZE) throw new SquareError('invalid_args', `Invalid stream tail: expected a non-negative safe integer no greater than ${PAGE_SIZE}.`);
  const heads = last === 0 ? [] : recipient === undefined
    ? facts.activityHeads({ kinds: NON_READ }, { edge: 'newest', limit: last }).items
    : facts.directed(recipient, { kinds: ['say'] }, { edge: 'newest', limit: last }).items;
  const activities = facts.activities(heads.map((head) => head.index)).map((activity) => recipient === undefined
    ? toPublicActivity(activity) : toPerceivedActivity(facts, activity, recipient));
  return { activities, cursor: facts.header().lastActIndex, hasMore: false };
}
