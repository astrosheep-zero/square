import { type WakeRoute } from './model.js';
import { hasPresentedAttention } from './presented.js';
import { lookupParticipant } from './registry.js';
import { readWakeRoutes } from './routes.js';
import {
  isWakeRouteAttemptable,
  readWakeAttempts,
  terminalWakeEvidence,
  type WakeAttempt,
} from './wake-attempts.js';
import { openSquare } from './square-file-adapter.js';
import { closeOpenSquare } from './open-square.js';
import { notificationDelivered } from './views.js';

export interface WakeEvidence {
  delivered: boolean;
  presented: boolean;
  attempts: WakeAttempt[];
  terminal?: WakeAttempt;
  attemptableRoutes: WakeRoute[];
}

/** Project every wake decision from the same primary evidence. */
export async function wakeEvidence(
  squarePath: string,
  recipient: string,
  actIndex: number,
  now: number,
  env: NodeJS.ProcessEnv,
): Promise<WakeEvidence> {
  const square = await openSquare(squarePath, { clock: () => now });
  const delivered = await notificationDelivered(square, recipient, actIndex).finally(() => closeOpenSquare(square));
  const owners = new Set(
    lookupParticipant(squarePath, recipient, now).map((binding) => binding.ownerId),
  );
  const attempts = readWakeAttempts({ attention: { squarePath, recipient, actIndex }, env, now });
  const terminal = terminalWakeEvidence(attempts);
  const routes = readWakeRoutes({ freshOnly: true, now, env })
    .filter((route) => owners.has(route.ownerId));
  return {
    delivered,
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
