// Shared model and constants for Square.

import type { Act, ActivityId } from './square-core.js';
export { formatActivityId, parseActivityId } from './square-core.js';
export type { Act, ActivityId, Audience, Reach } from './square-core.js';

export const WAKE_ROUTE_KINDS = ['opencode-server', 'codex-queue', 'claude-native', 'paseo'] as const;
export type WakeRouteKind = typeof WAKE_ROUTE_KINDS[number];

export function isWakeRouteKind(value: unknown): value is WakeRouteKind {
  return typeof value === 'string' && (WAKE_ROUTE_KINDS as readonly string[]).includes(value);
}

export interface WakeRoute {
  /** Ownership generation, when the receiver publishes a fenced route. */
  epoch?: number;
  location: string;
  participant: string;
  sessionId: string;
  channel: string;
  kind: WakeRouteKind;
  address: Record<string, string>;
  updatedAt: number;
}

export type SquareErrorCode =
  | 'invalid_name'
  | 'invalid_args'
  | 'unknown_participant'
  | 'not_joined'
  | 'already_joined'
  | 'already_done'
  | 'held'
  | 'capped'
  | 'throttled'
  | 'bell_quota'
  | 'behind'
  | 'io'
  | 'unavailable';

export type InternalSquareErrorCode = SquareErrorCode
  | 'not_found'
  | 'cap_reached'
  | 'conflict'
  | 'pending_peer';

export interface SquareErrorFacts {
  /** Express admission rejected before any activity was committed. */
  activityUnsent?: true;
  /** Refusal reason, including absent participants, conflicting reach, and inaccessible activities. */
  reason?: 'never_joined' | 'not_standing' | 'bell_mention_conflict' | 'not_addressed' | 'migration_required' | 'explicit_reach_required' | 'invalid_reply' | 'invalid_done_body';
  /** The activity id a `catch --id` refusal named. */
  activityId?: string;
  /** Requested recipient spellings, without parsing presentation copy. */
  targets?: readonly string[];
  /** Whether the artifact holds that activity at all; an unknown id needs an ordinary page. */
  activityExists?: boolean;
  pending?: number;
  holder?: string;
  holdReason?: string;
  retryAfterMs?: number;
}

class SquareErrorBase<Code extends string> extends Error {
  operation?: import('./square-facade.js').ApplicationFailureDetail;
  constructor(
    public code: Code,
    message: string,
    public facts?: SquareErrorFacts
  ) {
    super(message);
    this.name = 'SquareError';
  }
}

export class SquareError extends SquareErrorBase<SquareErrorCode> {}
export class InternalSquareError extends SquareErrorBase<InternalSquareErrorCode> {}

export function isSquareError(error: unknown): error is SquareError | InternalSquareError {
  return error instanceof SquareError || error instanceof InternalSquareError;
}

export type HardCap = number | null;

export interface BuildOptions {
  force: boolean;
  hardCap?: HardCap;
  template?: string;
  throttlePerMinute?: number;
}

export type StoredAct = Act & { index: number; at: number };

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

export type DirectedNotificationRoute = 'mention' | 'reply' | 'attention' | 'bell';

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

export interface WatchOptions {
  id?: ActivityId;
  participants?: string[];
  mention?: string;
  limit?: number;
  idleMs?: number;
  replace?: boolean;
  now?: boolean;
}

export type PublicAct = Extract<StoredAct, { kind: 'say' | 'done' }>;
export type RoomChangeAct = Extract<StoredAct, { kind: 'join' | 'done' | 'hold' | 'resume' | 'listen' | 'ignore' }>;

export function formatHardCap(hardCap: HardCap): string {
  return hardCap === null ? '-1' : String(hardCap);
}

export function parseParticipantList(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

export function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

export function sameName(a: string, b: string): boolean {
  return nameKey(a) === nameKey(b);
}

const TEXT_NAME_GRAPHEME_SOURCE = String.raw`[[\p{L}\p{N}\p{M}_\x2D]--[\p{Variation_Selector}]]`;
/** One name grapheme: Unicode letters, digits, marks, hyphens, or underscores (no isolated variation selectors), or a complete RGI emoji. Shared by name validation and body @mention scanning. */
export const NAME_GRAPHEME_SOURCE = String.raw`${TEXT_NAME_GRAPHEME_SOURCE}|\p{RGI_Emoji}`;

// Ordinary Unicode names need not trigger the full RGI emoji matcher’s cold compilation.
const TEXT_NAME_PATTERN = new RegExp(`^(?:${TEXT_NAME_GRAPHEME_SOURCE})+(?:/(?:${TEXT_NAME_GRAPHEME_SOURCE})+)*$`, 'v');
const NAME_PATTERN = new RegExp(`^(?:${NAME_GRAPHEME_SOURCE})+(?:/(?:${NAME_GRAPHEME_SOURCE})+)*$`, 'v');

export function validateName(name: string): void {
  if (!name || (!TEXT_NAME_PATTERN.test(name) && !NAME_PATTERN.test(name))) {
    throw new SquareError('invalid_name', 'Invalid name: names must contain non-empty slash-separated segments using Unicode letters, digits, marks, hyphens, underscores, or complete RGI emoji graphemes.');
  }
}
