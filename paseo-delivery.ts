import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import {
  isDeliveryDelivered,
  leaseOwnsNotification,
  type NotificationSink,
  type PendingNotification,
  type WakeSinkContext,
} from './delivery.js';
import { sessionInbox } from './inbox.js';
import { hasPresentedForOwner } from './presented.js';
import { lookupParticipant, type RegistryBinding } from './registry.js';
import { quoteShell } from './presentation.js';
import { isCurrentlyJoined, resolveRosterName } from './runtime.js';
import {
  discoverPaseoAgents,
  waitForPaseoWakeBoundary,
  type PaseoAgent,
} from './paseo-state.js';
import { PaseoWakeSendError, sendPaseoWake, type PaseoWakeRequest } from './wake-sink.js';
import { paseoDaemonHosts, resolvePaseoDaemonTarget } from './paseo-connection.js';

export class PaseoWakeError extends Error {
  constructor(
    message: string,
    public readonly diagnostic?: unknown,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'PaseoWakeError';
  }
}

interface PaseoOwnership {
  agentId: string;
  ownerId: string;
  sessionId: string;
}

function endpoint(): string {
  try { return resolvePaseoDaemonTarget(paseoDaemonHosts()[0]).url; }
  catch { return 'unresolved'; }
}

function diagnostic(
  phase: 'discovery' | 'selection' | 'boundary' | 'send',
  ownership: PaseoOwnership[],
  code: string
) {
  return {
    phase,
    code,
    command: phase === 'discovery' ? 'paseo ls --global --json' : 'paseo send <agent-id> --prompt <prompt> --no-wait --json',
    endpoint: endpoint(),
    paseoAgentIds: ownership.map((item) => item.agentId),
    ownerIds: [...new Set(ownership.map((item) => item.ownerId))],
    passwordPresent: Boolean(process.env.PASEO_PASSWORD),
  };
}

function ownershipSnapshot(bindings: RegistryBinding[]): PaseoOwnership[] {
  const out = new Map<string, PaseoOwnership>();
  for (const binding of bindings) {
    if (!binding.paseoAgentId) continue;
    out.set(`${binding.ownerId}\0${binding.paseoAgentId}`, {
      agentId: binding.paseoAgentId,
      ownerId: binding.ownerId,
      sessionId: binding.sessionId,
    });
  }
  return [...out.values()];
}

function selectActiveAgents(ownership: PaseoOwnership[], agents: PaseoAgent[]): PaseoAgent[] {
  const ids = new Set(ownership.map((item) => item.agentId));
  return agents.filter((agent) => ids.has(agent.id) && (agent.status === 'idle' || agent.status === 'running'));
}

function discoveryFailureIsRetryable(message: string): boolean {
  return /DAEMON_NOT_RUNNING|ECONNREFUSED|ENOENT|not found.*executable/i.test(message) &&
    !/ETIMEDOUT|timed out|timeout/i.test(message);
}

function catchCommand(squarePath: string, recipient: string): string {
  return `square --as ${quoteShell(recipient)} --square-path ${quoteShell(squarePath)} catch --now`;
}

function prompt(notification: PendingNotification, squarePath: string): string {
  const display = squarePath.startsWith(homedir()) ? `~${squarePath.slice(homedir().length)}` : squarePath;
  return [
    '<system-reminder source="square">',
    `${notification.route === 'bell' ? 'Bell' : notification.route === 'beside' ? 'Beside' : 'Mention'} from @${notification.item.actor} in \`${display}\``,
    'The native adapter will present it at the next boundary. If no native wake is available, pull from the square yourself.',
    `\`${catchCommand(squarePath, notification.recipient)}\``,
    '</system-reminder>',
  ].join('\n');
}

async function waitForCatch(squarePath: string, recipient: string, actIndex: number, ownerId: string): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const doc = loadSquare(squarePath);
    if (isDeliveryDelivered(doc, recipient, actIndex)) return true;
    const binding = lookupParticipant(squarePath, recipient).find((item) => item.ownerId === ownerId);
    const lease = binding && sessionInbox(binding.sessionId).find((item) => item.name === recipient)?.catchLease;
    if (!lease || lease.expiresAt <= Date.now()) return false;
    await sleep(Math.min(250, lease.expiresAt - Date.now()));
  }
  return false;
}

function send(
  request: PaseoWakeRequest,
  ownership: PaseoOwnership[],
  sendWake: (request: PaseoWakeRequest) => void
): void {
  try {
    sendWake(request);
  } catch (error) {
    throw new PaseoWakeError(
      error instanceof Error ? error.message : String(error),
      {
        ...diagnostic('send', ownership, 'failed'),
        outcome: error instanceof PaseoWakeSendError ? error.kind : 'unknown',
      },
      error instanceof PaseoWakeSendError && error.kind === 'retryable'
    );
  }
}

interface PaseoDispatchOptions {
  discover?: typeof discoverPaseoAgents;
  waitForBoundary?: typeof waitForPaseoWakeBoundary;
  sendWake?: typeof sendPaseoWake;
}

export async function dispatchPaseoNotification(
  notification: PendingNotification,
  ctx: WakeSinkContext,
  opts: PaseoDispatchOptions = {}
): Promise<void> {
  const initial = loadSquare(ctx.squarePath);
  const recipient = resolveRosterName(initial, notification.recipient);
  if (!recipient || !isCurrentlyJoined(initial.acts, recipient)) return;
  const ownership = ownershipSnapshot(lookupParticipant(ctx.squarePath, recipient));
  if (ownership.length === 0) return;

  const discovery = (opts.discover ?? discoverPaseoAgents)();
  if (discovery.error && discovery.agents.length === 0) {
    throw new PaseoWakeError(
      `Paseo unavailable: ${discovery.error}`,
      diagnostic('discovery', ownership, 'unavailable'),
      discoveryFailureIsRetryable(discovery.error)
    );
  }
  const active = selectActiveAgents(ownership, discovery.agents);
  if (active.length === 0) {
    throw new PaseoWakeError(
      'No registered Paseo agent is idle or running.',
      diagnostic('selection', ownership, 'not_active'),
      true
    );
  }

  let boundaryTimedOut = false;
  for (const agent of active) {
    const owner = ownership.find((item) => item.agentId === agent.id);
    if (!owner || hasPresentedForOwner(owner.ownerId, ctx.squarePath, recipient, notification.item.index)) continue;
    if (!(await (opts.waitForBoundary ?? waitForPaseoWakeBoundary)(agent))) {
      boundaryTimedOut = true;
      continue;
    }

    const latest = loadSquare(ctx.squarePath);
    if (
      !isCurrentlyJoined(latest.acts, recipient) ||
      isDeliveryDelivered(latest, recipient, notification.item.index) ||
      hasPresentedForOwner(owner.ownerId, ctx.squarePath, recipient, notification.item.index)
    ) return;
    const current = lookupParticipant(ctx.squarePath, recipient).find(
      (item) => item.ownerId === owner.ownerId && item.paseoAgentId === owner.agentId
    );
    if (!current) continue;
    const activeCatch = sessionInbox(current.sessionId).find((item) => item.name === recipient)?.catchLease;
    if (
      activeCatch &&
      leaseOwnsNotification(activeCatch, {
        actor: notification.item.actor,
        body: notification.item.body,
        route: notification.route,
        recipient,
      }) &&
      (await waitForCatch(ctx.squarePath, recipient, notification.item.index, owner.ownerId))
    ) {
      return;
    }

    if (
      isDeliveryDelivered(loadSquare(ctx.squarePath), recipient, notification.item.index) ||
      hasPresentedForOwner(owner.ownerId, ctx.squarePath, recipient, notification.item.index)
    ) return;
    const request = {
      agentId: agent.id,
      prompt: prompt({ ...notification, recipient }, ctx.squarePath),
    } satisfies PaseoWakeRequest;
    send(request, ownership, opts.sendWake ?? sendPaseoWake);
    return;
  }
  if (boundaryTimedOut) {
    throw new PaseoWakeError(
      'Paseo did not reach the current tool boundary before the wake timeout.',
      diagnostic('boundary', ownership, 'timeout'),
      false
    );
  }
}

export function paseoWakeSink(): NotificationSink {
  return { name: 'paseo', dispatch: dispatchPaseoNotification };
}

export function defaultWakeSinks(): NotificationSink[] {
  return process.env.SQUARE_DISABLE_PASEO_WAKE === '1' ? [] : [paseoWakeSink()];
}
