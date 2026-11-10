import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { LedgerStore } from '../dist/delivery-ledger-sqlite.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { attachDeliverySession } from '../dist/session-lifecycle.js';
import { dispatchEligibleCards, postAndDispatch } from '../dist/notifications.js';
import { runCodexWatch } from '../dist/codex-watch.js';
import { runClaudeMod } from '../dist/claude-mod.js';
import { codexHookResponse } from '../dist/codex-hook.js';
import { receiveOpenCodePending } from '../dist/plugins/opencode-shared/delivery.js';
import { retainDeliveryLedger } from '../dist/delivery-lifetime.js';

const owner = 'busy:owner';
const routes = [{ kind: 'controlled', address: {} }];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-delivery-busy-'));
  const location = path.join(root, 'delivery.sqlite');
  const env = { ...process.env, SQUARE_DELIVERY: location, CODEX_HOME: path.join(root, 'codex') };
  const ledger = await DeliveryLedger.open({ location });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes });
  const lock = new DatabaseSync(location);
  t.after(async () => { try { lock.exec('ROLLBACK'); } catch {} lock.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, location, env, ledger, session, lock };
}
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not settle');
    await sleep(5);
  }
}
const read = (file, sql) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

test('busy open resumes, cancelled validation closes, and an open signal never becomes a connection lifetime', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.lock.exec('BEGIN EXCLUSIVE');
  const abort = new AbortController(), reason = new Error('cancel open');
  const cancelled = assert.rejects(DeliveryLedger.open({ location: f.location, signal: abort.signal }), error => error === reason);
  let opened = false;
  const opening = DeliveryLedger.open({ location: f.location }).then(ledger => { opened = true; return ledger; });
  await sleep(40);
  assert.equal(opened, false);
  abort.abort(reason);
  await cancelled;
  f.lock.exec('ROLLBACK');
  const resumed = await opening;
  await resumed.close();
  const openingSignal = new AbortController();
  const reused = await DeliveryLedger.open({ location: f.location, signal: openingSignal.signal });
  openingSignal.abort();
  assert.equal((await reused.session(owner)).generation, f.session.generation);
  await reused.close();
});

test('queued cancellation returns before an unrelated writer, never executes later, and leaves the connection reusable', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  f.lock.exec('BEGIN IMMEDIATE');
  const first = f.ledger.post({ owner, key: 'first', text: 'first' });
  await sleep(30);
  const abort = new AbortController(), reason = new Error('cancel queued post');
  const cancelled = assert.rejects(f.ledger.post({ owner, key: 'cancelled', text: 'cancelled' }, abort.signal), error => error === reason);
  abort.abort(reason);
  await cancelled;
  // The first writer still cannot acquire the external lock.
  assert.deepEqual(f.lock.prepare('SELECT key FROM cards').all(), []);
  f.lock.exec('ROLLBACK');
  assert.equal((await first).status, 'posted');
  assert.equal((await f.ledger.post({ owner, key: 'later', text: 'later' })).status, 'posted');
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(card => card.key), ['first', 'later']);
});

test('close cancels active and queued ordinary waits without waiting for an external SQLite lock', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  f.lock.exec('BEGIN EXCLUSIVE');
  const active = assert.rejects(f.ledger.session(owner), /closed/);
  const queued = assert.rejects(f.ledger.post({ owner, key: 'never', text: 'never' }), /closed/);
  await sleep(30);
  await f.ledger.close();
  await Promise.all([active, queued]);
  f.lock.exec('ROLLBACK');
  assert.deepEqual(read(f.location, 'SELECT key FROM cards'), []);
});

test('handoff deadline includes busy acquisition, and initial current cancellation releases claimed custody before returning', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  let calls = 0;
  const transport = { kind: routes[0].kind, send: async () => { calls++; return 'accepted'; } };
  f.lock.exec('BEGIN IMMEDIATE');
  assert.equal((await f.ledger.dispatchHandoff(owner, 'one', transport, { generation: f.session.generation, timeoutMs: 30 })).outcome, 'not-invoked');
  f.lock.exec('ROLLBACK');
  assert.deepEqual(read(f.location, 'SELECT * FROM attempts'), []);
  const original = LedgerStore.prototype.claimHandoff;
  t.mock.method(LedgerStore.prototype, 'claimHandoff', async function (...args) {
    const claim = await original.apply(this, args);
    f.lock.exec('BEGIN EXCLUSIVE');
    setTimeout(() => f.lock.exec('ROLLBACK'), 80);
    return claim;
  });
  const released = await f.ledger.dispatchHandoff(owner, 'one', transport, { generation: f.session.generation, timeoutMs: 30 });
  assert.equal(released.outcome, 'released');
  assert.equal(released.persistence, 'recorded');
  assert.equal(calls, 0);
  assert.deepEqual(read(f.location, 'SELECT outcome FROM attempts').map(row => row.outcome), ['released']);
});

test('pre-send current errors release custody while preserving the persistence error', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  const failure = new Error('current read failed');
  t.mock.method(LedgerStore.prototype, 'current', async () => { throw failure; });
  await assert.rejects(f.ledger.dispatchHandoff(owner, 'one', { kind: routes[0].kind, send: () => assert.fail('must remain unsent') },
    { generation: f.session.generation, timeoutMs: 1000 }), error => error === failure);
  assert.deepEqual(read(f.location, 'SELECT outcome FROM attempts').map(row => row.outcome), ['released']);
});

test('cancelled caller cannot cancel successful boundary settlement, even while SQLite is busy', { timeout: 3000 }, async t => {
  const f = await fixture(t), abort = new AbortController();
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  const result = await presentPendingAtBoundary(owner, () => {
    f.lock.exec('BEGIN IMMEDIATE');
    abort.abort(new Error('run ended after output'));
    setTimeout(() => f.lock.exec('ROLLBACK'), 60);
    return 'accepted output';
  }, f.env, abort.signal);
  assert.equal(result, 'accepted output');
  assert.equal((await f.ledger.receipts(owner)).length, 1);
});

test('post-effect settlement has its own finite storage budget and reports failure without a false receipt', { timeout: 8000 }, async t => {
  const f = await fixture(t), abort = new AbortController();
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  try {
    await assert.rejects(presentPendingAtBoundary(owner, () => {
      f.lock.exec('BEGIN IMMEDIATE');
      abort.abort(new Error('caller already cancelled'));
    }, f.env, abort.signal), error => error.name === 'TimeoutError');
  } finally { f.lock.exec('ROLLBACK'); }
  assert.deepEqual(await f.ledger.receipts(owner), []);
  assert.equal(read(f.location, 'SELECT outcome FROM attempts')[0].outcome, 'dispatching');
  assert.equal((await f.ledger.post({ owner, key: 'later', text: 'connection remains usable' })).status, 'posted');
});

test('unknown persistence failure rejects but close retains the already invoked effect and records late presentation', { timeout: 3000 }, async t => {
  const f = await fixture(t), abort = new AbortController();
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  const entered = Promise.withResolvers(), completion = Promise.withResolvers();
  const failure = new Error('unknown persistence failed');
  const original = LedgerStore.prototype.settle;
  const injection = t.mock.method(LedgerStore.prototype, 'settle', function (tokens, outcome, ...rest) {
    if (outcome === 'unknown') return Promise.reject(failure);
    return original.call(this, tokens, outcome, ...rest);
  });
  const running = f.ledger.dispatchHandoff(owner, 'one', { kind: routes[0].kind, send() { entered.resolve(); return completion.promise; } },
    { generation: f.session.generation, timeoutMs: 1000, signal: abort.signal });
  const rejected = assert.rejects(running, error => error === failure);
  await entered.promise;
  abort.abort();
  await rejected;
  injection.mock.restore();
  await f.ledger.close();
  await assert.rejects(f.ledger.session(owner), /closed/);
  completion.resolve('presented');
  await until(() => read(f.location, 'SELECT * FROM receipts').length === 1);
});

test('close while transport is pending preserves its single late presentation without granting more send authority', { timeout: 3000 }, async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  const entered = Promise.withResolvers(), completion = Promise.withResolvers();
  let calls = 0;
  const running = f.ledger.dispatchHandoff(owner, 'one', { kind: routes[0].kind, send() {
    calls++; entered.resolve(); return completion.promise;
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  await entered.promise;
  await f.ledger.close();
  await assert.rejects(f.ledger.post({ owner, key: 'never', text: 'never' }), /closed/);
  completion.resolve('presented');
  const result = await running;
  assert.equal(result.outcome, 'presented');
  assert.equal(result.persistence, 'recorded');
  assert.equal(calls, 1);
  assert.equal(read(f.location, 'SELECT * FROM receipts').length, 1);
});

test('retirement between the initial current check and invocation releases custody without sending', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  const current = LedgerStore.prototype.current;
  t.mock.method(LedgerStore.prototype, 'current', async function (...args) {
    const result = await current.apply(this, args);
    await f.ledger.close();
    return result;
  });
  const result = await f.ledger.dispatchHandoff(owner, 'one', { kind: routes[0].kind, send: () => assert.fail('retired send') },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'released');
  assert.equal(read(f.location, 'SELECT outcome FROM attempts')[0].outcome, 'released');
  assert.deepEqual(read(f.location, 'SELECT * FROM receipts'), []);
});

test('retirement cancels an unrelated blocked writer so retained late settlement can proceed', { timeout: 3000 }, async t => {
  const f = await fixture(t), abort = new AbortController();
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  const entered = Promise.withResolvers(), completion = Promise.withResolvers();
  const running = f.ledger.dispatchHandoff(owner, 'one', { kind: routes[0].kind, send() { entered.resolve(); return completion.promise; } },
    { generation: f.session.generation, timeoutMs: 1000, signal: abort.signal });
  await entered.promise;
  abort.abort();
  const result = await running;
  f.lock.exec('BEGIN IMMEDIATE');
  const blocked = assert.rejects(f.ledger.post({ owner, key: 'never', text: 'never' }), /closed/);
  await sleep(20);
  const lifetime = retainDeliveryLedger(f.ledger);
  lifetime.track(result);
  await lifetime.close();
  await blocked;
  f.lock.exec('ROLLBACK');
  completion.resolve('presented');
  assert.deepEqual(await result.lateSettlement, { outcome: 'presented', persistence: { status: 'recorded' } });
  assert.equal(read(f.location, 'SELECT * FROM receipts').length, 1);
});

test('host, watcher, notification and OpenCode entry signals bound busy ledger opens and leave no delivery effects', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner, key: 'one', text: 'one' });
  f.lock.exec('BEGIN EXCLUSIVE');
  const abort = new AbortController(), reason = new Error('host lifetime ended');
  const rejected = [
    attachDeliverySession(owner, f.env, undefined, abort.signal),
    presentPendingAtBoundary(owner, () => assert.fail('sink must remain unsent'), f.env, abort.signal),
    dispatchEligibleCards(f.ledger, owner, { signal: abort.signal }),
    postAndDispatch(f.ledger, { owner, key: 'never', text: 'never' }, { signal: abort.signal }),
    receiveOpenCodePending('busy', f.session.generation, { kind: 'controlled', send: () => assert.fail('must remain unsent') }, f.env, abort.signal),
    runClaudeMod(JSON.stringify({ sessionId: 'busy' }), f.env, abort.signal, () => assert.fail('helper must remain unstarted')),
  ].map(promise => assert.rejects(promise, error => error === reason));
  const watches = [
    runCodexWatch(JSON.stringify({ hook_event_name: 'Stop', session_id: 'busy', turn_id: 'turn' }), f.env, abort.signal),
  ];
  const traces = [];
  const hook = codexHookResponse({ hook_event_name: 'PostToolUse', session_id: 'busy' }, () => assert.fail('no output'),
    { ...f.env, SQUARE_CODEX_HOOK_BUDGET_MS: '30' }, line => traces.push(line));
  await sleep(50);
  abort.abort(reason);
  await Promise.all([...rejected, ...watches, hook]);
  assert.match(traces[0], /error=TimeoutError/);
  f.lock.exec('ROLLBACK');
  assert.deepEqual(read(f.location, 'SELECT * FROM attempts'), []);
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(card => card.key), ['one']);
});
