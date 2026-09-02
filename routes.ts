import fs from 'node:fs';
import path from 'node:path';
import { nameKey } from './model.js';
import { WAKE_ROUTE_KINDS, type WakeRoute, type WakeRouteKind } from './model.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { isCurrentlyJoined } from './runtime.js';
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
  let userCapable = hostLedger !== undefined;
  if (hostLedger !== undefined) {
    try { await hostLedger.listPresence({ scopes: ['user'], now: Date.now() }); } catch { userCapable = false; }
  }
  const available = new Set<WakeRouteKind>();
  try { const { CodexQueueAdapter } = await import('./codex-queue.js'); available.add(new CodexQueueAdapter().kind); } catch { /* optional */ }
  try { const { PaseoAdapter } = await import('./paseo-delivery.js'); available.add(new PaseoAdapter().kind); } catch { /* optional */ }
  return { canUse: (kind, address) => userCapable && available.has(kind) && Object.values(address).every((value) => value.trim() !== '') };
}
function nativeCandidate(boundary: WakeBoundary): { kind: WakeRouteKind; address: Record<string, string> } | undefined {
  if (boundary.provider === 'codex') return { kind: 'codex-queue', address: { threadId: boundary.sessionId } };
  if (boundary.provider === 'claude') return { kind: 'claude-native', address: { sessionId: boundary.sessionId } };
  if (boundary.provider === 'opencode') return { kind: 'opencode-server', address: { sessionId: boundary.sessionId } };
  if (boundary.provider === 'pi') return { kind: 'pi-extension', address: { sessionId: boundary.sessionId } };
  return undefined;
}
export function selectPrimaryWakeRoute(input: { readonly boundary: WakeBoundary; readonly env: NodeJS.ProcessEnv; readonly capabilities: WakeRouteCapabilities }): Omit<WakeRoute, 'updatedAt'> | undefined {
  const { boundary, env, capabilities } = input;
  const paseoAgentId = env.PASEO_AGENT_ID?.trim();
  const candidates: Array<{ kind: WakeRouteKind; address: Record<string, string> }> = [];
  if (paseoAgentId) candidates.push({ kind: 'paseo', address: { agentId: paseoAgentId } });
  const native = nativeCandidate(boundary);
  if (native) candidates.push(native);
  const chosen = candidates.find((candidate) => Object.values(candidate.address).every((value) => value.trim() !== '') && capabilities.canUse(candidate.kind, candidate.address));
  return chosen === undefined ? undefined : { location: boundary.location, participant: boundary.participant, sessionId: boundary.sessionId, channel: boundary.provider === 'paseo' ? 'paseo' : boundary.provider === 'claude' ? 'claude-code' : boundary.provider, ...chosen };
}

export function routeIdentityKey(route: Pick<WakeRoute, 'location' | 'participant' | 'sessionId'>, location = route.location): string {
  return JSON.stringify([location, nameKey(route.participant), route.sessionId]);
}
export function resolvePrimaryWakeRoute(boundary: WakeBoundary, env: NodeJS.ProcessEnv, capabilities: WakeRouteCapabilities): Omit<WakeRoute, 'updatedAt'> | undefined {
  return selectPrimaryWakeRoute({ boundary, env, capabilities });
}

async function withArtifact<T>(location: string | undefined, fn: (square: import('./open-square.js').OpenSquare) => Promise<T>): Promise<T | undefined> {
  if (location === undefined) return undefined;
  try {
    await fs.promises.access(location);
    const square = await openSquare(location);
    try { return await fn(square); } finally { await closeOpenSquare(square); }
  } catch { return undefined; }
}
export async function readWakeRoutes(opts: { location?: string; participant?: string; sessionId?: string; freshOnly?: boolean; now?: number; env?: NodeJS.ProcessEnv } = {}): Promise<WakeRoute[]> {
  const now = opts.now ?? Date.now();
  const canonicalLocation = opts.location === undefined ? undefined : await canonicalRouteLocation(opts.location);
  const routes = await withArtifact(canonicalLocation, async (square) => (await square.artifact.read()).state.routes ?? []) ?? [];
  const filtered = routes.filter((route) => (opts.participant === undefined || nameKey(route.participant) === nameKey(opts.participant)) && (opts.sessionId === undefined || route.sessionId === opts.sessionId) && (!opts.freshOnly || now - route.updatedAt < ROUTE_FRESH_MS));
  const canonicalized = await Promise.all(filtered.map(async (route) => ({ ...route, location: await canonicalRouteLocation(route.location), address: { ...route.address } })));
  return canonicalLocation === undefined ? canonicalized : canonicalized.filter((route) => route.location === canonicalLocation);
}
export async function upsertWakeRoute(route: Omit<WakeRoute, 'updatedAt'>, opts: { at?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  const location = await canonicalRouteLocation(route.location);
  await withArtifact(location, async (square) => publishWakeRoute(square.artifact, { ...route, location }, opts));
}

export type RouteEpoch = { readonly epoch?: number };
function sameRouteAddress(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => rightKeys[index] === key && left[key] === right[key]);
}
function canonicalRouteLocationSync(location: string): string {
  const absolute = path.resolve(location);
  try { return fs.realpathSync(absolute); } catch { return absolute; }
}

export function applyWakeRouteToState(state: import('./model.js').SquareState, route: Omit<WakeRoute, 'updatedAt'> & RouteEpoch, at = Date.now()): void {
  const location = canonicalRouteLocationSync(route.location);
  state.routes = [...(state.routes ?? []).filter((item) => {
    const itemLocation = canonicalRouteLocationSync(item.location);
    return !(itemLocation === location && routeIdentityKey(item, itemLocation) === routeIdentityKey(route, location));
  }), { ...route, location, updatedAt: at }];
}
export function dropSessionWakeRoutesFromState(state: import('./model.js').SquareState, location: string, sessionId: string): void {
  const canonical = canonicalRouteLocationSync(location);
  state.routes = (state.routes ?? []).filter((item) => !(item.sessionId === sessionId && canonicalRouteLocationSync(item.location) === canonical));
}
export function dropParticipantWakeRoutesFromState(state: import('./model.js').SquareState, location: string, participant: string): void {
  const canonical = canonicalRouteLocationSync(location);
  state.routes = (state.routes ?? []).filter((item) => !(nameKey(item.participant) === nameKey(participant) && canonicalRouteLocationSync(item.location) === canonical));
}
export function sessionOwnsParticipantRoutes(state: import('./model.js').SquareState, location: string, participant: string, sessionId: string): boolean {
  const canonical = canonicalRouteLocationSync(location);
  const owned = (state.routes ?? []).filter((item) => nameKey(item.participant) === nameKey(participant) && canonicalRouteLocationSync(item.location) === canonical);
  return owned.length > 0 && owned.every((item) => item.sessionId === sessionId);
}
export function sessionCanEndParticipant(state: import('./model.js').SquareState, location: string, participant: string, sessionId: string, currentSessionId?: string): boolean {
  const canonical = canonicalRouteLocationSync(location);
  const owned = (state.routes ?? []).filter((item) => nameKey(item.participant) === nameKey(participant) && canonicalRouteLocationSync(item.location) === canonical);
  if (owned.length === 0) return currentSessionId === sessionId;
  return owned.every((item) => item.sessionId === sessionId) && (currentSessionId === undefined || currentSessionId === sessionId);
}

export async function publishWakeRoute(
  artifact: import('./ports.js').SquareArtifactPort,
  route: Omit<WakeRoute, 'updatedAt'> & RouteEpoch,
  opts: { at?: number; requireCurrentSession?: boolean } = {},
): Promise<void> {
  const location = await canonicalRouteLocation(route.location);
  const at = opts.at ?? Date.now();
  await artifact.transact((state) => {
    if (opts.requireCurrentSession) {
      const participantRoutes = (state.routes ?? []).filter((item) => nameKey(item.participant) === nameKey(route.participant) && canonicalRouteLocationSync(item.location) === location);
      if (!isCurrentlyJoined(state.acts, route.participant) || participantRoutes.some((item) => item.sessionId !== route.sessionId)) return { state, result: undefined };
    }
    const identity = routeIdentityKey({ ...route, location });
    const matching = (state.routes ?? []).filter((item) => routeIdentityKey(item, canonicalRouteLocationSync(item.location)) === identity);
    const existing = matching[0];
    const existingEpoch = (existing as (WakeRoute & RouteEpoch) | undefined)?.epoch;
    const epochMatches = route.epoch === undefined ? existingEpoch === undefined : existingEpoch === route.epoch;
    if (matching.length === 1 && existing !== undefined && existing.updatedAt > at - ROUTE_FRESH_MS && existing.kind === route.kind && existing.channel === route.channel && sameRouteAddress(existing.address, route.address) && epochMatches) return { result: undefined };
    return { state: { ...state, routes: [...(state.routes ?? []).filter((item) => routeIdentityKey(item, canonicalRouteLocationSync(item.location)) !== identity), { ...route, location, updatedAt: at }] }, result: undefined };
  });
}
export async function retireWakeRoute(route: WakeRoute, opts: { at?: number; env?: NodeJS.ProcessEnv; expectedEpoch?: number } = {}): Promise<void> {
  const location = await canonicalRouteLocation(route.location);
  await withArtifact(location, async (square) => retireWakeRouteFromArtifact(square.artifact, { ...route, location }, opts));
}
export async function retireWakeRouteFromArtifact(artifact: import('./ports.js').SquareArtifactPort, route: Pick<WakeRoute, 'location' | 'participant' | 'sessionId'>, opts: { readonly expectedEpoch?: number } = {}): Promise<void> {
  const location = await canonicalRouteLocation(route.location);
  const target = routeIdentityKey({ ...route, location });
  await artifact.transact((state) => ({ state: { ...state, routes: (state.routes ?? []).filter((item) => {
    const itemLocation = canonicalRouteLocationSync(item.location);
    if (routeIdentityKey(item, itemLocation) !== target) return true;
    const itemEpoch = (item as WakeRoute & RouteEpoch).epoch;
    return opts.expectedEpoch !== undefined && itemEpoch !== opts.expectedEpoch;
  }) }, result: undefined }));
}
export async function retireWakeRoutesForSessionFromArtifact(artifact: import('./ports.js').SquareArtifactPort, route: Pick<WakeRoute, 'location' | 'sessionId'>): Promise<void> {
  await artifact.transact((state) => { dropSessionWakeRoutesFromState(state, route.location, route.sessionId); return { state, result: undefined }; });
}
export async function canonicalRouteLocation(location: string): Promise<string> {
  return canonicalRouteLocationSync(location);
}
