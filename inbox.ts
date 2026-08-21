import { type InboxMembership } from './model.js';
import { lookupSessionBindings } from './registry.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { inboxProjection } from './views.js';

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
