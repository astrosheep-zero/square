import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import {
  isDeliveryDelivered,
  leaseOwnsNotification,
  type WakeAdapter,
  type WakeDispatchResult,
  type WakeRequest,
} from './delivery.js';
import { sessionInbox } from './inbox.js';
import { paseoDaemonHosts, resolvePaseoDaemonTarget } from './paseo-connection.js';
import { quoteShell } from './presentation.js';
import { lookupParticipant } from './registry.js';
import type { WakeRoute } from './routes.js';
import { isCurrentlyJoined } from './runtime.js';
import { discoverPaseoAgents, waitForPaseoWakeBoundary } from './paseo-state.js';
import { PaseoWakeSendError, sendPaseoWake } from './wake-sink.js';

function endpoint(): string {
  try { return resolvePaseoDaemonTarget(paseoDaemonHosts()[0]).url; }
  catch { return 'unresolved'; }
}

function diagnostic(phase: 'discovery' | 'selection' | 'boundary' | 'send', route: WakeRoute, code: string) {
  return {
    phase,
    code,
    command: phase === 'discovery' ? 'paseo ls --global --json' : 'paseo send <agent-id> --prompt <prompt> --no-wait --json',
    endpoint: endpoint(),
    paseoAgentIds: [route.address.agentId].filter(Boolean),
    ownerIds: [route.ownerId],
    passwordPresent: Boolean(process.env.PASEO_PASSWORD),
  };
}

function catchCommand(squarePath: string, recipient: string): string {
  return `square --as ${quoteShell(recipient)} --square-path ${quoteShell(squarePath)} catch --now`;
}

function prompt(request: WakeRequest): string {
  const display = request.squarePath.startsWith(homedir())
    ? `~${request.squarePath.slice(homedir().length)}`
    : request.squarePath;
  return [
    '<system-reminder source="square">',
    `${request.route === 'bell' ? 'Bell' : request.route === 'beside' ? 'Beside' : 'Mention'} from @${request.actor} in \`${display}\``,
    'The native adapter will present it at the next boundary. If no native wake is available, pull from the square yourself.',
    `\`${catchCommand(request.squarePath, request.recipient)}\``,
    '</system-reminder>',
  ].join('\n');
}

function discoveryRetryable(message: string): boolean {
  if (/password|auth|unauthori[sz]ed/i.test(message)) return false;
  return /DAEMON_NOT_RUNNING|ECONNREFUSED|ENOENT|not found.*executable|ETIMEDOUT|timed out|timeout/i.test(message);
}

async function waitForCatch(route: WakeRoute, request: WakeRequest): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const doc = loadSquare(request.squarePath);
    if (isDeliveryDelivered(doc, request.recipient, request.actIndex)) return true;
    const binding = lookupParticipant(request.squarePath, request.recipient).find((item) => item.ownerId === route.ownerId);
    const lease = binding && sessionInbox(binding.sessionId).find((item) => item.name === request.recipient)?.catchLease;
    if (!lease || lease.expiresAt <= Date.now()) return false;
    await sleep(Math.min(250, lease.expiresAt - Date.now()));
  }
  return false;
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
    route: WakeRoute,
    request: WakeRequest,
    beforeSend: () => Promise<boolean>
  ): Promise<WakeDispatchResult> {
    const agentId = route.address.agentId?.trim();
    if (!agentId) {
      return {
        outcome: 'failed',
        signature: 'invalid_address',
        message: 'Paseo route has no agent id.',
        diagnostic: diagnostic('selection', route, 'invalid_address'),
      };
    }

    const discovery = (this.opts.discover ?? discoverPaseoAgents)();
    if (discovery.error && discovery.agents.length === 0) {
      return {
        outcome: 'failed',
        signature: discoveryRetryable(discovery.error) ? 'discovery_transient' : 'discovery_rejected',
        message: `Paseo unavailable: ${discovery.error}`,
        diagnostic: diagnostic('discovery', route, 'unavailable'),
      };
    }
    const agent = discovery.agents.find((candidate) => candidate.id === agentId);
    if (agent === undefined || (agent.status !== 'idle' && agent.status !== 'running')) {
      return {
        outcome: 'failed',
        signature: agent === undefined ? 'address_not_found' : 'agent_not_active',
        message: agent === undefined ? 'The registered Paseo agent was not found.' : 'The registered Paseo agent is not idle or running.',
        diagnostic: diagnostic('selection', route, agent === undefined ? 'not_found' : 'not_active'),
      };
    }

    if (!(await (this.opts.waitForBoundary ?? waitForPaseoWakeBoundary)(agent))) {
      return {
        outcome: 'failed',
        signature: 'boundary_unavailable',
        message: 'Paseo did not reach the current tool boundary before the wake timeout.',
        diagnostic: diagnostic('boundary', route, 'unavailable'),
      };
    }

    const binding = lookupParticipant(request.squarePath, request.recipient).find((item) => item.ownerId === route.ownerId);
    const activeCatch = binding && sessionInbox(binding.sessionId).find((item) => item.name === request.recipient)?.catchLease;
    const attentionAct = loadSquare(request.squarePath).acts.find((act) => act.index === request.actIndex);
    const body = attentionAct?.kind === 'say' ? attentionAct.body : '';
    if (
      activeCatch &&
      leaseOwnsNotification(activeCatch, {
        actor: request.actor,
        body,
        route: request.route,
        recipient: request.recipient,
      }) &&
      (await waitForCatch(route, request))
    ) return { outcome: 'cancelled' };

    const latest = loadSquare(request.squarePath);
    if (!isCurrentlyJoined(latest.acts, request.recipient) || isDeliveryDelivered(latest, request.recipient, request.actIndex)) {
      return { outcome: 'cancelled' };
    }
    if (!(await beforeSend())) return { outcome: 'cancelled' };

    try {
      (this.opts.sendWake ?? sendPaseoWake)({ agentId, prompt: prompt(request) });
      return { outcome: 'accepted' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof PaseoWakeSendError ? error.kind : 'unknown';
      const details = { ...diagnostic('send', route, 'failed'), outcome: kind };
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
