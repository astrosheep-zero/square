import assert from 'node:assert/strict';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { hostLedgerRoot } from '../dist/host-ledger-root.js';
import { formatActivityId } from '../dist/square-core.js';

export function readWakeAttempts({ env, now = Date.now() }) {
  return createHostLedgerPort({ rootPath: hostLedgerRoot(env) }).listWakeAttempts({ now });
}

export async function recordWakeAttempt(attempt, env) {
  const ledger = createHostLedgerPort({ rootPath: hostLedgerRoot(env) });
  const { attention, at = Date.now(), ...details } = attempt;
  const record = {
    ...details,
    location: attention.squarePath,
    participant: attention.recipient,
    session: attempt.session ?? 'fixture-session',
    activity: formatActivityId(attention.actIndex),
    kind: 'wake',
    at,
  };
  const claim = await ledger.claimEvidence({ ...record, leaseMs: 5000, now: at });
  assert.equal(claim.status, 'acquired');
  await ledger.appendEvidence({ ...record, claimToken: claim.claimToken });
}
