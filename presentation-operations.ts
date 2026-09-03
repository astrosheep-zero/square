import { formatActivityId, parseActivityId, type ActivityId } from './square-core.js';
import type { PresentationResult, PresentPendingInput, SquareArtifactPort } from './ports.js';
import { deriveDeliveryModel } from './delivery.js';
import { recordObservation } from './runtime.js';

/** Present one pending activity; artifact seen remains the authoritative receipt. */
export async function presentPending(input: PresentPendingInput): Promise<PresentationResult> {
  const index = typeof input.activity === 'number' ? input.activity : parseActivityId(input.activity as ActivityId);
  if (index === undefined) return { presented: false };
  let before: Awaited<ReturnType<SquareArtifactPort['read']>>;
  try { before = await input.artifact.read(); } catch { return { presented: false }; }
  const delivery = deriveDeliveryModel(before.state);
  const item = before.state.acts.find((activity) => activity.index === index);
  if (item === undefined || delivery.isSeen(input.participant, index) || !delivery.pendingFor(input.participant).some((notification) => notification.item.index === index)) return { presented: false };
  let claimToken: string | undefined;
  if (input.hostLedger !== undefined && input.session !== undefined) {
    const claim = await input.hostLedger.claimEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', leaseMs: input.timeoutMs ?? 5000 });
    if (claim.status !== 'acquired') return { presented: false };
    claimToken = claim.claimToken;
    let current: Awaited<ReturnType<SquareArtifactPort['read']>>;
    try { current = await input.artifact.read(); }
    catch { await input.hostLedger.releaseEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', claimToken }).catch(() => undefined); return { presented: false }; }
    if (deriveDeliveryModel(current.state).isSeen(input.participant, index)) { await input.hostLedger.releaseEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', claimToken }).catch(() => undefined); return { presented: false }; }
    try { await input.sink.present(item); }
    catch (error) { await input.hostLedger.appendEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', outcome: 'failed', message: error instanceof Error ? error.message : String(error), claimToken }); throw error; }
  } else await input.sink.present(item);
  if (input.markSeen !== false) await input.artifact.transact((state) => { const changed = recordObservation(state, input.participant, index, 'seen', input.now ?? Date.now()); return changed ? { state, result: undefined } : { result: undefined }; });
  if (input.hostLedger !== undefined && input.session !== undefined && claimToken !== undefined) await input.hostLedger.appendEvidence({ location: input.location, participant: input.participant, session: input.session, activity: formatActivityId(index), kind: 'presentation', outcome: input.markSeen === false ? 'clipped' : 'presented', ...(input.markSeen === false ? { message: 'presentation clipped' } : {}), claimToken });
  return { presented: true, activity: item };
}
