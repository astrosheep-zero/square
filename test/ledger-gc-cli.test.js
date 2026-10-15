import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createArtifactPort, createSquareFile } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { nativePayload } from '../dist/claude-delivery.js';

const CLI = fileURLToPath(new URL('../dist/square.js', import.meta.url));

test('global ledger gc is explicit, read-only on dry-run, secret-free and idempotent', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-gc-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const squarePath = path.join(root, 'S.square'), ledgerRoot = path.join(root, 'ledger');
  await createSquareFile(squarePath, { hardCap: null, preamble: [], warmup: [], acts: [], runtime: emptyRuntimeState(0) });
  const artifact = createArtifactPort(squarePath);
  try {
    await artifact.transact(facts => {
      facts.land({ kind: 'join', actor: 'Alice', at: 1 });
      facts.land({ kind: 'join', actor: 'Bob', at: 2 });
      facts.land({ kind: 'say', actor: 'Alice', at: 3, body: 'private @Bob', mentions: ['Bob'] });
      facts.markSeen('Bob', [2], 4);
    });
  } finally { await artifact.close(); }
  const old = Date.now() - 8 * 86400000;
  const ledger = createHostLedgerPort({ rootPath: ledgerRoot, now: () => old });
  const claim = await ledger.claimWakeAttempt({ attention: { squarePath, recipient: 'Bob', actIndex: 2 }, session: 'receiver', routeKind: 'claude-native', leaseMs: 50 });
  assert.equal(claim.status, 'acquired');
  const row = { location: squarePath, participant: 'Bob', session: 'receiver', activity: 'act/2', kind: 'wake', routeKind: 'claude-native', claimToken: claim.claimToken, attemptN: claim.attemptN, nativeDelivery: { harness: 'claude', epoch: 1, endpoint: '/PRIVATE-ENDPOINT', payload: nativePayload(claim.claimToken, 'PRIVATE-PAYLOAD') } };
  await ledger.prepareNativeWake({ ...row, outcome: 'dispatching' });
  await ledger.appendEvidence({ ...row, outcome: 'unknown', at: old });
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: ledgerRoot, SQUARE_LOCATION: '', SQUARE_PARTICIPANT_NAME: '' };
  function run(args) {
    const result = spawnSync(process.execPath, [CLI, 'ledger', ...args], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-PAYLOAD|PRIVATE-ENDPOINT|square-inbox/);
    assert.ok(!result.stdout.includes(claim.claimToken), 'no recognition credential is printed');
    return result.stdout;
  }
  const database = path.join(ledgerRoot, 'host-ledger.sqlite');
  const beforeLedger = fs.readFileSync(database), beforeArtifact = fs.readFileSync(squarePath);
  assert.match(run(['gc', '--dry-run']), /eligible: 1/);
  assert.deepEqual(fs.readFileSync(database), beforeLedger);
  assert.deepEqual(fs.readFileSync(squarePath), beforeArtifact);
  const execution = run(['gc']);
  assert.match(execution, /retired: 1/);
  assert.deepEqual(fs.readFileSync(squarePath), beforeArtifact, 'GC never creates receipts');
  assert.deepEqual(await ledger.listEvidence({ includeExpired: true, includeReleased: true }), []);
  assert.deepEqual(await ledger.lookupNativeTokens({ harness: 'claude', session: 'receiver', tokens: [claim.claimToken] }), { deliveries: [], retired: [claim.claimToken] });
  assert.match(run(['gc']), /retired: 0/);
  run(['verify']);
});
