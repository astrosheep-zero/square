import { type InboxMembership, nameKey } from './model.js';
import type { PresentationProjection, SessionBindingProjection, SquareRead } from './ports.js';
import { createArtifactPort, observeSquareRevision } from './artifact.js';
import { hostLedgerForEnv } from './registry.js';
import { type VersionObserver } from './file-changes.js';
import { canonicalPath } from './canonical-path.js';
import { projectBoundaryEligibility, projectSessionBindings } from './square-projections.js';
import { freshWatchLease, WATCH_STALE_MS } from './runtime.js';
import { pendingHead, pendingNotifications, leaseOwnsNotification } from './delivery.js';
import { attentionBodyIsClipped, renderAttentionPreview } from './attention-presentation.js';

export interface PendingWaitOptions {
  signal?: AbortSignal;
  /** Local delivery suppression, never persisted as evidence of receipt. */
  excludeKeys?: ReadonlySet<string>;
  /** Arm before dispatch; retry only after a substantive change, not our failed evidence write. */
  skipImmediate?: boolean;
  onChangeArmed?: (armed: boolean) => void;
}

function bindingCoordinate(binding: SessionBindingProjection): string {
  return JSON.stringify([binding.location, nameKey(binding.participant), binding.sessionId, binding.channel, binding.epoch, binding.cancelledThrough ?? -1]);
}

function notificationKey(membership: InboxMembership, actIndex: number): string {
  return membership.squarePath + '\0' + membership.name.toLocaleLowerCase() + '\0' + actIndex;
}

export function projectPresentation(facts: SquareRead, requested: SessionBindingProjection, now = Date.now()): PresentationProjection {
  const participant = facts.participant(requested.participant);
  if (!participant?.joined) return { binding: requested, joined: false, notifications: [] };
  const binding = { ...requested, participant: participant.name };
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
  readonly actIndex: number; readonly epoch?: number; readonly cancelledThrough?: number; readonly now: number;
} & (
  | { readonly routeKind: 'claude-native'; readonly address: { readonly endpoint: string } }
  | { readonly routeKind: 'opencode-server'; readonly address: { readonly sessionId: string } }
);

/** First matching ordered route, exact native epoch/address and catch ownership. */
export function nativePendingPreview(facts: SquareRead, input: NativePendingPreviewInput): NativePendingPreview | undefined {
  const route = facts.routes().find((candidate) => candidate.kind === input.routeKind && candidate.sessionId === input.sessionId
    && candidate.epoch === input.epoch && nameKey(candidate.participant) === nameKey(input.participant)
    && (input.routeKind === 'claude-native' ? candidate.address.endpoint === input.address.endpoint : candidate.address.sessionId === input.address.sessionId));
  if (!route || input.actIndex <= (input.cancelledThrough ?? -1)) return undefined;
  const head = pendingHead(facts, input.participant, input.actIndex);
  const lease = freshWatchLease(facts, input.participant, input.now);
  if (!head || (lease !== undefined && leaseOwnsNotification(lease, head))) return undefined;
  const item = facts.activity(input.actIndex);
  if (item?.kind !== 'say') return undefined;
  return { payload: renderAttentionPreview({ squarePath: input.location, recipient: input.participant, actIndex: item.index,
    actor: item.actor, route: head.route, body: item.body }), clipped: attentionBodyIsClipped(item.body) };
}

async function readInboxMembership(binding: SessionBindingProjection, signal?: AbortSignal) {
  const artifact = createArtifactPort(binding.location, undefined, signal);
  try {
    return await artifact.read((facts): InboxMembership | undefined => {
      const projection = projectPresentation(facts, binding);
      if (!projection.joined) return undefined;
      return { name: projection.binding.participant, squarePath: projection.binding.location, notifications: [...projection.notifications],
        ...(projection.catchLease === undefined ? {} : { catchLease: projection.catchLease }) };
    }, signal);
  } finally { await artifact.close(); }
}

export async function sessionInbox(sessionId: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<InboxMembership[]> {
  const inbox: InboxMembership[] = [];
  const hostLedger = hostLedgerForEnv(env);
  for (const binding of await projectSessionBindings({ hostLedger, sessionId })) {
    if (signal?.aborted) throw signal.reason;
    try {
      const { value: membership } = await readInboxMembership(binding, signal);
      if (membership !== undefined) inbox.push(membership);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // A stale or unreadable membership cannot disable delivery for other memberships.
    }
  }
  return inbox;
}

interface CapturedChange<T = unknown> {
  kind: 'artifact' | 'presence' | 'evidence';
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
  wait(timeoutMs: number, options?: PendingWaitOptions): Promise<InboxMembership[]>;
  close(): void;
}

/** Session-scoped projection over process-shared storage change detectors. */
export async function observeSessionPending(sessionId: string, suppliedEnv: NodeJS.ProcessEnv = process.env): Promise<SessionPendingObserver> {
  const env = { ...suppliedEnv };
  const hostLedger = hostLedgerForEnv(env);
  const ledger = await hostLedger.observeChanges();
  const artifacts = new Map<string, {
    observer: VersionObserver<number | null>;
    inbox: Map<string, { binding: string; version: number; value: InboxMembership | undefined }>;
  }>();
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
          const sources: CapturedChange[] = await Promise.all([capture(ledger.presence, 'presence', signal), capture(ledger.evidence, 'evidence', signal)]);
          const bindings = await Promise.all((await projectSessionBindings({ hostLedger, sessionId })).map(async (binding) =>
            ({ ...binding, location: await canonicalPath(binding.location) })));
          const paths = new Set(bindings.map((binding) => binding.location));
          for (const [file, entry] of artifacts) {
            if (!paths.has(file)) { entry.observer.close(); artifacts.delete(file); }
          }
          for (const file of paths) {
            if (artifacts.has(file)) continue;
            const observer = await observeSquareRevision(file);
            if (signal.aborted) { observer.close(); return []; }
            artifacts.set(file, { observer, inbox: new Map() });
          }
          const revisions = new Map<string, number | null | undefined>();
          for (const [file, entry] of artifacts) {
            const source = await capture(entry.observer, 'artifact', signal);
            sources.push(source);
            revisions.set(file, source.value);
            const names = new Set(bindings.filter((binding) => binding.location === file).map((binding) => nameKey(binding.participant)));
            for (const name of entry.inbox.keys()) if (!names.has(name)) entry.inbox.delete(name);
          }
          const inbox: InboxMembership[] = [];
          for (const binding of bindings) {
            if (signal.aborted) return [];
            const entry = artifacts.get(binding.location)!;
            const name = nameKey(binding.participant);
            try {
              const coordinate = bindingCoordinate(binding);
              const cached = entry.inbox.get(name);
              if (cached?.version !== revisions.get(binding.location) || cached?.binding !== coordinate) {
                const projection = await readInboxMembership(binding, signal);
                entry.inbox.set(name, { ...projection, binding: coordinate });
              }
              const membership = entry.inbox.get(name)?.value;
              if (membership === undefined) continue;
              const { catchLease, ...rest } = membership;
              const now = Date.now();
              inbox.push(catchLease !== undefined && catchLease.expiresAt > now && now - catchLease.heartbeatAt <= WATCH_STALE_MS
                ? membership : rest);
            } catch (error) {
              if (signal.aborted) throw signal.reason ?? error;
              // Unreadable projections are retried, never cached as current.
            }
          }
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
      for (const entry of artifacts.values()) entry.observer.close();
      artifacts.clear();
    },
  };
}
