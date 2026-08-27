import { type WakeRoute } from './model.js';
import { deriveDeliveryModel, type DeliveryModel } from './delivery.js';
import { nameKey, type SquareState } from './model.js';
import { readPresentedAttentions } from './presented.js';
import { canonicalSquarePath, readActiveBindings } from './registry.js';
import { readWakeRoutes } from './routes.js';
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
  const owners = new Map<string, Set<string>>();
  for (const binding of await readActiveBindings(now)) {
    if (binding.squarePath !== canonicalPath) continue;
    const key = nameKey(binding.name);
    const recipientOwners = owners.get(key) ?? new Set<string>();
    recipientOwners.add(binding.ownerId);
    owners.set(key, recipientOwners);
  }

  const routesByOwner = new Map<string, WakeRoute[]>();
  for (const route of await readWakeRoutes({ freshOnly: true, now, env })) {
    const routes = routesByOwner.get(route.ownerId) ?? [];
    routes.push(route);
    routesByOwner.set(route.ownerId, routes);
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
    presentedOwners.add(presented.ownerId);
    presentedByAttention.set(key, presentedOwners);
  }

  return {
    evidence(recipient: string, actIndex: number): WakeEvidence {
      const recipientOwners = owners.get(nameKey(recipient)) ?? new Set<string>();
      const key = JSON.stringify([canonicalPath, nameKey(recipient), actIndex]);
      const attempts = attemptsByAttention.get(key) ?? [];
      const terminal = terminalWakeEvidence(attempts);
      const routes = [...recipientOwners].flatMap((ownerId) => routesByOwner.get(ownerId) ?? []);
      const presented = [...(presentedByAttention.get(key) ?? [])]
        .some((ownerId) => recipientOwners.has(ownerId));
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
