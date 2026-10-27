import { squareIndexPath } from './square-index.js';
import { createHash } from 'node:crypto';

import { withFileLock } from './file-lock.js';
import { createArtifactPort } from './artifact.js';
import { preparePendingPresentation } from './presentation-operations.js';
import { sessionInbox, projectBoundaryEligibility, pendingAtBoundary, pendingKey } from './inbox.js';
import type { Body, PendingMembership } from './model.js';
import type { SquareArtifactPort } from './ports.js';
import { attentionBodyIsClipped, renderAttentionPreview, renderSquareReminder } from './attention-presentation.js';
export { pendingAtBoundary };

const CONTEXT_MAX = 1200;

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
  const artifacts = new Map<string, SquareArtifactPort>();
  const claims: { key: string; claim: NonNullable<Awaited<ReturnType<typeof preparePendingPresentation>>> }[] = [];
  try {
    // Claim the entire candidate batch before its one external effect. No later item needs
    // a new claim (and new eligibility decision) after its bytes have already been rendered.
    for (const entry of renderBoundary(pending).complete) {
      const { location, seat } = entry.membership;
      let artifact = artifacts.get(location);
      if (artifact === undefined) {
        // This boundary owns the connection until all effect evidence/cleanup has settled.
        // Request cancellation travels with pre-effect operations, not that lifetime.
        artifact = createArtifactPort(location);
        artifacts.set(location, artifact);
      }
      for (const index of entry.actIndexes) {
        const claim = await preparePendingPresentation({ artifact, location, participant: seat.participant,
          activity: index, seat, markSeen: entry.markSeen, signal });
        if (claim !== undefined) claims.push({ key: pendingKey(entry.membership, index), claim });
      }
    }
    const eligible = new Set<string>();
    for (const { key, claim } of claims) if (await claim.eligible()) eligible.add(key);
    const fresh = renderBoundary(pending.map(membership => ({ ...membership,
      notifications: membership.notifications.filter(note => eligible.has(pendingKey(membership, note.actIndex))),
    })));
    const included = new Set(fresh.complete.flatMap(entry => entry.actIndexes.map(index => pendingKey(entry.membership, index))));
    if (included.size === 0 || signal?.aborted) return undefined;
    const rendered = claims.filter(({ key }) => included.has(key));
    let result: T;
    try { result = await present(fresh.context); }
    catch (error) {
      await Promise.all(rendered.map(({ claim }) => claim.release('failed', error instanceof Error ? error.message : String(error))));
      throw error;
    }
    // These are successful sink effects, not fresh delivery attempts. Settle the entire
    // rendered set before closing any connection, even if one member's settlement fails.
    const settlements = await Promise.allSettled(rendered.map(({ claim }) => claim.recordPresented()));
    for (const settlement of settlements) if (settlement.status === 'rejected') throw settlement.reason;
    return result;
  } finally {
    await Promise.all(claims.map(({ claim }) => claim.release()));
    await Promise.all([...artifacts.values()].map(artifact => artifact.close()));
  }
}

/**
 * Serialize a boundary across hook processes so one stale inbox cannot render twice.
 *
 * `lookup` returns the session's memberships for this boundary. It may reuse an observation it has
 * verified against the current presence binding and artifact revision; the boundary still projects
 * presentation evidence live. Every item is claimed and revalidated before the batch sink;
 * after success, captured-seat commits record only its included items without an eligibility veto.
 * A source that cannot verify its reuse must read the inbox again.
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
