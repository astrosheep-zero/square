export type Participant = string;
export type Reach = 'bell';
export type ActivityId = `act/${number}`;
export type Perception = 'full' | 'presence';
export const MAX_IDENTITY_SET_SIZE = 10;
export const PAGE_CAP = 100;
export const DEFAULT_LIST_DEPTH = 4;
export const MAX_LIST_DEPTH = 16;
export const DEFAULT_LIST_LIMIT = 20;
export const PERCEIVE_DEFAULT_LIMIT = 10;

export function formatActivityId(index: number): ActivityId {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid activity index: ${index}`);
  return `act/${index}`;
}
export const ACTIVITY_ID_PATTERN = /^act\/(0|[1-9][0-9]*)$/;
export function parseActivityId(value: string): number | undefined {
  if (value === 'act/0') return 0;
  if (typeof value !== 'string' || !ACTIVITY_ID_PATTERN.test(value)) return undefined;
  const index = Number(value.slice(4));
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}
export type Act =
  | { kind: 'join'; actor: Participant; at?: number }
  | { kind: 'done'; actor: Participant; at?: number; body?: string }
  | { kind: 'say'; actor: Participant; at?: number; body?: string; metadata?: import('./square-values.js').MessageMetadata; mentions?: readonly Participant[]; reply?: number }
  | { kind: 'read'; actor: Participant; at?: number; through: number }
  | { kind: 'listen'; actor: Participant; target: Participant; at?: number }
  | { kind: 'ignore'; actor: Participant; target: Participant; at?: number }
  | { kind: 'unlisten'; actor: Participant; target: Participant; at?: number };

export const NARRATED_ACTIVITY_KINDS: readonly Act['kind'][] = ['join', 'say', 'done'];
export function isNarratedActivity(kind: Act['kind']): boolean {
  return NARRATED_ACTIVITY_KINDS.includes(kind);
}
