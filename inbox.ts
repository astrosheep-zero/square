import { type Body, type InboxMembership, sameBody } from './model.js';
import type { PresentationProjection, SessionBindingProjection, SquareRead } from './ports.js';
import { createArtifactPort, observeSquareDeliveryRevision, observeSquareRevision } from './artifact.js';
import { indexedSquareEntries, observeSquareIndex } from './square-index.js';
import { type VersionObserver } from './file-changes.js';
import { canonicalPath } from './canonical-path.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import { freshWatchLease, WATCH_STALE_MS } from './runtime.js';
import { pendingHead, pendingNotifications, leaseOwnsNotification } from './delivery.js';
import { attentionBodyIsClipped, renderAttentionPreview, renderSquareReminder } from './attention-presentation.js';

export interface PendingWaitOptions {
  signal?: AbortSignal;
  /** Local delivery suppression, never persisted as evidence of receipt. */
  excludeKeys?: ReadonlySet<string>;
  /** Arm before dispatch; retry only after a substantive change, not our failed evidence write. */
  skipImmediate?: boolean;
  onChangeArmed?: (armed: boolean) => void;
}

function notificationKey(membership: InboxMembership, actIndex: number): string {
  return membership.squarePath + '\0' + membership.name.toLocaleLowerCase() + '\0' + actIndex;
}

export function pendingAtBoundary(inbox: readonly InboxMembership[]): InboxMembership[] {
  return inbox.map((membership) => {
    const lease = membership.catchLease;
    if (lease === undefined) return membership;
    return { ...membership, notifications: membership.notifications.filter(
      (notification) => !leaseOwnsNotification(lease, { ...notification, recipient: membership.name }),
    ) };
  }).filter((membership) => membership.notifications.length > 0);
}

function eligibleNotifications(facts: SquareRead, membership: InboxMembership) {
  const seat = facts.seat(membership.name);
  if (seat === undefined || membership.seat !== undefined
    && (seat.generation !== membership.seat.generation || !sameBody(seat.body, membership.seat.body))) return [];
  const cancelledThrough = facts.cancelledThrough(seat.participant, seat.generation);
  return membership.notifications.filter(notification =>
    (cancelledThrough === undefined || notification.actIndex > cancelledThrough)
    && !facts.deliveryEvidence(seat.participant, seat.generation, formatActivityId(notification.actIndex))
      .some(row => row.kind === 'presentation' && (row.outcome === 'presented' || row.outcome === 'clipped')));
}

/** Revalidate a supplied batch immediately before the boundary's independent claim/send checks. */
export async function projectBoundaryEligibility(inbox: readonly InboxMembership[]): Promise<InboxMembership[]> {
  const grouped = new Map<string, InboxMembership[]>();
  for (const membership of pendingAtBoundary(inbox)) {
    const entries = grouped.get(membership.squarePath) ?? [];
    entries.push(membership);
    grouped.set(membership.squarePath, entries);
  }
  const pending: InboxMembership[] = [];
  for (const [location, memberships] of grouped) {
    const artifact = createArtifactPort(location);
    try {
      const { value } = await artifact.read(facts => memberships.flatMap(membership => {
        const notifications = eligibleNotifications(facts, membership);
        return notifications.length === 0 ? [] : [{ ...membership, notifications }];
      }));
      pending.push(...value);
    } catch {
      // An unreadable or stale candidate cannot authorize boundary presentation.
    } finally { await artifact.close(); }
  }
  return pending;
}

export interface SessionBindingCandidate {
  readonly location: string;
  readonly body: Body;
}

/** HOME is a candidate path index; current seats and delivery evidence live in the artifact. */
export async function projectSessionCandidates(input: {
  readonly body?: Body;
  readonly sessionId?: string;
  readonly channel?: string;
  readonly agent?: string;
  readonly location?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<readonly SessionBindingCandidate[]> {
  const location = input.location === undefined ? undefined : await canonicalPath(input.location);
  const entries = await indexedSquareEntries({ body: input.body, session: input.sessionId, channel: input.channel, agent: input.agent }, input.env ?? process.env);
  const candidates = new Map<string, SessionBindingCandidate>();
  for (const entry of entries) {
    if (location !== undefined && location !== entry.location) continue;
    const key = JSON.stringify([entry.location, entry.body.channel, entry.body.session, entry.body.agent ?? null]);
    candidates.set(key, { location: entry.location, body: entry.body });
  }
  return [...candidates.values()];
}

interface ArtifactInbox {
  readonly bindings: SessionBindingProjection[];
  readonly inbox: InboxMembership[];
}
interface CachedInbox {
  readonly coordinate: string;
  readonly version: number;
  readonly value: ArtifactInbox;
}

/** One authoritative read per canonical artifact, even when discovery names several bodies. */
async function projectCandidates(candidates: readonly SessionBindingCandidate[], pending = false,
  cache?: Map<string, CachedInbox>, signal?: AbortSignal): Promise<ArtifactInbox[]> {
  const grouped = new Map<string, Body[]>();
  for (const { location, body } of candidates) {
    const bodies = grouped.get(location) ?? [];
    bodies.push(body);
    grouped.set(location, bodies);
  }
  const projections: ArtifactInbox[] = [];
  for (const [location, bodies] of grouped) {
    signal?.throwIfAborted();
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      const { value: current } = await artifact.read(facts => {
        const seats = bodies.flatMap(body => facts.seatsForBody(body));
        const coordinate = JSON.stringify([bodies, seats.map(seat => [seat.participant, seat.body, seat.generation])]);
        const header = facts.header();
        let cached = cache?.get(location);
        if (cached?.coordinate !== coordinate || cached.version !== header.revision) {
          const bindings = seats.flatMap(seat => {
            const index = parseActivityId(seat.generation);
            const joined = index === undefined ? undefined : facts.activity(index);
            return joined?.kind !== 'join' ? [] : [{ location, participant: seat.participant,
              sessionId: seat.body.session, channel: seat.body.channel, updatedAt: joined.at, seat: {
                participant: seat.participant, body: seat.body, generation: seat.generation,
              } }];
          });
          cached = { coordinate, version: header.revision,
            value: { bindings, inbox: pending ? inboxProjection(facts, bindings) : [] } };
        }
        // Cache conversation content, never leases or delivery eligibility: evidence can change
        // without a conversation revision and must not force body hydration or self-wake retries.
        return { cached, projection: { ...cached.value, inbox: cached.value.inbox.map(membership => {
          const catchLease = freshWatchLease(facts, membership.name);
          return { ...membership, notifications: eligibleNotifications(facts, membership),
            ...(catchLease === undefined ? {} : { catchLease }) };
        }) } };
      }, signal);
      cache?.set(location, current.cached);
      projections.push(current.projection);
    } catch (error) {
      cache?.delete(location);
      if (signal?.aborted) throw signal.reason ?? error;
      // Unreadable candidates remain watch targets, but never authorize cached content.
    } finally { await artifact.close(); }
  }
  return projections;
}

/** Verify discovery candidates against the current artifact seats before exposing bindings. */
export async function projectArtifactBindings(candidates: readonly SessionBindingCandidate[]): Promise<readonly SessionBindingProjection[]> {
  return (await projectCandidates(candidates)).flatMap(projection => projection.bindings);
}

export async function projectSessionBindings(input: {
  readonly body?: Body;
  readonly sessionId?: string;
  readonly channel?: string;
  readonly agent?: string;
  readonly location?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<readonly SessionBindingProjection[]> {
  return projectArtifactBindings(await projectSessionCandidates(input));
}
export function projectPresentation(facts: SquareRead, requested: SessionBindingProjection, now = Date.now()): PresentationProjection {
  const participant = facts.participant(requested.participant);
  const seat = facts.seat(requested.participant);
  const requestedBody = requested.seat?.body ?? { channel: requested.channel, session: requested.sessionId };
  if (!participant?.joined || seat === undefined || !sameBody(seat.body, requestedBody)) return { binding: requested, joined: false, notifications: [] };
  const binding = { ...requested, participant: participant.name, seat: {
    participant: seat.participant, body: seat.body, generation: seat.generation,
  } };
  const notifications = pendingNotifications(facts, participant.name).map(({ item, route }) => ({
    actIndex: item.index, actor: item.actor, at: item.at, body: item.body, route,
  }));
  const catchLease = freshWatchLease(facts, participant.name, now);
  return { binding, joined: true, notifications, ...(catchLease === undefined ? {} : { catchLease }) };
}

export interface NativePendingPreview {
  readonly payload: string;
  readonly clipped: boolean;
}
export type NativePendingPreviewInput = {
  readonly location: string; readonly sessionId: string; readonly participant: string;
  readonly actIndex: number; readonly cancelledThrough?: number; readonly now: number;
} & (
  | { readonly routeKind: 'claude-native'; readonly address: { readonly endpoint: string } }
  | { readonly routeKind: 'opencode-server'; readonly address: { readonly sessionId: string } }
);

function sameWakeAddress(address: import('./model.js').WakeAddress | undefined, kind: NativePendingPreviewInput['routeKind'], requested: Readonly<Record<string, string>>): boolean {
  if (address?.kind !== kind) return false;
  return Object.entries(requested).every(([key, value]) => address.address[key] === value);
}

/** First matching current seat, exact body/generation/address and catch ownership. */
export function nativePendingPreview(facts: SquareRead, input: NativePendingPreviewInput): NativePendingPreview | undefined {
  const seat = facts.seat(input.participant);
  if (seat === undefined || seat.body.session !== input.sessionId
    || !sameWakeAddress(seat.wakeAddress, input.routeKind, input.address)) return undefined;
  const cancelledThrough = facts.cancelledThrough(seat.participant, seat.generation);
  if (input.actIndex <= Math.max(input.cancelledThrough ?? -1, cancelledThrough ?? -1)) return undefined;
  const head = pendingHead(facts, seat.participant, input.actIndex);
  const lease = freshWatchLease(facts, input.participant, input.now);
  if (!head || (lease !== undefined && leaseOwnsNotification(lease, head))) return undefined;
  const item = facts.activity(input.actIndex);
  if (item?.kind !== 'say') return undefined;
  return { payload: renderSquareReminder([renderAttentionPreview({ squarePath: input.location, recipient: input.participant, actIndex: item.index,
    actor: item.actor, route: head.route, body: item.body })]), clipped: attentionBodyIsClipped(item.body) };
}

function inboxProjection(facts: SquareRead, bindings: readonly SessionBindingProjection[]): InboxMembership[] {
  return bindings.map(binding => {
    const projection = projectPresentation(facts, binding);
    return { name: binding.participant, squarePath: binding.location, seat: projection.binding.seat,
      notifications: [...projection.notifications] };
  });
}

export interface SessionIdentityQuery { readonly channel: string; readonly session: string; readonly allAgents?: true; }
export type SessionIdentity = Body | SessionIdentityQuery;

export async function sessionInbox(identity: SessionIdentity, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<InboxMembership[]> {
  const query = 'allAgents' in identity ? { channel: identity.channel, sessionId: identity.session, env }
    : { body: identity, env };
  return (await projectCandidates(await projectSessionCandidates(query), true, undefined, signal)).flatMap(projection => projection.inbox);
}

interface CapturedChange<T = unknown> {
  kind: 'artifact' | 'index' | 'delivery';
  value?: T;
  wait(timeoutMs: number, signal: AbortSignal): Promise<boolean>;
}
async function capture<T>(observer: VersionObserver<T>, kind: CapturedChange['kind'], signal: AbortSignal): Promise<CapturedChange<T>> {
  const generation = observer.generation;
  try {
    const value = await observer.read(signal);
    return { kind, value, wait: (timeout, abort) => observer.changed(value, timeout, abort) };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    // Failed revision reads are not changes; only a successful retry wakes projection.
    return { kind, wait: async (timeout, abort) => {
      const deadline = Date.now() + Math.max(0, timeout);
      let since = generation;
      while (await observer.hinted(since, Math.max(0, deadline - Date.now()), abort)) {
        since = observer.generation;
        try { await observer.read(abort); return true; }
        catch (error) { if (abort.aborted) throw abort.reason ?? error; }
      }
      return false;
    } };
  }
}

export interface SessionPendingObserver {
  /** Read committed revisions before reusing content; filesystem hints are only for waiting. */
  read(options?: Pick<PendingWaitOptions, 'signal' | 'excludeKeys'>): Promise<InboxMembership[]>;
  wait(timeoutMs: number, options?: PendingWaitOptions): Promise<InboxMembership[]>;
  close(): void;
}

/** Session-scoped projection over process-shared storage change detectors. */
export async function observeSessionPending(identity: SessionIdentity, suppliedEnv: NodeJS.ProcessEnv = process.env): Promise<SessionPendingObserver> {
  const env = { ...suppliedEnv };
  const query = 'allAgents' in identity ? { channel: identity.channel, sessionId: identity.session, env }
    : { body: identity, env };
  const index = await observeSquareIndex(env);
  const artifacts = new Map<string, {
    observer: VersionObserver<number | null>;
    delivery: VersionObserver<number | null>;
  }>();
  const cache = new Map<string, CachedInbox>();
  const lifetime = new AbortController();
  async function currentInbox(candidates: readonly SessionBindingCandidate[], signal: AbortSignal) {
    const inbox = (await projectCandidates(candidates, true, cache, signal)).flatMap(projection => projection.inbox);
    const now = Date.now();
    return inbox.map((membership): InboxMembership => {
      const { catchLease, ...rest } = membership;
      return catchLease !== undefined && catchLease.expiresAt > now && now - catchLease.heartbeatAt <= WATCH_STALE_MS
        ? membership : rest;
    });
  }
  function eligibleInbox(inbox: InboxMembership[], excludeKeys?: ReadonlySet<string>) {
    const eligible = pendingAtBoundary(inbox);
    return excludeKeys === undefined ? eligible : eligible.flatMap((membership) => {
      const notifications = membership.notifications.filter((notification) => !excludeKeys.has(notificationKey(membership, notification.actIndex)));
      return notifications.length === 0 ? [] : [{ ...membership, notifications }];
    });
  }
  return {
    async read(options = {}) {
      const signal = AbortSignal.any([lifetime.signal, ...(options.signal === undefined ? [] : [options.signal])]);
      signal.throwIfAborted();
      const inbox = await currentInbox(await projectSessionCandidates(query), signal);
      const pending = eligibleInbox(inbox, options.excludeKeys);
      signal.throwIfAborted();
      return pending;
    },
    async wait(timeoutMs, options = {}) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const expired = new AbortController();
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => expired.abort(), Math.min(timeoutMs, 2_147_483_647)) : undefined;
      const signal = AbortSignal.any([lifetime.signal, expired.signal, ...(options.signal === undefined ? [] : [options.signal])]);
      let canReturn = !options.skipImmediate;
      let previousEligible: string | undefined;
      let armed = false;
      let candidates: readonly SessionBindingCandidate[] = [];
      let candidatePresence: unknown;
      let discoveredCandidates = false;
      try {
        while (!signal.aborted) {
          // Subscribe to the candidate index before discovering artifacts; a concurrent join can
          // publish its path without touching the artifact revision.
          const sources: CapturedChange[] = [await capture(index, 'index', signal)];
          const presence = sources[0];
          const currentPresence = presence.value;
          if (!discoveredCandidates || currentPresence !== undefined && !Object.is(currentPresence, candidatePresence)) {
            candidates = await projectSessionCandidates(query);
            candidatePresence = currentPresence;
            discoveredCandidates = true;
          }
          const paths = new Set(candidates.map((candidate) => candidate.location));
          for (const [file, entry] of artifacts) {
            if (!paths.has(file)) { entry.observer.close(); entry.delivery.close(); artifacts.delete(file); cache.delete(file); }
          }
          for (const file of paths) {
            if (artifacts.has(file)) continue;
            const observer = await observeSquareRevision(file);
            const delivery = await observeSquareDeliveryRevision(file);
            if (signal.aborted) { observer.close(); delivery.close(); return []; }
            artifacts.set(file, { observer, delivery });
          }
          // Capture both revision baselines before selecting seats and pending facts. A takeover
          // during an empty selection must remain visible to the already armed observers.
          for (const entry of artifacts.values()) {
            sources.push(await capture(entry.observer, 'artifact', signal));
            sources.push(await capture(entry.delivery, 'delivery', signal));
          }
          const inbox = await currentInbox(candidates, signal);
          const pending = eligibleInbox(inbox, options.excludeKeys);
          const eligibleKeys = JSON.stringify(pending.flatMap((membership) => membership.notifications.map((note) => notificationKey(membership, note.actIndex))).sort());
          if (previousEligible !== undefined && previousEligible !== eligibleKeys) canReturn = true;
          previousEligible = eligibleKeys;
          if (signal.aborted) return [];
          if (canReturn && pending.length > 0) return pending;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return [];
          // Eligibility may change at lease expiry without any storage write.
          const leaseExpiry = Math.min(Infinity, ...inbox.flatMap((membership) =>
            membership.catchLease === undefined ? [] : [Math.min(membership.catchLease.expiresAt, membership.catchLease.heartbeatAt + WATCH_STALE_MS + 1)]));
          const nextExpiry = leaseExpiry;
          const duration = Math.min(remaining, Math.max(1, nextExpiry - Date.now()));
          const cancelled = new AbortController();
          const waitSignal = AbortSignal.any([signal, cancelled.signal]);
          const waits = sources.map(async (source) => {
            try { return await source.wait(duration, waitSignal) ? source.kind : 'deadline' as const; }
            catch (error) { if (waitSignal.aborted) throw error; return source.kind; }
          });
          if (!armed) { armed = true; options.onChangeArmed?.(true); }
          try {
            const change = await Promise.race(waits);
            if (change !== 'delivery') canReturn = true;
          } finally {
            cancelled.abort();
            await Promise.allSettled(waits);
          }
        }
        return [];
      } catch (error) {
        if (signal.aborted) return [];
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!armed) options.onChangeArmed?.(false);
      }
    },
    close() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      index.close();
      for (const entry of artifacts.values()) { entry.observer.close(); entry.delivery.close(); }
      artifacts.clear();
      cache.clear();
    },
  };
}
