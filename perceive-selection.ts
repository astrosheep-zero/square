import { sameName } from './model.js';
import { audienceIncludes, type Audience } from './square-core.js';

/** Pure filter over settled audience facts; unread/directed eligibility and paging belong to callers. */
export function matchesPerceiveSelection(
  actor: string,
  audience: Audience,
  filter: { readonly participants?: readonly string[]; readonly mention?: string },
  replyAuthor?: string,
): boolean {
  if (filter.participants !== undefined && !filter.participants.some((participant) => sameName(participant, actor))) {
    return false;
  }
  if (filter.mention === undefined) return true;
  // A reply is directed attention in its own right: the viewer is reached as the
  // author of the activity they answered, exactly like a mention.
  return audienceIncludes(audience, filter.mention)
    || (replyAuthor !== undefined && sameName(replyAuthor, filter.mention));
}

/** One directed arrival and the upper reason it reached its recipient. */
export interface RoutedNotification {
  readonly actor: string;
  readonly route: import('./model.js').DirectedNotificationRoute;
  readonly recipient: string;
}

/** A live perceive owns every matching notification, independent of its page size. */
export function leaseOwnsNotification(lease: import('./model.js').WatchLease, notification: RoutedNotification): boolean {
  return matchesPerceiveSelection(notification.actor, notification.route === 'bell' ? { kind: 'bell' }
    : { kind: 'mentions', names: notification.route === 'mention' ? [notification.recipient] : [] }, lease.filter ?? {},
  notification.route === 'reply' ? notification.recipient : undefined);
}
