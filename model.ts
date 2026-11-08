// Shared model and constants for Square.

import type { Act, ActivityId } from './square-core.js';
import type { Owner } from './neutral.js';
import type { WakeAddress } from './square-values.js';
export { WAKE_ROUTE_KINDS, MESSAGE_METADATA_MAX_BYTES as ACTIVITY_METADATA_MAX_BYTES, MESSAGE_METADATA_MAX_DEPTH as ACTIVITY_METADATA_MAX_DEPTH, validateMessageMetadata as validateActivityMetadata, messageMetadataHasContent as activityMetadataHasContent, isWakeRouteKind, sameName, NAME_GRAPHEME_SOURCE, validateName } from './square-values.js';
export type { WakeRouteKind, JsonValue, MessageMetadata as ActivityMetadata, WakeAddress, WakeRoute } from './square-values.js';
export { SquareErrorBase, SquareError, InternalSquareError, isSquareError, validateOwner, nameKey } from './neutral.js';
export type { Owner, SquareErrorCode, InternalSquareErrorCode, SquareErrorFacts } from './neutral.js';
export type { Act, ActivityId, Audience, Reach } from './square-core.js';

/** Artifact-owned custody binding. Generation is the join activity that established it. */
export interface Seat {
  readonly participant: string;
  readonly owner: Owner;
  readonly generation: string;
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
/** A landed activity owns its content and social facts. */
export type StoredAct = Act & { index: number; at: number };
export type HydratedAct = StoredAct;

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

export interface WatchOptions {
  participants?: string[];
  mention?: string;
  takeover?: boolean;
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
