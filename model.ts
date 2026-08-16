// Shared model and constants for Square.

import type { Act } from './square-core.js';
export type { Act, Audience, Reach } from './square-core.js';

export const WAKE_ROUTE_KINDS = ['opencode-server', 'codex-app-server', 'claude-native', 'pi-extension', 'paseo'] as const;
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
  | 'not_found'
  | 'invalid_name'
  | 'invalid_args'
  | 'throttled'
  | 'cap_reached'
  | 'conflict'
  | 'pending_peer';

export class SquareError extends Error {
  constructor(
    public code: SquareErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SquareError';
  }
}

export const WARMUP_HEADING = '## Warmup';
export const WARMUP_MARKER = '<!-- square:warmup -->';
export const ACTIVITIES_HEADING = '## Activities';
export const ACTIVITIES_MARKER = '<!-- square:activities -->';
export const ACT_MARKER_PREFIX = '<!-- square:act';
export const CURRENT_FORMAT_VERSION = 3;

export type HardCap = number | null;

export interface BuildOptions {
  force: boolean;
  hardCap?: HardCap;
  template?: string;
  throttlePerMinute?: number;
}

export type StoredAct = Act & { index: number; at: number };
export type StoredActHead = StoredAct extends infer T ? T extends StoredAct ? Omit<T, 'body' | 'through' | 'index'> : never : never;

export interface ReadCursor {
  consumedThroughIndex: number;
  updatedAt: number;
}

export interface DeliveryReceipt {
  /** Inject presentation lives only in the machine-local presented ledger. */
  status: 'delivered';
  at: number;
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

export type DirectedNotificationRoute = 'mention' | 'bell';

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

export interface NotifyLease {
  leaseId: string;
  expiresAt: number;
  phase: 'claimed' | 'dispatching';
  attemptN?: number;
  routeKind?: WakeRouteKind;
}

export interface SquareRuntimeState {
  version: 2;
  nextActIndex: number;
  cursors: Record<string, ReadCursor>;
  deliveryReceipts: Record<string, Record<string, DeliveryReceipt>>;
  leases: Record<string, WatchLease>;
  notifyLeases: Record<string, NotifyLease>;
}

export interface SquareDoc {
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
  /** Exclusive lower bound on stable act index (--after act_N). */
  afterIndex?: number;
  /** Center act index for a context window (--at). */
  atIndex?: number;
  beforeContext?: number;
  afterContext?: number;
  mention?: string;
  /** Undelivered mention/bell items for viewer only (read-only; requires viewer). */
  pending?: boolean;
  viewer?: string;
  full?: boolean;
  grep?: string;
  fixed?: string;
  ids?: number[];
  order?: 'asc' | 'desc';
  format?: string[];
  countOnly?: boolean;
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
export type RoomChangeAct = Extract<StoredAct, { kind: 'join' | 'done' | 'hold' | 'resume' }>;

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
  if (!name || !/^[\p{L}\p{N}_-]+$/u.test(name)) {
    throw new SquareError('invalid_name', 'Invalid name: names must be non-empty and can only contain Unicode letters, digits, hyphens, and underscores.');
  }
}
