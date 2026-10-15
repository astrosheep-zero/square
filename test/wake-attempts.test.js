import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatActivityId } from '../dist/square-core.js';
import { readWakeReleaseDiagnostics, redactWakeDiagnostic } from '../dist/wake-attempts.js';
import { readWakeAttempts, recordWakeAttempt } from './wake-attempt-fixtures.js';
import { readLedgerRecords, seedLedger } from './host-ledger-fixtures.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fixture() {
  // The ledger compares canonical location keys; seed rows through a canonical root.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'square-wake-attempts-')));
  return {
    root,
    attention: { squarePath: path.join(root, 'SQUARE.square'), actIndex: 4, recipient: 'Faye' },
    env: { SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'), SQUARE_HOST_LEDGER_ROOT: path.join(root, 'host-ledger') },
  };
}

function row(item, overrides = {}) {
  return {
    v: 1,
    at: 1_000,
    location: item.attention.squarePath,
    participant: 'Faye',
    session: 'test-session',
    activity: formatActivityId(4),
    kind: 'wake',
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'test',
    attemptN: 1,
    ...overrides,
  };
}

test('canonical wake evidence reads ignore expired and future rows', async () => {
  const item = fixture();
  const now = 8 * DAY_MS;
  // Only raw storage seeding can place rows outside the visibility window.
  seedLedger(item.env.SQUARE_HOST_LEDGER_ROOT, { evidence: [
    row(item, { at: now - 7 * DAY_MS - 1 }),
    row(item, { at: now + 1 }),
    row(item, { at: now - DAY_MS, outcome: 'unknown', signature: undefined }),
    row(item, { at: now - 7 * DAY_MS, outcome: 'accepted', signature: undefined, attemptN: 2 }),
  ] });

  assert.deepEqual((await readWakeAttempts({ env: item.env, now })).map((attempt) => [attempt.outcome, attempt.attemptN]), [
    ['unknown', 1], ['accepted', 2],
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('wake release diagnostics are readable without entering behavior evidence', async () => {
  const item = fixture();
  const ledger = (await import('../dist/host-ledger-file-adapter.js')).createHostLedgerPort({ rootPath: item.env.SQUARE_HOST_LEDGER_ROOT });
  const address = {
    location: item.attention.squarePath,
    participant: item.attention.recipient,
    session: 'test-session',
    activity: formatActivityId(item.attention.actIndex),
  };
  const claim = await ledger.claimWakeAttempt({ attention: item.attention, session: 'test-session', routeKind: 'paseo', leaseMs: 5_000, now: 1_000 });
  assert.equal(claim.status, 'acquired');
  await ledger.releaseEvidence({
    ...address,
    kind: 'wake',
    claimToken: claim.claimToken,
    routeKind: 'paseo',
    attemptN: 2,
    signature: 'agent_not_idle',
    message: 'The agent is not idle.',
    diagnostic: { phase: 'selection', code: 'not_idle' },
    now: 1_001,
  });

  assert.deepEqual(await ledger.listWakeAttempts({ attention: item.attention, now: 1_002 }), []);
  const [release] = await readWakeReleaseDiagnostics({ attention: item.attention, now: 1_002, env: item.env });
  assert.deepEqual([release.at, release.routeKind, release.attemptN, release.signature], [1_001, 'paseo', 2, 'agent_not_idle']);
  assert.deepEqual(release.diagnostic, { phase: 'selection', code: 'not_idle' });
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('wake diagnostics redact nested credentials while retaining safe presence flags', () => {
  assert.deepEqual(redactWakeDiagnostic({
    passwordPresent: true,
    nested: { apiKey: 'secret', detail: 'secret and ?password=query-secret' },
  }, { PASEO_PASSWORD: 'secret' }), {
    passwordPresent: true,
    nested: { apiKey: '[redacted]', detail: '[redacted] and ?password=[redacted]' },
  });
});

test('a wake attempt write drops expired ledger rows', async () => {
  const item = fixture();
  const now = Date.now();
  seedLedger(item.env.SQUARE_HOST_LEDGER_ROOT, { evidence: [
    row(item, { at: now - 7 * DAY_MS - 1 }),
    row(item, { at: now - DAY_MS, attemptN: 2 }),
  ] });

  await recordWakeAttempt({
    at: now,
    attention: item.attention,
    session: 'test-session',
    routeKind: 'paseo',
    outcome: 'failed',
    signature: 'new_route_failure',
  }, item.env);

  const rows = readLedgerRecords(item.env.SQUARE_HOST_LEDGER_ROOT, 'evidence');
  assert.deepEqual(rows.map((entry) => entry.attemptN), [2, 3]);
  fs.rmSync(item.root, { recursive: true, force: true });
});
