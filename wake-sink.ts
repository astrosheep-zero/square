import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadSquare } from './artifact.js';
import { leaseOwnsNotification, isDeliveryDelivered, type NotificationSink, type PendingNotification, type WakeSinkContext } from './delivery.js';
import { sessionInbox } from './inbox.js';
import { hasPresentedForOwner, presentOnce } from './presented.js';
import { lookupParticipant, type RegistryBinding } from './registry.js';
import { quoteShell } from './presentation.js';
import { isCurrentlyJoined, resolveRosterName } from './runtime.js';
import { waitForPaseoToolBoundary } from './paseo-timeline.js';

export interface PaseoAgent { id: string; name: string; status: string; cwd?: string; }
export interface PaseoOwnership { agentId: string; ownerId: string; sessionId: string; nativeGuarantee: boolean; }
export class PaseoWakeError extends Error { constructor(message: string, public readonly diagnostic?: unknown) { super(message); this.name = 'PaseoWakeError'; } }

function endpoint(): string {
  return process.env.SQUARE_PASEO_WS_URL ?? process.env.PASEO_LISTEN ?? '127.0.0.1:6767';
}

function diagnostic(phase: 'discovery' | 'selection' | 'boundary' | 'send', ownership: PaseoOwnership[], code: string) {
  return {
    phase,
    code,
    command: phase === 'discovery' ? 'paseo ls --json' : 'paseo send <agent-id> --prompt <prompt> --no-wait',
    endpoint: endpoint(),
    paseoAgentIds: ownership.map((item) => item.agentId),
    ownerIds: [...new Set(ownership.map((item) => item.ownerId))],
    passwordPresent: Boolean(process.env.PASEO_PASSWORD),
  };
}

function native(binding: RegistryBinding): boolean {
  return ['claude-code', 'codex', 'opencode', 'pi'].includes(binding.channel);
}

export function paseoOwnershipSnapshot(bindings: RegistryBinding[]): PaseoOwnership[] {
  const out = new Map<string, PaseoOwnership>();
  for (const binding of bindings) {
    if (!binding.paseoAgentId) continue;
    const owner = bindings.filter((item) => item.ownerId === binding.ownerId);
    out.set(`${binding.ownerId}\0${binding.paseoAgentId}`, {
      agentId: binding.paseoAgentId,
      ownerId: binding.ownerId,
      sessionId: owner.find(native)?.sessionId ?? binding.sessionId,
      nativeGuarantee: owner.some(native),
    });
  }
  return [...out.values()];
}

export function selectPaseoWakeAgents(ownership: PaseoOwnership[], agents: PaseoAgent[]): PaseoAgent[] {
  const ids = new Set(ownership.map((item) => item.agentId));
  return agents.filter((agent) => ids.has(agent.id) && (agent.status === 'idle' || agent.status === 'running'));
}

export function discoverPaseoAgents(timeoutMs = 5000): { agents: PaseoAgent[]; error?: string } {
  try {
    const raw = execFileSync(process.env.SQUARE_PASEO_BIN || 'paseo', ['ls', '--json'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(raw) as unknown;
    const agents = Array.isArray(parsed) ? parsed : (parsed as { agents?: unknown })?.agents;
    if (!Array.isArray(agents)) return { agents: [], error: 'Paseo returned malformed agent inventory.' };
    return { agents: agents.filter((item): item is PaseoAgent => item !== null && typeof item === 'object' && typeof (item as PaseoAgent).id === 'string' && typeof (item as PaseoAgent).status === 'string') };
  } catch (error) {
    return { agents: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function send(agentId: string, prompt: string): void {
  const result = spawnSync(process.env.SQUARE_PASEO_BIN || 'paseo', ['send', agentId, '--prompt', prompt, '--no-wait'], { stdio: 'ignore', timeout: 5000, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`paseo send exited with ${result.status ?? 'no status'}`);
}

function catchCommand(squarePath: string, recipient: string): string {
  return `square --as ${quoteShell(recipient)} --square-path ${quoteShell(squarePath)} catch --now`;
}

function prompt(notification: PendingNotification, squarePath: string, nativeWake: boolean): string {
  const display = squarePath.startsWith(homedir()) ? `~${squarePath.slice(homedir().length)}` : squarePath;
  const body = notification.item.body.length > 200 ? `${notification.item.body.slice(0, 197)}...` : notification.item.body;
  return [
    '<system-reminder source="square">',
    `${notification.route === 'bell' ? 'Bell' : notification.route === 'beside' ? 'Beside' : 'Mention'} from @${notification.item.actor} in \`${display}\``,
    nativeWake ? 'The native adapter will present it at the next boundary.' : `> ${body.replace(/\n/g, '\n> ')}`,
    `\`${catchCommand(squarePath, notification.recipient)}\``,
    '</system-reminder>',
  ].join('\n');
}

async function waitForCatch(squarePath: string, recipient: string, notification: PendingNotification, ownerId: string): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const doc = loadSquare(squarePath);
    if (isDeliveryDelivered(doc, recipient, notification.item.index)) return true;
    const binding = lookupParticipant(squarePath, recipient).find((item) => item.ownerId === ownerId);
    const lease = binding && sessionInbox(binding.sessionId).find((item) => item.name === recipient)?.catchLease;
    if (!lease || lease.expiresAt <= Date.now()) return false;
    await sleep(Math.min(250, lease.expiresAt - Date.now()));
  }
  return false;
}

export async function dispatchPaseoNotification(notification: PendingNotification, ctx: WakeSinkContext): Promise<void> {
  const initial = loadSquare(ctx.squarePath);
  const recipient = resolveRosterName(initial, notification.recipient);
  if (!recipient || !isCurrentlyJoined(initial.acts, recipient)) return;
  const bindings = lookupParticipant(ctx.squarePath, recipient);
  const ownership = paseoOwnershipSnapshot(bindings);
  if (ownership.length === 0) return;
  const discovery = discoverPaseoAgents();
  if (discovery.error && discovery.agents.length === 0) {
    throw new PaseoWakeError(`Paseo unavailable: ${discovery.error}`, diagnostic('discovery', ownership, 'unavailable'));
  }
  const active = selectPaseoWakeAgents(ownership, discovery.agents);
  if (active.length === 0) {
    throw new PaseoWakeError('No registered Paseo agent is idle or running.', diagnostic('selection', ownership, 'not_active'));
  }
  let boundaryTimedOut = false;
  for (const agent of active) {
    const owner = ownership.find((item) => item.agentId === agent.id);
    if (!owner || hasPresentedForOwner(owner.ownerId, ctx.squarePath, recipient, notification.item.index)) continue;
    if (agent.status === 'running' && !(await waitForPaseoToolBoundary(agent.id))) {
      boundaryTimedOut = true;
      continue;
    }
    const latest = loadSquare(ctx.squarePath);
    if (!isCurrentlyJoined(latest.acts, recipient) || isDeliveryDelivered(latest, recipient, notification.item.index)) return;
    const current = lookupParticipant(ctx.squarePath, recipient).find((item) => item.ownerId === owner.ownerId && item.paseoAgentId === owner.agentId);
    if (!current) continue;
    const activeCatch = sessionInbox(current.sessionId).find((item) => item.name === recipient)?.catchLease;
    if (activeCatch && leaseOwnsNotification(activeCatch, { actor: notification.item.actor, body: notification.item.body, route: notification.route, recipient })) {
      if (await waitForCatch(ctx.squarePath, recipient, notification, owner.ownerId)) return;
    }
    if (owner.nativeGuarantee) {
      try { send(agent.id, prompt({ ...notification, recipient }, ctx.squarePath, true)); }
      catch (error) { throw new PaseoWakeError(error instanceof Error ? error.message : String(error), diagnostic('send', ownership, 'failed')); }
      return;
    }
    presentOnce(current.sessionId, (id) => sessionInbox(id).map((item) => ({ ...item, notifications: item.notifications.filter((note) => note.actIndex === notification.item.index) })).filter((item) => item.notifications.length > 0), () => {
      try { send(agent.id, prompt({ ...notification, recipient }, ctx.squarePath, false)); }
      catch (error) { throw new PaseoWakeError(error instanceof Error ? error.message : String(error), diagnostic('send', ownership, 'failed')); }
      return true;
    });
    return;
  }
  if (boundaryTimedOut) throw new PaseoWakeError('Paseo did not reach the current tool boundary before the wake timeout.', diagnostic('boundary', ownership, 'timeout'));
}

export function paseoWakeSink(): NotificationSink { return { name: 'paseo', dispatch: dispatchPaseoNotification }; }
export function defaultWakeSinks(): NotificationSink[] { return process.env.SQUARE_DISABLE_PASEO_WAKE === '1' ? [] : [paseoWakeSink()]; }
