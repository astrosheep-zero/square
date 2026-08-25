/**
 * Machine-local participant discovery cache.
 *
 * The Square artifact remains authoritative for membership. This append-only
 * cache only maps native harness sessions and optional Paseo agent ids back to
 * active (square path, participant name) pairs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { nameKey, sameName, type StoredAct } from './model.js';
import { isCurrentlyJoined } from './runtime.js';
import { publishWakeRoutes, retireOwnerWakeRoutes } from './routes.js';

export type SessionChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';

export interface RegistryBinding {
  sessionId: string;
  name: string;
  squarePath: string;
  channel: SessionChannel;
  child: boolean;
  paseoAgentId?: string;
  ownerId: string;
  updatedAt: number;
}

export interface RegistryWriteOptions {
  channel?: SessionChannel;
  child?: boolean;
  paseoAgentId?: string;
  ownerId?: string;
  at?: number;
}

interface RegistryLine {
  v: 1;
  ts: string;
  op: 'join' | 'done';
  channel: SessionChannel;
  session_id: string;
  name: string;
  square_path: string;
  child?: true;
  paseo_agent_id?: string;
  owner_id?: string;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COMPACT_BYTES = 64 * 1024;
const COMPACT_LINES = 1000;
const VALID_CHANNELS = new Set<SessionChannel>(['claude-code', 'codex', 'opencode', 'pi', 'paseo', 'unknown']);
const LOCAL_SESSION_SOURCES: ReadonlyArray<{
  variable: 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID' | 'OPENCODE_SESSION_ID' | 'SQUARE_PI_SESSION_ID';
  channel: Exclude<SessionChannel, 'paseo' | 'unknown'>;
  child?: 'CLAUDE_CODE_CHILD_SESSION';
}> = [
  { variable: 'CLAUDE_CODE_SESSION_ID', channel: 'claude-code', child: 'CLAUDE_CODE_CHILD_SESSION' },
  { variable: 'CODEX_THREAD_ID', channel: 'codex' },
  { variable: 'OPENCODE_SESSION_ID', channel: 'opencode' },
  { variable: 'SQUARE_PI_SESSION_ID', channel: 'pi' },
];

export function registryPath(): string {
  if (process.env['SQUARE_REGISTRY']) return process.env['SQUARE_REGISTRY'];
  return path.join(homedir(), '.square', 'sessions.ndjsonl');
}

export function canonicalSquarePath(squarePath: string): string {
  const absolute = path.resolve(squarePath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function bindingKey(sessionId: string, squarePath: string, name: string, channel: SessionChannel): string {
  return JSON.stringify([sessionId, canonicalSquarePath(squarePath), nameKey(name), channel]);
}

function participantKey(squarePath: string, name: string): string {
  return JSON.stringify([canonicalSquarePath(squarePath), nameKey(name)]);
}

function nextOwnerId(): string {
  return randomUUID();
}

function parseLine(raw: string, now: number): RegistryLine | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const entry = value as Partial<RegistryLine> & { v?: unknown };
  if (
    (entry.v !== undefined && entry.v !== 1) ||
    (entry.op !== 'join' && entry.op !== 'done') ||
    typeof entry.session_id !== 'string' ||
    entry.session_id === '' ||
    typeof entry.name !== 'string' ||
    entry.name === '' ||
    typeof entry.square_path !== 'string' ||
    entry.square_path === '' ||
    typeof entry.ts !== 'string'
  ) {
    return undefined;
  }
  const updatedAt = Date.parse(entry.ts);
  if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > MAX_AGE_MS) return undefined;
  const channel = entry.channel ?? 'unknown';
  if (!VALID_CHANNELS.has(channel)) return undefined;
  if (entry.child !== undefined && entry.child !== true) return undefined;
  if (entry.paseo_agent_id !== undefined && typeof entry.paseo_agent_id !== 'string') return undefined;
  if (entry.owner_id !== undefined && typeof entry.owner_id !== 'string') return undefined;
  return { ...entry, v: 1, channel } as RegistryLine;
}

function foldRegistry(raw: string, now: number): RegistryBinding[] {
  const state = new Map<string, { entry: RegistryLine; updatedAt: number; ownerId: string }>();
  // A later claim replaces the participant's prior agent, while one claim may retain multiple adapter identities.
  const owners = new Map<string, string>();
  let order = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const entry = parseLine(line, now);
    if (!entry) continue;
    order++;
    const ownerId = entry.owner_id ?? `legacy:${order}`;
    state.set(bindingKey(entry.session_id, entry.square_path, entry.name, entry.channel), {
      entry,
      updatedAt: Date.parse(entry.ts),
      ownerId,
    });
    if (entry.op === 'join') owners.set(participantKey(entry.square_path, entry.name), ownerId);
  }

  const active: RegistryBinding[] = [];
  for (const { entry, updatedAt, ownerId } of state.values()) {
    if (entry.op !== 'join') continue;
    if (owners.get(participantKey(entry.square_path, entry.name)) !== ownerId) continue;
    active.push({
      sessionId: entry.session_id,
      name: entry.name,
      squarePath: canonicalSquarePath(entry.square_path),
      channel: entry.channel,
      child: entry.child === true,
      ...(entry.paseo_agent_id ? { paseoAgentId: entry.paseo_agent_id } : {}),
      ownerId,
      updatedAt,
    });
  }
  return active.sort((a, b) => b.updatedAt - a.updatedAt);
}

function writeRegistryBindings(filePath: string, bindings: RegistryBinding[]): void {
  const compacted = bindings
    .slice()
    .reverse()
    .map((binding) =>
      JSON.stringify({
        v: 1,
        ts: new Date(binding.updatedAt).toISOString(),
        op: 'join',
        channel: binding.channel,
        session_id: binding.sessionId,
        name: binding.name,
        square_path: binding.squarePath,
        ...(binding.child ? { child: true } : {}),
        ...(binding.paseoAgentId ? { paseo_agent_id: binding.paseoAgentId } : {}),
        owner_id: binding.ownerId,
      } satisfies RegistryLine)
    )
    .join('\n');
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, compacted === '' ? '' : `${compacted}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function compactRegistry(filePath: string, raw: string, now: number): void {
  writeRegistryBindings(filePath, foldRegistry(raw, now));
}

function maybeCompactRegistry(filePath: string, now: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stat.size <= COMPACT_BYTES) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean).length;
  if (stat.size > COMPACT_BYTES || lines > COMPACT_LINES) compactRegistry(filePath, raw, now);
}

function appendRegistryLine(entry: RegistryLine, now: number): void {
  const filePath = registryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  maybeCompactRegistry(filePath, now);
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function writeLifecycle(
  op: RegistryLine['op'],
  sessionId: string,
  name: string,
  squarePath: string,
  options: RegistryWriteOptions
): void {
  if (!sessionId || !name || !squarePath) return;
  const at = options.at ?? Date.now();
  if (!Number.isFinite(at)) return;
  try {
    appendRegistryLine(
      {
        v: 1,
        ts: new Date(at).toISOString(),
        op,
        channel: options.channel ?? 'unknown',
        session_id: sessionId,
        name,
        square_path: canonicalSquarePath(squarePath),
        ...(options.child ? { child: true } : {}),
        ...(options.paseoAgentId ? { paseo_agent_id: options.paseoAgentId } : {}),
        ...(op === 'join' ? { owner_id: options.ownerId ?? nextOwnerId() } : {}),
      },
      at
    );
  } catch (error) {
    process.stderr.write(
      `! square registry write failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

export function recordJoin(
  sessionId: string,
  name: string,
  squarePath: string,
  options: RegistryWriteOptions = {}
): void {
  writeLifecycle('join', sessionId, name, squarePath, options);
}

export function recordDone(
  sessionId: string,
  name: string,
  squarePath: string,
  options: RegistryWriteOptions = {}
): void {
  writeLifecycle('done', sessionId, name, squarePath, options);
}

function readActiveBindings(now = Date.now()): RegistryBinding[] {
  try {
    return foldRegistry(fs.readFileSync(registryPath(), 'utf8'), now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

export function lookupSessionBindings(sessionId: string, now = Date.now()): RegistryBinding[] {
  return readActiveBindings(now).filter((binding) => binding.sessionId === sessionId);
}

export function lookupSession(sessionId: string, now = Date.now()): Array<{ name: string; squarePath: string }> {
  return lookupSessionBindings(sessionId, now).map(({ name, squarePath }) => ({ name, squarePath }));
}

export function lookupParticipant(squarePath: string, name: string, now = Date.now()): RegistryBinding[] {
  const canonicalPath = canonicalSquarePath(squarePath);
  return readActiveBindings(now).filter(
    (binding) => binding.squarePath === canonicalPath && sameName(binding.name, name)
  );
}

/** Resolve the current local harness owner for a participant, if one is registered. */
export function localParticipantOwner(
  squarePath: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): string | undefined {
  const sessionIds = new Set(localSessionIdentities(env).map((identity) => identity.sessionId));
  if (sessionIds.size === 0) return undefined;
  return lookupParticipant(squarePath, name, now).find((binding) => sessionIds.has(binding.sessionId))?.ownerId;
}

export function localParticipantName(squarePath: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const identities = localSessionIdentities(env);
  const names = new Set(
    identities.flatMap((identity) => lookupSession(identity.sessionId).filter((item) => canonicalSquarePath(item.squarePath) === canonicalSquarePath(squarePath)).map((item) => item.name))
  );
  return names.size === 1 ? [...names][0] : undefined;
}

export interface RegistryPruneResult {
  removed: number;
  kept: number;
}

function bindingIsProvablyObsolete(binding: RegistryBinding, acts: StoredAct[] | undefined): boolean {
  return acts !== undefined && !isCurrentlyJoined(acts, binding.name);
}

/** Compact the registry and remove only bindings disproved by their authoritative artifact. */
export function pruneRegistry(
  readActs: (squarePath: string) => StoredAct[] | undefined,
  now = Date.now(),
): RegistryPruneResult {
  const filePath = registryPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, kept: 0 };
    throw error;
  }
  const active = foldRegistry(raw, now);
  const kept = active.filter((binding) => !bindingIsProvablyObsolete(binding, readActs(binding.squarePath)));
  writeRegistryBindings(filePath, kept);
  return { removed: active.length - kept.length, kept: kept.length };
}

export interface LocalSessionIdentity {
  sessionId: string;
  channel: SessionChannel;
  child: boolean;
  paseoAgentId?: string;
}

function addLocalSession(
  identities: LocalSessionIdentity[],
  sessionId: string | undefined,
  channel: SessionChannel,
  child: boolean,
  paseoAgentId: string | undefined
): void {
  if (!sessionId || identities.some((identity) => identity.sessionId === sessionId)) return;
  identities.push({ sessionId, channel, child, ...(paseoAgentId ? { paseoAgentId } : {}) });
}

export function localSessionIdentities(env: NodeJS.ProcessEnv = process.env): LocalSessionIdentity[] {
  const paseoAgentId = env['PASEO_AGENT_ID']?.trim() || undefined;
  const identities: LocalSessionIdentity[] = [];
  for (const source of LOCAL_SESSION_SOURCES) {
    addLocalSession(
      identities,
      env[source.variable]?.trim(),
      source.channel,
      source.child !== undefined && env[source.child] === '1',
      paseoAgentId
    );
  }
  addLocalSession(identities, paseoAgentId, 'paseo', false, paseoAgentId);
  return identities;
}

/** True when this process belongs to a harness that can deliver Square attention without a foreground catch. */
export function hasAutomaticDeliveryIdentity(env: NodeJS.ProcessEnv = process.env): boolean {
  return localSessionIdentities(env).length > 0;
}

export function recordLocalJoin(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const at = Date.now();
  const identities = localSessionIdentities(env);
  const current = lookupParticipant(squarePath, name, at);
  const ownerId = nextOwnerId();
  for (const binding of current) {
    recordDone(binding.sessionId, binding.name, binding.squarePath, {
      channel: binding.channel,
      child: binding.child,
      ...(binding.paseoAgentId ? { paseoAgentId: binding.paseoAgentId } : {}),
      at,
    });
  }
  for (const identity of identities) {
    recordJoin(identity.sessionId, name, squarePath, { ...identity, at, ownerId });
  }
  publishWakeRoutes(ownerId, { at, env });
  for (const previousOwnerId of new Set(current.map((binding) => binding.ownerId))) {
    if (previousOwnerId !== ownerId) retireOwnerWakeRoutes(previousOwnerId, { at, env });
  }
}

export function recordLocalDone(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const at = Date.now();
  const current = lookupParticipant(squarePath, name, at);
  for (const binding of current) {
    recordDone(binding.sessionId, binding.name, binding.squarePath, {
      channel: binding.channel,
      child: binding.child,
      ...(binding.paseoAgentId ? { paseoAgentId: binding.paseoAgentId } : {}),
      at,
    });
  }
  for (const ownerId of new Set(current.map((binding) => binding.ownerId))) {
    retireOwnerWakeRoutes(ownerId, { at, env });
  }
}

export function recordSessionJoin(
  sessionId: string,
  name: string,
  squarePath: string,
  channel: SessionChannel,
  env: NodeJS.ProcessEnv = process.env
): string {
  const at = Date.now();
  const ownerId = nextOwnerId();
  const current = lookupParticipant(squarePath, name, at);
  for (const binding of current) {
    recordDone(binding.sessionId, binding.name, binding.squarePath, {
      channel: binding.channel,
      child: binding.child,
      ...(binding.paseoAgentId ? { paseoAgentId: binding.paseoAgentId } : {}),
      at,
    });
    retireOwnerWakeRoutes(binding.ownerId, { at, env });
  }
  recordJoin(sessionId, name, squarePath, { channel, at, ownerId });
  publishWakeRoutes(ownerId, { at, env });
  return ownerId;
}

export function recordSessionDone(
  sessionId: string,
  name: string,
  squarePath: string,
  channel: SessionChannel,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const binding = lookupSessionBindings(sessionId).find(
    (item) => canonicalSquarePath(item.squarePath) === canonicalSquarePath(squarePath)
      && sameName(item.name, name)
      && item.channel === channel
  );
  if (binding === undefined) return false;
  const at = Date.now();
  recordDone(sessionId, binding.name, binding.squarePath, { channel, at });
  const remaining = lookupParticipant(squarePath, binding.name, at)
    .some((candidate) => candidate.ownerId === binding.ownerId);
  if (!remaining) retireOwnerWakeRoutes(binding.ownerId, { at, env });
  return true;
}
