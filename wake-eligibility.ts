import { nameKey, type WakeRoute } from './model.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import type { EvidenceRecord, PresenceRecord } from './host-ledger.js';
import { presenceEpoch } from './registry.js';
import type { DirectedHead, HostLedgerPort, PresentationEvidenceProjection, RouteFact, WakeRequest } from './ports.js';
import { canonicalPath } from './canonical-path.js';
import { decodeWakeEvidence, type WakeAttempt } from './wake-evidence.js';

export interface WakeSnapshot {
  readonly routes: readonly RouteFact[];
  readonly pending: readonly DirectedHead[];
  readonly seen?: readonly { readonly recipient: string; readonly index: number }[];
  /** Canonicalized by the caller; every identity in this snapshot is square-local. */
  readonly location: string;
  readonly owners: readonly PresenceRecord[];
  readonly bindings?: readonly PresenceRecord[];
  readonly wakeRecords: readonly EvidenceRecord[];
  readonly presentations: readonly PresentationEvidenceProjection[];
  readonly now: number;
}

export interface OwnedWakeRoute {
  readonly route: WakeRoute;
  readonly owner: PresenceRecord;
}

export interface WakeCurrentness {
  readonly current: boolean;
  readonly activityPending: boolean;
  readonly sessionBound: boolean;
  readonly routePublished: boolean;
  readonly selectedOwner: boolean;
  readonly cancelled: boolean;
  readonly presented: boolean;
}

export interface WakeEvidence {
  readonly delivered: boolean;
  /** All selected, uncancelled routes have session-local presentation evidence. */
  readonly presented: boolean;
  readonly attempts: readonly WakeAttempt[];
  readonly terminal?: WakeAttempt;
  readonly attemptableRoutes: readonly WakeRoute[];
}

export interface WakeEligibility {
  evidence(recipient: string, actIndex: number): WakeEvidence;
  currentness(request: WakeRequest): WakeCurrentness;
}

function identity(...parts: readonly (string | number)[]): string { return JSON.stringify(parts); }

/** One strict ownership join, latest selection, and request fence over primary evidence only. */
export function projectWakeEligibility(input: WakeSnapshot): WakeEligibility {
  const ownersBySession = new Map<string, PresenceRecord[]>();
  for (const owner of input.owners) {
    if (owner.location !== input.location) continue;
    const key = identity(nameKey(owner.participant), owner.session);
    const rows = ownersBySession.get(key) ?? [];
    rows.push(owner);
    ownersBySession.set(key, rows);
  }
  const ownerFor = (route: Pick<RouteFact, 'location' | 'participant' | 'sessionId' | 'epoch'>): PresenceRecord | undefined => route.location !== input.location ? undefined
    : ownersBySession.get(identity(nameKey(route.participant), route.sessionId))?.find(
      (row) => route.epoch === undefined || presenceEpoch(row) === route.epoch,
    );
  const ownedRoutes: OwnedWakeRoute[] = [];
  const latest = new Map<string, number>();
  for (const fact of input.routes) {
    const participant = nameKey(fact.participant);
    const owner = ownerFor(fact);
    // Malformed legacy epoch cannot acquire an owner by coercion or enter a transport request.
    if (owner === undefined || (fact.epoch !== undefined && typeof fact.epoch !== 'number')) continue;
    const { extra, epoch, ...route } = fact;
    ownedRoutes.push({ route: { ...route, ...(epoch === undefined ? {} : { epoch }) }, owner });
    latest.set(participant, Math.max(latest.get(participant) ?? Number.NEGATIVE_INFINITY, route.updatedAt));
  }
  const selectedByRecipient = new Map<string, OwnedWakeRoute[]>();
  for (const owned of ownedRoutes) {
    const key = nameKey(owned.route.participant);
    if (owned.route.updatedAt !== latest.get(key)) continue;
    const rows = selectedByRecipient.get(key) ?? [];
    rows.push(owned);
    selectedByRecipient.set(key, rows);
  }
  const pending = new Set(input.pending.map((head) => identity(nameKey(head.recipient), head.index)));
  const seen = new Set(input.seen?.map((receipt) => identity(nameKey(receipt.recipient), receipt.index)));
  const attemptsByAttention = new Map<string, WakeAttempt[]>();
  for (const record of input.wakeRecords) {
    if (record.location !== input.location) continue;
    const decoded = decodeWakeEvidence(record, input.now);
    if (decoded?.kind !== 'attempt') continue;
    const attempt = decoded.value;
    const key = identity(nameKey(attempt.attention.recipient), attempt.attention.actIndex);
    const rows = attemptsByAttention.get(key) ?? [];
    rows.push(attempt);
    attemptsByAttention.set(key, rows);
  }
  const presentedSessions = new Set<string>();
  for (const row of input.presentations) {
    if (row.location !== input.location || (row.outcome !== 'presented' && row.outcome !== 'clipped')) continue;
    presentedSessions.add(identity(nameKey(row.participant), row.activity, row.sessionId));
  }
  const isPresented = (route: WakeRoute, actIndex: number): boolean => presentedSessions.has(
    identity(nameKey(route.participant), formatActivityId(actIndex), route.sessionId),
  );
  const isCancelled = (owner: PresenceRecord, actIndex: number): boolean => actIndex <= (owner.cancelledThrough ?? -1);
  const bindingCurrent = (owner: PresenceRecord): boolean => input.bindings === undefined
    || input.bindings.some((captured) => sameBinding(captured, owner));

  return {
    evidence(recipient, actIndex) {
      const key = nameKey(recipient);
      // Accepted/unknown exclusion belongs to attention, not to a surviving owner or route kind.
      const attempts = attemptsByAttention.get(identity(key, actIndex)) ?? [];
      const terminal = attempts.findLast((attempt) => attempt.outcome === 'accepted')
        ?? attempts.findLast((attempt) => attempt.outcome === 'unknown');
      const routes = (selectedByRecipient.get(key) ?? []).filter(({ owner }) => !isCancelled(owner, actIndex));
      const presented = routes.length > 0 && routes.every(({ route }) => isPresented(route, actIndex));
      return {
        delivered: seen.has(identity(key, actIndex)), presented, attempts,
        ...(terminal === undefined ? {} : { terminal }),
        attemptableRoutes: terminal === undefined && pending.has(identity(key, actIndex))
          ? routes.filter(({ route, owner }) => bindingCurrent(owner) && !isPresented(route, actIndex)).map(({ route }) => route) : [],
      };
    },
    currentness(request) {
      const actIndex = parseActivityId(request.activity);
      const route = request.route;
      const sameRecipient = nameKey(request.participant) === nameKey(route.participant);
      const sameLocation = request.location === input.location && route.location === input.location;
      const activityPending = actIndex !== undefined && request.location === input.location
        && pending.has(identity(nameKey(request.participant), actIndex));
      const owner = sameLocation && sameRecipient ? ownerFor(route) : undefined;
      const sessionBound = owner !== undefined && bindingCurrent(owner);
      const matchesRequest = (published: RouteFact | WakeRoute): boolean => published.location === route.location
        && nameKey(published.participant) === nameKey(route.participant) && published.sessionId === route.sessionId
        && published.kind === route.kind && published.epoch === route.epoch && Object.keys(published.address).length === Object.keys(route.address).length && Object.keys(published.address).every((key) => published.address[key] === route.address[key]);
      const routePublished = sameLocation && sameRecipient && input.routes.some(matchesRequest);
      const selectedOwner = sameLocation && sameRecipient
        && (selectedByRecipient.get(nameKey(route.participant)) ?? []).some(({ route: published }) => matchesRequest(published));
      const cancelled = actIndex !== undefined && owner !== undefined && isCancelled(owner, actIndex);
      const presented = actIndex !== undefined && sameLocation && sameRecipient && isPresented(route, actIndex);
      // Dispatching evidence deliberately does not fence the request that owns the atomic claim.
      return { current: activityPending && sessionBound && routePublished && selectedOwner && !cancelled && !presented,
        activityPending, sessionBound, routePublished, selectedOwner, cancelled, presented };
    },
  };
}

/** Host observation happens only after detached artifact facts have left their transaction. */
export async function projectWakeEvidence(input: Pick<WakeSnapshot, 'routes' | 'pending' | 'seen' | 'location' | 'now' | 'bindings'> & {
  readonly hostLedger: HostLedgerPort;
  readonly owners?: readonly PresenceRecord[];
}): Promise<WakeEligibility> {
  const location = await canonicalPath(input.location);
  const owners = input.owners ?? await input.hostLedger.listPresence({ location, now: input.now });
  const records = await input.hostLedger.listEvidence({ location, now: input.now });
  const presentations = records.filter((row) => row.kind === 'presentation').map((row) => ({
    location: row.location, participant: row.participant, sessionId: row.session, activity: row.activity, outcome: row.outcome,
    ...(row.at === undefined ? {} : { at: row.at }),
  }));
  return projectWakeEligibility({ ...input, location, owners, wakeRecords: records.filter((row) => row.kind === 'wake'), presentations });
}

export function sameBinding(captured: PresenceRecord, current: PresenceRecord): boolean {
  return captured.location === current.location && nameKey(captured.participant) === nameKey(current.participant)
    && captured.session === current.session && captured.channel === current.channel && captured.epoch === current.epoch
    && (captured.cancelledThrough ?? -1) === (current.cancelledThrough ?? -1);
}

export function wakeIsEligible(evidence: WakeEvidence): boolean {
  return !evidence.delivered && !evidence.presented && evidence.terminal === undefined && evidence.attemptableRoutes.length > 0;
}
