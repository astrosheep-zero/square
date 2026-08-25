import { sameName, type StoredAct, type SquareState, type PublicAct, type RoomChangeAct } from './model.js';
import { landedAudienceIncludes } from './square-core.js';
import { readCursor } from './runtime.js';
import { deriveDeliveryModel, matchesCatchFilter } from './delivery.js';

export interface ActivityFeedFilter {
  participants?: string[];
  mention?: string;
}

export function actDelta(acts: StoredAct[], cursor: number): StoredAct[] {
  return acts.filter((act) => act.index > cursor);
}

/** Visible activities after the participant's derived continuous-seen prefix. */
export function deliveryDelta(squareState: SquareState, name: string): StoredAct[] {
  return actDelta(squareState.acts, readCursor(squareState, name));
}

export function peerRoomChanges(delta: StoredAct[], name: string): RoomChangeAct[] {
  return delta.filter((act): act is RoomChangeAct => act.actor !== undefined && !sameName(act.actor, name) && act.kind !== 'say' && act.kind !== 'read');
}

export function peerPublicActs(delta: StoredAct[], name: string): PublicAct[] {
  return delta.filter((act): act is PublicAct => act.actor !== undefined && !sameName(act.actor, name) && (act.kind === 'say' || act.kind === 'done'));
}

export function directedPeerSays(squareState: SquareState, delta: StoredAct[], name: string): Extract<StoredAct, { kind: 'say' }>[] {
  return delta.filter((act): act is Extract<StoredAct, { kind: 'say' }> => landedAudienceIncludes(squareState.acts, act, name));
}

function matchesParticipants(act: StoredAct, participants: string[] | undefined): boolean {
  return participants === undefined || (act.actor !== undefined && participants.some((participant) => sameName(participant, act.actor!)));
}

export function matchesFeedFilter(act: StoredAct, filter: ActivityFeedFilter, recipients?: readonly string[]): boolean {
  if (act.kind === 'say') {
    return matchesCatchFilter(
      { actor: act.actor, body: act.body, reach: act.reach, ...(recipients === undefined ? {} : { recipients }) },
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
