import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import type { PresentationResult, PresentPendingInput, SquareRead } from './ports.js';
import { pendingHead, sameJoin } from './delivery.js';

/** Presentation evidence is not a receipt; only the fenced receipt transaction marks seen. */
export async function presentPending(input: PresentPendingInput): Promise<PresentationResult> {
  const index = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (index === undefined) return { presented: false };
  const before = await input.artifact.read((facts) => {
    if (input.current?.(facts) === false || !pendingHead(facts, input.participant, index)) return undefined;
    return { item: facts.activity(index)!, participant: facts.participant(input.participant)! };
  }, input.signal).catch(() => undefined);
  if (before?.value === undefined) return { presented: false };
  const { item, participant } = before.value;
  const current = (facts: SquareRead) => sameJoin(facts, participant) && input.current?.(facts) !== false
    && pendingHead(facts, participant.name, index) !== undefined;
  const coordinate = { location: input.location, participant: input.participant, session: input.session!, activity: formatActivityId(index), kind: 'presentation' as const };
  let claimToken: string | undefined;
  const release = async () => {
    if (claimToken !== undefined) await input.hostLedger!.releaseEvidence({ ...coordinate, claimToken });
  };
  if (input.hostLedger !== undefined && input.session !== undefined) {
    const claim = await input.hostLedger.claimEvidence({ ...coordinate, leaseMs: input.timeoutMs ?? 5000 });
    if (claim.status !== 'acquired') return { presented: false };
    claimToken = claim.claimToken;
    const fresh = await input.artifact.read(current, input.signal).catch(() => undefined);
    if (!fresh?.value) { await release().catch(() => undefined); return { presented: false }; }
  }
  try { await input.sink.present(item); }
  catch (error) {
    if (claimToken !== undefined) await input.hostLedger!.appendEvidence({ ...coordinate, outcome: 'failed', message: error instanceof Error ? error.message : String(error), claimToken });
    throw error;
  }
  const { value: committed } = await input.artifact.transact((facts) => {
    if (!current(facts)) return false;
    return input.markSeen === false || facts.markSeen(participant.name, [index], input.now ?? Date.now()) > 0;
  }, input.signal);
  if (!committed) { await release(); return { presented: false }; }
  if (claimToken !== undefined) await input.hostLedger!.appendEvidence({ ...coordinate, outcome: input.markSeen === false ? 'clipped' : 'presented',
    ...(input.markSeen === false ? { message: 'presentation clipped' } : {}), claimToken });
  return { presented: true, activity: item };
}
