import {
  type WakeAdapter,
  type WakeAdapterResult,
  type WakeDispatchContext,
} from './delivery.js';
import { DeliveryError } from './packages/agent-delivery/src/index.js';
import { resolvePaseoDaemon } from './packages/agent-delivery/src/paseo-native.js';
import { discoverPaseoAgents, waitForPaseoWakeBoundary } from './paseo-state.js';
import { sendPaseoWake } from './wake-sink.js';

/** How a failed wake reads to the retry layer. `unknown` is never retried. */
type WakeFailureKind = 'transient' | 'rejected' | 'unknown';

/** Every send failure is a DeliveryError; only its code and certainty decide retry. */
function diagnostic(
  phase: 'discovery' | 'selection' | 'boundary' | 'send',
  address: Readonly<Record<string, string>>,
  code: string,
) {
  return {
    phase,
    code,
    // Only discovery still runs a Paseo CLI; a wake is a capability call on the shared entry.
    ...(phase === 'discovery' ? { command: 'paseo ls --global --json' } : {}),
    endpoint: resolvePaseoDaemon(undefined)?.url ?? 'unresolved',
    paseoAgentIds: [address.agentId].filter(Boolean),
    passwordPresent: Boolean(process.env.PASEO_PASSWORD),
  };
}

export interface PaseoAdapterOptions {
  discover?: typeof discoverPaseoAgents;
  waitForBoundary?: typeof waitForPaseoWakeBoundary;
  sendWake?: typeof sendPaseoWake;
}

export class PaseoAdapter implements WakeAdapter {
  readonly kind = 'paseo' as const;

  constructor(private readonly opts: PaseoAdapterOptions = {}) {}

  async dispatch(
    address: Readonly<Record<string, string>>,
    payload: string,
    beforeSend: () => Promise<boolean>,
    timeoutMs = 5000,
    context?: WakeDispatchContext,
  ): Promise<WakeAdapterResult> {
    const deadline = Date.now() + timeoutMs;
    const remainingMs = () => Math.max(0, deadline - Date.now());
    const budgetUnavailable = (): WakeAdapterResult => ({
      outcome: 'failed',
      unavailable: true,
      signature: 'dispatch_budget_exhausted',
      message: 'The wake dispatch budget elapsed before Paseo accepted the wake.',
      retainRoute: true,
    });
    const agentId = address.agentId?.trim();
    if (!agentId) {
      return {
        outcome: 'failed',
        unavailable: true,
        signature: 'invalid_address',
        message: 'Paseo route has no agent id.',
        routeStale: true,
        diagnostic: diagnostic('selection', address, 'invalid_address'),
      };
    }

    let remaining = remainingMs();
    if (remaining === 0) return budgetUnavailable();
    const discovery = (this.opts.discover ?? discoverPaseoAgents)(remaining);
    if (discovery.error && discovery.agents.length === 0) {
      return {
        outcome: 'failed',
        unavailable: true,
        // A credential or authorization refusal is proven; anything else may be transient.
        signature: /password|auth|unauthori[sz]ed/i.test(discovery.error) ? 'discovery_rejected'
          : /DAEMON_NOT_RUNNING|ECONNREFUSED|ENOENT|not found.*executable|ETIMEDOUT|timed out|timeout/i.test(discovery.error)
            ? 'discovery_transient' : 'discovery_rejected',
        message: `Paseo unavailable: ${discovery.error}`,
        diagnostic: diagnostic('discovery', address, 'unavailable'),
        retainRoute: true,
      };
    }
    const agent = discovery.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined || agent.status !== 'idle') {
      return {
        outcome: 'failed',
        unavailable: true,
        signature: agent === undefined ? 'address_not_found' : 'agent_not_idle',
        message: agent === undefined ? 'The registered Paseo agent was not found.' : 'The registered Paseo agent is not idle.',
        diagnostic: diagnostic('selection', address, agent === undefined ? 'not_found' : 'not_idle'),
        ...(agent === undefined ? {} : { retainRoute: true }),
        ...(agent === undefined ? { routeStale: true } : {}),
      };
    }

    remaining = remainingMs();
    if (remaining === 0) return budgetUnavailable();
    if (!(await (this.opts.waitForBoundary ?? waitForPaseoWakeBoundary)(agent, remaining))) {
      return {
        outcome: 'failed',
        unavailable: true,
        signature: 'boundary_unavailable',
        message: 'Paseo did not reach the current tool boundary before the wake timeout.',
        diagnostic: diagnostic('boundary', address, 'unavailable'),
        retainRoute: true,
      };
    }
    if (!(await beforeSend())) return { outcome: 'gate-rejected' };
    remaining = remainingMs();
    if (remaining === 0) return budgetUnavailable();

    try {
      await (this.opts.sendWake ?? sendPaseoWake)({
        agentId,
        prompt: payload,
        location: context?.location ?? '',
        participant: context?.participant ?? '',
        activity: context?.activity ?? '',
        ...(context?.attemptN === undefined ? {} : { attemptN: context.attemptN }),
      }, { timeoutMs: remaining });
      return { outcome: 'accepted' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind: WakeFailureKind = !(error instanceof DeliveryError) || error.maybeDelivered ? 'unknown'
        : error.code === 'unavailable' ? 'transient'
          : ['authentication_failed', 'session_not_found', 'rejected', 'invalid_arguments'].includes(error.code) ? 'rejected'
            : 'unknown';
      const details = { ...diagnostic('send', address, 'failed'), outcome: kind };
      if (kind === 'unknown') return { outcome: 'unknown', signature: 'send_unknown', message, diagnostic: details };
      return {
        outcome: 'failed',
        signature: kind === 'transient' ? 'send_pre_accept_transient' : 'send_pre_accept_rejected',
        message,
        diagnostic: details,
      };
    }
  }
}
