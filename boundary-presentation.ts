import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { leaseOwnsNotification } from './delivery.js';
import { withFileLock } from './file-lock.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { presentPending } from './presentation-operations.js';
import { hostLedgerForEnv, sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { attentionBodyIsClipped, renderAttentionPreview } from './attention-presentation.js';
import { presentationSuppressesWake, projectPresentationEvidence } from './square-projections.js';
import { formatActivityId } from './square-core.js';

const CONTEXT_MAX = 1200;
const presentationLocks = new Map<string, Promise<void>>();

function pendingCount(inbox: InboxMembership[]): number {
  return inbox.reduce((total, membership) => total + membership.notifications.length, 0);
}

/** A fresh blocking catch owns only the notifications admitted by its filter. */
export function pendingAtBoundary(inbox: InboxMembership[]): InboxMembership[] {
  return inbox
    .map((membership) => {
      const lease = membership.catchLease;
      if (lease === undefined) return membership;
      return {
        ...membership,
        notifications: membership.notifications.filter(
          (notification) => !leaseOwnsNotification(lease, { ...notification, recipient: membership.name })
        ),
      };
    })
    .filter((membership) => membership.notifications.length > 0);
}

export function renderPendingAtBoundary(inbox: InboxMembership[]): string {
  return renderBoundary(inbox).context;
}

interface CompleteBoundaryMembership {
  membership: InboxMembership;
  actIndexes: number[];
  markSeen: boolean;
}

interface BoundaryRender {
  context: string;
  complete: CompleteBoundaryMembership[];
}

function frameBoundary(lines: readonly string[]): string {
  return `\n${lines.join('\n')}\n`;
}

function renderBoundary(inbox: InboxMembership[]): BoundaryRender {
  const queued = inbox.flatMap((membership) =>
    membership.notifications.map((notification) => ({ membership, notification }))
  );
  const blocks: string[] = [];
  const complete: CompleteBoundaryMembership[] = [];
  let omitted = 0;

  for (const [index, entry] of queued.entries()) {
    const { membership, notification } = entry;
    const block = [
      renderAttentionPreview({
        squarePath: membership.squarePath,
        actIndex: notification.actIndex,
        recipient: membership.name,
        actor: notification.actor,
        route: notification.route,
        body: notification.body,
      }),
    ].join('\n');
    const omittedAfter = omitted + queued.length - index - 1;
    const prospective = frameBoundary([...blocks, block, ...(omittedAfter > 0 ? [`… ${omittedAfter} ${omittedAfter === 1 ? 'notification' : 'notifications'} omitted.`] : [])]);
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
    context: frameBoundary([...blocks, ...(omitted > 0 ? [`… ${omitted} ${omitted === 1 ? 'notification' : 'notifications'} omitted.`] : [])]),
    complete,
  };
}

async function presentPendingAtBoundaryUnlocked<T>(
  sessionId: string,
  present: (context: string) => T | Promise<T>,
  lookup: (sessionId: string, env?: NodeJS.ProcessEnv) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<T | undefined> {
  const inbox = await lookup(sessionId, env);
  if (signal?.aborted) return undefined;
  const hostLedger = hostLedgerForEnv(env);
  const pending: InboxMembership[] = [];
  for (const membership of pendingAtBoundary(inbox)) {
    const evidence = await projectPresentationEvidence({ hostLedger, location: membership.squarePath, participant: membership.name, sessionId });
    const notifications = membership.notifications.filter((notification) => !presentationSuppressesWake(
      evidence.filter((row) => row.activity === formatActivityId(notification.actIndex)),
    ));
    if (notifications.length > 0) pending.push({ ...membership, notifications });
  }
  if (pending.length === 0 || signal?.aborted) return undefined;
  const delivered = renderBoundary(pending);
  if (delivered.context === '') return undefined;
  let result: T | undefined;
  let rendered = false;
  const renderOnce = async () => { if (!rendered) { rendered = true; result = await present(delivered.context); } };
  for (const entry of delivered.complete) {
    let square;
    try {
      try { square = await openSquare(entry.membership.squarePath, { env }); } catch { continue; }
      for (const index of entry.actIndexes) {
        const key = `${entry.membership.squarePath}\u0000${entry.membership.name.toLocaleLowerCase()}\u0000${index}`;
        const prior = presentationLocks.get(key);
        if (prior !== undefined) { await prior; if (!rendered) return undefined; continue; }
        const work = presentPending({ artifact: square.artifact, location: entry.membership.squarePath, participant: entry.membership.name, activity: index, hostLedger: square.hostLedger, session: sessionId, sink: { present: renderOnce }, markSeen: entry.markSeen, now: Date.now() }).then(async (outcome) => {
          // A stale projection can outlive its activity; still surface the bounded preview,
          // but there is no artifact observation to commit.
          if (!outcome.presented) {
            const snapshot = await square!.artifact.read().catch(() => undefined);
            if (snapshot?.state.acts.every((activity: { index: number }) => activity.index !== index)) await renderOnce();
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

/** Serialize a boundary across hook processes so one stale inbox cannot render twice. */
export async function presentPendingAtBoundary<T>(
  sessionId: string,
  present: (context: string) => T | Promise<T>,
  lookup: (sessionId: string, env?: NodeJS.ProcessEnv) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const ledgerRoot = env.SQUARE_HOST_LEDGER_USER
    ?? (env.SQUARE_REGISTRY === undefined ? path.join(os.homedir(), '.square', 'host-ledger') : path.dirname(env.SQUARE_REGISTRY));
  const ownerKey = createHash('sha256').update(sessionId).digest('hex');
  return withFileLock(path.join(ledgerRoot, `presentation-boundary-${ownerKey}.lock`), { retryMs: 10, signal }, () =>
    presentPendingAtBoundaryUnlocked(sessionId, present, lookup, env, signal));
}
