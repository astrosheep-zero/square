import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { compareParticipantActivity, coreParticipants, resolveKnownName, unreadActivitySummaries } from './decisions.js';
import { SquareError, nameKey, type StoredAct } from './model.js';
import type { OpenSquare } from './open-square.js';
import type { ActivityFilter, ActivityHead, SquareRead } from './ports.js';
import { inSquareCount, readCursor, rosterNames } from './runtime.js';
import { perceiveActivity } from './perception-projection.js';
import { compileSearchPattern } from './search.js';
import type {
  Activity, ArchiveRecord, HistoryQuery, HistoryContinuation,
  OperationControl, ParticipantStatus, ParticipantSummary, PresenceClassification, ParticipantsResult, SquareSnapshot,
  EntryPresentation, ListPresentation, StatusResult, SquareObservation, CatchPresence, StreamProjection,
} from './square-facade.js';
export type { EntryPresentation, ListPresentation, CatchPresence, StreamProjection } from './square-facade.js';

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
    mentions: stored.kind === 'say' ? stored.mentions ?? [] : [], ...('target' in stored ? { target: stored.target } : {}),
    ...(stored.kind === 'say' && stored.reply !== undefined ? { reply: formatActivityId(stored.reply) } : {}) };
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
export async function resolveParticipant(square: OpenSquare, name: string, control?: OperationControl) {
  return (await square.artifact.read((facts) => ({ name: resolveKnownName(facts, name) }), control?.signal)).value;
}
export async function currentParticipant(square: OpenSquare, name: string, control?: OperationControl): Promise<string | undefined> {
  return (await square.artifact.read((facts) => { const p = facts.participant(name); return p?.joined ? p.name : undefined; }, control?.signal)).value;
}
function statuses(facts: SquareRead, now: number): ParticipantStatus[] {
  return coreParticipants(facts, now).filter((p) => p.state !== 'not joined').map((p) => {
    const cursor = readCursor(facts, p.name);
    return { name: p.name, state: p.state === 'done' ? 'done' : 'joined', consumedThrough: cursor < 0 ? null : formatActivityId(cursor), watching: p.presence === 'watching', listening: p.listening };
  });
}
export async function snapshot(square: OpenSquare, control?: OperationControl): Promise<SquareSnapshot> {
  return (await square.artifact.read((facts) => {
    const header = facts.header(), hold = facts.hold();
    const names = new Map(facts.roster().map((p) => [nameKey(p.name), p.name]));
    const receipts = new Set(facts.receiptAssignments().map((r) => JSON.stringify([r.owner, r.index])));
    return { context: [...header.preamble, ...header.warmup].join('\n'), actCount: facts.activityCount({ kinds: NON_READ }), hardCap: header.hardCap,
      ...(header.throttlePerMinute === undefined ? {} : { throttlePerMinute: header.throttlePerMinute }),
      held: hold.active && hold.actor !== undefined ? { by: hold.actor, ...(hold.reason === undefined ? {} : { reason: hold.reason }) } : null,
      participants: statuses(facts, square.clock()), delivered(name: string, id: ActivityId) { return receipts.has(JSON.stringify([names.get(nameKey(name)) ?? name, parseRequiredActivityId(id)])); } };
  }, control?.signal)).value;
}
export async function recoveryObservation(square: OpenSquare, name: string, control?: OperationControl) {
  return (await square.artifact.read((facts) => {
    const known = resolveKnownName(facts, name), hold = facts.hold();
    return { participant: known, roster: rosterNames(facts), activitySummaries: unreadActivitySummaries(facts, known, square.clock()), standingCount: inSquareCount(facts), held: hold.active,
      ...(hold.reason === undefined ? {} : { holdReason: hold.reason }), ownActivityCount: facts.participant(known)!.sayCount, hardCap: facts.header().hardCap };
  }, control?.signal)).value;
}
export async function entryPresentation(square: OpenSquare, name: string, lastN: number | null = HISTORY_DEFAULT_LIMIT, control?: OperationControl): Promise<EntryPresentation> {
  return (await square.artifact.read((facts) => {
    const header = facts.header();
    const recentActivities = selectHistory(facts, {}, lastN, ['say', 'done']).activities;
    return { joinedBefore: facts.activityCount({ kinds: ['join'], actors: [name] }) > 1,
      scene: header.warmup.join('\n').trim(),
      joinContext: (header.preamble.at(-1) === '---' ? header.preamble.slice(0, -1) : header.preamble).join('\n').trim(), recentActivities,
      perceptions: Object.fromEntries(recentActivities.map((a) => [a.index, perceiveActivity(facts, a, name)])),
      sayNumbers: facts.sayOrdinals(recentActivities.map((a) => a.index)) };
  }, control?.signal)).value;
}
function classifyPresence(participants: readonly ParticipantSummary[], now: number): PresenceClassification {
  const here = participants.filter((participant) => participant.state === 'active' && (participant.presence === 'watching'
    || (participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= STATUS_HERE_WINDOW_MS)));
  const hereNames = new Set(here.map((participant) => participant.name));
  return { orderedHereNames: [...here.filter((participant) => participant.presence === 'watching'), ...here.filter((participant) => participant.presence !== 'watching')].map((participant) => participant.name),
    lingeringCount: participants.filter((participant) => participant.state === 'active' && !hereNames.has(participant.name)).length,
    classificationByName: Object.fromEntries(participants.map((participant) => [participant.name, participant.state === 'done' ? 'done'
      : participant.state === 'not joined' ? 'not-joined' : hereNames.has(participant.name) ? 'here' : 'lingering'])) };
}
type ParticipantQueryContext = Pick<SquareObservation, 'location' | 'now' | 'automaticDeliveryAvailable'>;
export function queryParticipants(facts: SquareRead, context: ParticipantQueryContext, observe = false): ParticipantsResult {
  const participants = coreParticipants(facts, context.now);
  return { participants, ...(!observe ? {} : { observation: { ...context, ...classifyPresence(participants, context.now),
    standingCount: inSquareCount(facts), held: facts.hold().active } }) };
}
export async function listPresentation(square: OpenSquare, control?: OperationControl): Promise<ListPresentation> {
  return (await square.artifact.read((facts) => {
    const participants = facts.roster().filter((p) => p.joined).map((p) => {
      const receiptAt = facts.receiptFacts(p.name, p.lastJoinIndex ?? -1).latestAt;
      return { name: p.name, lastActiveAt: receiptAt === undefined ? p.lastActiveAt : Math.max(p.lastActiveAt ?? -Infinity, receiptAt) };
    }).sort(compareParticipantActivity).map((p) => p.name);
    return { context: facts.header().preamble, participants, activities: facts.activityCount({ kinds: ['say'] }) };
  }, control?.signal)).value;
}
export function queryStatus(facts: SquareRead, context: ParticipantQueryContext, viewer = '', observe = false): StatusResult {
  const participants = coreParticipants(facts, context.now);
  const header = facts.header(), hold = facts.hold(), standingCount = inSquareCount(facts);
  const latest = facts.activityHeads({ kinds: ['say', 'done'] }, { edge: 'newest', limit: 1 }).items[0];
  const latestAct = latest === undefined ? undefined : facts.activity(latest.index);
  const data: StatusResult = {
    hardCap: header.hardCap,
    ...(header.throttlePerMinute === undefined ? {} : { throttlePerMinute: header.throttlePerMinute }),
    activeCount: standingCount, doneCount: participants.filter((p) => p.state === 'done').length,
    hold: hold.active ? {
      ...(hold.actor === undefined ? {} : { by: hold.actor }),
      ...(hold.reason === undefined ? {} : { reason: hold.reason }),
      ...(hold.at === undefined ? {} : { at: hold.at }),
    } : null,
    participants: participants.filter((p) => p.state !== 'not joined'), now: context.now,
    ...(latestAct === undefined || latestAct.actor === undefined || latestAct.kind === 'read' ? {} : { latestActivity: toPublicActivity(latestAct) }),
  };
  if (!observe) return data;
  const afterIndex = latestAct?.index ?? -1;
  const joins = facts.activities(facts.activityHeads({ kinds: ['join'], afterIndex }, { edge: 'newest', limit: 3 }).items.map((h) => h.index)).map((activity) => ({ activity,
    rejoined: facts.activityCount({ kinds: ['done'], actors: [activity.actor!], actorMatch: 'exact', beforeIndex: activity.index }) > 0 }));
  const canonicalViewer = facts.participant(viewer)?.name ?? viewer;
  return {
    ...data,
    observation: {
      ...context, ...classifyPresence(participants, context.now), standingCount, held: hold.active,
      knownParticipantCount: participants.length, viewer: canonicalViewer,
      ...(canonicalViewer === '' ? {} : { participant: canonicalViewer }),
      joins, joinCount: facts.activityCount({ kinds: ['join'], afterIndex }),
      attentionNames: participants.filter((p) => canonicalViewer === '' || nameKey(p.name) === nameKey(canonicalViewer)).map((p) => p.name),
      ...(latestAct === undefined ? {} : { latestPerception: perceiveActivity(facts, latestAct, canonicalViewer) }),
      ...(latestAct?.kind === 'say' ? { latestActNumber: facts.sayOrdinals([latestAct.index])[latestAct.index] } : {}),
    },
  };
}
export async function catchPresence(square: OpenSquare, control?: OperationControl): Promise<CatchPresence> {
  return (await square.artifact.read((facts) => {
    const now = square.clock();
    const participants = coreParticipants(facts, now).filter((participant) => participant.state === 'done' || participant.presence === 'watching'
      || (participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= PRESENCE_WINDOW_MS));
    return { participants, now };
  }, control?.signal)).value;
}
export async function streamProjection(square: OpenSquare, cursor: number, recipient?: string, control?: OperationControl): Promise<StreamProjection> {
  return (await square.artifact.read((facts) => {
    const page = facts.activityHeads({ afterIndex: cursor }, { edge: 'oldest', limit: PAGE_SIZE });
    const heads = page.items.flatMap((head) => {
      const route = recipient === undefined ? undefined : facts.directedAt(recipient, head.index)?.route;
      return recipient !== undefined && route === undefined ? [] : [{ index: head.index, route }];
    });
    return { activities: facts.activities(heads.map((h) => h.index)).map((activity) => {
      const route = heads.find((h) => h.index === activity.index)!.route;
      return { activity, ...(route === undefined ? {} : { route }) };
    }), cursor: page.items.at(-1)?.index ?? cursor, hasMore: page.hasMore };
  }, control?.signal)).value;
}
export async function streamTailProjection(square: OpenSquare, last = HISTORY_DEFAULT_LIMIT, recipient?: string, control?: OperationControl): Promise<StreamProjection> {
  return (await square.artifact.read((facts) => {
    if (!Number.isSafeInteger(last) || last < 0 || last > PAGE_SIZE) throw new SquareError('invalid_args', `Invalid stream tail: expected a non-negative safe integer no greater than ${PAGE_SIZE}.`);
    const heads = last === 0 ? [] : recipient === undefined ? facts.activityHeads({}, { edge: 'newest', limit: last }).items : facts.directed(recipient, {}, { edge: 'newest', limit: last }).items;
    return { activities: facts.activities(heads.map((h) => h.index)).map((activity) => ({ activity,
      ...(recipient === undefined ? {} : { route: facts.directedAt(recipient, activity.index)!.route }) })), cursor: facts.header().lastActIndex, hasMore: false };
  }, control?.signal)).value;
}
