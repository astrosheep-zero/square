import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { isSquareError, sameBody } from './model.js';
import type { PresentationResult, PresentPendingInput, SquareRead } from './ports.js';
import { pendingHead, sameJoin } from './delivery.js';
import { deliveryDeferralExpiry } from './delivery-deferral.js';
import { asSeatRef } from './seats.js';

/** Prepare custody before any external effect. A batch prepares every included item first. */
export async function preparePendingPresentation(input: Omit<PresentPendingInput, 'sink'>) {
  const index = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (index === undefined) return undefined;
  const initial = await input.artifact.read((facts) => {
    const participant = facts.participant(input.participant);
    const seat = facts.seat(input.participant);
    if (!participant?.joined || seat === undefined || seat.attachment !== 'attached' || input.generation !== undefined && input.generation !== seat.generation
      || input.seat !== undefined && (input.seat.generation !== seat.generation || !sameBody(input.seat.body, seat.body))
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
    return current !== undefined && current.attachment === 'attached' && sameBody(current.body, seat.body) && current.generation === seat.generation
      && sameJoin(facts, participant);
  };
  const claimToken = randomUUID();
  const claimed = await input.artifact.claimDelivery({ seat: ref, activity: formatActivityId(index), kind: 'presentation',
    at: input.now ?? Date.now(), leaseMs: input.timeoutMs ?? 5000, claimToken }, input.signal).catch(() => ({ status: 'stale' as const }));
  if (claimed.status !== 'acquired') return undefined;

  let effectObserved = false, released = false;
  return {
    activity: item,
    async eligible(): Promise<boolean> {
      return (await input.artifact.read(facts => owns(facts) && input.current?.(facts) !== false
        && pendingHead(facts, participant.name, index) !== undefined
        && deliveryDeferralExpiry(facts, seat, index, input.now ?? Date.now()) === undefined,
      input.signal).catch(() => undefined))?.value === true;
    },
    async release(outcome: 'released' | 'failed' = 'released', message?: string): Promise<void> {
      if (effectObserved || released) return;
      released = true;
      await input.artifact.settleAs({ kind: 'participant', seat: ref }, facts => facts.completeDelivery({
        seat: ref, activity: formatActivityId(index), claimToken, outcome, at: Date.now(),
        ...(message === undefined ? {} : { message }),
      })).catch(() => false);
    },
    async recordPresented(): Promise<PresentationResult> {
      // Success is an observed external fact, not another eligibility decision. Neither
      // post-effect cancellation nor a new deferral can erase it and authorize replay.
      effectObserved = true;
      const outcome = input.markSeen === false ? 'clipped' : 'presented';
      const { value: committed } = await input.artifact.settleAs({ kind: 'participant', seat: ref }, facts => {
        if (!owns(facts)) return false;
        if (!facts.completeDelivery({ seat: ref, activity: formatActivityId(index), claimToken, outcome, at: input.now ?? Date.now() })) return false;
        if (input.markSeen !== false) facts.markSeen(participant.name, [index], input.now ?? Date.now());
        return true;
      }).catch(error => {
        if (isSquareError(error) && error.code === 'already_joined') return { value: false };
        throw error;
      });
      return committed ? { presented: true, activity: item } : { presented: false };
    },
  };
}

/** Eligibility precedes the sink; only captured ownership fences its truthful completion. */
export async function presentPending(input: PresentPendingInput): Promise<PresentationResult> {
  const prepared = await preparePendingPresentation(input);
  if (prepared === undefined) return { presented: false };
  try {
    if (!await prepared.eligible() || input.signal?.aborted) return { presented: false };
    try { await input.sink.present(prepared.activity); }
    catch (error) {
      await prepared.release('failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
    return await prepared.recordPresented();
  } finally { await prepared.release(); }
}
