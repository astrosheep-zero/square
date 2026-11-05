import { connect, DeliveryError } from './packages/agent-delivery/src/index.js';
import { codexQueueEndpoint } from './packages/agent-delivery/src/codex-endpoint.js';
import { renderDeliveryReminder } from './delivery-frame.js';
import type { DeliveryCard, DeliveryTransport, DeliveryTransportContext, TransportOutcome } from './delivery-ledger.js';

export interface CodexQueueTransportOptions {
  readonly address: Readonly<Record<string, string>>;
  readonly env?: NodeJS.ProcessEnv;
}
/** Instantiated only by the receiver. The native queue store is shared across
 * processes: the hosting Codex app-server polls it and starts queued input only
 * when the thread is idle, so admission needs no remote idle proof. */
export class CodexQueueTransport implements DeliveryTransport {
  readonly kind = 'codex-queue';
  constructor(private readonly opts: CodexQueueTransportOptions) {}
  async send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome> {
    const threadId = address.threadId?.trim();
    if (!threadId || !address.codexHome || Object.keys(address).length !== Object.keys(this.opts.address).length ||
      !Object.entries(this.opts.address).every(([key, value]) => address[key] === value)) return 'not-capable';
    const env = this.opts.env ?? process.env;
    try {
      // Receiver delivery addresses the shared queue store explicitly; disappearing
      // native custody must not trigger CLI service startup.
      const endpoint = address.endpoint ?? codexQueueEndpoint({ CODEX_HOME: address.codexHome });
      const agent = await connect({ harness: 'codex', transport: 'cli', sessionId: threadId,
        boundaries: { queueEligible: async () => {
          // Only ledger fences remain: currentness, suppression, cancellation,
          // attachment generation, signal and deadline immediately before launch.
          return await context.beforeSend()
            && !context.signal.aborted && Date.now() < context.deadline;
        } },
        env, bin: env.SQUARE_CODEX_BIN, codexHome: address.codexHome, endpoint });
      if (context.signal.aborted || Date.now() >= context.deadline) return 'not-capable';
      await agent.queue(renderDeliveryReminder([card.text], { tagged: true }), { timeoutMs: context.deadline - Date.now(), signal: context.signal });
      return 'accepted';
    } catch (error) {
      return error instanceof DeliveryError && !error.maybeDelivered ? 'not-capable' : 'unknown';
    }
  }
}
