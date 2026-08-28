import { leaseOwnsNotification } from './delivery.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { presentPending } from './presentation-operations.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { ATTENTION_BODY_MAX, renderAttentionPreview } from './attention-presentation.js';

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

function renderBoundary(inbox: InboxMembership[]): BoundaryRender {
  const count = pendingCount(inbox);
  const noun = count === 1 ? 'notification' : 'notifications';
  const header = `<system-reminder source="square">You have ${count} unread Square ${noun}.`;
  const footer = ['Read and respond in the square when appropriate.</system-reminder>'];
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
    const prospective = [
      header,
      ...blocks,
      block,
      ...(omittedAfter > 0
        ? [`… ${omittedAfter} unread ${omittedAfter === 1 ? 'notification' : 'notifications'} omitted.`]
        : []),
      ...footer,
    ].join('\n');
    if (prospective.length > CONTEXT_MAX) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
    complete.push({
      membership,
      actIndexes: [notification.actIndex],
      markSeen: notification.body.replace(/\r\n/g, '\n').length <= ATTENTION_BODY_MAX,
    });
  }

  return {
    context: [
      header,
      ...blocks,
      ...(omitted > 0
        ? [`… ${omitted} unread ${omitted === 1 ? 'notification' : 'notifications'} omitted.`]
        : []),
      ...footer,
    ].join('\n'),
    complete,
  };
}

export async function presentPendingAtBoundary<T>(
  sessionId: string,
  present: (context: string) => T | Promise<T>,
  lookup: (sessionId: string, env?: NodeJS.ProcessEnv) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal
): Promise<T | undefined> {
  const inbox = await lookup(sessionId, env);
  if (signal?.aborted) return undefined;
  const delivered = renderBoundary(pendingAtBoundary(inbox));
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
        if (prior !== undefined) { await prior; continue; }
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
      }
    } finally {
      if (square !== undefined) await closeOpenSquare(square);
    }
  }
  return result;
}
