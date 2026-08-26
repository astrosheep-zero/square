import { leaseOwnsNotification } from './delivery.js';
import { markBoundarySeen } from './square-wiring.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { ATTENTION_BODY_MAX, renderAttentionPreview } from './attention-presentation.js';
import { presentOnce, presentOnceAsync } from './presented.js';

const CONTEXT_MAX = 1200;

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
    if (notification.body.replace(/\r\n/g, '\n').length <= ATTENTION_BODY_MAX) {
      complete.push({ membership, actIndexes: [notification.actIndex] });
    }
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
  present: (context: string) => T,
  lookup: (sessionId: string) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): Promise<T | undefined> {
  const inbox = await lookup(sessionId);
  let delivered: BoundaryRender | undefined;
  const result = presentOnce(
    sessionId,
    () => pendingAtBoundary(inbox),
    (inbox) => {
      delivered = renderBoundary(inbox);
      return present(delivered.context);
    },
    env
  );
  if (result !== undefined && delivered !== undefined) {
    for (const entry of delivered.complete) {
      await markBoundarySeen(
        entry.membership.squarePath,
        entry.membership.name,
        entry.membership.ownerId,
        entry.actIndexes,
      );
    }
  }
  return result;
}

/** Async counterpart used by native adapters that acknowledge delivery asynchronously. */
export async function presentPendingAtBoundaryAsync<T>(
  sessionId: string,
  present: (context: string) => T | Promise<T>,
  lookup: (sessionId: string) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T | undefined> {
  const inbox = await lookup(sessionId);
  let delivered: BoundaryRender | undefined;
  const result = await presentOnceAsync(
    sessionId,
    () => pendingAtBoundary(inbox),
    async (current) => {
      delivered = renderBoundary(current);
      return present(delivered.context);
    },
    env,
  );
  if (result !== undefined && delivered !== undefined) {
    for (const entry of delivered.complete) {
      await markBoundarySeen(
        entry.membership.squarePath,
        entry.membership.name,
        entry.membership.ownerId,
        entry.actIndexes,
      );
    }
  }
  return result;
}
