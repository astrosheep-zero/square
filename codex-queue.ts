import { connect, DeliveryError, type CodexCliAgent, type CodexCliConnectOptions } from './packages/agent-delivery/src/index.js';
export { sendCodexQueue, CodexQueueSendError } from './packages/agent-delivery/src/codex-queue.js';
export type { CodexQueueRequest, CodexQueueFailureKind } from './packages/agent-delivery/src/codex-queue.js';
import { codexBoundaryStore } from './codex-boundary-state.js';
import { renderDeliveryReminder } from './delivery-frame.js';
import type { DeliveryCard, DeliveryTransport, DeliveryTransportContext, TransportOutcome } from './delivery-ledger.js';

export interface CodexQueueTransportOptions {
  env?: NodeJS.ProcessEnv;
  connect?: (options: CodexCliConnectOptions) => Promise<CodexCliAgent>;
}
export class CodexQueueTransport implements DeliveryTransport {
  readonly kind = 'codex-queue';
  constructor(private readonly opts: CodexQueueTransportOptions = {}) {}
  async send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome> {
    const threadId = address.threadId?.trim();
    if (!threadId) return 'not-capable';
    const env = this.opts.env ?? process.env;
    try {
      const boundaries = codexBoundaryStore(env);
      const agent = await (this.opts.connect ?? connect)({ harness: 'codex', transport: 'cli', sessionId: threadId,
        boundaries: { ...boundaries, queueEligible: async id => await boundaries.queueEligible(id)
          && await context.beforeSend() && !context.signal.aborted && Date.now() < context.deadline },
        env, bin: env.SQUARE_CODEX_BIN, codexHome: address.codexHome, endpoint: address.endpoint });
      if (context.signal.aborted || Date.now() >= context.deadline) return 'not-capable';
      await agent.queue(renderDeliveryReminder([card.text], { tagged: true }), { timeoutMs: context.deadline - Date.now(), signal: context.signal });
      return 'accepted';
    } catch (error) {
      return error instanceof DeliveryError && !error.maybeDelivered ? 'failed' : 'unknown';
    }
  }
}
