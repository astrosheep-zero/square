/** Machine-local participant discovery cache. */

import path from 'node:path';
import { homedir } from 'node:os';

import { nameKey, sameName, SquareError, type StoredAct } from './model.js';
import { isCurrentlyJoined } from './runtime.js';
import { squareAssignedParticipantName as computeSquareAssignedParticipantName } from './participant-identity.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { HostLedgerPort, HostLedgerScope, PresenceRecord } from './host-ledger.js';

export type SessionChannel = 'claude-code' | 'codex' | 'opencode' | 'pi' | 'paseo' | 'unknown';
export interface RegistryBinding { sessionId: string; name: string; squarePath: string; channel: SessionChannel; child: boolean; route?: PresenceRecord['route']; updatedAt: number; }
export interface RegistryWriteOptions { channel?: SessionChannel; child?: boolean; route?: PresenceRecord['route']; at?: number; env?: NodeJS.ProcessEnv; }

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCAL_SESSION_SOURCES: ReadonlyArray<{ variable: 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID' | 'OPENCODE_SESSION_ID' | 'SQUARE_PI_SESSION_ID'; channel: Exclude<SessionChannel, 'paseo' | 'unknown'>; child?: 'CLAUDE_CODE_CHILD_SESSION'; }> = [
  { variable: 'CLAUDE_CODE_SESSION_ID', channel: 'claude-code', child: 'CLAUDE_CODE_CHILD_SESSION' },
  { variable: 'CODEX_THREAD_ID', channel: 'codex' },
  { variable: 'OPENCODE_SESSION_ID', channel: 'opencode' },
  { variable: 'SQUARE_PI_SESSION_ID', channel: 'pi' },
];

export function registryPath(env: NodeJS.ProcessEnv = process.env): string { return env.SQUARE_REGISTRY || path.join(homedir(), '.square', 'sessions.ndjsonl'); }
export async function canonicalSquarePath(squarePath: string): Promise<string> { const absolute = path.resolve(squarePath); try { return await (await import('node:fs/promises')).realpath(absolute); } catch { return absolute; } }
function ledger(env: NodeJS.ProcessEnv, writableScope: HostLedgerScope = 'local'): HostLedgerPort { const root = path.dirname(registryPath(env)); return createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? (env.SQUARE_REGISTRY ? root : path.join(homedir(), '.square', 'host-ledger')), localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? (env.SQUARE_REGISTRY ? root : path.join(process.cwd(), '.square', 'host-ledger')), writableScope }); }
function toBinding(record: PresenceRecord): RegistryBinding { return { sessionId: record.session, name: record.participant, squarePath: record.location, channel: record.channel, child: false, ...(record.route === undefined ? {} : { route: record.route }), updatedAt: record.updatedAt ?? 0 }; }
async function activeBindings(now: number, env: NodeJS.ProcessEnv): Promise<RegistryBinding[]> { return (await ledger(env).listPresence({ now, scopes: ['user', 'local'] })).map(toBinding).sort((a, b) => b.updatedAt - a.updatedAt); }
async function writePresence(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions, done: boolean, scope: HostLedgerScope = 'local'): Promise<void> { if (!sessionId || !name || !squarePath) return; const env = options.env ?? process.env; const channel = options.channel ?? 'unknown'; const port = ledger(env, scope); const location = await canonicalSquarePath(squarePath); if (done) await port.removePresence({ location, participant: name, session: sessionId, channel }); else await port.ensurePresence({ location, participant: name, session: sessionId, channel, updatedAt: options.at ?? Date.now() }); }
export function recordJoin(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> { return writePresence(sessionId, name, squarePath, options, false); }
export async function recordDone(sessionId: string, name: string, squarePath: string, options: RegistryWriteOptions = {}): Promise<void> {
  await writePresence(sessionId, name, squarePath, options, true);
  await writePresence(sessionId, name, squarePath, options, true, 'user');
}
export async function readActiveBindings(now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RegistryBinding[]> { try { return await activeBindings(now, env); } catch { return []; } }
export async function lookupSessionBindings(sessionId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RegistryBinding[]> { return (await readActiveBindings(now, env)).filter((binding) => binding.sessionId === sessionId); }
export async function lookupSession(sessionId: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<Array<{ name: string; squarePath: string }>> { return (await lookupSessionBindings(sessionId, now, env)).map(({ name, squarePath }) => ({ name, squarePath })); }
export async function lookupParticipant(squarePath: string, name: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<RegistryBinding[]> { const canonicalPath = await canonicalSquarePath(squarePath); return (await readActiveBindings(now, env)).filter((binding) => binding.squarePath === canonicalPath && sameName(binding.name, name)); }
export async function localParticipantOwner(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string | undefined> { const sessionIds = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); if (sessionIds.size === 0) return undefined; return (await lookupParticipant(squarePath, name, now, env)).find((binding) => sessionIds.has(binding.sessionId))?.sessionId; }
export async function localParticipantName(squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> { const canonicalPath = await canonicalSquarePath(squarePath); const names = new Set((await Promise.all(localSessionIdentities(env).map(async (identity) => (await lookupSession(identity.sessionId, Date.now(), env)).filter((item) => item.squarePath === canonicalPath).map((item) => item.name)))).flat()); return names.size === 1 ? [...names][0] : undefined; }
export function squareAssignedParticipantName(env: NodeJS.ProcessEnv = process.env): string | undefined { return computeSquareAssignedParticipantName(env); }
export type CurrentParticipantBinding = Readonly<{ created: boolean; sessionId: string }>;
export async function claimSessionParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<{ readonly status: 'acquired' | 'owned'; readonly sessionId: string } | undefined> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return undefined;
  const location = await canonicalSquarePath(squarePath);
  const result = await ledger(env).claimPresence({ location, participant: name, session: identity.sessionId, channel: identity.channel, updatedAt: Date.now() }, 'local');
  if (result.status === 'busy') throw new SquareError('already_joined', `${name} is already bound to another session`);
  if (result.status === 'degraded') throw result.error;
  return { status: result.status, sessionId: identity.sessionId };
}
export async function releaseSessionParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const identity = localSessionIdentities(env)[0];
  if (identity === undefined) return;
  await ledger(env).removePresence({ location: squarePath, participant: name, session: identity.sessionId, channel: identity.channel });
}
export async function bindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<CurrentParticipantBinding> { if (squareAssignedParticipantName(env) !== name) throw new SquareError('invalid_args', `The current session is not assigned ${name}`); const sessionId = await localParticipantOwner(squarePath, name, env); if (sessionId !== undefined) return { created: false, sessionId }; if ((await lookupParticipant(squarePath, name, Date.now(), env)).at(0) !== undefined) throw new SquareError('already_joined', `${name} is already bound to another session`); await recordLocalJoin(name, squarePath, env); const currentSessionId = await localParticipantOwner(squarePath, name, env); if (currentSessionId === undefined) throw new Error(`Current participant binding did not commit for ${name}`); return { created: true, sessionId: currentSessionId }; }
export async function unbindCurrentParticipant(squarePath: string, name: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name, Date.now(), env)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordSessionDone(binding.sessionId, binding.name, binding.squarePath, binding.channel, env); return current.length > 0; }
export interface RegistryPruneResult { removed: number; kept: number; }
function bindingIsProvablyObsolete(binding: RegistryBinding, acts: StoredAct[] | undefined): boolean { return acts !== undefined && !isCurrentlyJoined(acts, binding.name); }
export async function pruneRegistry(readActs: (squarePath: string) => StoredAct[] | undefined | Promise<StoredAct[] | undefined>, now = Date.now()): Promise<RegistryPruneResult> { const active = await readActiveBindings(now); let removed = 0; for (const binding of active) { if (!bindingIsProvablyObsolete(binding, await readActs(binding.squarePath))) continue; await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at: now }); removed++; } return { removed, kept: active.length - removed }; }
export interface LocalSessionIdentity { sessionId: string; channel: SessionChannel; child: boolean; paseoAgentId?: string; }
function addLocalSession(identities: LocalSessionIdentity[], sessionId: string | undefined, channel: SessionChannel, child: boolean, paseoAgentId: string | undefined): void { if (!sessionId || identities.some((identity) => identity.sessionId === sessionId)) return; identities.push({ sessionId, channel, child, ...(paseoAgentId ? { paseoAgentId } : {}) }); }
export function localSessionIdentities(env: NodeJS.ProcessEnv = process.env): LocalSessionIdentity[] { const paseoAgentId = env.PASEO_AGENT_ID?.trim() || undefined; const identities: LocalSessionIdentity[] = []; for (const source of LOCAL_SESSION_SOURCES) addLocalSession(identities, env[source.variable]?.trim(), source.channel, source.child !== undefined && env[source.child] === '1', paseoAgentId); addLocalSession(identities, paseoAgentId, 'paseo', false, paseoAgentId); return identities; }
export function hasAutomaticDeliveryIdentity(env: NodeJS.ProcessEnv = process.env): boolean { return localSessionIdentities(env).length > 0; }
export async function recordLocalJoin(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = localSessionIdentities(env); const current = await lookupParticipant(squarePath, name, at, env); for (const identity of identities) { for (const binding of current.filter((item) => item.sessionId === identity.sessionId)) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); await recordJoin(identity.sessionId, name, squarePath, { ...identity, at, env }); } }
export async function recordLocalDone(name: string, squarePath: string, env: NodeJS.ProcessEnv = process.env): Promise<void> { const at = Date.now(); const identities = new Set(localSessionIdentities(env).map((identity) => identity.sessionId)); const current = (await lookupParticipant(squarePath, name, at, env)).filter((binding) => identities.has(binding.sessionId)); for (const binding of current) await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); }
export async function recordSessionJoin(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<string> { const at = Date.now(); const current = (await lookupParticipant(squarePath, name, at, env)).filter((binding) => binding.sessionId === sessionId); for (const binding of current) { await recordDone(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }); await writePresence(binding.sessionId, binding.name, binding.squarePath, { channel: binding.channel, at, env }, true, 'user'); } await recordJoin(sessionId, name, squarePath, { channel, at, env }); await writePresence(sessionId, name, squarePath, { channel, at, env }, false, 'user'); return sessionId; }
export async function recordSessionDone(sessionId: string, name: string, squarePath: string, channel: SessionChannel, env: NodeJS.ProcessEnv = process.env): Promise<boolean> { const canonicalPath = await canonicalSquarePath(squarePath); const binding = (await lookupSessionBindings(sessionId, Date.now(), env)).find((item) => item.squarePath === canonicalPath && sameName(item.name, name) && item.channel === channel); if (binding === undefined) return false; const options = { channel, at: Date.now(), env }; await recordDone(sessionId, binding.name, binding.squarePath, options); await writePresence(sessionId, binding.name, binding.squarePath, options, true, 'user'); return true; }
