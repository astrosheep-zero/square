import {
  type WakeAdapter,
  type WakeDispatchResult,
} from './delivery.js';
import { paseoDaemonHosts, resolvePaseoDaemonTarget } from './paseo-connection.js';
import { discoverPaseoAgents, waitForPaseoWakeBoundary } from './paseo-state.js';
import { PaseoWakeSendError, sendPaseoWake } from './wake-sink.js';

function endpoint(): string {
  try { return resolvePaseoDaemonTarget(paseoDaemonHosts()[0]).url; }
  catch { return 'unresolved'; }
}

function diagnostic(
  phase: 'discovery' | 'selection' | 'boundary' | 'send',
  address: Readonly<Record<string, string>>,
  code: string,
) {
  return {
    phase,
    code,
    command: phase === 'discovery' ? 'paseo ls --global --json' : 'paseo send <agent-id> --prompt <prompt> --no-wait --json',
    endpoint: endpoint(),
    paseoAgentIds: [address.agentId].filter(Boolean),
    passwordPresent: Boolean(process.env.PASEO_PASSWORD),
  };
}

function discoveryRetryable(message: string): boolean {
  if (/password|auth|unauthori[sz]ed/i.test(message)) return false;
  return /DAEMON_NOT_RUNNING|ECONNREFUSED|ENOENT|not found.*executable|ETIMEDOUT|timed out|timeout/i.test(message);
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
    beforeSend: () => Promise<boolean>
  ): Promise<WakeDispatchResult> {
    const agentId = address.agentId?.trim();
    if (!agentId) {
      return {
        outcome: 'failed',
        signature: 'invalid_address',
        message: 'Paseo route has no agent id.',
        diagnostic: diagnostic('selection', address, 'invalid_address'),
      };
    }

    const discovery = (this.opts.discover ?? discoverPaseoAgents)();
    if (discovery.error && discovery.agents.length === 0) {
      return {
        outcome: 'failed',
        signature: discoveryRetryable(discovery.error) ? 'discovery_transient' : 'discovery_rejected',
        message: `Paseo unavailable: ${discovery.error}`,
        diagnostic: diagnostic('discovery', address, 'unavailable'),
      };
    }
    const agent = discovery.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined || (agent.status !== 'idle' && agent.status !== 'running')) {
      return {
        outcome: 'failed',
        signature: agent === undefined ? 'address_not_found' : 'agent_not_active',
        message: agent === undefined ? 'The registered Paseo agent was not found.' : 'The registered Paseo agent is not idle or running.',
        diagnostic: diagnostic('selection', address, agent === undefined ? 'not_found' : 'not_active'),
      };
    }

    if (!(await (this.opts.waitForBoundary ?? waitForPaseoWakeBoundary)(agent))) {
      return {
        outcome: 'failed',
        signature: 'boundary_unavailable',
        message: 'Paseo did not reach the current tool boundary before the wake timeout.',
        diagnostic: diagnostic('boundary', address, 'unavailable'),
      };
    }
    if (!(await beforeSend())) return { outcome: 'cancelled' };

    try {
      (this.opts.sendWake ?? sendPaseoWake)({ agentId, prompt: payload });
      return { outcome: 'accepted' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof PaseoWakeSendError ? error.kind : 'unknown';
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
