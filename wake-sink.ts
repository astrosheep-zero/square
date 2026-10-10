import { createHash } from 'node:crypto';

import { DeliveryError, connect } from './packages/agent-delivery/src/index.js';

/** One Paseo wake attempt: where it goes, what it says, and what identifies it. */
export interface PaseoWakeRequest {
  agentId: string;
  prompt: string;
  location: string;
  participant: string;
  activity: string;
  attemptN?: number;
}

/**
 * The daemon's own dedup key for one attempt. Every retry of the same attempt
 * derives the same id; a later attempt of the same attention derives a new one.
 */
export function paseoWakeMessageId(request: Pick<PaseoWakeRequest, 'location' | 'participant' | 'activity' | 'attemptN'>): string {
  const digest = createHash('sha256')
    .update([request.location, request.participant, request.activity, request.attemptN ?? 0].join('|'))
    .digest('hex');
  return `square-${digest.slice(0, 32)}`;
}

/** Steer one existing Paseo agent through the shared delivery entry. Never interrupts a turn. */
export async function sendPaseoWake(
  request: PaseoWakeRequest,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const budgetMs = opts.timeoutMs;
  // A usable budget becomes one deadline both phases share; anything else is an
  // argument error, so it is handed to the entry untouched to classify.
  const bounded = budgetMs !== undefined && Number.isFinite(budgetMs) && budgetMs > 0;
  const deadline = bounded ? Date.now() + budgetMs : 0;
  // An elapsed budget never reached the daemon, so it is the shared entry's own
  // "unavailable" failure rather than a send error of its own.
  const connectMs = bounded ? Math.max(0, deadline - Date.now()) : budgetMs;
  if (bounded && connectMs === 0) throw new DeliveryError('unavailable');
  const agent = await connect({
    harness: 'paseo',
    agentId: request.agentId,
    ...(connectMs === undefined ? {} : { timeoutMs: connectMs }),
  });
  const steerMs = bounded ? Math.max(0, deadline - Date.now()) : budgetMs;
  if (bounded && steerMs === 0) throw new DeliveryError('unavailable');
  await agent.steer(request.prompt, {
    id: paseoWakeMessageId(request),
    ...(steerMs === undefined ? {} : { timeoutMs: steerMs }),
  });
}
