import { squareIndexPath } from './square-index.js';
import { createHash } from 'node:crypto';

import { withFileLock } from './file-lock.js';
import { openSquare } from './open-square.js';
import { closeOpenSquare } from './open-square.js';
import { presentPending } from './presentation-operations.js';
import { sessionInbox, projectBoundaryEligibility, pendingAtBoundary, pendingKey } from './inbox.js';
import type { Body, PendingMembership } from './model.js';
import type { OpenSquare } from './open-square.js';
import { attentionBodyIsClipped, renderAttentionPreview, renderSquareReminder } from './attention-presentation.js';
export { pendingAtBoundary };

const CONTEXT_MAX = 1200;
const presentationLocks = new Map<string, Promise<void>>();

/** One settled promise loses to an abort so an in-process presentation wait stays bounded too. */
async function awaitWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return promise;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        if (signal.aborted) { reject(signal.reason ?? new Error('Presentation aborted')); return; }
        onAbort = () => reject(signal.reason ?? new Error('Presentation aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

export function renderPendingAtBoundary(inbox: PendingMembership[]): string {
  return renderBoundary(inbox).context;
}

interface CompleteBoundaryMembership {
  membership: PendingMembership;
  actIndexes: number[];
  markSeen: boolean;
}

interface BoundaryRender {
  context: string;
  complete: CompleteBoundaryMembership[];
}

function renderBoundary(inbox: PendingMembership[]): BoundaryRender {
  const queued = inbox.flatMap((membership) =>
    membership.notifications.map((notification) => ({ membership, notification }))
  );
  const blocks: string[] = [];
  const complete: CompleteBoundaryMembership[] = [];
  let omitted = 0;
  const omission = (count: number) => `${count} more ${count === 1 ? 'activity' : 'activities'} not shown.`;

  for (const [index, entry] of queued.entries()) {
    const { membership, notification } = entry;
    const block = [
      renderAttentionPreview({
        squarePath: membership.location,
        actIndex: notification.actIndex,
        recipient: membership.seat.participant,
        actor: notification.actor,
        route: notification.route,
        body: notification.body,
      }),
    ].join('\n');
    const omittedAfter = omitted + queued.length - index - 1;
    const prospective = renderSquareReminder([...blocks, block, ...(omittedAfter > 0 ? [omission(omittedAfter)] : [])]);
    if (prospective.length > CONTEXT_MAX) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    complete.push({
      membership,
      actIndexes: [notification.actIndex],
      markSeen: !attentionBodyIsClipped(notification.body),
    });
  }

  return {
    context: renderSquareReminder([...blocks, ...(omitted > 0 ? [omission(omitted)] : [])]),
    complete,
  };
}

async function presentPendingAtBoundaryUnlocked<T>(
  identity: Body,
  present: (context: string) => T | Promise<T>,
  lookup: (identity: Body, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<T | undefined> {
  const inbox = await lookup(identity, env, signal);
  if (signal?.aborted) return undefined;
  const pending = await projectBoundaryEligibility(inbox);
  if (pending.length === 0 || signal?.aborted) return undefined;
  const delivered = renderBoundary(pending);
  if (delivered.context === '') return undefined;
  let result: T | undefined;
  let rendered = false;
  const renderOnce = async () => { if (!rendered) { rendered = true; result = await present(delivered.context); } };
  for (const entry of delivered.complete) {
    let square: OpenSquare | undefined;
    try {
      try { square = await openSquare(entry.membership.location, { signal }); } catch { continue; }
      for (const index of entry.actIndexes) {
        const key = pendingKey(entry.membership, index);
        const prior = presentationLocks.get(key);
        if (prior !== undefined) { await awaitWithSignal(prior, signal); if (signal?.aborted) return undefined; if (!rendered) return undefined; continue; }
        const work = presentPending({ artifact: square.artifact, location: entry.membership.location, participant: entry.membership.seat.participant, activity: index, seat: entry.membership.seat, sink: { present: renderOnce }, markSeen: entry.markSeen, now: Date.now(), signal }).then(async (outcome) => {
          // A stale projection can outlive its activity; still surface the bounded preview,
          // but there is no artifact observation to commit.
          if (!outcome.presented) {
            const exists = await square!.artifact.read((facts) => facts.activity(index) !== undefined, signal).catch(() => undefined);
            if (exists?.value === false) await renderOnce();
          }
        });
        presentationLocks.set(key, work);
        try { await work; } finally { presentationLocks.delete(key); }
        if (!rendered) return undefined;
      }
    } finally {
      if (square !== undefined) await closeOpenSquare(square);
    }
  }
  return result;
}

/**
 * Serialize a boundary across hook processes so one stale inbox cannot render twice.
 *
 * `lookup` returns the session's memberships for this boundary. It may reuse an observation it has
 * verified against the current presence binding and artifact revision; the boundary still projects
 * presentation evidence live, and `presentPending` still re-checks the pending head, join, ownership
 * claim and seen CAS. A source that cannot verify its reuse must read the inbox again.
 */
export async function presentPendingAtBoundary<T>(
  identity: Body,
  present: (context: string) => T | Promise<T>,
  lookup: (identity: Body, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const indexPath = squareIndexPath(env);
  const ownerKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return withFileLock(`${indexPath}.boundary-${ownerKey}.lock`, { retryMs: 10, signal }, () =>
    presentPendingAtBoundaryUnlocked(identity, present, lookup, env, signal));
}
