import { connect, DeliveryError } from './packages/agent-delivery/src/index.js';
import { codexIdleAtStop } from './packages/agent-delivery/src/codex.js';
import { codexQueueEndpoint } from './packages/agent-delivery/src/codex-endpoint.js';
import { codexBoundaryStore, type CodexStopEpoch } from './codex-boundary-state.js';
import { renderDeliveryReminder } from './delivery-frame.js';
import type { DeliveryCard, DeliveryTransport, DeliveryTransportContext, TransportOutcome } from './delivery-ledger.js';

export interface CodexQueueTransportOptions {
  readonly epoch: CodexStopEpoch;
  readonly address: Readonly<Record<string, string>>;
  readonly env?: NodeJS.ProcessEnv;
}
/** Instantiated only by the receiver, for one captured Stop epoch. */
export class CodexQueueTransport implements DeliveryTransport {
  readonly kind = 'codex-queue';
  constructor(private readonly opts: CodexQueueTransportOptions) {}
  async send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome> {
    const threadId = address.threadId?.trim();
    if (!threadId || !address.codexHome || Object.keys(address).length !== Object.keys(this.opts.address).length ||
      !Object.entries(this.opts.address).every(([key, value]) => address[key] === value)) return 'not-capable';
    const env = this.opts.env ?? process.env;
    const boundaries = codexBoundaryStore(env), epoch = this.opts.epoch;
    try {
      // Receiver delivery addresses the already-hosting endpoint explicitly;
      // disappearing native custody must not trigger CLI service startup.
      const endpoint = address.endpoint ?? codexQueueEndpoint({ CODEX_HOME: address.codexHome });
      const agent = await connect({ harness: 'codex', transport: 'cli', sessionId: threadId,
        boundaries: { queueEligible: async id => {
          if (!await boundaries.queueEligible(id, epoch)) return false;
          // Repeat the native sample after claim, immediately before the final
          // epoch and ledger fences. These reads are not an atomic native enqueue.
          if (!await codexIdleAtStop({ harness: 'codex', sessionId: id, codexHome: address.codexHome,
            endpoint, timeoutMs: Math.max(1, context.deadline - Date.now()), signal: context.signal }, epoch.turnId)) return false;
          return await boundaries.queueEligible(id, epoch) && await context.beforeSend()
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
