import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSquareState, writeSquareFile, readSquareRevision } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { observeSessionPending } from '../dist/inbox.js';

async function fixture(t, leaseMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pending-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SQUARE.square');
  const ledgerRoot = path.join(root, 'ledger');
  const ledger = createHostLedgerPort({ rootPath: ledgerRoot });
  const state = await createSquareState({ force: true, hardCap: null }, 'pending');
  state.acts = [
    { kind: 'join', actor: 'Alice', index: 0, at: 1 },
    { kind: 'join', actor: 'Bob', index: 1, at: 2 },
    { kind: 'say', actor: 'Alice', index: 2, at: 3, body: 'hello', mentions: ['Bob'] },
  ];
  state.runtime.nextActIndex = 3;
  if (leaseMs !== undefined) state.runtime.leases.Bob = { leaseId: 'catch', heartbeatAt: Date.now(), expiresAt: Date.now() + leaseMs, filter: { mention: 'Bob' } };
  await writeSquareFile(file, state);
  const observer = await observeSessionPending('one', { SQUARE_HOST_LEDGER_ROOT: ledgerRoot });
  t.after(() => observer.close());
  const bind = (session = 'one') => ledger.ensurePresence({ location: file, participant: 'Bob', session, channel: 'pi', updatedAt: Date.now() });
  return { file, ledger, ledgerRoot, observer, bind };
}

function armedWait(observer, options = {}) {
  let armed;
  const ready = new Promise((resolve) => { armed = resolve; });
  const pending = observer.wait(4_000, { ...options, onChangeArmed: armed });
  return { ready, pending };
}

test('an initially unbound session notices a new binding without an artifact write', async (t) => {
  const item = await fixture(t);
  const baseline = await readSquareRevision(item.file);
  const waiting = armedWait(item.observer);
  await waiting.ready;
  await item.bind();
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);
  assert.equal(await readSquareRevision(item.file), baseline);
});

test('catch lease expiry wakes notification eligibility without an artifact write', async (t) => {
  const item = await fixture(t, 250);
  await item.bind();
  const baseline = await readSquareRevision(item.file);
  const pending = await item.observer.wait(2_000);
  assert.equal(pending[0].notifications[0].actIndex, 2);
  assert.equal(await readSquareRevision(item.file), baseline);
});

test('presentation-only evidence invalidates eligibility; failed evidence cannot spin deferred retries', async (t) => {
  const item = await fixture(t);
  await item.bind();
  const base = { location: item.file, participant: 'Bob', session: 'one', activity: 'act/2', kind: 'presentation' };
  let claim = await item.ledger.claimEvidence({ ...base, leaseMs: 1_000 });
  await item.ledger.appendEvidence({ ...base, claimToken: claim.claimToken, outcome: 'clipped' });
  const waiting = armedWait(item.observer);
  await waiting.ready;
  claim = await item.ledger.claimEvidence({ ...base, leaseMs: 1_000 });
  await item.ledger.appendEvidence({ ...base, claimToken: claim.claimToken, outcome: 'failed' });
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);

  const controller = new AbortController();
  const retry = armedWait(item.observer, { skipImmediate: true, signal: controller.signal });
  await retry.ready;
  let resolved = false;
  retry.pending.then(() => { resolved = true; });
  claim = await item.ledger.claimEvidence({ ...base, leaseMs: 1_000 });
  await item.ledger.appendEvidence({ ...base, claimToken: claim.claimToken, outcome: 'failed' });
  await sleep(100);
  assert.equal(resolved, false);
  const cell = createFileCell(item.file);
  try { await cell.transact((state) => ({ state: { ...state, preamble: ['external edge'] }, result: undefined })); }
  finally { await cell.close(); }
  assert.equal((await retry.pending)[0].notifications[0].actIndex, 2);
});

test('one session cancellation cannot close a shared monitor or suppress another session', async (t) => {
  const item = await fixture(t);
  const other = await observeSessionPending('two', { SQUARE_HOST_LEDGER_ROOT: item.ledgerRoot });
  t.after(() => other.close());
  const cancelled = new AbortController();
  const first = armedWait(item.observer, { signal: cancelled.signal });
  const second = armedWait(other);
  await Promise.all([first.ready, second.ready]);
  cancelled.abort();
  assert.deepEqual(await first.pending, []);
  item.observer.close();
  await item.bind('two');
  assert.equal((await second.pending)[0].notifications[0].actIndex, 2);
});
