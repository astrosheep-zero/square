import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { nameKey, type NotifyLease } from './model.js';
import { canonicalSquarePath } from './registry.js';
import { isWakeRouteKind, type WakeRoute, type WakeRouteKind } from './routes.js';

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

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const VALID_OUTCOMES = new Set<WakeOutcome>(['accepted', 'unknown', 'failed']);
const lockWait = new Int32Array(new SharedArrayBuffer(4));

export function wakeAttemptsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_WAKE_ATTEMPTS || path.join(os.homedir(), '.square', 'wake-attempts.ndjsonl');
}

export function wakeAttentionKey(attention: WakeAttention): string {
  return JSON.stringify([canonicalSquarePath(attention.squarePath), `act_${attention.actIndex}`, nameKey(attention.recipient)]);
}

function parseRow(raw: string, now: number): WakeAttemptRow | undefined {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (value === null || typeof value !== 'object') return undefined;
  const row = value as Partial<WakeAttemptRow>;
  if (
    row.v !== 1 || typeof row.ts !== 'number' || !Number.isFinite(row.ts) || row.ts > now || now - row.ts > RETENTION_MS ||
    row.attention === undefined || typeof row.attention.square_path !== 'string' || row.attention.square_path === '' ||
    typeof row.attention.act_id !== 'string' || !/^act_\d+$/.test(row.attention.act_id) ||
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

function readRows(env: NodeJS.ProcessEnv, now: number): WakeAttemptRow[] {
  let raw: string;
  try { raw = fs.readFileSync(wakeAttemptsPath(env), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').filter(Boolean).map((line) => parseRow(line, now)).filter((row): row is WakeAttemptRow => row !== undefined);
}

function fromRow(row: WakeAttemptRow): WakeAttempt {
  return {
    at: row.ts,
    attention: {
      squarePath: canonicalSquarePath(row.attention.square_path),
      actIndex: Number(row.attention.act_id.slice(4)),
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

export function readWakeAttempts(
  opts: { attention?: WakeAttention; now?: number; env?: NodeJS.ProcessEnv } = {}
): WakeAttempt[] {
  const now = opts.now ?? Date.now();
  const expected = opts.attention === undefined ? undefined : wakeAttentionKey(opts.attention);
  return readRows(opts.env ?? process.env, now)
    .map(fromRow)
    .filter((attempt) => expected === undefined || wakeAttentionKey(attempt.attention) === expected);
}

export function terminalWakeEvidence(attempts: readonly WakeAttempt[]): WakeAttempt | undefined {
  return attempts.findLast((attempt) => attempt.outcome === 'accepted' || attempt.outcome === 'unknown');
}

export function terminalWakeAttempt(
  attention: WakeAttention,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {}
): WakeAttempt | undefined {
  return terminalWakeEvidence(readWakeAttempts({ attention, ...opts }));
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

export function nextWakeAttemptNumber(
  attention: WakeAttention,
  opts: { now?: number; env?: NodeJS.ProcessEnv } = {}
): number {
  return readWakeAttempts({ attention, ...opts }).reduce((highest, attempt) => Math.max(highest, attempt.attemptN), 0) + 1;
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

function withLedgerLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`); }
      finally { fs.closeSync(fd); }
      try { return fn(); }
      finally { try { fs.unlinkSync(lock); } catch {} }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      Atomics.wait(lockWait, 0, 0, 10);
    }
  }
}

function toRow(attempt: WakeAttempt, env: NodeJS.ProcessEnv): WakeAttemptRow {
  const safe = redact(attempt, env.PASEO_PASSWORD) as WakeAttempt;
  return {
    v: 1,
    ts: safe.at,
    attention: {
      square_path: canonicalSquarePath(safe.attention.squarePath),
      act_id: `act_${safe.attention.actIndex}`,
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

export function recordWakeAttempt(
  attempt: Omit<WakeAttempt, 'at'> & { at?: number },
  env: NodeJS.ProcessEnv = process.env
): WakeAttempt {
  const value = { ...attempt, at: attempt.at ?? Date.now() } as WakeAttempt;
  if (!isWakeRouteKind(value.routeKind)) throw new Error('Wake attempts require a real adapter route kind.');
  if (value.outcome !== 'accepted' && !value.signature) {
    throw new Error(`${value.outcome} wake attempts require a transport signature.`);
  }
  const file = wakeAttemptsPath(env);
  withLedgerLock(file, () => fs.appendFileSync(file, `${JSON.stringify(toRow(value, env))}\n`, { mode: 0o600 }));
  return value;
}

export function recordRecoveredUnknown(
  attention: WakeAttention,
  lease: Pick<NotifyLease, 'attemptN' | 'routeKind'>,
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now()
): WakeAttempt | undefined {
  const routeKind = lease.routeKind;
  if (lease.attemptN === undefined || !isWakeRouteKind(routeKind)) return undefined;
  const file = wakeAttemptsPath(env);
  return withLedgerLock(file, () => {
    const attempts = readRows(env, at).map(fromRow).filter(
      (attempt) => wakeAttentionKey(attempt.attention) === wakeAttentionKey(attention),
    );
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
    fs.appendFileSync(file, `${JSON.stringify(toRow(value, env))}\n`, { mode: 0o600 });
    return value;
  });
}
