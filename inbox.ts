import { loadSquare } from './artifact.js';
import { deriveDeliveryModel, type DirectedNotificationRoute } from './delivery.js';
import { lookupSessionBindings } from './registry.js';
import { freshWatchLease, isCurrentlyJoined, resolveRosterName } from './runtime.js';
import type { WatchLease } from './model.js';

export interface InboxNotification {
  actIndex: number;
  actor: string;
  at: number;
  route: DirectedNotificationRoute;
  body: string;
}

export interface InboxMembership {
  name: string;
  squarePath: string;
  notifications: InboxNotification[];
  catchLease?: WatchLease;
}

export function sessionInbox(sessionId: string): InboxMembership[] {
  const inbox: InboxMembership[] = [];
  for (const binding of lookupSessionBindings(sessionId)) {
    try {
      const doc = loadSquare(binding.squarePath);
      const name = resolveRosterName(doc, binding.name);
      if (!name || !isCurrentlyJoined(doc.acts, name)) continue;
      const notifications = deriveDeliveryModel(doc).pendingFor(name).map(({ item, route }) => ({
        actIndex: item.index,
        actor: item.actor,
        at: item.at,
        route,
        body: item.body,
      }));
      const lease = freshWatchLease(doc, name);
      const catchLease = lease?.ownerId === binding.ownerId ? lease : undefined;
      inbox.push({
        name,
        squarePath: binding.squarePath,
        notifications,
        ...(catchLease !== undefined ? { catchLease } : {}),
      });
    } catch {
      // A stale discovery-cache row only disables delivery for that membership.
    }
  }
  return inbox;
}
