import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WAKE_ROUTE_KINDS, isWakeRouteKind, type WakeRoute, type WakeRouteKind } from './model.js';
export { isWakeRouteKind, WAKE_ROUTE_KINDS } from './model.js';
export type { WakeRoute, WakeRouteKind } from './model.js';

interface RouteRow {
  v: 1;
  ts: number;
  op: 'upsert' | 'retire';
  owner_id: string;
  session_id: string;
  kind: WakeRouteKind;
  address?: Record<string, string>;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ROUTE_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Dispatch priority doubles as the kind declaration order: native kinds
 * precede paseo. Within one kind, the freshest route wins.
 */
const ROUTE_KIND_PRIORITY: ReadonlyMap<WakeRouteKind, number> = new Map(
  WAKE_ROUTE_KINDS.map((kind, index) => [kind, index])
);
export function routesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_ROUTES || path.join(os.homedir(), '.square', 'routes.ndjsonl');
}

function routeKey(ownerId: string, kind: WakeRouteKind): string {
  return `${ownerId}\0${kind}`;
}

function stringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string');
}

function parseRow(raw: string, now: number): RouteRow | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Partial<RouteRow>;
  if (
    row.v !== 1 ||
    (row.op !== 'upsert' && row.op !== 'retire') ||
    typeof row.ts !== 'number' || !Number.isFinite(row.ts) || row.ts > now || now - row.ts > RETENTION_MS ||
    typeof row.owner_id !== 'string' || row.owner_id === '' ||
    typeof row.session_id !== 'string' || row.session_id === '' ||
    !isWakeRouteKind(row.kind)
  ) return undefined;
  if (row.op === 'upsert' && !stringRecord(row.address)) return undefined;
  return row as RouteRow;
}

function readRows(env: NodeJS.ProcessEnv, now: number): RouteRow[] {
  let raw: string;
  try { raw = fs.readFileSync(routesPath(env), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').filter(Boolean).map((line) => parseRow(line, now)).filter((row): row is RouteRow => row !== undefined);
}

export function readWakeRoutes(
  opts: { ownerId?: string; freshOnly?: boolean; now?: number; env?: NodeJS.ProcessEnv } = {}
): WakeRoute[] {
  const now = opts.now ?? Date.now();
  const state = new Map<string, RouteRow>();
  for (const row of readRows(opts.env ?? process.env, now)) {
    const key = routeKey(row.owner_id, row.kind);
    const current = state.get(key);
    if (current === undefined || row.ts >= current.ts) state.set(key, row);
  }
  return [...state.values()]
    .filter((row): row is RouteRow & { op: 'upsert'; address: Record<string, string> } => row.op === 'upsert')
    .map((row) => ({
      ownerId: row.owner_id,
      sessionId: row.session_id,
      kind: row.kind,
      address: row.address,
      updatedAt: row.ts,
    }))
    .filter((route) => opts.ownerId === undefined || route.ownerId === opts.ownerId)
    .filter((route) => opts.freshOnly !== true || now - route.updatedAt < ROUTE_FRESH_MS)
    .sort(
      (a, b) =>
        (ROUTE_KIND_PRIORITY.get(a.kind) ?? 0) - (ROUTE_KIND_PRIORITY.get(b.kind) ?? 0) ||
        b.updatedAt - a.updatedAt
    );
}

function appendRouteRow(row: RouteRow, env: NodeJS.ProcessEnv): void {
  const file = routesPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

export function upsertWakeRoute(
  route: Omit<WakeRoute, 'updatedAt'>,
  opts: { at?: number; env?: NodeJS.ProcessEnv } = {}
): void {
  const at = opts.at ?? Date.now();
  appendRouteRow({
    v: 1,
    ts: at,
    op: 'upsert',
    owner_id: route.ownerId,
    session_id: route.sessionId,
    kind: route.kind,
    address: route.address,
  }, opts.env ?? process.env);
}

export function retireOwnerWakeRoutes(
  ownerId: string,
  opts: { at?: number; env?: NodeJS.ProcessEnv } = {}
): void {
  const at = opts.at ?? Date.now();
  const env = opts.env ?? process.env;
  for (const route of readWakeRoutes({ ownerId, now: at, env })) {
    appendRouteRow({
      v: 1,
      ts: at,
      op: 'retire',
      owner_id: ownerId,
      session_id: route.sessionId,
      kind: route.kind,
    }, env);
  }
}

export interface WakeRouteEvidence {
  sessionId: string;
  address: Record<string, string>;
}

/** A provider's self-check: complete, callable endpoint evidence for one kind, or nothing. */
export type WakeRouteProbe = (env: NodeJS.ProcessEnv) => WakeRouteEvidence | undefined;

/** Publication requires a non-blank session and a non-empty address of non-blank values. */
function completeRouteEvidence(value: WakeRouteEvidence | undefined): value is WakeRouteEvidence {
  if (value === undefined || value === null) return false;
  if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') return false;
  const address = value.address;
  if (address === null || typeof address !== 'object' || Array.isArray(address)) return false;
  const entries = Object.entries(address);
  return entries.length > 0 && entries.every(([key, item]) => key.trim() !== '' && typeof item === 'string' && item.trim() !== '');
}

/**
 * One probe per kind. A probe publishes only when its provider's complete
 * endpoint evidence is present; session identity alone never publishes. The
 * four native transports have no endpoint lifecycle in this delivery, so
 * their probes publish nothing until those transports land.
 */
export const WAKE_ROUTE_PROBES: Readonly<Record<WakeRouteKind, WakeRouteProbe>> = {
  'opencode-server': () => undefined,
  'codex-app-server': () => undefined,
  'claude-native': () => undefined,
  'pi-extension': () => undefined,
  paseo: (env) => {
    const agentId = env.PASEO_AGENT_ID?.trim();
    return agentId ? { sessionId: agentId, address: { agentId } } : undefined;
  },
};

/** The kind-neutral publication loop; probes supply complete evidence per kind. */
export function publishWakeRoutesFrom(
  ownerId: string,
  probes: Readonly<Record<WakeRouteKind, WakeRouteProbe>>,
  opts: { at?: number; env?: NodeJS.ProcessEnv } = {}
): void {
  const at = opts.at ?? Date.now();
  const env = opts.env ?? process.env;
  for (const kind of WAKE_ROUTE_KINDS) {
    const evidence = probes[kind](env);
    if (!completeRouteEvidence(evidence)) continue;
    upsertWakeRoute({ ownerId, sessionId: evidence.sessionId, kind, address: evidence.address }, { at, env });
  }
}

/** Publication boundary: every route written is complete provider evidence. */
export function publishWakeRoutes(
  ownerId: string,
  opts: { at?: number; env?: NodeJS.ProcessEnv } = {}
): void {
  publishWakeRoutesFrom(ownerId, WAKE_ROUTE_PROBES, opts);
}
