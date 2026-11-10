import type { DeliveryTransport } from './delivery-ledger.js';

export type WakeTransports = readonly DeliveryTransport[];

/** Native receivers own their effects; producers never target Claude's private helper. */
export async function createDefaultDeliveryTransports(): Promise<WakeTransports> {
  const [{ HttpWakeTransport }, { PaseoWakeTransport }] = await Promise.all([
    import('./http-delivery.js'),
    import('./paseo-delivery.js'),
  ]);
  return [new HttpWakeTransport(), new PaseoWakeTransport()];
}
