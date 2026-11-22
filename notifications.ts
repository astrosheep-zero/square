import { copyDeliveryKey, type DeliveryKey } from './delivery-key.js';
import type { DeliveryLedger, DeliveryRoute, DeliveryTransport, HandoffResult, PostResult } from './delivery-ledger.js';
import { isProducerDispatchRoute } from './session-lifecycle.js';
import type { Owner } from './owner.js';

const DEFAULT_DELIVERY_WAIT_MS = 5000;

/** Native receivers own their effects; producers never target Claude's private helper. */
async function createDefaultDeliveryTransports(): Promise<readonly DeliveryTransport[]> {
  const [{ HttpWakeTransport }, { PaseoWakeTransport }, { KeiyakuWakeTransport }] = await Promise.all([
    import('./http-delivery.js'),
    import('./paseo-delivery.js'),
    import('./keiyaku-delivery.js'),
  ]);
  return [new HttpWakeTransport(), new PaseoWakeTransport(), new KeiyakuWakeTransport()];
}

function canDispatch(route: DeliveryRoute, squareMention: boolean): boolean {
  return isProducerDispatchRoute(route) && (route.kind !== 'keiyaku' || squareMention);
}

/** Best-effort dispatch for currently eligible cards, including cards restored by release. */
export async function dispatchEligibleCards(ledger: DeliveryLedger, owner: Owner, options: {
  readonly signal?: AbortSignal; readonly track?: (result: HandoffResult) => void;
  readonly transports?: readonly DeliveryTransport[];
} = {}): Promise<void> {
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_DELIVERY_WAIT_MS);
  const session = await ledger.session(owner, signal);
  if (!session || session.state !== 'attached' || signal.aborted || !session.routes.some(route => canDispatch(route, false))) return;
  const pending = await ledger.pending(owner, { generation: session.generation }, signal);
  for (const card of pending) await dispatchPostedCard(ledger, owner, card.key, { signal, track: options.track, transports: options.transports });
}

/** Post, then best-effort dispatch without consulting producer storage. */
export async function postAndDispatch(ledger: DeliveryLedger, input: { readonly owner: Owner; readonly key: DeliveryKey; readonly text: string; readonly details?: Readonly<Record<string, unknown>> }, options: {
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
export async function dispatchPostedCard(ledger: DeliveryLedger, owner: Owner, key: DeliveryKey, options: {
  readonly signal?: AbortSignal;
  readonly track?: (result: HandoffResult) => void;
  readonly transports?: readonly DeliveryTransport[];
  readonly squareMention?: boolean;
}): Promise<void> {
  key = copyDeliveryKey(key);
  const signal = options.signal ?? AbortSignal.timeout(DEFAULT_DELIVERY_WAIT_MS);
  if (signal.aborted) return;
  const session = await ledger.session(owner, signal);
  if (!session || session.state !== 'attached') return;
  // Native receiver custody belongs to the receiver itself, including for
  // callers that supply transports explicitly to the producer API.
  const routes = session.routes.filter(route => canDispatch(route, options.squareMention === true));
  if (!routes.length) return;
  const transports = options.transports ?? await createDefaultDeliveryTransports();
  for (const route of routes) {
    if (signal.aborted) return;
    const transport = transports.find(candidate => candidate.kind === route.kind);
    if (!transport) continue;
    const result = await ledger.dispatchHandoff(owner, key, transport, { generation: session.generation, timeoutMs: DEFAULT_DELIVERY_WAIT_MS, signal });
    options.track?.(result);
    if (result.outcome === 'accepted' || result.outcome === 'presented' || result.outcome === 'unknown') return;
  }
}
