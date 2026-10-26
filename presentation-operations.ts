import { randomUUID } from 'node:crypto';
import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import { isSquareError, sameBody, type Seat } from './model.js';
import type { PresentationResult, PresentPendingInput, SeatRef, SquareRead } from './ports.js';
import { pendingHead, sameJoin } from './delivery.js';

function asSeatRef(seat: Seat): SeatRef {
  const { wakeAddress: _wakeAddress, ...ref } = seat;
  return ref;
}

function currentFor(input: PresentPendingInput, captured: Seat, participant: import('./ports.js').ParticipantFact, index: number) {
  return (facts: SquareRead) => {
    const seat = facts.seat(captured.participant);
    return seat !== undefined && sameBody(seat.body, captured.body) && seat.generation === captured.generation
      && sameJoin(facts, participant) && input.current?.(facts) !== false
      && pendingHead(facts, captured.participant, index) !== undefined;
  };
}

/** Presentation is external; its claim and receipt/evidence commit are generation-fenced in the artifact. */
export async function presentPending(input: PresentPendingInput): Promise<PresentationResult> {
  const index = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (index === undefined) return { presented: false };
  const initial = await input.artifact.read((facts) => {
    const participant = facts.participant(input.participant);
    const seat = facts.seat(input.participant);
    if (!participant?.joined || seat === undefined || input.generation !== undefined && input.generation !== seat.generation
      || input.seat !== undefined && (input.seat.generation !== seat.generation || !sameBody(input.seat.body, seat.body))
      || input.current?.(facts) === false || !pendingHead(facts, participant.name, index)) return undefined;
    const item = facts.activity(index);
    return item?.kind === 'say' ? { participant, seat, item } : undefined;
  }, input.signal).catch(() => undefined);
  if (initial?.value === undefined) return { presented: false };
  const { participant, seat, item } = initial.value;
  const ref = asSeatRef(seat);
  const current = currentFor(input, seat, participant, index);
  const claimToken = randomUUID();
  const claimed = await input.artifact.claimDelivery({ seat: ref, activity: formatActivityId(index), kind: 'presentation',
    at: input.now ?? Date.now(), leaseMs: input.timeoutMs ?? 5000, claimToken }, input.signal).catch(() => ({ status: 'stale' as const }));
  if (claimed.status !== 'acquired') return { presented: false };

  const release = async (outcome: 'released' | 'failed', message?: string) => input.artifact.completeDelivery({
    seat: ref, activity: formatActivityId(index), claimToken, outcome, at: Date.now(),
    ...(message === undefined ? {} : { message }),
  }, input.signal).catch(() => false);
  const fresh = await input.artifact.read(current, input.signal).catch(() => undefined);
  if (!fresh?.value) { await release('released', 'The notification changed before presentation.'); return { presented: false }; }

  try { await input.sink.present(item); }
  catch (error) {
    await release('failed', error instanceof Error ? error.message : String(error));
    throw error;
  }

  const outcome = input.markSeen === false ? 'clipped' : 'presented';
  const { value: committed } = await input.artifact.transactAs({ kind: 'participant', seat: ref }, (facts) => {
    if (!current(facts)) return false;
    if (!facts.completeDelivery({ seat: ref, activity: formatActivityId(index), claimToken, outcome, at: input.now ?? Date.now() })) return false;
    if (input.markSeen === false) return true;
    return facts.markSeen(participant.name, [index], input.now ?? Date.now()) > 0;
  }, input.signal).catch(error => {
    if (isSquareError(error) && error.code === 'already_joined') return { value: false };
    throw error;
  });
  if (!committed) return { presented: false };
  return { presented: true, activity: item };
}
