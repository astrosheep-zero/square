import type { DeliveryCard, DeliveryTransport, DeliveryTransportContext, TransportOutcome } from './delivery-ledger.js';
import { DeliveryError } from './packages/agent-delivery/src/index.js';
import { discoverPaseoAgents, waitForPaseoWakeBoundary } from './paseo-state.js';
import { sendPaseoWake } from './wake-sink.js';

export interface PaseoWakeTransportOptions {
  discover?: typeof discoverPaseoAgents;
  waitForBoundary?: typeof waitForPaseoWakeBoundary;
  sendWake?: typeof sendPaseoWake;
}
export class PaseoWakeTransport implements DeliveryTransport {
  readonly kind = 'paseo';
  private discovering?: ReturnType<typeof discoverPaseoAgents>;
  constructor(private readonly opts: PaseoWakeTransportOptions = {}) {}
  private discover(timeoutMs: number): ReturnType<typeof discoverPaseoAgents> {
    return this.discovering ??= Promise.resolve().then(() => (this.opts.discover ?? discoverPaseoAgents)(timeoutMs))
      .finally(() => { this.discovering = undefined; });
  }
  async send(card: DeliveryCard, address: Readonly<Record<string, string>>, context: DeliveryTransportContext): Promise<TransportOutcome> {
    const agentId = address.agentId?.trim();
    if (!agentId) return 'not-capable';
    const remaining = () => Math.max(0, context.deadline - Date.now());
    if (context.signal.aborted || !remaining()) return 'not-capable';
    try {
      const discovery = await this.discover(remaining());
      const agent = discovery.agents.find(candidate => candidate.id === agentId);
      if (!agent || agent.status !== 'idle' || !remaining()) return 'failed';
      if (!await (this.opts.waitForBoundary ?? waitForPaseoWakeBoundary)(agent, remaining())) return 'failed';
      if (!await context.prepare({ messageId: context.token }) || context.signal.aborted || !remaining()) return 'not-capable';
      await (this.opts.sendWake ?? sendPaseoWake)({ agentId, prompt: card.text, messageId: context.token },
        { timeoutMs: remaining(), beforeSend: context.beforeSend, signal: context.signal });
      return 'accepted';
    } catch (error) { return error instanceof DeliveryError && !error.maybeDelivered ? 'failed' : 'unknown'; }
  }
}
