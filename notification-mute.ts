import { DeliveryLedger } from './delivery-ledger.js';

/** A read-only ledger open is an observation, never a new ledger file. */
export async function openReadOnlyDeliveryLedger(location: string, clock: () => number, signal?: AbortSignal): Promise<DeliveryLedger | undefined> {
  try {
    return await DeliveryLedger.open({ location, clock, signal, readOnly: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
