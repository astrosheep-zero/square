import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { retainDeliveryLedger } from '../dist/delivery-lifetime.js';
import { harnessOwner } from '../dist/owner.js';
import { receiveOpenCodePending } from '../dist/plugins/opencode-shared/delivery.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-late-lifetime-'));
  const env = { ...process.env, SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'),
    SQUARE_NOTIFY_DELIVERY_WAIT_MS: '100', SQUARE_DISABLE_PASEO_WAKE: '1' };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(async () => { await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, env, ledger };
}

test('producer timeout returns while the same idle connection preserves late HTTP acceptance', { timeout: 10000 }, async t => {
  const f = await fixture(t), received = deferred(), release = deferred(), closed = deferred();
  let requests = 0, result, senderLedger, closes = 0;
  const server = http.createServer((request, response) => {
    requests++; request.resume(); response.writeHead(204); response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const square = await Square.build({ path: path.join(f.root, 'world.square'), markdown: '', env: f.env });
  const owner = 'producer:late';
  await square.join('recipient', { owner, wakeAddress: { kind: 'http', address: { url: `http://127.0.0.1:${server.address().port}/` } } });
  const originalFetch = globalThis.fetch, originalDispatch = DeliveryLedger.prototype.dispatchHandoff;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    received.resolve(); await release.promise; return response;
  };
  DeliveryLedger.prototype.dispatchHandoff = async function (...args) {
    senderLedger = this;
    const originalClose = this.close.bind(this);
    this.close = async () => { closes++; await originalClose(); closed.resolve(); };
    result = await originalDispatch.apply(this, args);
    return result;
  };
  try {
    const sending = square.send({ from: 'notice', to: 'recipient', body: 'late acceptance' });
    await received.promise;
    await sending;
    assert.equal(result.outcome, 'unknown');
    assert.ok(result.lateSettlement);
    assert.equal(closes, 0);
    // An independent writer commits while the retained transport has not settled.
    assert.equal((await f.ledger.post({ owner, key: 'independent', text: 'not blocked' })).status, 'posted');
    assert.equal((await senderLedger.session(owner)).state, 'attached');
    release.resolve();
    assert.deepEqual(await result.lateSettlement, { outcome: 'accepted', persistence: { status: 'recorded' } });
    await closed.promise;
    const session = await f.ledger.session(owner);
    assert.deepEqual((await f.ledger.handoffs(owner, { generation: session.generation })).map(attempt => attempt.outcome), ['accepted']);
    assert.equal(requests, 1);
    assert.equal(closes, 1);
  } finally {
    release.resolve(); globalThis.fetch = originalFetch; DeliveryLedger.prototype.dispatchHandoff = originalDispatch;
    await square.close(); await new Promise(resolve => server.close(resolve));
  }
});

test('receiver cancellation retires promptly and records only the already-invoked late effect', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = deferred(), finish = deferred(), closed = deferred();
  const owner = harnessOwner({ channel: 'opencode', session: 'late' });
  const session = await f.ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'controlled', address: {} }] });
  await f.ledger.post({ owner, key: 'first', text: 'first' });
  await f.ledger.post({ owner, key: 'second', text: 'second' });
  const abort = new AbortController(), original = DeliveryLedger.prototype.dispatchHandoff;
  let result, calls = 0, closes = 0;
  DeliveryLedger.prototype.dispatchHandoff = async function (...args) {
    const originalClose = this.close.bind(this);
    this.close = async () => { closes++; await originalClose(); closed.resolve(); };
    result = await original.apply(this, args); return result;
  };
  try {
    const running = receiveOpenCodePending('late', session.generation, { kind: 'controlled', send: async () => {
      calls++; entered.resolve(); return finish.promise;
    } }, f.env, abort.signal);
    await entered.promise;
    abort.abort();
    await running;
    assert.equal(result.outcome, 'unknown');
    assert.equal(closes, 0);
    assert.equal(await f.ledger.cancel({ owner, generation: session.generation }), true);
    finish.resolve('accepted');
    assert.deepEqual(await result.lateSettlement, { outcome: 'accepted', persistence: { status: 'recorded' } });
    await closed.promise;
    assert.equal(calls, 1);
    assert.equal(closes, 1);
    assert.deepEqual((await f.ledger.handoffs(owner, { generation: session.generation })).map(attempt => attempt.outcome), ['accepted']);
    assert.deepEqual(await f.ledger.receipts(owner), []);
  } finally { finish.resolve('accepted'); DeliveryLedger.prototype.dispatchHandoff = original; }
});

test('throwing host diagnostics cannot reject late observers or strand a retired connection', async t => {
  const diagnostics = [], closed = deferred();
  t.mock.method(console, 'warn', () => { throw Error('host diagnostic sink failed'); });
  t.mock.method(process.stderr, 'write', text => { diagnostics.push(JSON.parse(text)); return true; });
  let closes = 0;
  const lifetime = retainDeliveryLedger({ close: async () => { closes++; closed.resolve(); throw Error('close failed'); } });
  const late = deferred();
  lifetime.track({ outcome: 'unknown', lateSettlement: late.promise });
  lifetime.track({ outcome: 'unknown', lateSettlement: Promise.reject(Error('unexpected rejection')) });
  await lifetime.close();
  late.resolve({ outcome: 'accepted', persistence: { status: 'error', error: Error('private body') } });
  await closed.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.deepEqual(new Set(diagnostics.map(item => item.event)), new Set([
    'delivery-late-settlement', 'delivery-late-settlement-rejected', 'delivery-ledger-deferred-close-error',
  ]));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private body/);
});

test('retirement observes every late result, diagnoses failure without body text and closes once', async t => {
  const warnings = [], originalWarn = console.warn;
  console.warn = value => warnings.push(value);
  t.after(() => { console.warn = originalWarn; });
  let closes = 0;
  const lifetime = retainDeliveryLedger({ close: async () => { closes++; } });
  const first = deferred(), second = deferred(), third = deferred();
  lifetime.track({ outcome: 'unknown', token: 'private-token', lateSettlement: first.promise });
  lifetime.track({ outcome: 'unknown', lateSettlement: second.promise });
  lifetime.track({ outcome: 'unknown', lateSettlement: third.promise });
  await lifetime.close();
  assert.equal(closes, 0);
  first.resolve({ outcome: 'accepted', persistence: { status: 'error', error: Error('private body') } });
  second.resolve({ outcome: 'accepted', persistence: { status: 'not-recorded' } });
  await Promise.resolve();
  assert.equal(closes, 0);
  third.resolve({ outcome: 'accepted', persistence: { status: 'recorded' } });
  await Promise.resolve(); await lifetime.close();
  assert.equal(closes, 1);
  assert.deepEqual(warnings.map(item => item.persistence), ['error', 'not-recorded']);
  assert.doesNotMatch(JSON.stringify(warnings), /private body|private-token/);
  let immediate = 0;
  const idle = retainDeliveryLedger({ close: async () => { immediate++; } });
  await idle.close(); await idle.close();
  assert.equal(immediate, 1);
});
