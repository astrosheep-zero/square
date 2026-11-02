import { type Owner, type LocatedSeat, type PendingMembership, type Seat } from './model.js';
import type { SquareRead } from './ports.js';
import { createArtifactPort, observeSquareDeliveryRevision, observeSquareRevision } from './artifact.js';
import { indexedSquareEntries, observeSquareIndex } from './square-index.js';
import { type VersionObserver } from './file-changes.js';
import { canonicalPath } from './canonical-path.js';
import { formatMessageId } from './message.js';
import { freshWatchLease, WATCH_STALE_MS } from './runtime.js';
import { nativePendingHead, pendingHeads, type NativePendingInput } from './delivery.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { projectMessageNotification, renderSquareReminder } from './attention-presentation.js';

export interface PendingWaitOptions {
  signal?: AbortSignal;
  /** Local delivery suppression, never persisted as evidence of receipt. */
  excludeKeys?: ReadonlySet<string>;
  /** Arm before dispatch; retry only after a substantive change, not our failed evidence write. */
  skipImmediate?: boolean;
  onChangeArmed?: (armed: boolean) => void;
}

export function pendingKey(membership: LocatedSeat, messageIndex: number): string {
  return membership.location + '\0' + membership.seat.participant.toLocaleLowerCase() + '\0' + messageIndex;
}

function eligibleNotifications(facts: SquareRead, membership: PendingMembership, now = Date.now()): Pick<PendingMembership, 'notifications' | 'deliveryDeferralExpiry'> {
  const seat = facts.seat(membership.seat.participant);
  if (seat === undefined || seat.attachment !== 'attached' || seat.generation !== membership.seat.generation
    || seat.owner !== membership.seat.owner) return { notifications: [] };
  const cancelledThrough = facts.channel.cancelledThrough(seat.participant, seat.generation);
  let expiry = Infinity;
  const notifications = membership.notifications.filter(notification => {
    if (cancelledThrough !== undefined && notification.messageIndex <= cancelledThrough
      || facts.deliveryEvidence(seat.participant, seat.generation, formatMessageId(notification.messageIndex))
        .some(row => row.outcome !== 'failed' && row.outcome !== 'released')) return false;
    const deferredUntil = deliveryDeferralExpiry(facts.channel, seat, notification.messageIndex, now);
    if (deferredUntil === undefined) return true;
    expiry = Math.min(expiry, deferredUntil);
    return false;
  });
  return { notifications, ...(expiry === Infinity ? {} : { deliveryDeferralExpiry: expiry }) };
}

/** Revalidate a supplied batch immediately before the boundary's independent claim/send checks. */
export async function projectBoundaryEligibility(inbox: readonly PendingMembership[]): Promise<PendingMembership[]> {
  const grouped = new Map<string, PendingMembership[]>();
  for (const membership of inbox.filter(candidate => candidate.notifications.length > 0)) {
    const entries = grouped.get(membership.location) ?? [];
    entries.push(membership);
    grouped.set(membership.location, entries);
  }
  const pending: PendingMembership[] = [];
  for (const [location, memberships] of grouped) {
    const artifact = createArtifactPort(location);
    try {
      const { value } = await artifact.read(facts => memberships.flatMap(membership => {
        const eligibility = eligibleNotifications(facts, membership);
        return eligibility.notifications.length === 0 ? [] : [{ ...membership, ...eligibility }];
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
  readonly owner: Owner;
}

/** HOME is a candidate path index; current seats and delivery evidence live in the artifact. */
export async function projectSessionCandidates(input: SessionSeatQuery): Promise<readonly SessionBindingCandidate[]> {
  const location = input.location === undefined ? undefined : await canonicalPath(input.location);
  const entries = await indexedSquareEntries({ owner: input.owner }, input.env ?? process.env);
  const candidates = new Map<string, SessionBindingCandidate>();
  for (const entry of entries) {
    if (location !== undefined && location !== entry.location) continue;
    const key = JSON.stringify([entry.location, entry.owner]);
    candidates.set(key, { location: entry.location, owner: entry.owner });
  }
  return [...candidates.values()];
}

export interface SessionSeatQuery {
  readonly owner?: Owner;
  readonly location?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function groupCandidates(candidates: readonly SessionBindingCandidate[]): Map<string, Owner[]> {
  const grouped = new Map<string, Owner[]>();
  for (const { location, owner } of candidates) {
    const owners = grouped.get(location) ?? [];
    owners.push(owner);
    grouped.set(location, owners);
  }
  return grouped;
}

function locatedSeats(facts: SquareRead, location: string, seats: readonly Seat[]): LocatedSeat[] {
  return seats.flatMap(seat => {
    const participant = facts.participant(seat.participant);
    const index = participant?.lastJoinIndex;
    const joined = index === undefined ? undefined : facts.activity(index);
    return joined?.kind === 'join' ? [{ location, seat, joinedAt: joined.at }] : [{ location, seat, joinedAt: 0 }];
  });
}

/** Lifecycle reads resolve seats and join times, never pending activity bodies. */
export async function projectSessionSeats(input: SessionSeatQuery, signal?: AbortSignal): Promise<LocatedSeat[]> {
  const seats: LocatedSeat[] = [];
  for (const [location, owners] of groupCandidates(await projectSessionCandidates(input))) {
    signal?.throwIfAborted();
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      seats.push(...(await artifact.read(facts => locatedSeats(facts, location, owners.flatMap(owner => facts.seatsForOwner(owner))), signal)).value);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
    } finally { await artifact.close(); }
  }
  return seats;
}

/** Public count boundary: one coherent read per artifact, without pending body hydration. */
export async function sessionInboxCounts(input: SessionSeatQuery, signal?: AbortSignal): Promise<import('./square-facade.js').InboxMembershipSummary[]> {
  const rows: import('./square-facade.js').InboxMembershipSummary[] = [];
  for (const [location, owners] of groupCandidates(await projectSessionCandidates(input))) {
    signal?.throwIfAborted();
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      rows.push(...(await artifact.read(facts => locatedSeats(facts, location, owners.flatMap(owner => facts.seatsForOwner(owner).filter(seat => seat.attachment === 'attached'))).map(({ seat }) => ({
        name: seat.participant, squarePath: location, pending: facts.directedCount(seat.participant, { unseenOnly: true, currentGeneration: true }),
      })), signal)).value);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
    } finally { await artifact.close(); }
  }
  return rows;
}

interface CachedInbox {
  readonly coordinate: string;
  readonly version: number;
  readonly value: PendingMembership[];
}

/** One authoritative read per canonical artifact, even when discovery names several bodies. */
async function projectPending(candidates: readonly SessionBindingCandidate[],
  cache?: Map<string, CachedInbox>, signal?: AbortSignal): Promise<PendingMembership[]> {
  const pending: PendingMembership[] = [];
  for (const [location, owners] of groupCandidates(candidates)) {
    signal?.throwIfAborted();
    const artifact = createArtifactPort(location, undefined, signal);
    try {
      const { value: current } = await artifact.read(facts => {
        const seats = owners.flatMap(owner => facts.seatsForOwner(owner).filter(seat => seat.attachment === 'attached'));
        const coordinate = JSON.stringify([owners, seats.map(seat => [seat.participant, seat.owner, seat.generation])]);
        const header = facts.header();
        let cached = cache?.get(location);
        if (cached?.coordinate !== coordinate || cached.version !== header.revision) {
          cached = { coordinate, version: header.revision, value: locatedSeats(facts, location, seats).map(membership => {
            const heads = pendingHeads(facts, membership.seat.participant, Date.now(), false);
            const messages = new Map(facts.channel.messages(heads.map(head => head.index)).map(item => [item.index, item]));
            return { ...membership, notifications: heads.flatMap(head => {
              const item = messages.get(head.index);
              if (item === undefined) return [];
              return [{ messageIndex: item.index, ...(head.activityIndex === undefined ? {} : { actIndex: head.activityIndex }),
                actor: item.from, at: item.at, body: item.body, ...(item.preview === undefined ? {} : { preview: item.preview }), ...(head.route === undefined ? {} : { route: head.route }) }];
            }) };
          }) };
        }
        // Cache conversation content, never leases or delivery eligibility: evidence can change
        // without a conversation revision and must not force body hydration or self-wake retries.
        return { cached, pending: cached.value.map(membership => {
          const catchLease = freshWatchLease(facts, membership.seat.participant);
          // Cached conversation content, but claim coverage and deferrals are re-read on every projection.
          const observed = { ...membership, notifications: membership.notifications.filter(note =>
            !facts.channel.suppressed(membership.seat.participant, membership.seat.generation, note.messageIndex, Date.now())) };
          return { ...observed, ...eligibleNotifications(facts, observed),
            ...(catchLease === undefined ? {} : { catchLease }) };
        }) };
      }, signal);
      cache?.set(location, current.cached);
      pending.push(...current.pending);
    } catch (error) {
      cache?.delete(location);
      if (signal?.aborted) throw signal.reason ?? error;
      // Unreadable candidates remain watch targets, but never authorize cached content.
    } finally { await artifact.close(); }
  }
  return pending;
}

export interface NativePendingPreview {
  readonly payload: string;
  readonly clipped: boolean;
}
export interface NativePendingSource { readonly text: string; readonly clipped: boolean }

/** One current eligibility + source projection read; senders use text, ACK coverage uses clipped. */
export function nativePendingSource(facts: SquareRead, input: NativePendingInput): NativePendingSource | undefined {
  const head = nativePendingHead(facts, input);
  if (head === undefined) return undefined;
  const item = facts.channel.message(input.index);
  if (item === undefined) return undefined;
  const projected = projectMessageNotification({ squarePath: input.location, recipient: input.participant,
    actor: item.from, body: item.body, ...(item.preview === undefined ? {} : { preview: item.preview }),
    ...(head.activityIndex === undefined || head.route === undefined ? {} : { agora: { actIndex: head.activityIndex, route: head.route } }) });
  return { text: projected.text, clipped: projected.clipped };
}

/** The sender-facing fixed reminder over the shared source projection. */
export function nativePendingPreview(facts: SquareRead, input: NativePendingInput): NativePendingPreview | undefined {
  const source = nativePendingSource(facts, input);
  return source === undefined ? undefined : { payload: renderSquareReminder([source.text]), clipped: source.clipped };
}

export async function sessionInbox(owner: Owner, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<PendingMembership[]> {
  return projectPending(await projectSessionCandidates({ owner, env }), undefined, signal);
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
  read(options?: Pick<PendingWaitOptions, 'signal' | 'excludeKeys'>): Promise<PendingMembership[]>;
  wait(timeoutMs: number, options?: PendingWaitOptions): Promise<PendingMembership[]>;
  close(): void;
}

/** Session-scoped projection over process-shared storage change detectors. */
export async function observeSessionPending(owner: Owner, suppliedEnv: NodeJS.ProcessEnv = process.env): Promise<SessionPendingObserver> {
  const env = { ...suppliedEnv };
  const query = { owner, env };
  const index = await observeSquareIndex(env);
  const artifacts = new Map<string, {
    observer: VersionObserver<number | null>;
    delivery: VersionObserver<number | null>;
  }>();
  const cache = new Map<string, CachedInbox>();
  const lifetime = new AbortController();
  async function currentInbox(candidates: readonly SessionBindingCandidate[], signal: AbortSignal) {
    const inbox = await projectPending(candidates, cache, signal);
    const now = Date.now();
    return inbox.map((membership): PendingMembership => {
      const { catchLease, ...rest } = membership;
      return catchLease !== undefined && catchLease.expiresAt > now && now - catchLease.heartbeatAt <= WATCH_STALE_MS
        ? membership : rest;
    });
  }
  function eligibleInbox(inbox: PendingMembership[], excludeKeys?: ReadonlySet<string>) {
    const eligible = inbox.filter(membership => membership.notifications.length > 0);
    return excludeKeys === undefined ? eligible : eligible.flatMap((membership) => {
      const notifications = membership.notifications.filter((notification) => !excludeKeys.has(pendingKey(membership, notification.messageIndex)));
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
          const eligibleKeys = JSON.stringify(pending.flatMap((membership) => membership.notifications.map((note) => pendingKey(membership, note.messageIndex))).sort());
          if (previousEligible !== undefined && previousEligible !== eligibleKeys) canReturn = true;
          previousEligible = eligibleKeys;
          if (signal.aborted) return [];
          if (canReturn && pending.length > 0) return pending;
          const remaining = deadline - Date.now();
          if (remaining <= 0) return [];
          // Eligibility may change at lease expiry without any storage write.
          const leaseExpiry = Math.min(Infinity, ...inbox.flatMap((membership) =>
            membership.catchLease === undefined ? [] : [Math.min(membership.catchLease.expiresAt, membership.catchLease.heartbeatAt + WATCH_STALE_MS + 1)]));
          const nextExpiry = Math.min(leaseExpiry, ...inbox.map(membership => membership.deliveryDeferralExpiry ?? Infinity));
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
