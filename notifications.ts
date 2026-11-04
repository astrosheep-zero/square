import type { DeliveryLedger, DeliveryTransport, HandoffResult, PostResult } from './delivery-ledger.js';
import type { Owner } from './owner.js';
import { createDefaultDeliveryTransports } from './wake-transports.js';
export { createDefaultDeliveryTransports } from './wake-transports.js';

/** Best-effort dispatch for currently eligible cards, including cards restored by release. */
export async function dispatchEligibleCards(ledger: DeliveryLedger, owner: Owner, options: {
  readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal; readonly track?: (result: HandoffResult) => void;
  readonly transports?: readonly DeliveryTransport[];
} = {}): Promise<void> {
  const session = await ledger.session(owner);
  if (!session || session.state !== 'attached' || options.signal?.aborted) return;
  const pending = await ledger.pending(owner, { generation: session.generation });
  for (const card of pending) await dispatchPostedCard(ledger, owner, card.key, options.track ?? (() => undefined), options.env, options.signal, options.transports);
}

/** Post, then best-effort dispatch without consulting producer storage. */
export async function postAndDispatch(ledger: DeliveryLedger, input: { readonly owner: Owner; readonly key: string; readonly text: string; readonly details?: Readonly<Record<string, unknown>> }, options: {
  readonly env?: NodeJS.ProcessEnv; readonly signal?: AbortSignal; readonly track?: (result: HandoffResult) => void;
  readonly transports?: readonly DeliveryTransport[];
} = {}): Promise<PostResult> {
  const result = await ledger.post(input);
  if (result.status === 'posted' || result.status === 'duplicate') {
    try { await dispatchEligibleCards(ledger, input.owner, options); } catch { /* Posting is already committed. */ }
  }
  return result;
}

/** Best-effort dispatch after a card has been posted; never inspect producer storage. */
export async function dispatchPostedCard(ledger: DeliveryLedger, owner: Owner, key: string, track: (result: HandoffResult) => void, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal, suppliedTransports?: readonly DeliveryTransport[]): Promise<void> {
  if (signal?.aborted) return;
  const session = await ledger.session(owner);
  if (!session || session.state !== 'attached') return;
  const transports: readonly DeliveryTransport[] = suppliedTransports ?? await createDefaultDeliveryTransports(env);
  const configured = Number(env.SQUARE_NOTIFY_DELIVERY_WAIT_MS ?? 5000);
  const timeoutMs = Number.isSafeInteger(configured) && configured > 0 ? configured : 5000;
  for (const route of session.routes) {
    // Codex custody belongs to its native receiver, including for callers that
    // supply transports explicitly to the public producer API.
    if (route.kind === 'codex-queue') continue;
    if (signal?.aborted) return;
    const transport = transports.find(candidate => candidate.kind === route.kind);
    if (!transport) continue;
    const result = await ledger.dispatchHandoff(owner, key, transport, { generation: session.generation, timeoutMs, signal });
    track(result);
    if (result.outcome === 'accepted' || result.outcome === 'presented' || result.outcome === 'unknown') return;
  }
}
