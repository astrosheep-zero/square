import { loadSquare } from './artifact.js';
import { isDeliveryDelivered } from './delivery.js';
import { type SquareDoc } from './model.js';
import { hasPresentedAttention } from './presented.js';
import { lookupParticipant } from './registry.js';
import { isCurrentlyJoined } from './runtime.js';
import { readWakeRoutes, type WakeRoute } from './routes.js';
import {
  isWakeRouteAttemptable,
  readWakeAttempts,
  terminalWakeEvidence,
  type WakeAttempt,
} from './wake-attempts.js';

export interface WakeEvidence {
  delivered: boolean;
  presented: boolean;
  attempts: WakeAttempt[];
  terminal?: WakeAttempt;
  attemptableRoutes: WakeRoute[];
}

export function joinedRecipients(doc: SquareDoc): string[] {
  return [...new Set(doc.acts.filter((act) => act.kind === 'join').map((act) => act.actor))]
    .filter((name) => isCurrentlyJoined(doc.acts, name));
}

/** Project every wake decision from the same primary evidence. */
export function wakeEvidence(
  squarePath: string,
  recipient: string,
  actIndex: number,
  now: number,
  env: NodeJS.ProcessEnv,
): WakeEvidence {
  const doc = loadSquare(squarePath);
  const owners = new Set(
    lookupParticipant(squarePath, recipient, now).map((binding) => binding.ownerId),
  );
  const attempts = readWakeAttempts({ attention: { squarePath, recipient, actIndex }, env, now });
  const terminal = terminalWakeEvidence(attempts);
  const routes = readWakeRoutes({ freshOnly: true, now, env })
    .filter((route) => owners.has(route.ownerId));
  return {
    delivered: isDeliveryDelivered(doc, recipient, actIndex),
    presented: hasPresentedAttention(squarePath, recipient, actIndex, env, now),
    attempts,
    ...(terminal === undefined ? {} : { terminal }),
    attemptableRoutes: terminal === undefined
      ? routes.filter((route) => isWakeRouteAttemptable(route, attempts))
      : [],
  };
}

export function wakeIsEligible(evidence: WakeEvidence): boolean {
  return !evidence.delivered
    && !evidence.presented
    && evidence.terminal === undefined
    && evidence.attemptableRoutes.length > 0;
}
