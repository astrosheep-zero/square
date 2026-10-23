import { nameKey, WAKE_ROUTE_KINDS, type WakeRoute, type WakeRouteKind } from './model.js';
import type { SquareRead, SquareWrite } from './ports.js';
import { canonicalPath, canonicalPathSync } from './canonical-path.js';
export { WAKE_ROUTE_KINDS } from './model.js';
export type { WakeRoute, WakeRouteKind } from './model.js';
export const ROUTE_FRESH_MS = 24 * 60 * 60 * 1000;
export type WakeBoundaryProvider = 'codex' | 'claude' | 'opencode' | 'pi' | 'paseo';
export interface WakeBoundary {
  readonly location: string;
  readonly participant: string;
  readonly sessionId: string;
  readonly provider: WakeBoundaryProvider;
}
export interface WakeRouteCapabilities {
  readonly canUse: (kind: WakeRouteKind, address: Readonly<Record<string, string>>) => boolean;
}
export async function defaultWakeRouteCapabilities(hostLedger?: import('./host-ledger.js').HostLedgerPort): Promise<WakeRouteCapabilities> {
  const available = new Set<WakeRouteKind>();
  try { const { CodexQueueAdapter } = await import('./codex-queue.js'); available.add(new CodexQueueAdapter().kind); } catch { /* optional */ }
  try { const { PaseoAdapter } = await import('./paseo-delivery.js'); available.add(new PaseoAdapter().kind); } catch { /* optional */ }
  return { canUse: (kind, address) => hostLedger !== undefined && available.has(kind) && Object.values(address).every((value) => value.trim() !== '') };
}
export function resolvePrimaryWakeRoute(boundary: WakeBoundary, env: NodeJS.ProcessEnv, capabilities: WakeRouteCapabilities): Omit<WakeRoute, 'updatedAt'> | undefined {
  const paseoAgentId = env.PASEO_AGENT_ID?.trim();
  const candidates: Array<{ kind: WakeRouteKind; address: Record<string, string> }> = [];
  if (boundary.provider === 'codex') candidates.push({ kind: 'codex-queue', address: { threadId: boundary.sessionId } });
  if (paseoAgentId) candidates.push({ kind: 'paseo', address: { agentId: paseoAgentId } });
  const chosen = candidates.find((candidate) => Object.values(candidate.address).every((value) => value.trim() !== '') && capabilities.canUse(candidate.kind, candidate.address));
  return chosen === undefined ? undefined : { location: boundary.location, participant: boundary.participant, sessionId: boundary.sessionId, channel: boundary.provider === 'paseo' ? 'paseo' : boundary.provider === 'claude' ? 'claude-code' : boundary.provider, ...chosen };
}

export function routeIdentityKey(route: Pick<WakeRoute, 'location' | 'participant' | 'sessionId'>, location = route.location): string {
  return JSON.stringify([location, nameKey(route.participant), route.sessionId]);
}
export type RouteEpoch = { readonly epoch?: number };
function sameRouteAddress(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => rightKeys[index] === key && left[key] === right[key]);
}

export function applyWakeRoute(facts: SquareWrite, route: Omit<WakeRoute, 'updatedAt'> & RouteEpoch, at = Date.now()): void {
  const location = canonicalPathSync(route.location);
  const identity = routeIdentityKey(route, location);
  facts.replaceRoutes([...facts.routes().filter((item) => routeIdentityKey(item, canonicalPathSync(item.location)) !== identity),
    { ...route, location, updatedAt: at, extra: {} }]);
}
export function dropSessionWakeRoutes(facts: SquareWrite, location: string, sessionId: string, expectedEpoch?: number): void {
  const canonical = canonicalPathSync(location);
  facts.replaceRoutes(facts.routes().filter((item) => item.sessionId !== sessionId || canonicalPathSync(item.location) !== canonical
    || (expectedEpoch !== undefined && item.epoch !== expectedEpoch)));
}

/** Keep an in-flight same-session rejoin; unknown host evidence is not a reason to retire it. */
export function dropEndedSessionWakeRoutes(
  facts: SquareWrite,
  location: string,
  sessionId: string,
  opts: { readonly expectedEpoch?: number; readonly liveParticipants?: ReadonlySet<string>; readonly force: boolean; readonly participant?: string },
): void {
  const canonical = canonicalPathSync(location);
  facts.replaceRoutes(facts.routes().filter((item) => {
    if (item.sessionId !== sessionId || canonicalPathSync(item.location) !== canonical) return true;
    if (opts.participant !== undefined && nameKey(item.participant) !== nameKey(opts.participant)) return true;
    if (!opts.force && facts.participant(item.participant)?.joined
      && (opts.liveParticipants === undefined || opts.liveParticipants.has(nameKey(item.participant)))) return true;
    return opts.expectedEpoch !== undefined && item.epoch !== opts.expectedEpoch;
  }));
}
export function dropParticipantWakeRoutes(facts: SquareWrite, location: string, participant: string): void {
  const canonical = canonicalPathSync(location);
  facts.replaceRoutes(facts.routes().filter((item) => !(nameKey(item.participant) === nameKey(participant) && canonicalPathSync(item.location) === canonical)));
}
export function sessionCanEndParticipant(facts: SquareRead, location: string, participant: string, sessionId: string, sessionIdNow?: string): boolean {
  const canonical = canonicalPathSync(location);
  const owned = facts.routes().filter((item) => nameKey(item.participant) === nameKey(participant) && canonicalPathSync(item.location) === canonical);
  if (owned.length === 0) return sessionIdNow === sessionId;
  return owned.every((item) => item.sessionId === sessionId) && (sessionIdNow === undefined || sessionIdNow === sessionId);
}

export async function publishWakeRoute(
  artifact: import('./ports.js').SquareArtifactPort,
  route: Omit<WakeRoute, 'updatedAt'> & RouteEpoch,
  opts: { at?: number; requireCurrentSession?: boolean } = {},
): Promise<void> {
  const location = await canonicalPath(route.location);
  const at = opts.at ?? Date.now();
  await artifact.transact((facts) => {
    const routes = facts.routes();
    if (opts.requireCurrentSession && (!facts.participant(route.participant)?.joined
      || routes.some((item) => nameKey(item.participant) === nameKey(route.participant) && canonicalPathSync(item.location) === location && item.sessionId !== route.sessionId))) return;
    const identity = routeIdentityKey(route, location);
    const matching = routes.filter((item) => routeIdentityKey(item, canonicalPathSync(item.location)) === identity);
    // A receiver's fresh native registration outranks a generic Paseo proposal.
    // Arbitrate in the write transaction so tool publication and mod reconciliation cannot flip it back.
    if (route.kind === 'paseo' && matching.some((item) => item.kind !== 'paseo' && item.channel === route.channel
      && item.epoch === route.epoch && item.updatedAt <= at && item.updatedAt > at - ROUTE_FRESH_MS)) return;
    const existing = matching[0];
    if (matching.length === 1 && existing.updatedAt > at - ROUTE_FRESH_MS && existing.kind === route.kind
      && existing.channel === route.channel && sameRouteAddress(existing.address, route.address) && existing.epoch === route.epoch) return;
    applyWakeRoute(facts, { ...route, location }, at);
  });
}
export async function retireWakeRouteFromArtifact(artifact: import('./ports.js').SquareArtifactPort, route: Pick<WakeRoute, 'location' | 'participant' | 'sessionId'>, opts: { readonly expectedEpoch?: number } = {}): Promise<void> {
  const location = await canonicalPath(route.location);
  const target = routeIdentityKey(route, location);
  await artifact.transact((facts) => facts.replaceRoutes(facts.routes().filter((item) =>
    routeIdentityKey(item, canonicalPathSync(item.location)) !== target || (opts.expectedEpoch !== undefined && item.epoch !== opts.expectedEpoch))));
}
