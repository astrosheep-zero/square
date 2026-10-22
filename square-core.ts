import { sameName } from './model.js';

export type Participant = string;
export type Reach = 'bell';
export type Audience = { readonly kind: 'bell' } | { readonly kind: 'mentions'; readonly names: readonly Participant[] };
export type ActivityId = `act/${number}`;
export type Perception = 'full' | 'presence';
export const MAX_IDENTITY_SET_SIZE = 10;

export function formatActivityId(index: number): ActivityId {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Invalid activity index: ${index}`);
  return `act/${index}`;
}
export function parseActivityId(value: string): number | undefined {
  if (value === 'act/0') return 0;
  if (typeof value !== 'string' || !/^act\/[1-9]\d*$/.test(value)) return undefined;
  const index = Number(value.slice(4));
  return Number.isSafeInteger(index) ? index : undefined;
}
export type Act =
  | { kind: 'join'; actor: Participant; at?: number }
  | { kind: 'done'; actor: Participant; at?: number; body?: string }
  | { kind: 'say'; actor: Participant; at?: number; body: string; mentions?: readonly Participant[]; reach?: Reach; reply?: number }
  | { kind: 'hold'; actor?: Participant; at?: number; body?: string }
  | { kind: 'resume'; actor?: Participant; at?: number }
  | { kind: 'read'; actor: Participant; at?: number; through: number }
  | { kind: 'listen'; actor: Participant; target: Participant; at?: number }
  | { kind: 'ignore'; actor: Participant; target: Participant; at?: number }
  | { kind: 'unlisten'; actor: Participant; target: Participant; at?: number };

export function audienceOf(say: { body: string; mentions?: readonly Participant[]; reach?: Reach }): Audience {
  if (say.reach === 'bell') return { kind: 'bell' };
  const names: string[] = [];
  for (const name of say.mentions ?? []) if (!names.some((existing) => sameName(existing, name))) names.push(name);
  return { kind: 'mentions', names };
}
export function audienceIncludes(audience: Audience, name: string): boolean {
  return audience.kind === 'bell' || audience.names.some((mentioned) => sameName(mentioned, name));
}
