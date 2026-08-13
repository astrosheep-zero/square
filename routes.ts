import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WAKE_ROUTE_KINDS = ['paseo'] as const;

export type WakeRouteKind = typeof WAKE_ROUTE_KINDS[number];

export interface WakeRoute {
  ownerId: string;
  sessionId: string;
  kind: WakeRouteKind;
  address: Record<string, string>;
  updatedAt: number;
}

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
const VALID_KINDS = new Set<string>(WAKE_ROUTE_KINDS);

export function routesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_ROUTES || path.join(os.homedir(), '.square', 'routes.ndjsonl');
}

export function isWakeRouteKind(value: unknown): value is WakeRouteKind {
  return typeof value === 'string' && VALID_KINDS.has(value);
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
    .sort((a, b) => b.updatedAt - a.updatedAt);
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

export function refreshPaseoRoute(ownerId: string, env: NodeJS.ProcessEnv = process.env, at = Date.now()): void {
  const paseoAgentId = env.PASEO_AGENT_ID?.trim();
  if (paseoAgentId) {
    upsertWakeRoute({ ownerId, sessionId: paseoAgentId, kind: 'paseo', address: { agentId: paseoAgentId } }, { at, env });
  }
}
