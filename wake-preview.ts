import type { WakeProjectionContext, WakeProjection, SquareArtifactPort } from './ports.js';
import { parseMessageId } from './message.js';
import { nativePendingPreview } from './inbox.js';
import { canonicalPathSync } from './canonical-path.js';

export function squareWakeProjection(artifact: SquareArtifactPort): WakeProjection {
  return async context => (await artifact.read(facts => wakePreview(facts, context))).value;
}

/** Agora-framed projection over the narrow captured delivery context. */
export function wakePreview(facts: import('./ports.js').SquareRead, request: WakeProjectionContext) {
  const index = parseMessageId(request.message);
  if (index === undefined) return undefined;
  const preview = nativePendingPreview(facts, { location: canonicalPathSync(request.location), participant: request.participant,
    generation: request.seat.generation, owner: request.seat.owner, index, route: request.route, now: Date.now() });
  return preview === undefined ? undefined : { payload: preview.payload, coverage: preview.clipped ? 'clipped' as const : 'full' as const };
}
