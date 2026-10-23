import { hostLedgerForEnv } from './registry.js';
import type { NativeDeliveryObservation } from './host-ledger.js';

export interface ClaudeDeliveryStatus extends NativeDeliveryObservation {
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
  const ledger = hostLedgerForEnv(env);
  const rows = await ledger.listEvidence({ kind: 'wake', session: input.sessionId, includeReleased: true });
  const row = rows.find((row) => row.nativeDelivery?.harness === 'claude' && row.nativeDelivery.messageId === input.messageId);
  if (!row?.claimToken) return false;
  const { eventId, messageId, state, reason, observedAt } = input;
  return ledger.observeNativeDelivery({ ...row, claimToken: row.claimToken }, {
    eventId, messageId, state, ...(reason === undefined ? {} : { reason }), observedAt,
  });
}
