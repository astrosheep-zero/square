// Shared model and constants for Square.

import type { Act, ActivityId } from './square-core.js';
import type { EndpointGeneration } from './message.js';
import type { Owner } from './neutral.js';
import type { MessageMetadata as ActivityMetadata, WakeAddress } from './channel-values.js';
export { WAKE_ROUTE_KINDS, MESSAGE_METADATA_MAX_BYTES as ACTIVITY_METADATA_MAX_BYTES, MESSAGE_METADATA_MAX_DEPTH as ACTIVITY_METADATA_MAX_DEPTH, validateMessageMetadata as validateActivityMetadata, messageMetadataHasContent as activityMetadataHasContent, isWakeRouteKind, sameName, NAME_GRAPHEME_SOURCE, validateName } from './channel-values.js';
export type { WakeRouteKind, JsonValue, MessageMetadata as ActivityMetadata, WakeAddress, WakeRoute } from './channel-values.js';
export { SquareErrorBase, SquareError, InternalSquareError, isSquareError, validateOwner, nameKey } from './neutral.js';
export type { Owner, SquareErrorCode, InternalSquareErrorCode, SquareErrorFacts } from './neutral.js';
export type { Act, ActivityId, Audience, Reach } from './square-core.js';

/** Artifact-owned custody binding. Generation is the join activity that established it. */
export interface Seat {
  readonly participant: string;
  readonly owner: Owner;
  readonly generation: EndpointGeneration;
  readonly attachment: 'attached' | 'detached';
  readonly wakeAddress?: WakeAddress;
}

export interface SeatWatchLease {
  readonly generation: ActivityId;
  readonly lease: WatchLease;
}

export type HardCap = number | null;

export interface BuildOptions {
  force: boolean;
  hardCap?: HardCap;
  template?: string;
  throttlePerMinute?: number;
}

/** An upper publication draft: content and social facts before any index exists. */
export type ActDraft = Act & { at: number };
/** Persisted say: identity and social facts only. Its content lives in the linked Channel message. */
export type SayRelation = Omit<Extract<Act, { kind: 'say' }>, 'body' | 'metadata'> & {
  index: number;
  at: number;
  messageIndex: number;
};
/** A landed upper activity. A say is a relation; it carries no content of its own. */
export type StoredAct = Extract<Act, { kind: 'join' | 'done' | 'read' | 'listen' | 'ignore' | 'unlisten' }> & { index: number; at: number } | SayRelation;
/** Explicit upper projection: a stored say resolved against its authoritative message. */
export type HydratedAct = Exclude<StoredAct, SayRelation> | SayRelation & { body?: string; metadata?: ActivityMetadata };

export type ObservationState = 'seen';

export interface ActivityObservation {
  state: ObservationState;
  at: number;
}

export interface WatchLeaseFilter {
  participants?: string[];
  mention?: string;
}

export interface WatchLease {
  leaseId: string;
  heartbeatAt: number;
  expiresAt: number;
  filter?: WatchLeaseFilter;
}

export type DirectedNotificationRoute = import('./attention.js').AudienceRoute;

export interface InboxNotification {
  /** Lower message coordinate. */
  messageIndex: number;
  /** Upper Agora activity sharing this message, when one exists. */
  actIndex?: number;
  actor: string;
  at: number;
  route?: DirectedNotificationRoute;
  body: string;
  readonly preview?: string;
  readonly description?: string;
  readonly coverage?: 'full' | 'clipped';
}

/** The one stored-content-to-notification field mapping used by inbox and native previews. */
export function notificationFacts(item: HydratedAct, route: DirectedNotificationRoute): InboxNotification {
  if (item.kind !== 'say' || item.messageIndex === undefined) throw new Error(`Activity ${item.index} is not conversation content.`);
  return { messageIndex: item.messageIndex, actIndex: item.index, actor: item.actor, at: item.at, route, body: item.body ?? '(structured activity)' };
}

export interface LocatedSeat {
  readonly location: string;
  readonly seat: Seat;
  readonly joinedAt: number;
}

export interface PendingMembership extends LocatedSeat {
  readonly notifications: InboxNotification[];
  readonly catchLease?: WatchLease;
  readonly deliveryDeferralExpiry?: number;
}

export interface WatchOptions {
  participants?: string[];
  mention?: string;
  replace?: boolean;
}

export type PublicAct = Extract<HydratedAct, { kind: 'say' | 'done' }>;
export type RoomChangeAct = Extract<HydratedAct, { kind: 'join' | 'done' | 'listen' | 'ignore' | 'unlisten' }>;

export function formatHardCap(hardCap: HardCap): string {
  return hardCap === null ? '-1' : String(hardCap);
}

export function parseParticipantList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}
