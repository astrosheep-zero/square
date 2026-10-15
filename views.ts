import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { compareParticipantActivity, coreParticipants, coreStatus, resolveKnownName, unreadActivitySummaries } from './decisions.js';
import { SquareError, nameKey, type ActivitiesOptions, type StoredAct } from './model.js';
import type { OpenSquare } from './open-square.js';
import type { ActivityFilter, ActivityHead, SquareRead } from './ports.js';
import { inSquareCount, presenceAnchor, readCursor, rosterNames } from './runtime.js';
import { perceiveActivity } from './perception-projection.js';
import { compileSearchPattern } from './search.js';
import type {
  Activity, ApplicationOutcome, ApplicationError, ArchiveRecord, HistoryQuery, HistoryApplicationQuery, HistoryApplicationData,
  OperationControl, ParticipantStatus, ParticipantSummary, PresenceClassification, ParticipantsPresentation, SquareSnapshot,
  RecoveryObservation, EntryPresentation, HistoryPresentation, ListPresentation, StatusPresentation, CatchPresence, StreamProjection, EventPresentation,
} from './square-facade.js';
export type { RecoveryObservation, EntryPresentation, HistoryPresentation, ListPresentation, StatusPresentation, CatchPresence, StreamProjection } from './square-facade.js';

const PAGE_SIZE = 100;
export const HISTORY_DEFAULT_LIMIT = 10;
export const HISTORY_MAX_LIMIT = 100;
const STATUS_HERE_WINDOW_MS = 30 * 60_000;
const PRESENCE_WINDOW_MS = 8 * 60 * 60_000;
const NON_READ = ['join', 'done', 'say', 'hold', 'resume', 'listen', 'ignore'] as const;
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

/** Traverse relational candidates in one transaction; only search hydrates unselected bodies. */
function selectHistory(facts: SquareRead, opts: ActivitiesOptions, hideRead: boolean, kinds?: ActivityFilter['kinds']): Pick<HistoryPresentation, 'activities' | 'totalMatches' | 'publicBefore' | 'publicAfter'> {
  const actors = (opts.participants ?? []).map((name) => resolveKnownName(facts, name));
  const recipient = opts.mention == null ? undefined : resolveKnownName(facts, opts.mention);
  const pattern = opts.grep ?? opts.fixed;
  const search = pattern === undefined || pattern === '' ? undefined : compileSearchPattern(pattern, opts.grep === undefined);
  const limit = opts.lastN ?? null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new SquareError('invalid_args', 'History limit must be a positive integer');
  const filter: ActivityFilter = {
    ...(actors.length === 0 ? {} : { actors }), afterIndex: opts.afterIndex, beforeIndex: opts.beforeIndex, afterAt: opts.after,
    ...(opts.atIndexes?.length ? { indexes: facts.contextIndexes(opts.atIndexes, opts.beforeContext ?? 0, opts.afterContext ?? 0) } : {}),
    ...(search === undefined ? kinds !== undefined ? { kinds } : hideRead ? { kinds: NON_READ } : {} : { kinds: ['say', 'done'] }),
  };
  if (recipient === undefined && search === undefined && limit !== null && limit <= PAGE_SIZE) {
    const heads = facts.activityHeads(filter, { edge: opts.afterIndex === undefined ? 'newest' : 'oldest', limit }).items;
    const publicHeads = heads.filter((head) => ARCHIVE.has(head.kind));
    const publicFilter = { ...filter, kinds: [...ARCHIVE] as ActivityFilter['kinds'] };
    const activities = [...facts.activities(heads.map((head) => head.index))];
    if (opts.order === 'desc') activities.reverse();
    return { activities, totalMatches: facts.activityCount(filter),
      publicBefore: publicHeads.length > 0 && facts.activityCount({ ...publicFilter, beforeIndex: publicHeads[0].index }) > 0,
      publicAfter: publicHeads.length > 0 && facts.activityCount({ ...publicFilter, afterIndex: publicHeads.at(-1)!.index }) > 0 };
  }
  const selected: ActivityHead[] = [];
  let totalMatches = 0, firstPublic = Infinity, lastPublic = -1, cursor = opts.afterIndex ?? -1;
  while (true) {
    const source = recipient === undefined
      ? facts.activityHeads({ ...filter, afterIndex: cursor }, { edge: 'oldest', limit: PAGE_SIZE })
      : facts.directed(recipient, { afterIndex: cursor, beforeIndex: opts.beforeIndex }, { edge: 'oldest', limit: PAGE_SIZE });
    const heads = recipient === undefined ? source.items as readonly ActivityHead[] : source.items.length === 0 ? []
      : facts.activityHeads({ ...filter, indexes: source.items.map((head) => head.index).filter((index) => filter.indexes === undefined || filter.indexes.includes(index)) }, { edge: 'oldest', limit: PAGE_SIZE }).items;
    const matches = search === undefined ? undefined : new Set(facts.activities(heads.map((head) => head.index)).filter((act) =>
      [formatActivityId(act.index), act.actor ?? '', 'body' in act ? act.body ?? '' : ''].some((field) => search.test(field))).map((act) => act.index));
    for (const head of heads) {
      if (matches !== undefined && !matches.has(head.index)) continue;
      totalMatches++;
      if (ARCHIVE.has(head.kind)) { firstPublic = Math.min(firstPublic, head.index); lastPublic = head.index; }
      if (limit === null || opts.afterIndex === undefined || selected.length < limit) selected.push(head);
      if (limit !== null && selected.length > limit) selected.shift();
    }
    if (!source.hasMore) break;
    cursor = source.items.at(-1)!.index;
  }
  const publicHeads = selected.filter((head) => ARCHIVE.has(head.kind));
  const publicBefore = publicHeads.length > 0 && firstPublic < publicHeads[0].index;
  const publicAfter = publicHeads.length > 0 && lastPublic > publicHeads.at(-1)!.index;
  const activities = [...facts.activities(selected.map((head) => head.index))];
  if (opts.order === 'desc') activities.reverse();
  return { activities, totalMatches, publicBefore, publicAfter };
}
function facadeHistoryOptions(query: HistoryQuery): ActivitiesOptions {
  if (query.before !== undefined && query.after !== undefined) throw new SquareError('invalid_args', 'History cannot combine before and after cursors');
  const afterIndex = query.after === undefined ? undefined : parseRequiredActivityId(query.after);
  const beforeIndex = query.before === undefined ? undefined : parseRequiredActivityId(query.before);
  return { participants: query.from === undefined ? undefined : [...query.from], grep: query.grep, fixed: query.fixed,
    mention: query.mention, afterIndex, beforeIndex, order: query.order, lastN: query.limit };
}
function publicActivities(activities: readonly ArchiveRecord[]): Activity[] {
  return activities.flatMap((activity) => activity.kind === 'read' || activity.actor === undefined ? [] : [toPublicActivity(activity)]);
}
export async function history(square: OpenSquare, query: HistoryQuery = {}, control?: OperationControl): Promise<Activity[]> {
  return (await square.artifact.read((facts) => publicActivities(selectHistory(facts, facadeHistoryOptions(query), true).activities), control?.signal)).value;
}
/** Application history is bounded independently of participant selection; SDK archive defaults stay separate. */
export async function applicationHistory(square: OpenSquare, query: HistoryApplicationQuery = {}, control?: OperationControl): Promise<ApplicationOutcome<HistoryApplicationData, HistoryPresentation>> {
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > HISTORY_MAX_LIMIT)) {
    throw new SquareError('invalid_args', `History limit must be a positive integer no greater than ${HISTORY_MAX_LIMIT}`);
  }
  if (query.grep !== undefined && query.fixed !== undefined) throw new SquareError('invalid_args', 'History cannot combine regular-expression and literal search');
  if (query.grep === '' || query.fixed === '') throw new SquareError('invalid_args', 'History search requires non-empty text');
  if (query.since !== undefined && !Number.isFinite(query.since)) throw new SquareError('invalid_args', 'History timestamp must be finite');
  for (const count of [query.contextBefore, query.contextAfter]) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new SquareError('invalid_args', 'History context must be a non-negative safe integer');
  }
  const atIndexes = query.at?.length ? query.at.map(parseRequiredActivityId) : undefined;
  const projection = await historyPresentation(square, {
    ...facadeHistoryOptions(query), after: query.since, atIndexes,
    beforeContext: query.contextBefore, afterContext: query.contextAfter,
    lastN: query.limit ?? (atIndexes === undefined ? HISTORY_DEFAULT_LIMIT : null),
  }, control);
  if (query.limit === undefined && atIndexes !== undefined && projection.totalMatches > HISTORY_MAX_LIMIT) {
    const error: ApplicationError = new SquareError('invalid_args', `History context exceeds ${HISTORY_MAX_LIMIT} activities`);
    Object.assign(error, { operation: { operation: 'history', historyBounds: { maxLimit: HISTORY_MAX_LIMIT, totalMatches: projection.totalMatches } } });
    throw error;
  }
  return { data: { activities: publicActivities(projection.activities) }, projection };
}
export function participantHistory(square: OpenSquare, _name: string, query: HistoryQuery = {}, control?: OperationControl): Promise<Activity[]> {
  return history(square, query.limit === undefined ? { ...query, limit: 10 } : query, control);
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
export async function participants(square: OpenSquare): Promise<ParticipantStatus[]> {
  return (await square.artifact.read((facts) => statuses(facts, square.clock()))).value;
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
export async function recoveryObservation(square: OpenSquare, name: string, control?: OperationControl): Promise<RecoveryObservation> {
  return (await square.artifact.read((facts) => {
    const known = resolveKnownName(facts, name), hold = facts.hold();
    return { name: known, roster: rosterNames(facts), activitySummaries: unreadActivitySummaries(facts, known, square.clock()), participantCount: inSquareCount(facts), held: hold.active,
      ...(hold.reason === undefined ? {} : { holdReason: hold.reason }), ownActivityCount: facts.participant(known)!.sayCount, hardCap: facts.header().hardCap };
  }, control?.signal)).value;
}
export async function entryPresentation(square: OpenSquare, name: string, lastN: number | null = HISTORY_DEFAULT_LIMIT, control?: OperationControl): Promise<EntryPresentation> {
  return (await square.artifact.read((facts) => {
    const header = facts.header(), p = facts.participant(name);
    const recentActivities = selectHistory(facts, { lastN }, false, ['say', 'done']).activities;
    return { joined: p?.joined ?? false, joinedBefore: facts.activityCount({ kinds: ['join'], actors: [name] }) > 1,
      scene: header.warmup.join('\n').trim(), context: header.preamble.join('\n').trim(),
      joinContext: (header.preamble.at(-1) === '---' ? header.preamble.slice(0, -1) : header.preamble).join('\n').trim(), recentActivities,
      perceptions: Object.fromEntries(recentActivities.map((a) => [a.index, perceiveActivity(facts, a, name)])),
      sayNumbers: facts.sayOrdinals(recentActivities.map((a) => a.index)), participantCount: inSquareCount(facts), held: facts.hold().active };
  }, control?.signal)).value;
}
export async function historyPresentation(square: OpenSquare, options: ActivitiesOptions, control?: OperationControl): Promise<HistoryPresentation> {
  return (await square.artifact.read((facts) => {
    const hideRead = options.atIndexes === undefined && options.beforeContext === undefined && options.afterContext === undefined && options.after === undefined;
    const selected = selectHistory(facts, options, hideRead), indexes = selected.activities.map((a) => a.index);
    const presenceAnchors: Record<number, string[]> = {};
    for (const p of facts.roster()) {
      const anchor = presenceAnchor(facts, p.name);
      if (indexes.includes(anchor)) (presenceAnchors[anchor] ??= []).push(p.name);
    }
    const visibleActivities = selected.activities.filter((activity) => ARCHIVE.has(activity.kind));
    const direction = options.afterIndex === undefined ? 'before' as const : 'after' as const;
    const hasMore = direction === 'before' ? selected.publicBefore : selected.publicAfter;
    const limit = options.lastN ?? null;
    const cursor = visibleActivities.length === 0 ? undefined : direction === 'before'
      ? Math.min(...visibleActivities.map((activity) => activity.index)) : Math.max(...visibleActivities.map((activity) => activity.index));
    return { ...selected, visibleActivities, sayNumbers: facts.sayOrdinals(indexes), presenceAnchors, participantCount: inSquareCount(facts), held: facts.hold().active,
      ...(limit === null || cursor === undefined || !hasMore ? {} : { continuation: { direction, cursor: formatActivityId(cursor), limit } }),
      bounds: { limit, maxLimit: HISTORY_MAX_LIMIT, contextWindow: options.atIndexes !== undefined } };
  }, control?.signal)).value;
}
function classifyPresence(participants: readonly ParticipantSummary[], now: number): PresenceClassification {
  const here = participants.filter((participant) => participant.state === 'active' && (participant.presence === 'watching'
    || (participant.lastActiveAt !== undefined && now - participant.lastActiveAt <= STATUS_HERE_WINDOW_MS)));
  const hereNames = new Set(here.map((participant) => participant.name));
  return { orderedHere: [...here.filter((participant) => participant.presence === 'watching'), ...here.filter((participant) => participant.presence !== 'watching')],
    lingeringCount: participants.filter((participant) => participant.state === 'active' && !hereNames.has(participant.name)).length,
    classificationByName: Object.fromEntries(participants.map((participant) => [participant.name, participant.state === 'done' ? 'done'
      : participant.state === 'not joined' ? 'not-joined' : hereNames.has(participant.name) ? 'here' : 'lingering'])) };
}
export async function participantsPresentation(square: OpenSquare, control?: OperationControl): Promise<ParticipantsPresentation> {
  return (await square.artifact.read((facts) => {
    const now = square.clock(), participants = coreParticipants(facts, now);
    return { participants, ...classifyPresence(participants, now), now, standingCount: inSquareCount(facts), held: facts.hold().active };
  }, control?.signal)).value;
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
export async function statusPresentation(square: OpenSquare, viewer = '', control?: OperationControl): Promise<StatusPresentation> {
  return (await square.artifact.read((facts) => {
    const status = coreStatus(facts, square.clock()), afterIndex = status.latestAct?.index ?? -1;
    const joins = facts.activities(facts.activityHeads({ kinds: ['join'], afterIndex }, { edge: 'newest', limit: 3 }).items.map((h) => h.index)).map((activity) => ({ activity,
      rejoined: facts.activityCount({ kinds: ['done'], actors: [activity.actor!], actorMatch: 'exact', beforeIndex: activity.index }) > 0 }));
    const canonicalViewer = facts.participant(viewer)?.name ?? viewer;
    return { status, joins, joinCount: facts.activityCount({ kinds: ['join'], afterIndex }), ...classifyPresence(status.participants, status.now),
      viewer: canonicalViewer, attentionNames: status.participants.filter((participant) => canonicalViewer === '' || nameKey(participant.name) === nameKey(canonicalViewer)).map((participant) => participant.name),
      ...(status.latestAct === undefined ? {} : { latestPerception: perceiveActivity(facts, status.latestAct, canonicalViewer) }),
      ...(status.latestAct?.kind === 'say' ? { latestActNumber: facts.sayOrdinals([status.latestAct.index])[status.latestAct.index] } : {}) };
  }, control?.signal)).value;
}
export async function eventPresentation(square: OpenSquare, id: ActivityId, control?: OperationControl): Promise<EventPresentation> {
  return (await square.artifact.read((facts) => {
    const activity = facts.activity(parseRequiredActivityId(id));
    if (activity === undefined) throw new SquareError('invalid_args', `Unknown activity id: ${id}`);
    return { activity, participantCount: inSquareCount(facts), held: facts.hold().active };
  }, control?.signal)).value;
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
