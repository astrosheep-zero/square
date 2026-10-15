import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LEDGER_FILENAME } from '../dist/host-ledger-sqlite.js';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { seedLedger, readLedgerRecords, readLedgerRevisions } from './host-ledger-fixtures.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'square-ledger-semantics-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'test.square');
  return { root, location, ledger: new FileHostLedgerPort({ rootPath: root, now: () => 100 }) };
}

test('presence claims retain latest-time stable precedence, include future owners, and do not prune on refusal', async (t) => {
  const { root, location, ledger } = fixture(t);
  const base = { v: 1, location, participant: 'Alice', channel: 'pi' };
  const rows = [
    { ...base, session: 'high-epoch', epoch: 99, updatedAt: 90 },
    { ...base, session: 'first-future', epoch: 1, updatedAt: 110 },
    { ...base, participant: 'ALICE', session: 'second-future', epoch: 9, updatedAt: 110 },
    { ...base, participant: 'Other', session: 'expired', updatedAt: -7 * 86400000 },
  ];
  seedLedger(root, { presence: rows });
  const before = await readLedgerRevisions(root);
  const result = await ledger.claimPresence({ ...base, session: 'contender', updatedAt: 100 });
  assert.equal(result.status, 'busy');
  assert.deepEqual(result.record, rows[1], 'timestamp beats epoch; equal timestamps keep original insertion order');
  assert.deepEqual(readLedgerRecords(root, 'presence'), rows, 'a refused claim must not perform retention housekeeping');
  assert.deepEqual(await readLedgerRevisions(root), before);
});

test('duplicate exact presence identities keep last-match update/removal and same-epoch cancellation semantics', async (t) => {
  const { root, location, ledger } = fixture(t);
  const base = { v: 1, location, participant: 'Alice', session: 'one', channel: 'pi' };
  const rows = [
    { ...base, epoch: 1, updatedAt: 10, cancelledThrough: 8 },
    { ...base, epoch: 2, updatedAt: 20, cancelledThrough: 3 },
    { ...base, epoch: 2, updatedAt: 20, cancelledThrough: 5 },
    { ...base, channel: 'codex', epoch: 2, updatedAt: 20 },
  ];
  seedLedger(root, { presence: rows });
  assert.equal(await ledger.suppressPresence({ ...base, epoch: 2 }, 9), true);
  assert.deepEqual(readLedgerRecords(root, 'presence'), [rows[0], rows[1], { ...rows[2], cancelledThrough: 9 }, rows[3]]);
  assert.equal(await ledger.removePresenceIfUnchanged({ ...base, epoch: 2, updatedAt: 20 }), true);
  assert.deepEqual(readLedgerRecords(root, 'presence'), [rows[0], rows[1], rows[3]], 'only the last matching duplicate is removed');
  assert.equal((await ledger.ensurePresence({ ...base, epoch: 2, updatedAt: 100, cancelledThrough: 1 })).status, 'ensured');
  assert.deepEqual(readLedgerRecords(root, 'presence'), [rows[3], { ...base, epoch: 2, updatedAt: 100, cancelledThrough: 3 }], 'replacement appends and uses the last same-epoch cancellation maximum');
});

test('retention housekeeping uses its time index and only runs when a mutation publishes', async (t) => {
  const { root, location, ledger } = fixture(t);
  const base = { v: 1, location, participant: 'Alice', session: 'one', activity: 'act/2', kind: 'wake' };
  const rows = [
    { ...base, outcome: 'accepted', at: -7 * 86400000 },
    { ...base, outcome: 'failed', at: -7 * 86400000 },
    { ...base, outcome: 'failed', at: 110 },
  ];
  seedLedger(root, { evidence: rows });
  const db = new DatabaseSync(path.join(root, LEDGER_FILENAME), { readOnly: true });
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN DELETE FROM host_evidence WHERE effective_at<? AND NOT (kind='wake' AND outcome IN ('accepted','unknown','dispatching'))").all(100 - 7 * 86400000);
    assert.match(plan.map((row) => row.detail).join('\n'), /SEARCH host_evidence USING INDEX host_evidence_time/);
  } finally { db.close(); }
  const claim = { attention: { squarePath: location, recipient: 'Alice', actIndex: 2 }, session: 'new', routeKind: 'paseo', leaseMs: 10 };
  assert.equal((await ledger.claimWakeAttempt(claim)).status, 'terminal');
  assert.deepEqual(readLedgerRecords(root, 'evidence'), rows, 'terminal refusal does not prune aged ordinary evidence');
  assert.equal((await ledger.claimWakeAttempt({ ...claim, attention: { ...claim.attention, actIndex: 3 } })).status, 'acquired');
  assert.deepEqual(readLedgerRecords(root, 'evidence').slice(0, 2), [rows[0], rows[2]], 'mutation prunes expired ordinary evidence, not durable or future records');
});

test('wake accepted-before-unknown and presentation busy-before-presented precedence survive duplicates', async (t) => {
  const { root, location, ledger } = fixture(t);
  const base = { v: 1, location, participant: 'Alice', activity: 'act/2', at: 100 };
  const accepted = { ...base, session: 'accepted-session', kind: 'wake', outcome: 'accepted' };
  const dispatch = { ...base, session: '', kind: 'presentation', outcome: 'dispatching', expiresAt: 120, claimToken: 'live' };
  seedLedger(root, { evidence: [accepted,
    { ...base, session: 'unknown-session', kind: 'wake', outcome: 'unknown', unknownSource: 'transport' },
    { ...base, session: 'live-session', kind: 'wake', outcome: 'dispatching', expiresAt: 120, ownerPid: process.pid },
    { ...base, session: '', kind: 'presentation', outcome: 'presented' }, dispatch,
    { ...base, session: 'foreign', kind: 'presentation', outcome: 'dispatching', expiresAt: 999 },
  ] });
  const wake = await ledger.claimWakeAttempt({ attention: { squarePath: location, recipient: 'ALICE', actIndex: 2 }, session: 'new', routeKind: 'paseo', leaseMs: 10 });
  assert.deepEqual(wake, { status: 'terminal', record: accepted });
  const input = { location, participant: 'ALICE', session: '', kind: 'presentation', activity: 'act/2', leaseMs: 10 };
  assert.deepEqual(await ledger.claimEvidence({ ...input, now: 100 }), { status: 'busy', record: dispatch });
  assert.equal((await ledger.claimEvidence({ ...input, now: 120 })).status, 'delivered', 'an empty exact session never borrows a foreign live claim');
});
