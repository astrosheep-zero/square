import { nameKey } from './neutral.js';

/** Producer-defined identity; segments are compared verbatim, never normalized. */
export type DeliveryKey = readonly string[];

/** The structural key facts a square post carries; no producer record is required. */
export interface SquarePostKeyFacts {
  readonly kind: 'activity' | 'notice';
  readonly index: number;
  readonly recipient: string;
  readonly generation: string;
}
export interface SquarePostIdentity extends Omit<SquarePostKeyFacts, 'recipient'> {
  readonly recipientKey: string;
}

export function copyDeliveryKey(value: DeliveryKey, prefix = false): DeliveryKey {
  if (!Array.isArray(value) || !prefix && value.length === 0) throw new TypeError('Expected a delivery key array');
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i) || typeof value[i] !== 'string') throw new TypeError('Expected string delivery key segments');
  }
  return [...value];
}
export function encodeDeliveryKey(value: DeliveryKey, prefix = false): string {
  return JSON.stringify(copyDeliveryKey(value, prefix));
}
export function deliveryKeyEqual(a: DeliveryKey, b: DeliveryKey): boolean {
  return a.length === b.length && deliveryKeyPrefix(a, b);
}
export function deliveryKeyPrefix(prefix: DeliveryKey, key: DeliveryKey): boolean {
  return prefix.length <= key.length && prefix.every((segment, i) => segment === key[i]);
}

export function squarePostKey(location: string, post: SquarePostKeyFacts): DeliveryKey {
  return ['square', location, 'recipient', nameKey(post.recipient), 'join', post.generation,
    post.kind === 'activity' ? 'act' : 'notice', String(post.index)];
}
/** Only canonical keys from this square identify producer records. */
export function parseSquarePostKey(location: string, key: DeliveryKey): SquarePostIdentity | undefined {
  if (!Array.isArray(key) || key.length !== 8 || !Array.from(key).every(segment => typeof segment === 'string')
    || key[0] !== 'square' || key[1] !== location
    || key[2] !== 'recipient' || key[4] !== 'join' || !['act', 'notice'].includes(key[6]!) || !/^(0|[1-9]\d*)$/.test(key[7]!)) return undefined;
  const index = Number(key[7]), recipientKey = key[3]!, generation = key[5]!;
  const kind = key[6] === 'act' ? 'activity' : 'notice';
  if (!Number.isSafeInteger(index) || !deliveryKeyEqual(squarePostKey(location, { kind, index, recipient: recipientKey, generation }), key)) return undefined;
  return { kind, index, recipientKey, generation };
}
