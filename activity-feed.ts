import { sameName, type StoredAct, type SquareDoc, type PublicAct, type RoomChangeAct } from './model.js';
import { advanceCursor, latestActIndex, readCursor } from './runtime.js';
import { deriveDeliveryModel, matchesCatchFilter } from './delivery.js';

export interface ActivityFeedFilter {
  participants?: string[];
  mention?: string;
}

export function actDelta(acts: StoredAct[], cursor: number): StoredAct[] {
  return acts.filter((act) => act.index > cursor);
}

/** Public cursor changes plus directed receipts that remain pending behind it. */
export function deliveryDelta(doc: SquareDoc, name: string): StoredAct[] {
  const items = actDelta(doc.acts, readCursor(doc, name));
  const seen = new Set(items.map((act) => act.index));
  for (const notification of deriveDeliveryModel(doc).pendingFor(name)) {
    if (!seen.has(notification.item.index)) items.push(notification.item);
  }
  return items.sort((a, b) => a.index - b.index);
}

export function peerRoomChanges(delta: StoredAct[], name: string): RoomChangeAct[] {
  return delta.filter((act): act is RoomChangeAct => act.actor !== undefined && !sameName(act.actor, name) && act.kind !== 'say' && act.kind !== 'read');
}

export function peerPublicActs(delta: StoredAct[], name: string): PublicAct[] {
  return delta.filter((act): act is PublicAct => act.actor !== undefined && !sameName(act.actor, name) && (act.kind === 'say' || act.kind === 'done'));
}

function matchesParticipants(act: StoredAct, participants: string[] | undefined): boolean {
  return participants === undefined || (act.actor !== undefined && participants.some((participant) => sameName(participant, act.actor!)));
}

export function matchesFeedFilter(act: StoredAct, filter: ActivityFeedFilter): boolean {
  if (act.kind === 'say') {
    return matchesCatchFilter(
      { actor: act.actor, body: act.body, reach: act.reach },
      filter
    );
  }
  return filter.mention === undefined && matchesParticipants(act, filter.participants);
}

export function filteredPeerActivities(delta: StoredAct[], name: string, filter: ActivityFeedFilter): PublicAct[] {
  return peerPublicActs(delta, name)
    .filter((act) => act.kind === 'say')
    .filter((act) => matchesFeedFilter(act, filter));
}

export function filteredRoomChanges(delta: StoredAct[], name: string, filter: ActivityFeedFilter): RoomChangeAct[] {
  if (filter.mention !== undefined) return [];
  return peerRoomChanges(delta, name).filter((act) => matchesParticipants(act, filter.participants));
}

export function ackPeerDelta(doc: SquareDoc, name: string, delta: StoredAct[]): boolean {
  return advanceCursor(doc, name, latestActIndex([...peerPublicActs(delta, name), ...peerRoomChanges(delta, name)]));
}
