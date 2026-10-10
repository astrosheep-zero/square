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

export type PaseoWakeFailureKind = 'transient' | 'rejected' | 'unknown';

export class PaseoWakeSendError extends Error {
  constructor(message: string, public readonly kind: PaseoWakeFailureKind) {
    super(message);
    this.name = 'PaseoWakeSendError';
  }
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

function sendFailure(error: unknown): PaseoWakeSendError {
  if (error instanceof PaseoWakeSendError) return error;
  if (!(error instanceof DeliveryError)) {
    return new PaseoWakeSendError(error instanceof Error ? error.message : String(error), 'unknown');
  }
  // The daemon's connection is the uncertainty boundary: past it nothing is proven absent.
  if (error.maybeDelivered) return new PaseoWakeSendError(error.message, 'unknown');
  if (error.code === 'unavailable') return new PaseoWakeSendError(error.message, 'transient');
  if (error.code === 'authentication_failed' || error.code === 'session_not_found'
    || error.code === 'rejected' || error.code === 'invalid_arguments') {
    return new PaseoWakeSendError(error.message, 'rejected');
  }
  return new PaseoWakeSendError(error.message, 'unknown');
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
  const left = (): number | undefined => (bounded ? Math.max(0, deadline - Date.now()) : budgetMs);
  try {
    const connectMs = left();
    if (bounded && connectMs === 0) throw new PaseoWakeSendError('The Paseo wake dispatch budget elapsed before send.', 'transient');
    const agent = await connect({
      harness: 'paseo',
      agentId: request.agentId,
      ...(connectMs === undefined ? {} : { timeoutMs: connectMs }),
    });
    const steerMs = left();
    if (bounded && steerMs === 0) throw new PaseoWakeSendError('The Paseo wake dispatch budget elapsed before the steer.', 'transient');
    await agent.steer(request.prompt, {
      id: paseoWakeMessageId(request),
      ...(steerMs === undefined ? {} : { timeoutMs: steerMs }),
    });
  } catch (error) {
    throw sendFailure(error);
  }
}
