/** Machine-local participant discovery cache. */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { nameKey, sameName, SquareError, type StoredAct } from './model.js';
import { isCurrentlyJoined } from './runtime.js';
import { publishWakeRoutes, retireOwnerWakeRoutes } from './routes.js';
import { squareAssignedParticipantName as computeSquareAssignedParticipantName } from './participant-identity.js';

export type SessionChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface RegistryBinding { sessionId: string; name: string; squarePath: string; channel: SessionChannel; child: boolean; paseoAgentId?: string; ownerId: string; updatedAt: number; }
export interface RegistryWriteOptions { channel?: SessionChannel; child?: boolean; paseoAgentId?: string; ownerId?: string; at?: number; }
interface RegistryLine { v: 1; ts: string; op: 'join' | 'done'; channel: SessionChannel; session_id: string; name: string; square_path: string; child?: true; paseo_agent_id?: string; owner_id?: string; }

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COMPACT_BYTES = 64 * 1024;
const COMPACT_LINES = 1000;
const VALID_CHANNELS = new Set<SessionChannel>(['claude-code', 'codex', 'opencode', 'pi', 'paseo', 'unknown']);
const LOCAL_SESSION_SOURCES: ReadonlyArray<{ variable: 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID' | 'OPENCODE_SESSION_ID' | 'SQUARE_PI_SESSION_ID'; channel: Exclude<SessionChannel, 'paseo' | 'unknown'>; child?: 'CLAUDE_CODE_CHILD_SESSION'; }> = [
  { variable: 'CLAUDE_CODE_SESSION_ID', channel: 'claude-code', child: 'CLAUDE_CODE_CHILD_SESSION' },
  { variable: 'CODEX_THREAD_ID', channel: 'codex' },
  { variable: 'OPENCODE_SESSION_ID', channel: 'opencode' },
  { variable: 'SQUARE_PI_SESSION_ID', channel: 'pi' },
];

export function registryPath(): string { return process.env.SQUARE_REGISTRY || path.join(homedir(), '.square', 'sessions.ndjsonl'); }
export async function canonicalSquarePath(squarePath: string): Promise<string> { const absolute = path.resolve(squarePath); try { return await fs.realpath(absolute); } catch { return absolute; } }
async function bindingKey(sessionId: string, squarePath: string, name: string, channel: SessionChannel): Promise<string> { return JSON.stringify([sessionId, await canonicalSquarePath(squarePath), nameKey(name), channel]); }
async function participantKey(squarePath: string, name: string): Promise<string> { return JSON.stringify([await canonicalSquarePath(squarePath), nameKey(name)]); }
function nextOwnerId(): string { return randomUUID(); }

function parseLine(raw: string, now: number): RegistryLine | undefined {
  let value: unknown; try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const entry = value as Partial<RegistryLine> & { v?: unknown };
  if ((entry.v !== undefined && entry.v !== 1) || (entry.op !== 'join' && entry.op !== 'done') || typeof entry.session_id !== 'string' || entry.session_id === '' || typeof entry.name !== 'string' || entry.name === '' || typeof entry.square_path !== 'string' || entry.square_path === '' || typeof entry.ts !== 'string') return undefined;
  const updatedAt = Date.parse(entry.ts);
  if (!Number.isFinite(updatedAt) || updatedAt > now || now - updatedAt > MAX_AGE_MS) return undefined;
  const channel = entry.channel ?? 'unknown';
  if (!VALID_CHANNELS.has(channel) || (entry.child !== undefined && entry.child !== true) || (entry.paseo_agent_id !== undefined && typeof entry.paseo_agent_id !== 'string') || (entry.owner_id !== undefined && typeof entry.owner_id !== 'string')) return undefined;
  return { ...entry, v: 1, channel } as RegistryLine;
}

async function foldRegistry(raw: string, now: number): Promise<RegistryBinding[]> {
  const state = new Map<string, { entry: RegistryLine; updatedAt: number; ownerId: string }>();
  const owners = new Map<string, string>(); let order = 0;
  for (const line of raw.split('\n')) { if (!line.trim()) continue; const entry = parseLine(line, now); if (!entry) continue; order++; const ownerId = entry.owner_id ?? `legacy:${order}`; state.set(await bindingKey(entry.session_id, entry.square_path, entry.name, entry.channel), { entry, updatedAt: Date.parse(entry.ts), ownerId }); if (entry.op === 'join') owners.set(await participantKey(entry.square_path, entry.name), ownerId); }
  const active: RegistryBinding[] = [];
  for (const { entry, updatedAt, ownerId } of state.values()) { if (entry.op !== 'join' || owners.get(await participantKey(entry.square_path, entry.name)) !== ownerId) continue; active.push({ sessionId: entry.session_id, name: entry.name, squarePath: await canonicalSquarePath(entry.square_path), channel: entry.channel, child: entry.child === true, ...(entry.paseo_agent_id ? { paseoAgentId: entry.paseo_agent_id } : {}), ownerId, updatedAt }); }
  return active.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function writeRegistryBindings(filePath: string, bindings: RegistryBinding[]): Promise<void> { const compacted = bindings.slice().reverse().map((binding) => JSON.stringify({ v: 1, ts: new Date(binding.updatedAt).toISOString(), op: 'join', channel: binding.channel, session_id: binding.sessionId, name: binding.name, square_path: binding.squarePath, ...(binding.child ? { child: true } : {}), ...(binding.paseoAgentId ? { paseo_agent_id: binding.paseoAgentId } : {}), owner_id: binding.ownerId } satisfies RegistryLine)).join('\n'); const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`; await fs.writeFile(temporary, compacted === '' ? '' : `${compacted}\n`, { mode: 0o600 }); await fs.rename(temporary, filePath); }
async function maybeCompactRegistry(filePath: string, now: number): Promise<void> { let stat; try { stat = await fs.stat(filePath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; } if (stat.size <= COMPACT_BYTES) return; const raw = await fs.readFile(filePath, 'utf8'); if (stat.size > COMPACT_BYTES || raw.split('\n').filter(Boolean).length > COMPACT_LINES) await writeRegistryBindings(filePath, await foldRegistry(raw, now)); }
async function appendRegistryLine(entry: RegistryLine, now: number): Promise<void> { const filePath = registryPath(); await fs.mkdir(path.dirname(filePath), { recursive: true }); await maybeCompactRegistry(filePath, now); await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }); }
async function writeLifecycle(op: RegistryLine['op'], sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions): Promise<void> { if (!sessionId || !name || !squarePath) return; const at = options.at ?? Date.now(); if (!Number.isFinite(at)) return; try { await appendRegistryLine({ v: 1, ts: new Date(at).toISOString(), op, channel: options.channel ?? 'unknown', session_id: sessionId, name, square_path: await canonicalSquarePath(squarePath), ...(options.child ? { child: true } : {}), ...(options.paseoAgentId ? { paseo_agent_id: options.paseoAgentId } : {}), ...(op === 'join' ? { owner_id: options.ownerId ?? nextOwnerId() } : {}) }, at); } catch (error) { process.stderr.write(`! square registry write failed: ${error instanceof Error ? error.message : String(error)}\n`); } }
export function recordJoin(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> { return writeLifecycle('join', sessionId, name, squarePath, options); }
export function recordDone(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> { return writeLifecycle('done', sessionId, name, squarePath, options); }
export async function readActiveBindings(now = Date.now()): Promise<RegistryBinding[]> { try { return await foldRegistry(await fs.readFile(registryPath(), 'utf8'), now); } catch { return []; } }
export async function lookupSessionBindings(sessionId: string, now = Date.now()): Promise<RegistryBinding[]> { return (await readActiveBindings(now)).filter((binding) => binding.sessionId === sessionId); }
export async function lookupSession(sessionId: string, now = Date.now()): Promise<Array<{ name: string; squarePath: string }>> { return (await lookupSessionBindings(sessionId, now)).map(({ name, squarePath }) => ({ name, squarePath })); }
export async function lookupParticipant(squarePath: string, name: string, now = Date.now()): Promise<RegistryBinding[]> { const canonicalPath = await canonicalSquarePath(squarePath); return (await readActiveBindings(now)).filter((binding) => binding.squarePath === canonicalPath && sameName(binding.name, name)); }
export async function localParticipantOwner(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string | undefined> { const sessionIds = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); if (sessionIds.size === 0) return undefined; return (await lookupParticipant(squarePath, name, now)).find((binding) => sessionIds.has(binding.sessionId))?.ownerId; }
export async function localParticipantName(squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> { const canonicalPath = await canonicalSquarePath(squarePath); const names = new Set((await Promise.all(localSessionIdentities(env).map(async (identity) => (await lookupSession(identity.sessionId)).filter((item) => item.squarePath === canonicalPath).map((item) => item.name)))).flat()); return names.size === 1 ? [...names][0] : undefined; }
export function squareAssignedParticipantName(env: NodeJS.ProcessEnv = process.env): string | undefined { return computeSquareAssignedParticipantName(env); }
export type CurrentParticipantBinding = Readonly<{ created: boolean; ownerId: string }>;
export async function bindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<CurrentParticipantBinding> { if (squareAssignedParticipantName(env) !== name) throw new SquareError('invalid_args', `The current session is not assigned ${name}`); const localOwner = await localParticipantOwner(squarePath, name, env); if (localOwner !== undefined) return { created: false, ownerId: localOwner }; if ((await lookupParticipant(squarePath, name)).at(0) !== undefined) throw new SquareError('already_joined', `${name} is already bound to another session`); await recordLocalJoin(name, squarePath, env); const ownerId = await localParticipantOwner(squarePath, name, env); if (ownerId === undefined) throw new Error(`Current participant binding did not commit for ${name}`); return { created: true, ownerId }; }
export async function unbindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordSessionDone(binding.sessionId, binding.name, binding.squarePath, binding.channel, env); return current.length > 0; }
export interface RegistryPruneResult { removed: number; kept: number; }
function bindingIsProvablyObsolete(binding: RegistryBinding, acts: StoredAct[] | undefined): boolean { return acts !== undefined && !isCurrentlyJoined(acts, binding.name); }
export async function pruneRegistry(readActs: (squarePath: string) => StoredAct[] | undefined | Promise<StoredAct[] | undefined>, now = Date.now()): Promise<RegistryPruneResult> { const filePath = registryPath(); let raw: string; try { raw = await fs.readFile(filePath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, kept: 0 }; throw error; } const active = await foldRegistry(raw, now); const observed = await Promise.all(active.map(async (binding) => ({ binding, acts: await readActs(binding.squarePath) }))); const kept = observed.filter(({ binding, acts }) => !bindingIsProvablyObsolete(binding, acts)).map(({ binding }) => binding); await writeRegistryBindings(filePath, kept); return { removed: active.length - kept.length, kept: kept.length }; }
export interface LocalSessionIdentity { sessionId: string; channel: SessionChannel; child: boolean; paseoAgentId?: string; }
function addLocalSession(identities: LocalSessionIdentity[], sessionId: string | undefined, channel: SessionChannel, child: boolean, paseoAgentId: string | undefined): void { if (!sessionId || identities.some((identity) => identity.sessionId === sessionId)) return; identities.push({ sessionId, channel, child, ...(paseoAgentId ? { paseoAgentId } : {}) }); }
export function localSessionIdentities(env: NodeJS.ProcessEnv = process.env): LocalSessionIdentity[] { const paseoAgentId = env.PASEO_AGENT_ID?.trim() || undefined; const identities: LocalSessionIdentity[] = []; for (const source of LOCAL_SESSION_SOURCES) addLocalSession(identities, env[source.variable]?.trim(), source.channel, source.child !== undefined && env[source.child] === '1', paseoAgentId); addLocalSession(identities, paseoAgentId, 'paseo', false, paseoAgentId); return identities; }
export function hasAutomaticDeliveryIdentity(env: NodeJS.ProcessEnv = process.env): boolean { return localSessionIdentities(env).length > 0; }
export async function recordLocalJoin(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = localSessionIdentities(env); const current = await lookupParticipant(squarePath, name, at); const ownerId = nextOwnerId(); for (const binding of current) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, child: binding.child, ...(binding.paseoAgentId ? { paseoAgentId: binding.paseoAgentId } : {}), at }); for (const identity of identities) await recordJoin(identity.sessionId, name, squarePath, { ...identity, at, ownerId }); await publishWakeRoutes(ownerId, { at, env }); for (const previousOwnerId of new Set(current.map((binding) => binding.ownerId))) if (previousOwnerId !== ownerId) await retireOwnerWakeRoutes(previousOwnerId, { at, env }); }
export async function recordLocalDone(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const current = await lookupParticipant(squarePath, name, at); for (const binding of current) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, child: binding.child, ...(binding.paseoAgentId ? { paseoAgentId: binding.paseoAgentId } : {}), at }); for (const ownerId of new Set(current.map((binding) => binding.ownerId))) await retireOwnerWakeRoutes(ownerId, { at, env }); }
export async function recordSessionJoin(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<string> { const at = Date.now(); const ownerId = nextOwnerId(); const current = await lookupParticipant(squarePath, name, at); for (const binding of current) { await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, child: binding.child, ...(binding.paseoAgentId ? { paseoAgentId: binding.paseoAgentId } : {}), at }); await retireOwnerWakeRoutes(binding.ownerId, { at, env }); } await recordJoin(sessionId, name, squarePath, { channel, at, ownerId }); await publishWakeRoutes(ownerId, { at, env }); return ownerId; }
export async function recordSessionDone(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const canonicalPath = await canonicalSquarePath(squarePath); const binding = (await lookupSessionBindings(sessionId)).find((item) => item.squarePath === canonicalPath && sameName(item.name, name) && item.channel === channel); if (binding === undefined) return false; const at = Date.now(); await recordDone(sessionId, binding.name, binding.squarePath, { channel, at }); const remaining = (await lookupParticipant(squarePath, binding.name, at)).some((candidate) => candidate.ownerId === binding.ownerId); if (!remaining) await retireOwnerWakeRoutes(binding.ownerId, { at, env }); return true; }
