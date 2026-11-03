import type { DeliveryLedger, DeliveryTransport, HandoffResult } from './delivery-ledger.js';
import type { Owner } from './owner.js';
import { createDefaultDeliveryTransports } from './wake-transports.js';
export { createDefaultDeliveryTransports } from './wake-transports.js';

/** Best-effort dispatch after a card has been posted; never inspect producer storage. */
export async function dispatchPostedCard(ledger: DeliveryLedger, owner: Owner, key: string, track: (result: HandoffResult) => void, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  const session = await ledger.session(owner);
  if (!session || session.state !== 'attached') return;
  const transports: readonly DeliveryTransport[] = await createDefaultDeliveryTransports(env);
  const configured = Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000);
  const timeoutMs = Number.isSafeInteger(configured) && configured > 0 ? configured : 5000;
  for (const route of session.routes) {
    if (signal?.aborted) return;
    const transport = transports.find(candidate => candidate.kind === route.kind);
    if (!transport) continue;
    const result = await ledger.dispatchHandoff(owner, key, transport, { generation: session.generation, timeoutMs, signal });
    track(result);
    if (result.outcome === 'accepted' || result.outcome === 'presented' || result.outcome === 'unknown') return;
  }
}
