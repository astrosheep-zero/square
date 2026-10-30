import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { isSquareError } from './model.js';
import type { PresentationResult, PresentPendingInput, SquareRead } from './ports.js';
import { pendingHead, sameJoin } from './delivery.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { asSeatRef } from './seats.js';
import { preparePresentation, presentPrepared } from './delivery-effects.js';

/** Prepare custody before any external effect. A batch prepares every included item first. */
export async function preparePendingPresentation(input: Omit<PresentPendingInput, 'sink'>) {
  const index = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (index === undefined) return undefined;
  const initial = await input.artifact.read((facts) => {
    const participant = facts.participant(input.participant);
    const seat = facts.seat(input.participant);
    if (!participant?.joined || seat === undefined || seat.attachment !== 'attached' || input.generation !== undefined && input.generation !== seat.generation
      || input.seat !== undefined && (input.seat.generation !== seat.generation || input.seat.owner !== seat.owner)
      || input.current?.(facts) === false || !pendingHead(facts, participant.name, index)
      || deliveryDeferralExpiry(facts, seat, index, input.now ?? Date.now()) !== undefined) return undefined;
    const item = facts.activity(index);
    return item?.kind === 'say' ? { participant, seat, item } : undefined;
  }, input.signal).catch(() => undefined);
  if (initial?.value === undefined) return undefined;
  const { participant, seat, item } = initial.value;
  const ref = asSeatRef(seat);
  const owns = (facts: SquareRead) => {
    const current = facts.seat(seat.participant);
    return current !== undefined && current.attachment === 'attached' && current.owner === seat.owner && current.generation === seat.generation
      && sameJoin(facts, participant);
  };
  const claimToken = randomUUID();
  return preparePresentation({
    payload: item, coverage: input.markSeen === false ? 'clipped' : 'full',
    port: {
      async claim(signal) {
        const claimed = await input.artifact.claimDelivery({ seat: ref, activity: formatActivityId(index), kind: 'presentation',
          at: input.now ?? Date.now(), leaseMs: input.timeoutMs ?? 5000, claimToken }, signal).catch(() => ({ status: 'stale' as const }));
        return claimed.status === 'acquired' ? { token: claimToken, ordinal: claimed.attemptN } : undefined;
      },
      async current(signal) {
        return (await input.artifact.read(facts => owns(facts) && input.current?.(facts) !== false
          && pendingHead(facts, participant.name, index) !== undefined
          && deliveryDeferralExpiry(facts, seat, index, input.now ?? Date.now()) === undefined,
        signal ?? input.signal)).value;
      },
      async settle(claim, completion) {
        const success = completion.outcome === 'presented' || completion.outcome === 'clipped';
        const { value } = await input.artifact.settleAs({ kind: 'participant', seat: ref }, facts => {
          // Captured ownership fences truth; post-effect policy/cancellation cannot veto it.
          if (!owns(facts)) return false;
          if (!facts.completeDelivery({ seat: ref, activity: formatActivityId(index), claimToken: claim.token,
            outcome: completion.outcome, at: success ? input.now ?? Date.now() : Date.now(),
            ...(completion.reason === 'threw' ? { message: completion.error instanceof Error ? completion.error.message : String(completion.error) } : {}),
          })) return false;
          if (completion.outcome === 'presented') facts.markSeen(participant.name, [index], input.now ?? Date.now());
          return true;
        }).catch(error => {
          if (!success || isSquareError(error) && error.code === 'already_joined') return { value: false };
          throw error;
        });
        return value;
      },
    },
  }, { signal: input.signal });
}

/** Square sinks explicitly classify rejection as failed; the public effect core defaults to unknown. */
export async function presentPending(input: PresentPendingInput): Promise<PresentationResult> {
  const prepared = await preparePendingPresentation(input);
  if (prepared === undefined) return { presented: false };
  const report = await presentPrepared(prepared, activity => input.sink.present(activity), {
    signal: input.signal, classifyError: () => 'failed',
  });
  if (report.observation.kind === 'threw') throw report.observation.error;
  const result = report.settlements[0]!.result;
  if (result.persistence.status === 'error') throw result.persistence.error;
  return report.observation.kind === 'returned' && result.persistence.status === 'recorded'
    ? { presented: true, activity: prepared.payload } : { presented: false };
}
