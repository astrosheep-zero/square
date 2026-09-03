import os from 'node:os';
import path from 'node:path';

import { isWakeRouteKind, nameKey, type WakeRoute, type WakeRouteKind } from './model.js';
import { canonicalSquarePath } from './registry.js';
import { formatActivityId, parseActivityId } from './square-core.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import type { HostLedgerPort } from './host-ledger.js';
import { terminalWakeEvidence } from './square-projections.js';
import type { WakeAttempt as ProjectedWakeAttempt } from './square-projections.js';
export { hasAttemptableWakeRoute, isWakeRouteAttemptable, terminalWakeEvidence } from './square-projections.js';

export type WakeOutcome = 'accepted' | 'unknown' | 'failed';

export interface WakeAttention {
  squarePath: string;
  actIndex: number;
  recipient: string;
}

export type WakeAttempt = ProjectedWakeAttempt;

export interface WakeDispatchLease {
  readonly leaseId: string;
  readonly expiresAt: number;
  readonly phase: 'claimed' | 'dispatching';
  readonly routeKind?: WakeRouteKind;
  readonly attemptN?: number;
  readonly session?: string;
}

export type WakeDispatchClaim =
  | { readonly type: 'acquired'; readonly leaseId: string }
  | { readonly type: 'busy' }
  | { readonly type: 'ambiguous'; readonly lease: WakeDispatchLease };

const VALID_OUTCOMES = new Set<WakeOutcome>(['accepted', 'unknown', 'failed']);

function ledger(env: NodeJS.ProcessEnv): HostLedgerPort {
  return createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER ?? path.dirname(wakeAttemptsPath(env)), readableScopes: ['user'], writableScope: 'user' });
}

export function wakeAttemptsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SQUARE_WAKE_ATTEMPTS || path.join(os.homedir(), '.square', 'wake-attempts.ndjsonl');
}

export async function wakeAttentionKey(attention: WakeAttention): Promise<string> {
  return JSON.stringify([await canonicalSquarePath(attention.squarePath), formatActivityId(attention.actIndex), nameKey(attention.recipient)]);
}

export async function claimWakeDispatch(
  attention: WakeAttention,
  leaseId: string,
  leaseMs: number,
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now(),
  session?: string,
): Promise<WakeDispatchClaim> {
  return ledger(env).claimWakeDispatch({ attention, leaseId, leaseMs, at, session });
}

export async function transitionWakeDispatch(
  attention: WakeAttention,
  leaseId: string,
  phase: WakeDispatchLease['phase'],
  leaseMs: number,
  routeKind: WakeRouteKind | undefined,
  attemptN: number | undefined,
  session: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now(),
): Promise<boolean> {
  return ledger(env).transitionWakeDispatch({ attention, leaseId, phase, leaseMs, routeKind, attemptN, session, at });
}

export async function releaseWakeDispatch(attention: WakeAttention, leaseId: string, env: NodeJS.ProcessEnv = process.env, at = Date.now()): Promise<void> {
  await ledger(env).releaseWakeDispatch({ attention, leaseId, at });
}

async function readRows(env: NodeJS.ProcessEnv, now: number): Promise<WakeAttempt[]> {
  const records = await ledger(env).listWakeAttempts({ now });
  return records.flatMap((record) => {
    const actIndex = parseActivityId(record.activity);
    if (actIndex === undefined || !isWakeRouteKind(record.routeKind) || !VALID_OUTCOMES.has(record.outcome as WakeOutcome) || typeof record.attemptN !== 'number') return [];
    return [{ at: record.at ?? now, attention: { squarePath: record.location, actIndex, recipient: record.participant }, routeKind: record.routeKind, outcome: record.outcome as WakeOutcome, attemptN: record.attemptN, ...(record.signature === undefined ? {} : { signature: record.signature }), ...(record.session === undefined ? {} : { session: record.session }), ...(record.message === undefined ? {} : { message: record.message }), ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }) }];
  });
}

export async function readWakeAttempts(
  opts: { attention?: WakeAttention; sessionId?: string; now?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<WakeAttempt[]> {
  const now = opts.now ?? Date.now();
  const expected = opts.attention === undefined ? undefined : await wakeAttentionKey(opts.attention);
  const attempts = await readRows(opts.env ?? process.env, now);
  const scoped = opts.sessionId === undefined ? attempts : attempts.filter((attempt) => attempt.session === opts.sessionId);
  if (expected === undefined) return scoped;
  const keys = await Promise.all(scoped.map((attempt) => wakeAttentionKey(attempt.attention)));
  return scoped.filter((_, index) => keys[index] === expected);
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

export async function recordWakeAttempt(
  attempt: Omit<WakeAttempt, 'at'> & { at?: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<WakeAttempt> {
  const value = { ...attempt, at: attempt.at ?? Date.now() } as WakeAttempt;
  if (!isWakeRouteKind(value.routeKind)) throw new Error('Wake attempts require a real adapter route kind.');
  if (value.outcome !== 'accepted' && !value.signature) {
    throw new Error(`${value.outcome} wake attempts require a transport signature.`);
  }
  const safe = redact(value, env.PASEO_PASSWORD) as WakeAttempt;
  const session = safe.session ?? safe.signature ?? `route:${safe.routeKind}`;
  const claim = await ledger(env).claimEvidence({ location: safe.attention.squarePath, participant: safe.attention.recipient, session, activity: formatActivityId(safe.attention.actIndex), kind: 'wake', leaseMs: 5000 });
  if (claim.status === 'acquired') await ledger(env).appendWakeAttempt({ location: safe.attention.squarePath, participant: safe.attention.recipient, session, activity: formatActivityId(safe.attention.actIndex), kind: 'wake', outcome: safe.outcome, routeKind: safe.routeKind, signature: safe.signature, attemptN: safe.attemptN, message: safe.message, diagnostic: safe.diagnostic, at: safe.at, claimToken: claim.claimToken });
  return value;
}

export async function recordRecoveredUnknown(
  attention: WakeAttention,
  lease: { attemptN?: number; routeKind?: WakeRouteKind; session?: string },
  env: NodeJS.ProcessEnv = process.env,
  at = Date.now()
): Promise<WakeAttempt | undefined> {
  const routeKind = lease.routeKind;
  if (lease.attemptN === undefined || !isWakeRouteKind(routeKind)) return undefined;
  const rows = await readRows(env, at);
  {
    const expected = await wakeAttentionKey(attention);
    const attempts: WakeAttempt[] = [];
    for (const attempt of rows) {
      if (await wakeAttentionKey(attempt.attention) !== expected) continue;
      if (lease.session !== undefined && attempt.session !== lease.session) continue;
      attempts.push(attempt);
    }
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
    const session = lease.session ?? value.signature!;
    const claim = await ledger(env).claimEvidence({ location: attention.squarePath, participant: attention.recipient, session, activity: formatActivityId(attention.actIndex), kind: 'wake', leaseMs: 5000 });
    if (claim.status === 'acquired') await ledger(env).appendWakeAttempt({ location: attention.squarePath, participant: attention.recipient, session, activity: formatActivityId(attention.actIndex), kind: 'wake', outcome: 'unknown', routeKind, signature: value.signature, attemptN: value.attemptN, message: value.message, at, claimToken: claim.claimToken });
    return value;
  }
}
