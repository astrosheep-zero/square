// Test-only read of the live presentation evidence projection.
import { hostLedgerForEnv } from '../dist/registry.js';
import { canonicalPath } from '../dist/canonical-path.js';
import { formatActivityId } from '../dist/square-core.js';
import { projectPresentationEvidence } from '../dist/square-projections.js';

export async function hasPresentedForOwner(sessionId, squarePath, name, actIndex, env = process.env, now = Date.now()) {
  const location = await canonicalPath(squarePath);
  const evidence = await projectPresentationEvidence({
    hostLedger: hostLedgerForEnv(env),
    now,
    location,
    participant: name,
    sessionId,
    activity: formatActivityId(actIndex),
  });
  return evidence.some((row) => row.outcome === 'presented');
}
