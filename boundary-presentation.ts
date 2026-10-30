import { squareIndexPath } from './square-index.js';
import { createHash } from 'node:crypto';

import { withFileLock } from './file-lock.js';
import { createArtifactPort } from './artifact.js';
import { preparePendingPresentation } from './presentation-operations.js';
import { presentPreparedBatch } from './delivery-effects.js';
import { sessionInbox, projectBoundaryEligibility, pendingAtBoundary, pendingKey } from './inbox.js';
import type { Owner, PendingMembership } from './model.js';
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
  identity: Owner,
  present: (context: string) => T | Promise<T>,
  lookup: (identity: Owner, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
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
    try {
      // Enumeration owns discovery/connections only; returned handles belong to the common runner.
      for (const entry of renderBoundary(pending).complete) {
        const { location, seat } = entry.membership;
        let artifact = artifacts.get(location);
        if (artifact === undefined) {
          // Keep connections alive through all signal-independent settlement/cleanup.
          artifact = createArtifactPort(location);
          artifacts.set(location, artifact);
        }
        for (const index of entry.actIndexes) {
          const claim = await preparePendingPresentation({ artifact, location, participant: seat.participant,
            activity: index, seat, markSeen: entry.markSeen, signal });
          if (claim !== undefined) claims.push({ key: pendingKey(entry.membership, index), claim });
        }
      }
    } catch (error) {
      // Transfer has not happened: enumeration must abandon any custody already acquired.
      await Promise.all(claims.map(({ claim }) => claim.release()));
      throw error;
    }
    const report = await presentPreparedBatch(claims.map(({ claim }) => claim), eligibleClaims => {
      const eligible = new Set(claims.filter(({ claim }) => eligibleClaims.includes(claim)).map(({ key }) => key));
      const fresh = renderBoundary(pending.map(membership => ({ ...membership,
        notifications: membership.notifications.filter(note => eligible.has(pendingKey(membership, note.actIndex))),
      })));
      const included = new Set(fresh.complete.flatMap(entry => entry.actIndexes.map(index => pendingKey(entry.membership, index))));
      return { payload: fresh.context, included: claims.filter(({ key }) => included.has(key)).map(({ claim }) => claim) };
    }, present, { signal, classifyError: () => 'failed' });
    if (report.observation.kind === 'threw') throw report.observation.error;
    for (const { result } of report.settlements) if (result.persistence.status === 'error') throw result.persistence.error;
    return report.observation.kind === 'returned' ? report.observation.value : undefined;
  } finally {
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
  identity: Owner,
  present: (context: string) => T | Promise<T>,
  lookup: (identity: Owner, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const indexPath = squareIndexPath(env);
  const ownerKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return withFileLock(`${indexPath}.boundary-${ownerKey}.lock`, { retryMs: 10, signal }, () =>
    presentPendingAtBoundaryUnlocked(identity, present, lookup, env, signal));
}
