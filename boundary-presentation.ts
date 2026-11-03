import { squareIndexPath } from './square-index.js';
import { createHash } from 'node:crypto';

import { withFileLock } from './file-lock.js';
import { createArtifactPort } from './artifact.js';
import { preparePendingPresentation } from './presentation-operations.js';
import { presentPreparedBatch } from './delivery-effects.js';
import { sessionInbox, projectBoundaryEligibility, pendingKey } from './inbox.js';
import type { Owner, PendingMembership } from './model.js';
import type { SquareArtifactPort } from './ports.js';
import { projectChannelNotification, projectNotification, renderSquareReminder } from './attention-presentation.js';
import { decodeHarnessOwner } from './owner.js';
import { deliveryAddress } from './channel-delivery.js';

const CONTEXT_MAX = 1200;

export function renderPendingAtBoundary(inbox: PendingMembership[]): string {
  return renderBoundary(inbox).context;
}

interface BoundaryEntry {
  membership: PendingMembership;
  messageIndex: number;
  markSeen: boolean;
}

interface BoundaryRender {
  context: string;
  entries: BoundaryEntry[];
}

function renderBoundary(inbox: PendingMembership[]): BoundaryRender {
  const queued = inbox.flatMap((membership) =>
    membership.notifications.map((notification) => ({ membership, notification }))
  );
  const blocks: string[] = [];
  const agoraBlocks: string[] = [];
  let remainingAgora = queued.filter(({ notification }) => notification.route !== undefined).length;
  const entries: BoundaryEntry[] = [];
  let omitted = 0;
  const omission = (count: number) => `${count} more ${count === 1 ? 'activity' : 'activities'} not shown.`;

  for (const entry of queued) {
    const { membership, notification } = entry;
    // The omission line represents the rest of this batch too, but never consumes its bodies.
    const coverage = { membership, messageIndex: notification.messageIndex, markSeen: false };
    entries.push(coverage);
    const projected = notification.route === undefined
      ? projectChannelNotification({ squarePath: membership.location, recipient: membership.seat.participant,
          actor: notification.actor, body: notification.body, ...(notification.preview === undefined ? {} : { preview: notification.preview }) })
      : projectNotification({ squarePath: membership.location, actIndex: notification.actIndex ?? notification.messageIndex,
          recipient: membership.seat.participant, actor: notification.actor, route: notification.route,
          body: notification.body, ...(notification.preview === undefined ? {} : { preview: notification.preview }) });
    const block = projected.text;
    if ('agora' in projected && projected.agora) {
      remainingAgora -= 1;
      const omittedAfter = omitted + remainingAgora;
      const prospective = renderSquareReminder([...agoraBlocks, block, ...(omittedAfter > 0 ? [omission(omittedAfter)] : [])]);
      if (prospective.length > CONTEXT_MAX) {
        omitted += 1;
        continue;
      }
      agoraBlocks.push(block);
    }
    blocks.push(block);
    coverage.markSeen = !projected.clipped;
  }

  return {
    context: renderSquareReminder([...blocks, ...(omitted > 0 ? [omission(omitted)] : [])]),
    entries,
  };
}

async function presentPendingAtBoundaryUnlocked<T>(
  identity: Owner,
  present: (context: string, delivered: PendingMembership[]) => T | Promise<T>,
  lookup: (identity: Owner, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<T | undefined> {
  const inbox = await lookup(identity, env, signal);
  if (signal?.aborted) return undefined;
  const pending = await projectBoundaryEligibility(inbox);
  if (pending.length === 0 || signal?.aborted) return undefined;
  const piObserver = decodeHarnessOwner(identity)?.channel === 'pi';
  const artifacts = new Map<string, SquareArtifactPort>();
  const claims: { key: string; claim: NonNullable<Awaited<ReturnType<typeof preparePendingPresentation>>> }[] = [];
  try {
    try {
      // Enumeration owns discovery/connections only; returned handles belong to the common runner.
      for (const entry of renderBoundary(pending).entries) {
        const { location, seat } = entry.membership;
        let artifact = artifacts.get(location);
        if (artifact === undefined) {
          // Keep connections alive through all signal-independent settlement/cleanup.
          artifact = createArtifactPort(location);
          artifacts.set(location, artifact);
        }
        const claim = await preparePendingPresentation({ artifact, location, participant: seat.participant,
          message: entry.messageIndex, seat, markSeen: entry.markSeen,
          ...(piObserver ? { current: facts => deliveryAddress(facts.channel.endpoint(seat.participant)) === undefined } : {}), signal });
        if (claim !== undefined) claims.push({ key: pendingKey(entry.membership, entry.messageIndex), claim });
      }
    } catch (error) {
      // Transfer has not happened: enumeration must abandon any custody already acquired.
      await Promise.all(claims.map(({ claim }) => claim.release()));
      throw error;
    }
    const report = await presentPreparedBatch(claims.map(({ claim }) => claim), eligibleClaims => {
      const eligible = new Set(claims.filter(({ claim }) => eligibleClaims.includes(claim)).map(({ key }) => key));
      const delivered = pending.map(membership => ({ ...membership,
        notifications: membership.notifications.filter(note => eligible.has(pendingKey(membership, note.messageIndex))),
      })).filter(membership => membership.notifications.length > 0);
      return { payload: { context: renderBoundary(delivered).context, delivered }, included: eligibleClaims };
    }, payload => present(payload.context, payload.delivered), { signal });
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
 * after success, captured-seat commits record the winning batch, including budget omissions as
 * clipped (no consumption receipt), without an eligibility veto. Coverage is conservative if a
 * competing claim's removal lets a previously omitted body fit in the final preview.
 * A source that cannot verify its reuse must read the inbox again.
 */
export async function presentPendingAtBoundary<T>(
  identity: Owner,
  present: (context: string, delivered: PendingMembership[]) => T | Promise<T>,
  lookup: (identity: Owner, env?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<PendingMembership[]> | PendingMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const indexPath = squareIndexPath(env);
  const ownerKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return withFileLock(`${indexPath}.boundary-${ownerKey}.lock`, { retryMs: 10, signal }, () =>
    presentPendingAtBoundaryUnlocked(identity, present, lookup, env, signal));
}
