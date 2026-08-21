import { type InboxMembership } from './model.js';
import { lookupSessionBindings } from './registry.js';
import { openFileApplication } from './square-file-adapter.js';

export async function sessionInbox(sessionId: string): Promise<InboxMembership[]> {
  const inbox: InboxMembership[] = [];
  for (const binding of lookupSessionBindings(sessionId)) {
    let application;
    try {
      application = await openFileApplication(binding.squarePath);
      const projection = await application.inboxProjection(binding.name, binding.ownerId);
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
      await application?.close();
    }
  }
  return inbox;
}
