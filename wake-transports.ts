import type { DeliveryTransport } from './delivery-ledger.js';

export type WakeTransports = readonly DeliveryTransport[];

/** Claude now receives only at native hooks; producers never target a socket. */
export async function createDefaultDeliveryTransports(env: NodeJS.ProcessEnv = process.env): Promise<WakeTransports> {
  const { HttpWakeTransport } = await import('./http-delivery.js');
  const transports: DeliveryTransport[] = [new HttpWakeTransport({ env })];
  if (env.SQUARE_DISABLE_PASEO_WAKE !== '1') {
    const { PaseoWakeTransport } = await import('./paseo-delivery.js');
    transports.push(new PaseoWakeTransport());
  }
  return transports;
}
