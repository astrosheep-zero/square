// Test-only read of the live artifact-owned presentation evidence.
import { createArtifactPort } from '../dist/artifact.js';
import { harnessOwner } from '../dist/owner.js';
import { formatActivityId } from '../dist/square-core.js';

export async function hasPresentedForOwner(sessionId, squarePath, name, actIndex, _env = process.env, _now = Date.now()) {
  const artifact = createArtifactPort(squarePath);
  try {
    const { value: evidence } = await artifact.read((facts) => {
      const seat = facts.seat(name);
      if (seat === undefined || seat.owner !== harnessOwner({ channel: 'pi', session: sessionId })) return [];
      const activity = facts.activity(actIndex);
      if (activity?.kind !== 'say' || activity.messageIndex === undefined) return [];
      return facts.deliveryEvidence(seat.participant, seat.generation, `msg/${activity.messageIndex}`)
        .filter((row) => row.kind === 'presentation');
    });
    return evidence.some((row) => row.outcome === 'presented');
  } finally {
    await artifact.close();
  }
}
