import os from 'node:os';
import path from 'node:path';
import { DeliveryLedger, type DeliveryRoute, type DeliverySession } from './delivery-ledger.js';
import type { Owner } from './owner.js';

function openLedger(env: NodeJS.ProcessEnv): Promise<DeliveryLedger> {
  return DeliveryLedger.open({ location: env.SQUARE_DELIVERY ?? path.join(os.homedir(), '.square', 'delivery.sqlite') });
}

/** Rotate the captured session generation; omitted routes retain its registrations. */
export async function attachDeliverySession(owner: Owner, env: NodeJS.ProcessEnv = process.env, routes?: readonly DeliveryRoute[], signal?: AbortSignal): Promise<DeliverySession | false> {
  return attach(owner, env, routes, false, signal);
}

/** Replace the supplied route kinds while preserving every other registered route. */
export async function attachDeliverySessionRoutes(owner: Owner, env: NodeJS.ProcessEnv = process.env, routes: readonly DeliveryRoute[], signal?: AbortSignal): Promise<DeliverySession | false> {
  return attach(owner, env, routes, true, signal);
}

async function attach(owner: Owner, env: NodeJS.ProcessEnv, routes: readonly DeliveryRoute[] | undefined, merge: boolean, signal?: AbortSignal): Promise<DeliverySession | false> {
  if (signal?.aborted) return false;
  const ledger = await openLedger(env);
  try {
    const previous = await ledger.session(owner);
    if (signal?.aborted) return false;
    const selected = merge && routes ? [...(previous?.routes ?? []).filter(old => !routes.some(route => route.kind === old.kind)), ...routes] : routes ?? previous?.routes ?? [];
    return await ledger.attach({ owner, expectedGeneration: previous?.generation ?? null, routes: selected });
  } finally { await ledger.close(); }
}

export async function detachDeliverySession(owner: Owner, generation: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const ledger = await openLedger(env);
  try { return await ledger.detach({ owner, generation }); } finally { await ledger.close(); }
}

export async function markDeliverySessionDeleted(owner: Owner, generation: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const ledger = await openLedger(env);
  try { return await ledger.markDeleted({ owner, generation }); } finally { await ledger.close(); }
}
