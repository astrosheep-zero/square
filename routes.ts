import os from 'node:os';
import path from 'node:path';
import { WAKE_ROUTE_KINDS, type WakeRoute, type WakeRouteKind } from './model.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
export { WAKE_ROUTE_KINDS } from './model.js';
export type { WakeRoute, WakeRouteKind } from './model.js';
export const ROUTE_FRESH_MS = 24 * 60 * 60 * 1000;
function ledger(env: NodeJS.ProcessEnv) { return createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? path.join(os.homedir(), '.square', 'host-ledger'), writableScope: 'user', readableScopes: ['user'] }); }
export async function readWakeRoutes(opts: { location?: string; participant?: string; sessionId?: string; freshOnly?: boolean; now?: number; env?: NodeJS.ProcessEnv } = {}): Promise<WakeRoute[]> { const now = opts.now ?? Date.now(); const records = await ledger(opts.env ?? process.env).listPresence({ location: opts.location, participant: opts.participant, session: opts.sessionId, now, scopes: ['user'] }); return records.flatMap((record) => record.route === undefined || (opts.freshOnly === true && now - (record.updatedAt ?? 0) >= ROUTE_FRESH_MS) ? [] : [{ location: record.location, participant: record.participant, sessionId: record.session, channel: record.channel, kind: record.route.kind, address: { ...record.route.address }, updatedAt: record.updatedAt ?? 0 }]); }
export async function upsertWakeRoute(route: Omit<WakeRoute, 'updatedAt'>, opts: { at?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> { await ledger(opts.env ?? process.env).ensurePresence({ location: route.location, participant: route.participant, session: route.sessionId, channel: route.channel as import('./host-ledger.js').PresenceChannel, route: { kind: route.kind, address: route.address }, updatedAt: opts.at ?? Date.now() }); }
export async function retireWakeRoute(route: WakeRoute, opts: { at?: number; env?: NodeJS.ProcessEnv } = {}): Promise<void> { await ledger(opts.env ?? process.env).ensurePresence({ location: route.location, participant: route.participant, session: route.sessionId, channel: route.channel as import('./host-ledger.js').PresenceChannel, updatedAt: opts.at ?? Date.now() }); }
