import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { compareParticipantActivity, coreParticipants, resolveKnownName, unreadActivitySummaries } from './decisions.js';
import { SquareError, nameKey, type StoredAct } from './model.js';
import type { ActivityFilter, ActivityHead, SquareRead } from './ports.js';
import { inSquareCount } from './runtime.js';
import { perceiveActivity } from './perception-projection.js';
import { compileSearchPattern } from './search.js';
import type {
  Activity, ArchiveRecord, PerceivedActivity, HistoryQuery, HistoryContinuation,
  ParticipantSummary, PresenceClassification, ParticipantsResult, SquareSnapshot,
  EntryPresentation, StatusResult, SquareObservation, CatchPresence,
} from './square-facade.js';

const PAGE_SIZE = 100;
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 100;
const STATUS_HERE_WINDOW_MS = 30 * 60_000;
const PRESENCE_WINDOW_MS = 8 * 60 * 60_000;
export const NON_READ = ['join', 'done', 'say', 'hold', 'resume', 'listen', 'ignore', 'unlisten'] as const;
const ARCHIVE = new Set(['join', 'done', 'say', 'hold', 'resume']);

/** The one StoredAct-to-public-Activity field mapping. Rejects read and actorless acts. */
export function toPublicActivity(stored: StoredAct): Activity {
  if (stored.kind === 'read' || stored.actor === undefined) throw new Error(`Cannot expose stored activity ${formatActivityId(stored.index)}`);
  return { id: formatActivityId(stored.index), at: stored.at, kind: stored.kind, actor: stored.actor,
    ...(stored.kind === 'say' && stored.reach !== undefined ? { reach: stored.reach } : {}),
    ...('body' in stored && stored.body !== undefined ? { body: stored.body } : {}),
    ...(stored.kind === 'say' && stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
    mentions: stored.kind === 'say' ? stored.mentions ?? [] : [], ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}) };
}
export function toPerceivedActivity(facts: SquareRead, stored: StoredAct, viewer: string): PerceivedActivity {
  const via = facts.directedAt(viewer, stored.index)?.route;
  return { ...toPublicActivity(stored), perception: perceiveActivity(facts, stored, viewer),
    ...(via === undefined ? {} : { via }) };
}
export function parseRequiredActivityId(id: ActivityId): number {
  const index = parseActivityId(id);
  if (index === undefined) throw new SquareError('invalid_args', `Invalid activity id: ${id}`);
  return index;
}

/** Compile the public query directly to typed selectors; only search hydrates unselected bodies. */
export function selectHistory(facts: SquareRead, query: HistoryQuery, limit: number | null, kinds: ActivityFilter['kinds'], presentation = true) {
  if (query.before !== undefined && query.after !== undefined) throw new SquareError('invalid_args', 'History cannot combine before and after cursors');
  const afterIndex = query.after === undefined ? undefined : parseRequiredActivityId(query.after);
  const beforeIndex = query.before === undefined ? undefined : parseRequiredActivityId(query.before);
  const actors = (query.from ?? []).map((name) => resolveKnownName(facts, name));
  const recipient = query.mention == null ? undefined : resolveKnownName(facts, query.mention);
  const pattern = query.grep ?? query.fixed;
  const search = pattern === undefined || pattern === '' ? undefined : compileSearchPattern(pattern, query.grep === undefined);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new SquareError('invalid_args', 'History limit must be a positive integer');
  const filter: ActivityFilter = {
    ...(actors.length === 0 ? {} : { actors }), afterIndex, beforeIndex, afterAt: query.since,
    ...(query.at?.length ? { indexes: facts.contextIndexes(query.at.map(parseRequiredActivityId), query.contextBefore ?? 0, query.contextAfter ?? 0) } : {}),
    kinds: search === undefined ? kinds : ['say', 'done'],
  };
  let selected: readonly ActivityHead[], totalMatches: number, publicBefore = false, publicAfter = false;
  if (recipient === undefined && search === undefined && limit !== null && limit <= PAGE_SIZE) {
    selected = facts.activityHeads(filter, { edge: afterIndex === undefined ? 'newest' : 'oldest', limit }).items;
    totalMatches = facts.activityCount(filter);
    if (presentation) {
      const publicHeads = selected.filter((head) => ARCHIVE.has(head.kind));
      const publicFilter = { ...filter, kinds: [...ARCHIVE] as ActivityFilter['kinds'] };
      publicBefore = publicHeads.length > 0 && facts.activityCount({ ...publicFilter, beforeIndex: publicHeads[0].index }) > 0;
      publicAfter = publicHeads.length > 0 && facts.activityCount({ ...publicFilter, afterIndex: publicHeads.at(-1)!.index }) > 0;
    }
  } else {
    const page: ActivityHead[] = [];
    totalMatches = 0;
    let firstPublic = Infinity, lastPublic = -1, cursor = afterIndex ?? -1;
    while (true) {
      const source = recipient === undefined
        ? facts.activityHeads({ ...filter, afterIndex: cursor }, { edge: 'oldest', limit: PAGE_SIZE })
        : facts.directed(recipient, { afterIndex: cursor, beforeIndex }, { edge: 'oldest', limit: PAGE_SIZE });
      const heads = recipient === undefined ? source.items as readonly ActivityHead[] : source.items.length === 0 ? []
        : facts.activityHeads({ ...filter, indexes: source.items.map((head) => head.index).filter((index) => filter.indexes === undefined || filter.indexes.includes(index)) }, { edge: 'oldest', limit: PAGE_SIZE }).items;
      const matches = search === undefined ? undefined : new Set(facts.activities(heads.map((head) => head.index)).filter((act) =>
        [formatActivityId(act.index), act.actor ?? '', 'body' in act ? act.body ?? '' : ''].some((field) => search.test(field))).map((act) => act.index));
      for (const head of heads) {
        if (matches !== undefined && !matches.has(head.index)) continue;
        totalMatches++;
        if (presentation && ARCHIVE.has(head.kind)) { firstPublic = Math.min(firstPublic, head.index); lastPublic = head.index; }
        if (limit === null || afterIndex === undefined || page.length < limit) page.push(head);
        if (limit !== null && page.length > limit) page.shift();
      }
      if (!source.hasMore) break;
      cursor = source.items.at(-1)!.index;
    }
    selected = page;
    if (presentation) {
      const publicHeads = selected.filter((head) => ARCHIVE.has(head.kind));
      publicBefore = publicHeads.length > 0 && firstPublic < publicHeads[0].index;
      publicAfter = publicHeads.length > 0 && lastPublic > publicHeads.at(-1)!.index;
    }
  }
  const activities = [...facts.activities(selected.map((head) => head.index))];
  if (query.order === 'desc') activities.reverse();
  const visibleActivities = presentation ? activities.filter((activity) => ARCHIVE.has(activity.kind)) : [];
  const direction = afterIndex === undefined ? 'before' : 'after';
  const cursor = visibleActivities.length === 0 ? undefined : direction === 'before'
    ? Math.min(...visibleActivities.map((activity) => activity.index)) : Math.max(...visibleActivities.map((activity) => activity.index));
  const continuation: HistoryContinuation | undefined = limit === null || cursor === undefined || !(direction === 'before' ? publicBefore : publicAfter)
    ? undefined : { direction, cursor: formatActivityId(cursor), limit };
  return { activities, visibleActivities, totalMatches, ...(continuation === undefined ? {} : { continuation }) };
}
export function publicActivities(activities: readonly ArchiveRecord[]): Activity[] {
  return activities.flatMap((activity) => activity.kind === 'read' || activity.actor === undefined ? [] : [toPublicActivity(activity)]);
}
export function snapshot(facts: SquareRead, now: number): SquareSnapshot {
  const header = facts.header(), hold = facts.hold();
  const names = new Map(facts.roster().map((p) => [nameKey(p.name), p.name]));
  const receipts = new Set(facts.receiptAssignments().map((r) => JSON.stringify([r.owner, r.index])));
  return { context: [...header.preamble, ...header.warmup].join('\n'), actCount: facts.activityCount({ kinds: NON_READ }), hardCap: header.hardCap,
    ...(header.throttlePerMinute === undefined ? {} : { throttlePerMinute: header.throttlePerMinute }),
    held: hold.active && hold.actor !== undefined ? { by: hold.actor, ...(hold.reason === undefined ? {} : { reason: hold.reason }) } : null,
    participants: coreParticipants(facts, now).filter((p) => p.presence !== 'never-joined').map(({ name, presence, listening }) => ({ name, presence, listening })),
    delivered(name: string, id: ActivityId) { return receipts.has(JSON.stringify([names.get(nameKey(name)) ?? name, parseRequiredActivityId(id)])); } };
}
export function recoveryObservation(facts: SquareRead, name: string, now: number) {
  const known = resolveKnownName(facts, name), hold = facts.hold();
  return { participant: known, activitySummaries: unreadActivitySummaries(facts, known, now), standingCount: inSquareCount(facts), held: hold.active,
    ownActivityCount: facts.participant(known)!.sayCount, hardCap: facts.header().hardCap };
}
export function entryPresentation(facts: SquareRead, name: string, lastN: number | null = HISTORY_DEFAULT_LIMIT): EntryPresentation {
  const header = facts.header();
  const recentActivities = selectHistory(facts, {}, lastN, ['say', 'done']).activities;
  return { joinedBefore: facts.activityCount({ kinds: ['join'], actors: [name] }) > 1,
    scene: header.warmup.join('\n').trim(),
    joinContext: (header.preamble.at(-1) === '---' ? header.preamble.slice(0, -1) : header.preamble).join('\n').trim(),
    recentActivities: recentActivities.map((activity) => ({ ...toPublicActivity(activity), perception: perceiveActivity(facts, activity, name) })) };
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
    standingCount: inSquareCount(facts), held: facts.hold().active } }) };
}
export function listPresentation(facts: SquareRead) {
  const participants = facts.roster().filter((p) => p.joined).map((p) => {
    const receiptAt = facts.receiptFacts(p.name, p.lastJoinIndex ?? -1).latestAt;
    return { name: p.name, lastActiveAt: receiptAt === undefined ? p.lastActiveAt : Math.max(p.lastActiveAt ?? -Infinity, receiptAt) };
  }).sort(compareParticipantActivity).map((p) => p.name);
  return { context: facts.header().preamble, participants, activities: facts.activityCount({ kinds: ['say'] }) };
}
export function queryStatus(facts: SquareRead, context: ParticipantQueryContext, viewer = '', observe = false): StatusResult {
  const participants = coreParticipants(facts, context.now);
  const header = facts.header(), hold = facts.hold(), standingCount = inSquareCount(facts);
  const listener = participants.find((p) => p.presence !== 'never-joined' && nameKey(p.name) === nameKey(viewer));
  const latest = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: 1 }).items[0];
  const latestAct = latest === undefined ? undefined : facts.activity(latest.index);
  const data: StatusResult = {
    hardCap: header.hardCap,
    ...(header.throttlePerMinute === undefined ? {} : { throttlePerMinute: header.throttlePerMinute }),
    held: hold.active ? {
      ...(hold.actor === undefined ? {} : { by: hold.actor }),
      ...(hold.reason === undefined ? {} : { reason: hold.reason }),
      ...(hold.at === undefined ? {} : { at: hold.at }),
    } : null,
    ...(listener === undefined ? {} : { listening: listener.listening }),
    participants: participants.filter((p) => p.presence !== 'never-joined'), now: context.now,
    ...(latestAct === undefined || latestAct.actor === undefined || latestAct.kind === 'read' ? {} : { latestActivity: toPublicActivity(latestAct) }),
  };
  if (!observe) return data;
  const afterIndex = latestAct?.index ?? -1;
  const joins = facts.activities(facts.activityHeads({ kinds: ['join'], afterIndex }, { edge: 'newest', limit: 3 }).items.map((h) => h.index)).map((activity) => ({
    rejoined: facts.activityCount({ kinds: ['done'], actors: [activity.actor!], actorMatch: 'exact', beforeIndex: activity.index }) > 0,
    activity: toPublicActivity(activity) }));
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
export function catchPresence(facts: SquareRead, now: number): CatchPresence {
  const participants = coreParticipants(facts, now).filter((participant) => participant.presence === 'done' || participant.presence === 'away' || participant.presence === 'watching'
    || (participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= PRESENCE_WINDOW_MS));
  return { participants, now };
}
export function streamProjection(facts: SquareRead, cursor: number, recipient?: string) {
  const page = facts.activityHeads({ afterIndex: cursor, kinds: NON_READ, actorRequired: true }, { edge: 'oldest', limit: PAGE_SIZE });
  const heads = recipient === undefined ? page.items : page.items.filter((head) => facts.directedAt(recipient, head.index) !== undefined);
  const activities = facts.activities(heads.map((head) => head.index)).map((activity) => recipient === undefined
    ? toPublicActivity(activity) : toPerceivedActivity(facts, activity, recipient));
  return { activities, cursor: page.items.at(-1)?.index ?? cursor, hasMore: page.hasMore };
}
export function streamTailProjection(facts: SquareRead, last = HISTORY_DEFAULT_LIMIT, recipient?: string) {
  if (!Number.isSafeInteger(last) || last < 0 || last > PAGE_SIZE) throw new SquareError('invalid_args', `Invalid stream tail: expected a non-negative safe integer no greater than ${PAGE_SIZE}.`);
  const heads = last === 0 ? [] : recipient === undefined
    ? facts.activityHeads({ kinds: NON_READ, actorRequired: true }, { edge: 'newest', limit: last }).items
    : facts.directed(recipient, {}, { edge: 'newest', limit: last }).items;
  const activities = facts.activities(heads.map((head) => head.index)).map((activity) => recipient === undefined
    ? toPublicActivity(activity) : toPerceivedActivity(facts, activity, recipient));
  return { activities, cursor: facts.header().lastActIndex, hasMore: false };
}
