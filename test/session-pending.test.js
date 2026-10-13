import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createSquareState, writeSquareFile, readSquareRevision } from '../dist/artifact.js';
import { createFileCell } from '../dist/square-storage.js';
import { createHostLedgerPort, FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { observeSessionPending } from '../dist/inbox.js';

async function fixture(t, leaseMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pending-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SQUARE.square');
  const ledgerRoot = path.join(root, 'ledger');
  fs.mkdirSync(ledgerRoot);
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

function armedWait(observer, options = {}, timeoutMs = 4_000) {
  let armed;
  const ready = new Promise((resolve) => { armed = resolve; });
  const pending = observer.wait(timeoutMs, { ...options, onChangeArmed: armed });
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

test('unrelated ledger changes reuse unchanged history while local activity still notifies', async (t) => {
  const item = await fixture(t);
  const cell = createFileCell(item.file);
  t.after(() => cell.close());
  await cell.transact((state) => {
    state.acts.pop();
    state.runtime.nextActIndex = 2;
    return { state, result: undefined };
  });
  await item.bind();
  const waiting = armedWait(item.observer, {}, 2_500);
  await waiting.ready;
  let snapshots = 0;
  let refreshes = 0;
  const listPresence = FileHostLedgerPort.prototype.listPresence;
  t.mock.method(FileHostLedgerPort.prototype, 'listPresence', function (input) {
    if (input.session === 'one') refreshes++;
    return listPresence.call(this, input);
  });
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/^SELECT id, revision, state FROM square_snapshot$/i.test(sql)) snapshots++;
    return prepare.call(this, sql, ...args);
  });
  const base = { location: path.join(item.ledgerRoot, 'unrelated.square'), participant: 'Other', session: 'unrelated', activity: 'act/0', kind: 'presentation' };
  const claim = await item.ledger.claimEvidence({ ...base, leaseMs: 1_000 });
  await item.ledger.appendEvidence({ ...base, claimToken: claim.claimToken, outcome: 'presented' });
  await item.ledger.ensurePresence({ ...base, channel: 'pi' });
  assert.deepEqual(await waiting.pending, []);
  assert.ok(refreshes > 0, 'the observer must refresh bindings after the ledger changes');
  assert.equal(snapshots, 0);
  const changed = armedWait(item.observer);
  await changed.ready;
  await cell.transact((state) => {
    state.acts.push({ kind: 'say', actor: 'Alice', index: 2, at: 4, body: 'new activity', mentions: ['Bob'] });
    state.runtime.nextActIndex = 3;
    return { state, result: undefined };
  });
  assert.equal((await changed.pending)[0].notifications[0].body, 'new activity');
});

test('an unreadable artifact cannot reuse stale pending and repair restores delivery', async (t) => {
  const item = await fixture(t);
  await item.bind();
  assert.equal((await item.observer.wait(1_000))[0].notifications[0].actIndex, 2);
  const saved = fs.readFileSync(item.file);
  fs.writeFileSync(item.file, 'not a SQLite database');
  await sleep(30);
  const waiting = armedWait(item.observer);
  await waiting.ready;
  fs.writeFileSync(item.file, saved);
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);
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

test('a stale binding does not rescan the ledger on missing-artifact reconciliation', async (t) => {
  const item = await fixture(t);
  await item.bind();
  const saved = fs.readFileSync(item.file);
  fs.unlinkSync(item.file);
  let reads = 0;
  const readFile = fs.promises.readFile.bind(fs.promises);
  t.mock.method(fs.promises, 'readFile', (...args) => {
    if (String(args[0]).startsWith(item.ledgerRoot)) reads++;
    return readFile(...args);
  });
  const waiting = armedWait(item.observer);
  await waiting.ready;
  const baseline = reads;
  await sleep(2_200);
  assert.equal(reads, baseline);
  fs.writeFileSync(item.file, saved);
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);
});

test('an unreadable binding stays quiet across reconciliation and restores delivery on repair', async (t) => {
  const item = await fixture(t);
  const saved = fs.readFileSync(item.file);
  const cell = createFileCell(item.file);
  try { await cell.transact((state) => { state.acts.pop(); state.runtime.nextActIndex--; return { state, result: undefined }; }); }
  finally { await cell.close(); }
  const corruptFile = path.join(path.dirname(item.file), 'CORRUPT.square');
  fs.writeFileSync(corruptFile, 'not a SQLite artifact');
  await item.bind();
  await item.ledger.ensurePresence({ location: corruptFile, participant: 'Bob', session: 'one', channel: 'pi', updatedAt: Date.now() });
  await assert.rejects(readSquareRevision(corruptFile), { code: 'invalid_args' });
  let snapshotReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/\bFROM\s+square_snapshot\b/i.test(sql) && /\bstate\b/i.test(sql)) snapshotReads++;
    return prepare.call(this, sql, ...args);
  });
  let ledgerReads = 0;
  const readFile = fs.promises.readFile.bind(fs.promises);
  t.mock.method(fs.promises, 'readFile', (...args) => {
    if (String(args[0]).startsWith(item.ledgerRoot)) ledgerReads++;
    return readFile(...args);
  });
  const waiting = armedWait(item.observer, {}, 8_000);
  await waiting.ready;
  snapshotReads = 0;
  ledgerReads = 0;
  await sleep(4_200);
  assert.equal(snapshotReads, 0);
  assert.equal(ledgerReads, 0);
  fs.writeFileSync(corruptFile, saved);
  const repaired = (await waiting.pending)[0];
  assert.equal(path.basename(repaired.squarePath), 'CORRUPT.square');
  assert.equal(repaired.notifications[0].actIndex, 2);
});

test('an unrepaired binding respects timeout and cancellation', async (t) => {
  const item = await fixture(t);
  await item.bind();
  fs.writeFileSync(item.file, 'not a SQLite artifact');
  assert.deepEqual(await item.observer.wait(80), []);
  const controller = new AbortController();
  const waiting = armedWait(item.observer, { signal: controller.signal });
  await waiting.ready;
  controller.abort();
  assert.deepEqual(await waiting.pending, []);
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
