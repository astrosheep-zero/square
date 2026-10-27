import { SquareError, sameBody, type ActivityMetadata, type JsonValue, type ActivityId } from './model.js';
import type { SeatRef, SquareRead } from './ports.js';

export type MetadataScalar = null | boolean | number | string;
export interface MetadataMatch {
  readonly fields: readonly Readonly<{ path: readonly string[]; equals: MetadataScalar }>[];
}
export interface DeliveryDeferral {
  readonly id: string;
  readonly expiresAt: string;
}
export interface DeliveryDeferralFact {
  readonly participant: string;
  readonly generation: ActivityId;
  readonly id: string;
  readonly match: MetadataMatch;
  readonly expiresAt: number;
}
export const MAX_DELIVERY_DEFERRAL_MS = 24 * 60 * 60 * 1000;

export function validateMetadataMatch(value: unknown): MetadataMatch {
  const fail = (): never => { throw new SquareError('invalid_args', 'Invalid metadata match.'); };
  const record = (item: unknown): item is Record<string, unknown> => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(item).length === 0
      && Object.getOwnPropertyNames(item).every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        return descriptor.enumerable && 'value' in descriptor;
      });
  };
  const dense = (item: unknown): item is unknown[] => Array.isArray(item)
    && Object.getOwnPropertySymbols(item).length === 0 && Object.keys(item).length === item.length
    && Object.getOwnPropertyNames(item).length === item.length + 1
    && Array.from({ length: item.length }, (_, index) => Object.getOwnPropertyDescriptor(item, index))
      .every(descriptor => descriptor !== undefined && descriptor.enumerable && 'value' in descriptor);
  if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'fields')) return fail();
  const fields = value.fields;
  if (!dense(fields) || fields.length === 0) return fail();
  const paths = new Set<string>();
  const validated = fields.map((field) => {
    if (!record(field) || Object.keys(field).length !== 2
      || !Object.hasOwn(field, 'path') || !Object.hasOwn(field, 'equals')) return fail();
    const { path, equals } = field;
    if (!dense(path) || path.length === 0 || !path.every((part) => typeof part === 'string' && part.length > 0)) return fail();
    if (!(equals === null || typeof equals === 'string' || typeof equals === 'boolean'
      || typeof equals === 'number' && Number.isFinite(equals))) return fail();
    const key = JSON.stringify(path);
    if (paths.has(key)) return fail();
    paths.add(key);
    return Object.freeze({ path: Object.freeze([...path]) as readonly string[], equals: equals as MetadataScalar });
  });
  return Object.freeze({ fields: Object.freeze(validated) });
}

export function validateDeferralDuration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new SquareError('invalid_args', 'Delivery deferral duration must be a positive safe integer.');
  return Math.min(value as number, MAX_DELIVERY_DEFERRAL_MS);
}

export function validateDeferralId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new SquareError('invalid_args', 'Invalid delivery deferral id.');
  return value;
}

export function matchesMetadata(metadata: ActivityMetadata | undefined, match: MetadataMatch): boolean {
  if (metadata === undefined) return false;
  return match.fields.every(({ path, equals }) => {
    let value: JsonValue = metadata;
    for (const segment of path) {
      if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, segment)) return false;
      value = (value as Readonly<Record<string, JsonValue>>)[segment];
    }
    return value === equals && (value === null || typeof value !== 'object');
  });
}

export function matchingDeferrals(
  deferrals: readonly DeliveryDeferralFact[], metadata: ActivityMetadata | undefined, now: number,
): readonly DeliveryDeferralFact[] {
  return deferrals.filter((lease) => lease.expiresAt > now && matchesMetadata(metadata, lease.match));
}

export function deliveryDeferralExpiry(facts: SquareRead, captured: SeatRef, index: number, now: number): number | undefined {
  const seat = facts.seat(captured.participant);
  if (seat === undefined || seat.generation !== captured.generation || !sameBody(seat.body, captured.body)) return undefined;
  const leases = facts.deliveryDeferrals(seat.participant, seat.generation);
  if (!leases.some(lease => lease.expiresAt > now)) return undefined;
  const activity = facts.activity(index);
  return activity?.kind === 'say' ? earliestMatchingDeferralExpiry(leases, activity.metadata, now) : undefined;
}

export function earliestMatchingDeferralExpiry(
  deferrals: readonly DeliveryDeferralFact[], metadata: ActivityMetadata | undefined, now: number,
): number | undefined {
  const matches = matchingDeferrals(deferrals, metadata, now);
  return matches.length ? Math.min(...matches.map((lease) => lease.expiresAt)) : undefined;
}
