import { type InboxMembership } from './model.js';
import { lookupSessionBindings } from './registry.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { inboxProjection } from './views.js';
import { waitForSquareChanges } from './square-file-adapter.js';

export interface PendingWaitOptions {
  signal?: AbortSignal;
  /** Ephemeral watcher de-duplication; never persisted or used by delivery derivation. */
  excludeKeys?: ReadonlySet<string>;
  /** After a delivery failure, wait for a new state edge before retrying the same pending work. */
  skipImmediate?: boolean;
}

function notificationKey(membership: InboxMembership, actIndex: number): string {
  return `${membership.squarePath}\u0000${membership.name.toLocaleLowerCase()}\u0000${actIndex}`;
}

function withoutExcluded(inbox: InboxMembership[], excludeKeys?: ReadonlySet<string>): InboxMembership[] {
  if (excludeKeys === undefined || excludeKeys.size === 0) return inbox;
  return inbox
    .map((membership) => ({
      ...membership,
      notifications: membership.notifications.filter(
        (notification) => !excludeKeys.has(notificationKey(membership, notification.actIndex)),
      ),
    }))
    .filter((membership) => membership.notifications.length > 0);
}

export async function sessionInbox(sessionId: string): Promise<InboxMembership[]> {
  const inbox: InboxMembership[] = [];
  for (const binding of lookupSessionBindings(sessionId)) {
    let square;
    try {
      square = await openSquare(binding.squarePath);
      const projection = await inboxProjection(square, binding.name, binding.ownerId);
      if (!projection.joined) continue;
      inbox.push({
        name: projection.name,
        squarePath: binding.squarePath,
        ownerId: binding.ownerId,
        notifications: [...projection.notifications],
        ...(projection.catchLease !== undefined ? { catchLease: projection.catchLease } : {}),
      });
    } catch {
      // A stale discovery-cache row only disables delivery for that membership.
    } finally {
      if (square !== undefined) await closeOpenSquare(square);
    }
  }
  return inbox;
}

/** Wait for a bound square to produce a new pending notification without consuming it. */
export async function waitForSessionPending(
  sessionId: string,
  timeoutMs: number,
  options: PendingWaitOptions = {},
): Promise<InboxMembership[]> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  if (!options.skipImmediate) {
    const immediate = withoutExcluded(await sessionInbox(sessionId), options.excludeKeys);
    if (immediate.some((membership) => membership.notifications.length > 0)) return immediate;
  }
  if (timeoutMs <= 0 || options.signal?.aborted) return [];

  const bindings = lookupSessionBindings(sessionId);
  const paths = [...new Set(bindings.map((binding) => binding.squarePath))];
  let aborted = false;
  let projectAfterReady = !options.skipImmediate;
  const onAbort = () => { aborted = true; };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (!aborted) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      const change = await waitForSquareChanges(paths, remaining, options.signal, async () => {
        if (!projectAfterReady) return undefined;
        const current = withoutExcluded(await sessionInbox(sessionId), options.excludeKeys);
        return current.some((membership) => membership.notifications.length > 0) ? current : undefined;
      });
      if (aborted || change.status === 'expired') return [];
      if (change.status === 'ready') return change.value;
      projectAfterReady = true;
    }
    return [];
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
