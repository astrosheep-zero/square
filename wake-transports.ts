import type { DeliveryTransport } from './delivery-ledger.js';

export type WakeTransports = readonly DeliveryTransport[];

/** Concrete transports share no producer-specific state. */
export async function createDefaultDeliveryTransports(env: NodeJS.ProcessEnv = process.env): Promise<WakeTransports> {
  const { createClaudeWakeTransport } = await import('./claude-transport.js');
  const { HttpWakeTransport } = await import('./http-delivery.js');
  const transports: DeliveryTransport[] = [createClaudeWakeTransport(env), new HttpWakeTransport({ env })];
  if (env.SQUARE_DISABLE_PASEO_WAKE !== '1') {
    const { PaseoWakeTransport } = await import('./paseo-delivery.js');
    transports.push(new PaseoWakeTransport());
  }
  return transports;
}
