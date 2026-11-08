import type { DeliveryTransport } from './delivery-ledger.js';

export type WakeTransports = readonly DeliveryTransport[];

/** Claude now receives only at native hooks; producers never target a socket. */
export async function createDefaultDeliveryTransports(): Promise<WakeTransports> {
  const [{ HttpWakeTransport }, { PaseoWakeTransport }] = await Promise.all([
    import('./http-delivery.js'),
    import('./paseo-delivery.js'),
  ]);
  return [new HttpWakeTransport(), new PaseoWakeTransport()];
}
