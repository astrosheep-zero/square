import { type InboxMembership } from './model.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { type SquareChangeCursor, waitForSquareChanges } from './square-file-adapter.js';
import path from 'node:path';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import { projectPresentation, projectSessionBindings } from './square-projections.js';

function hostLedgerForEnv(env: NodeJS.ProcessEnv) {
  const root = env.SQUARE_REGISTRY === undefined ? undefined : path.dirname(env.SQUARE_REGISTRY);
  return createHostLedgerPort({
    userPath: env.SQUARE_HOST_LEDGER_USER ?? root,
    localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? root,
  });
}

export interface PendingWaitOptions {
  signal?: AbortSignal;
  /** Ephemeral watcher de-duplication; never persisted or used by delivery derivation. */
  excludeKeys?: ReadonlySet<string>;
  /** After a delivery failure, wait for a new state edge before retrying the same pending work. */
  skipImmediate?: boolean;
  /** A durable pre-delivery observation: changes since it satisfy a deferred retry edge. */
  changeCursor?: SquareChangeCursor;
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

export async function sessionInbox(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<InboxMembership[]> {
  const inbox: InboxMembership[] = [];
  const hostLedger = hostLedgerForEnv(env);
  for (const binding of await projectSessionBindings({ hostLedger, sessionId })) {
    let square;
    try {
      square = await openSquare(binding.location, { env, hostLedger });
      const projection = await projectPresentation({ artifact: square.artifact, binding, now: square.clock() });
      if (!projection.joined) continue;
      inbox.push({
        name: projection.binding.participant,
        squarePath: projection.binding.location,
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
  env: NodeJS.ProcessEnv = process.env,
): Promise<InboxMembership[]> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  if (!options.skipImmediate) {
    const immediate = withoutExcluded(await sessionInbox(sessionId, env), options.excludeKeys);
    if (immediate.some((membership) => membership.notifications.length > 0)) return immediate;
  }
  if (timeoutMs <= 0 || options.signal?.aborted) return [];

  const bindings = await projectSessionBindings({ hostLedger: hostLedgerForEnv(env), sessionId });
  const paths = [...new Set(bindings.map((binding) => binding.location))];
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
        const current = withoutExcluded(await sessionInbox(sessionId, env), options.excludeKeys);
        return current.some((membership) => membership.notifications.length > 0) ? current : undefined;
      }, options.changeCursor);
      if (aborted || change.status === 'expired') return [];
      if (change.status === 'ready') return change.value;
      projectAfterReady = true;
    }
    return [];
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }
}
