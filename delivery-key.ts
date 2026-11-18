/** Producer-defined identity; segments are compared verbatim, never normalized. */
export type DeliveryKey = readonly string[];

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
