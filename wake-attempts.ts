import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { withFileLock } from './file-lock.js';
import { isWakeRouteKind, nameKey, type WakeRoute, type WakeRouteKind } from './model.js';
import { canonicalSquarePath } from './registry.js';
import { formatActivityId, parseActivityId } from './square-core.js';

export type WakeOutcome = 'accepted' | 'unknown' | 'failed';

export interface WakeAttention {
  squarePath: string;
  actIndex: number;
  recipient: string;
}

export interface WakeAttempt {
  at: number;
  attention: WakeAttention;
  routeKind: WakeRouteKind;
  outcome: WakeOutcome;
  signature?: string;
  attemptN: number;
  message?: string;
  diagnostic?: unknown;
}

export interface WakeDispatchLease {
  readonly leaseId: string;
  readonly expiresAt: number;
  readonly phase: 'claimed' | 'dispatching';
  readonly routeKind?: WakeRouteKind;
  readonly attemptN?: number;
}

export type WakeDispatchClaim =
  | { readonly type: 'acquired'; readonly leaseId: string }
  | { readonly type: 'busy' }
  | { readonly type: 'ambiguous'; readonly lease: WakeDispatchLease };

interface WakeAttemptRow {
  v: 1;
  ts: number;
  attention: { square_path: string; act_id: string; recipient: string };
  route_kind: WakeRouteKind;
  outcome: WakeOutcome;
  signature?: string;
  attempt_n: number;
  message?: string;
  diagnostic?: unknown;
}

interface WakeClaimRow extends WakeDispatchLease {
  v: 1;
  ts: number;
  attention_key: string;
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_RETRY_MS = 10;
const VALID_OUTCOMES = new Set<WakeOutcome>(['accepted', 'unknown', 'failed']);

export function wakeAttemptsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_WAKE_ATTEMPTS || path.join(os.homedir(), '.square', 'wake-attempts.ndjsonl');
}

/** Host-owned, cross-process wake claim ledger. It is never part of SquareState. */
export function wakeClaimsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_WAKE_CLAIMS || `${wakeAttemptsPath(env)}.claims`;
}

export async function wakeAttentionKey(attention: WakeAttention): Promise<string> {
  return JSON.stringify([await canonicalSquarePath(attention.squarePath), formatActivityId(attention.actIndex), nameKey(attention.recipient)]);
}

function parseRow(raw: string, now: number): WakeAttemptRow | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Partial<WakeAttemptRow>;
  if (
    row.v !== 1 || typeof row.ts !== 'number' || !Number.isFinite(row.ts) || row.ts > now || now - row.ts > RETENTION_MS ||
    row.attention === undefined || typeof row.attention.square_path !== 'string' || row.attention.square_path === '' ||
    typeof row.attention.act_id !== 'string' || parseActivityId(row.attention.act_id) === undefined ||
    typeof row.attention.recipient !== 'string' || row.attention.recipient === '' ||
    typeof row.outcome !== 'string' || !VALID_OUTCOMES.has(row.outcome as WakeOutcome) ||
    typeof row.attempt_n !== 'number' || !Number.isInteger(row.attempt_n) || row.attempt_n <= 0 ||
    !isWakeRouteKind(row.route_kind) ||
    (row.signature !== undefined && typeof row.signature !== 'string') ||
    (row.outcome !== 'accepted' && (typeof row.signature !== 'string' || row.signature === '')) ||
    (row.message !== undefined && typeof row.message !== 'string')
  ) return undefined;
  return row as WakeAttemptRow;
}

async function readRowsFromFile(filePath: string, now: number): Promise<WakeAttemptRow[]> {
  let raw: string;
  try { raw = await fs.promises.readFile(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').filter(Boolean).map((line) => parseRow(line, now)).filter((row): row is WakeAttemptRow => row !== undefined);
}

async function readRows(env: NodeJS.ProcessEnv, now: number): Promise<WakeAttemptRow[]> {
  return readRowsFromFile(wakeAttemptsPath(env), now);
}

async function writeRows(filePath: string, rows: WakeAttemptRow[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), {
    mode: 0o600,
  });
  await fs.promises.rename(temporary, filePath);
}

function parseClaimRow(raw: string, now: number): WakeClaimRow | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Partial<WakeClaimRow>;
  if (
    row.v !== 1 || typeof row.ts !== 'number' || !Number.isFinite(row.ts) || now - row.ts > RETENTION_MS ||
    typeof row.attention_key !== 'string' || row.attention_key === '' ||
    typeof row.leaseId !== 'string' || row.leaseId === '' || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) ||
    (row.phase !== 'claimed' && row.phase !== 'dispatching') ||
    (row.routeKind !== undefined && !isWakeRouteKind(row.routeKind)) ||
    (row.attemptN !== undefined && (!Number.isSafeInteger(row.attemptN) || row.attemptN < 1))
  ) return undefined;
  if (row.phase === 'dispatching' && (row.routeKind === undefined || row.attemptN === undefined)) return undefined;
  return row as WakeClaimRow;
}

async function readClaimRows(filePath: string, now: number): Promise<WakeClaimRow[]> {
  let raw: string;
  try { raw = await fs.promises.readFile(filePath, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').filter(Boolean).map((line) => parseClaimRow(line, now)).filter((row): row is WakeClaimRow => row !== undefined);
}

async function writeClaimRows(filePath: string, rows: WakeClaimRow[]): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), { mode: 0o600 });
  await fs.promises.rename(temporary, filePath);
}

export async function claimWakeDispatch(
  attention: WakeAttention,
  leaseId: string,
  leaseMs: number,
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now(),
): Promise<WakeDispatchClaim> {
  const file = wakeClaimsPath(env);
  const key = await wakeAttentionKey(attention);
  return withFileLock(`${file}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, async () => {
    const rows = await readClaimRows(file, at);
    const existing = rows.find((row) => row.attention_key === key);
    if (existing?.phase === 'dispatching') return { type: 'ambiguous', lease: existing };
    if (existing !== undefined && existing.expiresAt > at) return { type: 'busy' };
    const next: WakeClaimRow = { v: 1, ts: at, attention_key: key, leaseId, expiresAt: at + leaseMs, phase: 'claimed' };
    await writeClaimRows(file, [...rows.filter((row) => row.attention_key !== key), next]);
    return { type: 'acquired', leaseId };
  });
}

export async function transitionWakeDispatch(
  attention: WakeAttention,
  leaseId: string,
  phase: WakeDispatchLease['phase'],
  leaseMs: number,
  routeKind: WakeRouteKind | undefined,
  attemptN: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now(),
): Promise<boolean> {
  const file = wakeClaimsPath(env);
  const key = await wakeAttentionKey(attention);
  return withFileLock(`${file}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, async () => {
    const rows = await readClaimRows(file, at);
    const current = rows.find((row) => row.attention_key === key);
    if (current?.leaseId !== leaseId) return false;
    const next: WakeClaimRow = { v: 1, ts: at, attention_key: key, leaseId, expiresAt: at + leaseMs, phase, ...(routeKind === undefined ? {} : { routeKind }), ...(attemptN === undefined ? {} : { attemptN }) };
    await writeClaimRows(file, [...rows.filter((row) => row.attention_key !== key), next]);
    return true;
  });
}

export async function releaseWakeDispatch(attention: WakeAttention, leaseId: string, env: NodeJS.ProcessEnv = process.env, at = Date.now()): Promise<void> {
  const file = wakeClaimsPath(env);
  const key = await wakeAttentionKey(attention);
  await withFileLock(`${file}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, async () => {
    const rows = await readClaimRows(file, at);
    await writeClaimRows(file, rows.filter((row) => row.attention_key !== key || row.leaseId !== leaseId));
  });
}

async function fromRow(row: WakeAttemptRow): Promise<WakeAttempt> {
  const actIndex = parseActivityId(row.attention.act_id);
  if (actIndex === undefined) throw new Error(`Invalid wake activity id: ${row.attention.act_id}`);
  return {
    at: row.ts,
    attention: {
      squarePath: await canonicalSquarePath(row.attention.square_path),
      actIndex,
      recipient: row.attention.recipient,
    },
    routeKind: row.route_kind,
    outcome: row.outcome,
    ...(row.signature === undefined ? {} : { signature: row.signature }),
    attemptN: row.attempt_n,
    ...(row.message === undefined ? {} : { message: row.message }),
    ...(row.diagnostic === undefined ? {} : { diagnostic: row.diagnostic }),
  };
}

export async function readWakeAttempts(
  opts: { attention?: WakeAttention; now?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<WakeAttempt[]> {
  const now = opts.now ?? Date.now();
  const expected = opts.attention === undefined ? undefined : await wakeAttentionKey(opts.attention);
  const attempts = await Promise.all((await readRows(opts.env ?? process.env, now)).map(fromRow));
  if (expected === undefined) return attempts;
  const keys = await Promise.all(attempts.map((attempt) => wakeAttentionKey(attempt.attention)));
  return attempts.filter((_, index) => keys[index] === expected);
}

export function terminalWakeEvidence(attempts: readonly WakeAttempt[]): WakeAttempt | undefined {
  return attempts.findLast((attempt) => attempt.outcome === 'accepted' || attempt.outcome === 'unknown');
}

export async function terminalWakeAttempt(
  attention: WakeAttention,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<WakeAttempt | undefined> {
  return terminalWakeEvidence(await readWakeAttempts({ attention, ...opts }));
}

export function isWakeRouteAttemptable(
  route: Pick<WakeRoute, 'kind' | 'updatedAt'>,
  attempts: readonly WakeAttempt[],
): boolean {
  if (terminalWakeEvidence(attempts) !== undefined) return false;
  const failed = attempts.findLast(
    (attempt) => attempt.routeKind === route.kind && attempt.outcome === 'failed',
  );
  return failed === undefined || route.updatedAt > failed.at;
}

export function hasAttemptableWakeRoute(
  routes: readonly Pick<WakeRoute, 'kind' | 'updatedAt'>[],
  attempts: readonly WakeAttempt[],
): boolean {
  return routes.some((route) => isWakeRouteAttemptable(route, attempts));
}

export async function nextWakeAttemptNumber(
  attention: WakeAttention,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<number> {
  return (await readWakeAttempts({ attention, ...opts })).reduce((highest, attempt) => Math.max(highest, attempt.attemptN), 0) + 1;
}

function redact(value: unknown, secret: string | undefined): unknown {
  if (typeof value === 'string') {
    const withoutKnownSecret = secret ? value.split(secret).join('[redacted]') : value;
    return withoutKnownSecret.replace(/([?&]password=)[^&\s]+/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  }
  return value;
}

async function toRow(attempt: WakeAttempt, env: NodeJS.ProcessEnv): Promise<WakeAttemptRow> {
  const safe = redact(attempt, env.PASEO_PASSWORD) as WakeAttempt;
  return {
    v: 1,
    ts: safe.at,
    attention: {
      square_path: await canonicalSquarePath(safe.attention.squarePath),
      act_id: formatActivityId(safe.attention.actIndex),
      recipient: safe.attention.recipient,
    },
    route_kind: safe.routeKind,
    outcome: safe.outcome,
    ...(safe.signature === undefined ? {} : { signature: safe.signature }),
    attempt_n: safe.attemptN,
    ...(safe.message === undefined ? {} : { message: safe.message }),
    ...(safe.diagnostic === undefined ? {} : { diagnostic: safe.diagnostic }),
  };
}

export async function recordWakeAttempt(
  attempt: Omit<WakeAttempt, 'at'> & { at?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<WakeAttempt> {
  const value = { ...attempt, at: attempt.at ?? Date.now() } as WakeAttempt;
  if (!isWakeRouteKind(value.routeKind)) throw new Error('Wake attempts require a real adapter route kind.');
  if (value.outcome !== 'accepted' && !value.signature) {
    throw new Error(`${value.outcome} wake attempts require a transport signature.`);
  }
  const file = wakeAttemptsPath(env);
  await withFileLock(`${file}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, async () => {
    await writeRows(file, [...await readRowsFromFile(file, value.at), await toRow(value, env)]);
  });
  return value;
}

export async function recordRecoveredUnknown(
  attention: WakeAttention,
  lease: { attemptN?: number; routeKind?: WakeRouteKind },
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now()
): Promise<WakeAttempt | undefined> {
  const routeKind = lease.routeKind;
  if (lease.attemptN === undefined || !isWakeRouteKind(routeKind)) return undefined;
  const file = wakeAttemptsPath(env);
  return withFileLock(`${file}.lock`, { retryMs: LOCK_RETRY_MS, staleMs: LOCK_STALE_MS }, async () => {
    const rows = await readRowsFromFile(file, at);
    const expected = await wakeAttentionKey(attention);
    const attempts: WakeAttempt[] = [];
    for (const row of rows) { const attempt = await fromRow(row); if (await wakeAttentionKey(attempt.attention) === expected) attempts.push(attempt); }
    const terminal = terminalWakeEvidence(attempts);
    if (terminal !== undefined) return terminal;
    const value: WakeAttempt = {
      at,
      attention,
      routeKind,
      outcome: 'unknown',
      signature: 'worker_interrupted_during_dispatch',
      attemptN: lease.attemptN!,
      message: 'The notification worker ended after dispatch began; transport acceptance is unknown.',
    };
    await writeRows(file, [...rows, await toRow(value, env)]);
    return value;
  });
}
