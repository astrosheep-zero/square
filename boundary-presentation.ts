import { leaseOwnsNotification, notificationMessageId } from './delivery.js';
import { sessionInbox } from './inbox.js';
import type { InboxMembership } from './model.js';
import { participantCommandPrefix, participantIdentity } from './presentation.js';
import { presentOnce } from './presented.js';

const BODY_MAX = 200;
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
          (notification) => !leaseOwnsNotification(lease, notification)
        ),
      };
    })
    .filter((membership) => membership.notifications.length > 0);
}

function bodyPreview(body: string): string {
  const compact = body.replace(/\r\n/g, '\n');
  if (compact.length <= BODY_MAX) return compact;
  return `${compact.slice(0, BODY_MAX).trimEnd()}\n… [truncated; run catch --now]`;
}

export function renderPendingAtBoundary(inbox: InboxMembership[]): string {
  const count = pendingCount(inbox);
  const noun = count === 1 ? 'notification' : 'notifications';
  const header = `<system-reminder source="square">You have ${count} unread Square ${noun}.`;
  const footer = [
    'Ids are stable across boundaries. If you already acted on an id, do not repeat the action; still run catch --now to mark delivered.',
    'Read and respond in the square when appropriate.</system-reminder>',
  ];
  const queued = inbox.flatMap((membership) =>
    membership.notifications.map((notification) => ({ membership, notification }))
  );
  const blocks: string[] = [];
  let omitted = 0;

  for (const [index, entry] of queued.entries()) {
    const { membership, notification } = entry;
    const command = `${participantCommandPrefix(membership.squarePath, membership.name)} catch --now`;
    const id = notificationMessageId(membership.squarePath, notification.actIndex);
    const block = [
      `${id} · ${membership.squarePath}: ${participantIdentity(membership.name)} from ${participantIdentity(notification.actor)} (${notification.route})`,
      bodyPreview(notification.body),
      `Ack with: ${command}`,
    ].join('\n');
    const omittedAfter = omitted + queued.length - index - 1;
    const prospective = [
      header,
      ...blocks,
      block,
      ...(omittedAfter > 0
        ? [`… ${omittedAfter} unread ${omittedAfter === 1 ? 'notification' : 'notifications'} omitted. Run catch --now to receive them.`]
        : []),
      ...footer,
    ].join('\n');
    if (prospective.length > CONTEXT_MAX) {
      omitted += 1;
      continue;
    }
    blocks.push(block);
  }

  return [
    header,
    ...blocks,
    ...(omitted > 0
      ? [`… ${omitted} unread ${omitted === 1 ? 'notification' : 'notifications'} omitted. Run catch --now to receive them.`]
      : []),
    ...footer,
  ].join('\n');
}

export async function presentPendingAtBoundary<T>(
  sessionId: string,
  present: (context: string) => T,
  lookup: (sessionId: string) => Promise<InboxMembership[]> | InboxMembership[] = sessionInbox,
  env: NodeJS.ProcessEnv = process.env
): Promise<T | undefined> {
  const inbox = await lookup(sessionId);
  return presentOnce(
    sessionId,
    () => pendingAtBoundary(inbox),
    (inbox) => present(renderPendingAtBoundary(inbox)),
    env
  );
}
