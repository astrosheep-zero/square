import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SQUARE_IDENTITY } from './identity.js';
import type { SessionChannel } from './registry.js';

export interface AdapterHeartbeat {
  ownerId: string;
  sessionId: string;
  channel: SessionChannel;
  adapterVersion: string;
  updatedAt: number;
}

interface HeartbeatRow {
  v: 1;
  ts: number;
  owner_id: string;
  session_id: string;
  channel: SessionChannel;
  adapter_version: string;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const COALESCE_MS = 10 * 60 * 1000;
const VALID_CHANNELS = new Set<SessionChannel>(['claude-code', 'codex', 'opencode', 'pi', 'paseo', 'unknown']);

export function heartbeatsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_HEARTBEATS || path.join(os.homedir(), '.square', 'heartbeats.ndjsonl');
}

function heartbeatKey(ownerId: string, sessionId: string): string {
  return `${ownerId}\0${sessionId}`;
}

function parseRow(raw: string, now: number): HeartbeatRow | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Partial<HeartbeatRow>;
  if (
    row.v !== 1 || typeof row.ts !== 'number' || !Number.isFinite(row.ts) || row.ts > now || now - row.ts > RETENTION_MS ||
    typeof row.owner_id !== 'string' || row.owner_id === '' ||
    typeof row.session_id !== 'string' || row.session_id === '' ||
    typeof row.channel !== 'string' || !VALID_CHANNELS.has(row.channel as SessionChannel) ||
    typeof row.adapter_version !== 'string' || row.adapter_version === ''
  ) return undefined;
  return row as HeartbeatRow;
}

export function readAdapterHeartbeats(
  opts: { ownerId?: string; now?: number; env?: NodeJS.ProcessEnv } = {}
): AdapterHeartbeat[] {
  const now = opts.now ?? Date.now();
  let raw: string;
  try { raw = fs.readFileSync(heartbeatsPath(opts.env ?? process.env), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const state = new Map<string, HeartbeatRow>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const row = parseRow(line, now);
    if (!row) continue;
    const key = heartbeatKey(row.owner_id, row.session_id);
    const current = state.get(key);
    if (current === undefined || row.ts >= current.ts) state.set(key, row);
  }
  return [...state.values()]
    .filter((row) => opts.ownerId === undefined || row.owner_id === opts.ownerId)
    .map((row) => ({ ownerId: row.owner_id, sessionId: row.session_id, channel: row.channel, adapterVersion: row.adapter_version, updatedAt: row.ts }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function recordAdapterHeartbeat(
  heartbeat: Omit<AdapterHeartbeat, 'adapterVersion' | 'updatedAt'> & { adapterVersion?: string },
  opts: { at?: number; env?: NodeJS.ProcessEnv } = {}
): boolean {
  const at = opts.at ?? Date.now();
  const env = opts.env ?? process.env;
  const latest = readAdapterHeartbeats({ ownerId: heartbeat.ownerId, now: at, env })
    .find((item) => item.sessionId === heartbeat.sessionId);
  if (latest && at - latest.updatedAt < COALESCE_MS) return false;
  const file = heartbeatsPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    v: 1,
    ts: at,
    owner_id: heartbeat.ownerId,
    session_id: heartbeat.sessionId,
    channel: heartbeat.channel,
    adapter_version: heartbeat.adapterVersion ?? SQUARE_IDENTITY.packageVersion,
  } satisfies HeartbeatRow)}\n`, { mode: 0o600 });
  return true;
}
