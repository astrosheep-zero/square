import { createArtifactPort } from './artifact.js';
import { indexedSquareEntries } from './square-index.js';

export interface ClaudeDeliveryObservation {
  readonly eventId: string;
  readonly messageId: string;
  readonly state: 'held' | 'released' | 'dropped';
  readonly reason?: string;
  readonly observedAt: number;
}

export interface ClaudeDeliveryStatus extends ClaudeDeliveryObservation {
  readonly provider: 'claude';
  readonly sessionId: string;
}

const holdReasons = new Set(['explicit-setting', 'managed-setting', 'repo-setting', 'invalid-setting', 'bypass-default', 'mode-unknown', 'mode-mismatch', 'no-mode-asserted']);
const dropReasons = new Set(['expired', 'refused', 'dropped', 'discarded']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** This receiver-owned observation is not a model tool and grants no delivery authority. */
export async function recordClaudeDeliveryStatus(input: ClaudeDeliveryStatus, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!input || input.provider !== 'claude' || typeof input.sessionId !== 'string' || !input.sessionId
    || typeof input.messageId !== 'string' || !uuid.test(input.messageId)
    || typeof input.eventId !== 'string' || !uuid.test(input.eventId)
    || !Number.isFinite(input.observedAt) || input.observedAt < 0
    || !['held', 'released', 'dropped'].includes(input.state)
    || (input.state === 'held' ? !holdReasons.has(input.reason ?? '')
      : input.state === 'dropped' ? !dropReasons.has(input.reason ?? '') : input.reason !== undefined)) return false;
  for (const entry of await indexedSquareEntries({ channel: 'claude-code', session: input.sessionId }, env)) {
    const artifact = createArtifactPort(entry.location);
    try {
      const { value: match } = await artifact.read((facts) => facts.roster().flatMap((participant) => {
        const seat = facts.seat(participant.name);
        if (seat === undefined || seat.attachment !== 'attached' || seat.body.session !== input.sessionId || seat.body.channel !== 'claude-code') return [];
        const evidence = facts.deliveryEvidence(seat.participant, seat.generation).find((row) =>
          row.correlation?.harness === 'claude' && row.correlation.messageId === input.messageId && row.claimToken !== undefined);
        return evidence === undefined ? [] : [{ seat, evidence }];
      }));
      if (match.length === 0) continue;
      const { seat, evidence } = match[0];
      const ref = { participant: seat.participant, body: seat.body, generation: seat.generation };
      return (await artifact.transactAs({ kind: 'participant', seat: ref }, (facts) =>
        facts.observeNativeDelivery({ seat: ref, claimToken: evidence.claimToken!, observation: {
          eventId: input.eventId, messageId: input.messageId, state: input.state,
          ...(input.reason === undefined ? {} : { reason: input.reason }), observedAt: input.observedAt,
        }}))).value;
    } finally { await artifact.close(); }
  }
  return false;
}
