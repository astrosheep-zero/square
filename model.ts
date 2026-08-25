// Shared model and constants for Square.

import type { Act } from './square-core.js';
export { formatActivityId, parseActivityId } from './square-core.js';
export type { Act, ActivityId, Audience, Reach } from './square-core.js';

export const WAKE_ROUTE_KINDS = ['opencode-server', 'codex-queue', 'claude-native', 'pi-extension', 'paseo'] as const;
export type WakeRouteKind = typeof WAKE_ROUTE_KINDS[number];

export function isWakeRouteKind(value: unknown): value is WakeRouteKind {
  return typeof value === 'string' && (WAKE_ROUTE_KINDS as readonly string[]).includes(value);
}

export interface WakeRoute {
  ownerId: string;
  sessionId: string;
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
  pending?: number;
  holder?: string;
  retryAfterMs?: number;
}

class SquareErrorBase<Code extends string> extends Error {
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
export type StoredActHead = StoredAct extends infer T ? T extends StoredAct ? Omit<T, 'body' | 'through' | 'index'> : never : never;

export type ObservationState = 'notified' | 'seen';

export interface ActivityObservation {
  state: ObservationState;
  at: number;
  ownerId?: string;
}

export interface WatchLeaseFilter {
  participants?: string[];
  mention?: string;
}

export interface WatchLease {
  leaseId: string;
  /** Machine-local owner that may claim automatic delivery for this lease. */
  ownerId?: string;
  heartbeatAt: number;
  expiresAt: number;
  filter?: WatchLeaseFilter;
}

export type DirectedNotificationRoute = 'mention' | 'attention' | 'bell';

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
  ownerId?: string;
  notifications: InboxNotification[];
  catchLease?: WatchLease;
}

export interface NotifyLease {
  leaseId: string;
  expiresAt: number;
  phase: 'claimed' | 'dispatching';
  attemptN?: number;
  routeKind?: WakeRouteKind;
}

export interface SquareRuntimeState {
  nextActIndex: number;
  observations: Record<string, Record<string, ActivityObservation>>;
  leases: Record<string, WatchLease>;
  notifyLeases: Record<string, NotifyLease>;
}

export interface SquareState {
  hardCap: HardCap;
  throttlePerMinute?: number;
  preamble: string[];
  warmup: string[];
  acts: StoredAct[];
  runtime: SquareRuntimeState;
}

export interface ActivitiesOptions {
  lastN?: number | null;
  participants?: string[];
  /** Exclusive upper bound on act.at (ms). */
  before?: number;
  /** Exclusive lower bound on act.at (ms). Alias of --since. */
  after?: number;
  /** Exclusive lower bound on stable act index (--after act/<index>). */
  afterIndex?: number;
  /** Center act indexes for context windows (--at). */
  atIndexes?: number[];
  beforeContext?: number;
  afterContext?: number;
  mention?: string;
  /** Undelivered mention/bell items for viewer only (read-only; requires viewer). */
  pending?: boolean;
  viewer?: string;
  full?: boolean;
  grep?: string;
  fixed?: string;
  order?: 'asc' | 'desc';
  format?: string[];
  json?: boolean;
}

export interface WatchOptions {
  participants?: string[];
  mention?: string;
  idleMs?: number;
  replace?: boolean;
  now?: boolean;
}

export type PublicAct = Extract<StoredAct, { kind: 'say' | 'done' }>;
export type RoomChangeAct = Extract<StoredAct, { kind: 'join' | 'done' | 'hold' | 'resume' | 'listen' | 'ignore' }>;

export interface HoldState {
  active: boolean;
  at?: number;
  reason?: string;
}

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

export function findParticipantName(participants: string[], name: string): string | undefined {
  return participants.find((participant) => sameName(participant, name));
}

export function validateName(name: string): void {
  if (!name || !/^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(name)) {
    throw new SquareError('invalid_name', 'Invalid name: names must contain non-empty slash-separated segments using only Unicode letters, digits, hyphens, and underscores.');
  }
}
