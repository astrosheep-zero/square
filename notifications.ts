import type { DeliveryLedger, DeliveryTransport, HandoffResult, PostResult } from './delivery-ledger.js';
import type { Owner } from './owner.js';
import { createDefaultDeliveryTransports } from './wake-transports.js';
export { createDefaultDeliveryTransports } from './wake-transports.js';

const DEFAULT_DELIVERY_WAIT_MS = 5000;
const NATIVE_RECEIVER_ROUTES = new Set(['codex-queue', 'claude-mod', 'claude-native', 'pi-native']);

/** Best-effort dispatch for currently eligible cards, including cards restored by release. */
export async function dispatchEligibleCards(ledger: DeliveryLedger, owner: Owner, options: {
  readonly signal?: AbortSignal; readonly track?: (result: HandoffResult) => void;
  readonly transports?: readonly DeliveryTransport[];
} = {}): Promise<void> {
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_DELIVERY_WAIT_MS);
  const session = await ledger.session(owner, signal);
  if (!session || session.state !== 'attached' || signal.aborted) return;
  const pending = await ledger.pending(owner, { generation: session.generation }, signal);
  for (const card of pending) await dispatchPostedCard(ledger, owner, card.key, options.track ?? (() => undefined), signal, options.transports);
}

/** Post, then best-effort dispatch without consulting producer storage. */
export async function postAndDispatch(ledger: DeliveryLedger, input: { readonly owner: Owner; readonly key: string; readonly text: string; readonly details?: Readonly<Record<string, unknown>> }, options: {
  readonly signal?: AbortSignal; readonly track?: (result: HandoffResult) => void;
  readonly transports?: readonly DeliveryTransport[];
} = {}): Promise<PostResult> {
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_DELIVERY_WAIT_MS);
  const result = await ledger.post(input, signal);
  if (result.status === 'posted' || result.status === 'duplicate') {
    try { await dispatchEligibleCards(ledger, input.owner, { ...options, signal }); } catch { /* Posting is already committed. */ }
  }
  return result;
}

/** Best-effort dispatch after a card has been posted; never inspect producer storage. */
export async function dispatchPostedCard(ledger: DeliveryLedger, owner: Owner, key: string, track: (result: HandoffResult) => void, signal?: AbortSignal, suppliedTransports?: readonly DeliveryTransport[]): Promise<void> {
  if (signal?.aborted) return;
  signal ??= AbortSignal.timeout(DEFAULT_DELIVERY_WAIT_MS);
  const session = await ledger.session(owner, signal);
  if (!session || session.state !== 'attached') return;
  // Native receiver custody belongs to the receiver itself, including for
  // callers that supply transports explicitly to the producer API.
  const routes = session.routes.filter(route => !NATIVE_RECEIVER_ROUTES.has(route.kind));
  if (!routes.length) return;
  const transports: readonly DeliveryTransport[] = suppliedTransports ?? await createDefaultDeliveryTransports();
  for (const route of routes) {
    if (signal.aborted) return;
    const transport = transports.find(candidate => candidate.kind === route.kind);
    if (!transport) continue;
    const result = await ledger.dispatchHandoff(owner, key, transport, { generation: session.generation, timeoutMs: DEFAULT_DELIVERY_WAIT_MS, signal });
    track(result);
    if (result.outcome === 'accepted' || result.outcome === 'presented' || result.outcome === 'unknown') return;
  }
}
