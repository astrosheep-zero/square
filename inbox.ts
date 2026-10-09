import { type InboxMembership } from './model.js';
import { openSquareArtifact, observeSquareChanges } from './square-file-adapter.js';
import { hostLedgerForEnv } from './registry.js';
import { canonicalFilePath, type VersionObserver } from './file-changes.js';
import { projectBoundaryEligibility, projectPresentation, projectSessionBindings } from './square-projections.js';
import { WATCH_STALE_MS } from './runtime.js';

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

export async function sessionInbox(sessionId: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<InboxMembership[]> {
  const inbox: InboxMembership[] = [];
  const hostLedger = hostLedgerForEnv(env);
  for (const binding of await projectSessionBindings({ hostLedger, sessionId })) {
    if (signal?.aborted) throw signal.reason;
    const artifact = openSquareArtifact(binding.location, signal);
    try {
      const projection = await projectPresentation({ artifact, binding, now: Date.now() });
      if (!projection.joined) continue;
      inbox.push({ name: projection.binding.participant, squarePath: projection.binding.location,
        notifications: [...projection.notifications],
        ...(projection.catchLease === undefined ? {} : { catchLease: projection.catchLease }) });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // A stale or unreadable membership cannot disable delivery for other memberships.
    } finally { await artifact.close(); }
  }
  return inbox;
}

interface CapturedChange {
  kind: 'artifact' | 'presence' | 'evidence';
  wait(timeoutMs: number, signal: AbortSignal): Promise<boolean>;
}
async function capture<T>(observer: VersionObserver<T>, kind: CapturedChange['kind'], signal: AbortSignal): Promise<CapturedChange> {
  const generation = observer.generation;
  try {
    const value = await observer.read(signal);
    return { kind, wait: (timeout, abort) => observer.changed(value, timeout, abort) };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    // Keep watching an unreadable/missing artifact so repair can restore delivery.
    return { kind, wait: (timeout, abort) => observer.hinted(generation, timeout, abort) };
  }
}

export interface SessionPendingObserver {
  wait(timeoutMs: number, options?: PendingWaitOptions): Promise<InboxMembership[]>;
  close(): void;
}

/** Session-scoped projection over process-shared storage change detectors. */
export async function observeSessionPending(sessionId: string, suppliedEnv: NodeJS.ProcessEnv = process.env): Promise<SessionPendingObserver> {
  const env = { ...suppliedEnv };
  const hostLedger = hostLedgerForEnv(env);
  const ledger = await hostLedger.observeChanges();
  const artifacts = new Map<string, VersionObserver<number>>();
  const lifetime = new AbortController();
  return {
    async wait(timeoutMs, options = {}) {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      const expired = new AbortController();
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => expired.abort(), Math.min(timeoutMs, 2_147_483_647)) : undefined;
      const signal = AbortSignal.any([lifetime.signal, expired.signal, ...(options.signal === undefined ? [] : [options.signal])]);
      let canReturn = !options.skipImmediate;
      let previousEligible: string | undefined;
      let armed = false;
      try {
        while (!signal.aborted) {
          // Subscribe/capture the ledger BEFORE discovering bindings; a concurrent join cannot fall in a gap.
          const sources = await Promise.all([capture(ledger.presence, 'presence', signal), capture(ledger.evidence, 'evidence', signal)]);
          const bindings = await projectSessionBindings({ hostLedger, sessionId });
          const paths = new Set(await Promise.all(bindings.map((binding) => canonicalFilePath(binding.location))));
          for (const [file, observer] of artifacts) {
            if (!paths.has(file)) { observer.close(); artifacts.delete(file); }
          }
          for (const file of paths) {
            if (artifacts.has(file)) continue;
            const observer = await observeSquareChanges(file);
            if (signal.aborted) { observer.close(); return []; }
            artifacts.set(file, observer);
          }
          sources.push(...await Promise.all([...artifacts.values()].map((observer) => capture(observer, 'artifact', signal))));
          const inbox = await sessionInbox(sessionId, env, signal);
          const eligible = await projectBoundaryEligibility({ hostLedger, sessionId, inbox });
          const excludeKeys = options.excludeKeys;
          const pending: InboxMembership[] = excludeKeys === undefined ? eligible : eligible.flatMap((membership) => {
            const notifications = membership.notifications.filter((notification) => !excludeKeys.has(notificationKey(membership, notification.actIndex)));
            return notifications.length === 0 ? [] : [{ ...membership, notifications }];
          });
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
          const nextExpiry = Math.min(leaseExpiry, await hostLedger.nextExpiry(sessionId));
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
            // Evidence writes from our own failed injection must not generate a retry loop.
            if (change !== 'evidence') canReturn = true;
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
      ledger.presence.close();
      ledger.evidence.close();
      for (const observer of artifacts.values()) observer.close();
      artifacts.clear();
    },
  };
}

/** Finite one-shot consumers retain their API; Pi owns a long-lived observer instead. */
export async function waitForSessionPending(sessionId: string, timeoutMs: number, options: PendingWaitOptions = {}, env: NodeJS.ProcessEnv = process.env): Promise<InboxMembership[]> {
  const observer = await observeSessionPending(sessionId, env);
  try { return await observer.wait(timeoutMs, options); }
  finally { observer.close(); }
}
