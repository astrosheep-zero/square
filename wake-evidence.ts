import { type WakeRoute } from './model.js';
import { deriveDeliveryModel, type DeliveryModel } from './delivery.js';
import { nameKey, type SquareState } from './model.js';
import { readPresentedAttentions } from './presented.js';
import { canonicalSquarePath, readActiveBindings } from './registry.js';
import { createHostLedgerPort } from './host-ledger-file-adapter.js';
import {
  isWakeRouteAttemptable,
  readWakeAttempts,
  terminalWakeEvidence,
  type WakeAttempt,
} from './wake-attempts.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { observationFor } from './runtime.js';
import { entryPresentation } from './views.js';

export interface WakeEvidence {
  delivered: boolean;
  presented: boolean;
  attempts: WakeAttempt[];
  terminal?: WakeAttempt;
  attemptableRoutes: WakeRoute[];
}

export interface WakeEvidenceProjection {
  evidence(recipient: string, actIndex: number): WakeEvidence;
}

async function attentionKey(squarePath: string, recipient: string, actIndex: number): Promise<string> {
  return JSON.stringify([await canonicalSquarePath(squarePath), nameKey(recipient), actIndex]);
}

async function projectionFromState(
  squarePath: string,
  state: SquareState,
  now: number,
  env: NodeJS.ProcessEnv,
  delivery = deriveDeliveryModel(state),
): Promise<WakeEvidenceProjection> {
  const canonicalPath = await canonicalSquarePath(squarePath);
  const bindings = await readActiveBindings(now, env);
  const routes = (await createHostLedgerPort({ userPath: env.SQUARE_HOST_LEDGER_USER, writableScope: 'user', readableScopes: ['user'] }).listPresence({ location: canonicalPath, scopes: ['user'], now })).filter((binding) => binding.route !== undefined);
  const routesByBinding = new Map<string, WakeRoute[]>();
  for (const binding of bindings) {
    if (binding.squarePath !== canonicalPath) continue;
    const route = routes.find((candidate) => candidate.session === binding.sessionId && candidate.channel === binding.channel && nameKey(candidate.participant) === nameKey(binding.name));
    if (route?.route !== undefined) routesByBinding.set(JSON.stringify([binding.squarePath, nameKey(binding.name), binding.sessionId, binding.channel]), [{ location: binding.squarePath, participant: binding.name, sessionId: binding.sessionId, channel: binding.channel, kind: route.route.kind, address: { ...route.route.address }, updatedAt: route.updatedAt ?? 0 }]);
  }

  const attemptsByAttention = new Map<string, WakeAttempt[]>();
  for (const attempt of await readWakeAttempts({ env, now })) {
    const key = await attentionKey(attempt.attention.squarePath, attempt.attention.recipient, attempt.attention.actIndex);
    const attempts = attemptsByAttention.get(key) ?? [];
    attempts.push(attempt);
    attemptsByAttention.set(key, attempts);
  }

  const presentedByAttention = new Map<string, Set<string>>();
  for (const presented of await readPresentedAttentions(env, now)) {
    const key = await attentionKey(presented.squarePath, presented.name, presented.actIndex);
    const presentedOwners = presentedByAttention.get(key) ?? new Set<string>();
    presentedOwners.add(presented.sessionId);
    presentedByAttention.set(key, presentedOwners);
  }

  return {
    evidence(recipient: string, actIndex: number): WakeEvidence {
      const recipientBindings = bindings.filter((binding) => binding.squarePath === canonicalPath && nameKey(binding.name) === nameKey(recipient));
      const key = JSON.stringify([canonicalPath, nameKey(recipient), actIndex]);
      const attempts = attemptsByAttention.get(key) ?? [];
      const terminal = terminalWakeEvidence(attempts);
      const routes = recipientBindings.flatMap((binding) => routesByBinding.get(JSON.stringify([binding.squarePath, nameKey(binding.name), binding.sessionId, binding.channel]) ) ?? []);
      const presented = (presentedByAttention.get(key) ?? new Set()).size > 0;
      return {
        delivered: delivery.isSeen(recipient, actIndex),
        presented,
        attempts,
        ...(terminal === undefined ? {} : { terminal }),
        attemptableRoutes: terminal === undefined
          ? routes.filter((route) => isWakeRouteAttemptable(route, attempts))
          : [],
      };
    },
  };
}

/** Capture the primary wake facts once and derive any number of eligibility decisions from them. */
export async function wakeEvidenceProjection(
  squarePath: string,
  now: number,
  env: NodeJS.ProcessEnv,
): Promise<WakeEvidenceProjection> {
  const square = await openSquare(squarePath, { clock: () => now });
  try {
    const { state } = await entryPresentation(square, '');
    return projectionFromState(squarePath, state, now, env);
  } finally {
    await closeOpenSquare(square);
  }
}

export function wakeEvidenceProjectionFromState(
  squarePath: string,
  state: SquareState,
  now: number,
  env: NodeJS.ProcessEnv,
  delivery?: DeliveryModel,
): Promise<WakeEvidenceProjection> {
  return projectionFromState(squarePath, state, now, env, delivery);
}

/** Project every wake decision from the same primary evidence. */
export async function wakeEvidence(
  squarePath: string,
  recipient: string,
  actIndex: number,
  now: number,
  env: NodeJS.ProcessEnv,
): Promise<WakeEvidence> {
  return (await wakeEvidenceProjection(squarePath, now, env)).evidence(recipient, actIndex);
}

export function wakeIsEligible(evidence: WakeEvidence): boolean {
  return !evidence.delivered
    && evidence.terminal === undefined
    && evidence.attemptableRoutes.length > 0;
}
