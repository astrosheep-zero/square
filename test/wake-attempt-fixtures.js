import assert from 'node:assert/strict';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { hostLedgerRoot } from '../dist/host-ledger-root.js';
import { formatActivityId } from '../dist/square-core.js';

export function readWakeAttempts({ env, now = Date.now() }) {
  return createHostLedgerPort({ rootPath: hostLedgerRoot(env) }).listWakeAttempts({ now });
}

/** Seed one terminal wake attempt through the real claim and terminal write. */
export async function recordWakeAttempt(attempt, env) {
  const ledger = createHostLedgerPort({ rootPath: hostLedgerRoot(env) });
  const { attention, at = Date.now(), session = 'fixture-session', routeKind, ...details } = attempt;
  const leaseMs = 5000;
  const claim = await ledger.claimWakeAttempt({ attention, session, routeKind, leaseMs, now: at });
  assert.equal(claim.status, 'acquired');
  await ledger.appendEvidence({
    ...details,
    location: attention.squarePath,
    participant: attention.recipient,
    session,
    activity: formatActivityId(attention.actIndex),
    kind: 'wake',
    routeKind,
    attemptN: claim.attemptN,
    at,
    claimToken: claim.claimToken,
  });
}
