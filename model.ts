// Shared model and constants for Square.

import type { Act, ActivityId } from './square-core.js';
export { formatActivityId, parseActivityId } from './square-core.js';
export type { Act, ActivityId, Audience, Reach } from './square-core.js';

export const WAKE_ROUTE_KINDS = ['opencode-server', 'codex-queue', 'claude-native', 'paseo'] as const;
export type WakeRouteKind = typeof WAKE_ROUTE_KINDS[number];

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ActivityMetadata = Readonly<Record<string, JsonValue>>;
export const ACTIVITY_METADATA_MAX_BYTES = 16 * 1024;
export const ACTIVITY_METADATA_MAX_DEPTH = 256;

/** Validate the bounded, lossless JSON object carried by a say. */
export function validateActivityMetadata(value: unknown): ActivityMetadata | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new SquareError('invalid_args', 'Activity metadata must be a non-null JSON object.');

  type Frame = { readonly value: unknown; readonly depth: number; readonly exit?: object };
  const visiting = new Set<object>();
  const stack: Frame[] = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit !== undefined) {
      visiting.delete(frame.exit);
      continue;
    }
    const item = frame.value;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new SquareError('invalid_args', 'Activity metadata must contain only finite JSON values.');
      continue;
    }
    if (typeof item !== 'object') throw new SquareError('invalid_args', 'Activity metadata must contain only JSON values.');
    if (frame.depth > ACTIVITY_METADATA_MAX_DEPTH)
      throw new SquareError('invalid_args', `Activity metadata nesting cannot exceed ${ACTIVITY_METADATA_MAX_DEPTH} levels.`);
    if (visiting.has(item)) throw new SquareError('invalid_args', 'Activity metadata cannot contain a cycle.');
    visiting.add(item);
    stack.push({ value: item, depth: frame.depth, exit: item });

    if (Array.isArray(item)) {
      if (Object.getOwnPropertySymbols(item).length > 0 || Object.keys(item).length !== item.length)
        throw new SquareError('invalid_args', 'Activity metadata arrays must be dense JSON arrays.');
      const names = Object.getOwnPropertyNames(item);
      if (names.some(name => name !== 'length' && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= item.length)))
        throw new SquareError('invalid_args', 'Activity metadata arrays must contain only indexed values.');
      for (const key of Object.keys(item).reverse()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor === undefined || !('value' in descriptor)) throw new SquareError('invalid_args', 'Activity metadata cannot contain accessors.');
        stack.push({ value: descriptor.value, depth: frame.depth + 1 });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null)
      throw new SquareError('invalid_args', 'Activity metadata must contain only plain JSON objects.');
    if (Object.getOwnPropertySymbols(item).length > 0)
      throw new SquareError('invalid_args', 'Activity metadata cannot contain symbol keys.');
    const names = Object.getOwnPropertyNames(item);
    if (names.some(name => !Object.prototype.propertyIsEnumerable.call(item, name)))
      throw new SquareError('invalid_args', 'Activity metadata cannot contain non-enumerable properties.');
    for (const name of names.reverse()) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name)!;
      if (!('value' in descriptor)) throw new SquareError('invalid_args', 'Activity metadata cannot contain accessors.');
      stack.push({ value: descriptor.value, depth: frame.depth + 1 });
    }
  }

  let serialized: string;
  try { serialized = JSON.stringify(value)!; }
  catch { throw new SquareError('invalid_args', 'Activity metadata must contain only lossless JSON values.'); }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > ACTIVITY_METADATA_MAX_BYTES)
    throw new SquareError('invalid_args', `Activity metadata cannot exceed ${ACTIVITY_METADATA_MAX_BYTES} UTF-8 bytes.`);
  return value as ActivityMetadata;
}

export function activityMetadataHasContent(metadata: ActivityMetadata | undefined): boolean {
  return metadata !== undefined && Object.keys(metadata).length > 0;
}

export interface Body {
  readonly channel: string;
  readonly session: string;
  readonly agent?: string;
}

export interface WakeAddress {
  readonly kind: WakeRouteKind;
  readonly address: Readonly<Record<string, string>>;
}

/** Artifact-owned custody binding. Generation is the join activity that established it. */
export interface Seat {
  readonly participant: string;
  readonly body: Body;
  readonly generation: ActivityId;
  readonly attachment: 'attached' | 'detached';
  readonly wakeAddress?: WakeAddress;
}

export interface SeatWatchLease {
  readonly generation: ActivityId;
  readonly lease: WatchLease;
}

export function sameBody(left: Body, right: Body): boolean {
  return left.channel === right.channel && left.session === right.session && left.agent === right.agent;
}

export function validateBody(body: Body): void {
  if (!body || typeof body.channel !== 'string' || !body.channel || typeof body.session !== 'string' || !body.session
    || (body.agent !== undefined && (typeof body.agent !== 'string' || !body.agent))) {
    throw new SquareError('invalid_args', 'A participant write requires an explicit channel and session body.');
  }
}

export function isWakeRouteKind(value: unknown): value is WakeRouteKind {
  return typeof value === 'string' && (WAKE_ROUTE_KINDS as readonly string[]).includes(value);
}

export interface WakeRoute {
  /** Ownership generation, when the receiver publishes a fenced route. */
  epoch?: number;
  location: string;
  participant: string;
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
  reason?: 'never_joined' | 'not_standing' | 'bell_mention_conflict' | 'not_addressed' | 'migration_required' | 'invalid_reply' | 'invalid_done_body' | 'needs_seat';
  /** The activity id a `catch --id` refusal named. */
  activityId?: string;
  /** The host ledger requiring offline migration, rather than the selected artifact. */
  ledgerRoot?: string;
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
  operation?: import('./square-facade.js').OperationFailureDetail;
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

export type PublicAct = Extract<StoredAct, { kind: 'say' | 'done' }>;
export type RoomChangeAct = Extract<StoredAct, { kind: 'join' | 'done' | 'hold' | 'resume' | 'listen' | 'ignore' | 'unlisten' }>;

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
