import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { renderDeliveryBatch } from '../dist/delivery-ledger-render.js';

const owner = 'native:session/1';
const pull = { kind: 'boundary', address: {} };
const push = { kind: 'socket', address: { endpoint: '/opaque/address' } };
const routes = [pull, push];
const day = 86_400_000;
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-ledger-'));
  const location = path.join(dir, 'delivery.sqlite');
  const ledger = await DeliveryLedger.open({ location, ...options });
  t.after(async () => { await ledger.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes });
  const read = (sql, ...params) => {
    const db = new DatabaseSync(location, { readOnly: true });
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
  };
  return { ledger, location, session, read,
    post: (key, text = key) => ledger.post({ owner, key, text }),
    claim: (budgetChars = 10000, generation = session.generation, signal) => ledger.claimPresentation(owner, { generation, budgetChars, signal }),
    dispatch: (key, outcome = 'accepted', extra = {}) => ledger.dispatchHandoff(owner, key,
      { kind: push.kind, send: async () => outcome }, { generation: session.generation, timeoutMs: 1000, ...extra }),
  };
}

async function interruptedHandoff(f, key) {
  await f.post(key);
  const started = Promise.withResolvers(), completion = Promise.withResolvers();
  const controller = new AbortController();
  let calls = 0;
  const running = f.ledger.dispatchHandoff(owner, key, { kind: push.kind, send() {
    calls++; started.resolve(); return completion.promise;
  } }, { generation: f.session.generation, timeoutMs: 60000, signal: controller.signal });
  await started.promise;
  controller.abort(new Error('abort after invocation'));
  const result = await running;
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.persistence, 'recorded');
  assert.ok(result.lateSettlement instanceof Promise);
  return { result, ...completion, calls: () => calls };
}

test('stable owner cards are idempotent, whole, and retained through detach and CAS reattach', async t => {
  const f = await fixture(t);
  assert.equal((await f.ledger.post({ owner: 'unknown', key: 'p:1', text: 'x' })).status, 'unknown-session');
  const text = '<message>\n鱼 🐈\n</message>';
  assert.equal((await f.post('p:1', text)).status, 'posted');
  assert.equal((await f.post('p:1', text)).status, 'duplicate');
  assert.equal((await f.post('p:1', text + '!')).status, 'conflict');
  assert.equal(await f.ledger.detach({ owner, generation: f.session.generation }), true);
  await f.post('p:2');
  assert.equal(await f.claim(), undefined);
  const resumed = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.notEqual(resumed.generation, f.session.generation);
  assert.equal(await f.claim(), undefined);
  const batch = await f.claim(1000, resumed.generation);
  assert.deepEqual(batch.cards.map(c => c.key), ['p:1', 'p:2']);
  assert.ok(batch.text.includes(text));
  assert.equal(await batch.settle('presented'), true);
  assert.equal(await f.claim(1000, resumed.generation), undefined);
  assert.equal((await f.ledger.receipts(owner)).length, 2);
  assert.equal((await f.ledger.receipts(owner, { keys: ['p:2'] }))[0].key, 'p:2');
});

test('attachment CAS has one winner and fences all lifecycle, route and new attempt operations', async t => {
  const f = await fixture(t);
  const second = await DeliveryLedger.open({ location: f.location });
  t.after(() => second.close());
  const stale = f.session.generation;
  const results = await Promise.all([f.ledger, second].map(ledger => ledger.attach({ owner, expectedGeneration: stale, routes })));
  assert.equal(results.filter(Boolean).length, 1);
  const fresh = results.find(Boolean);
  for (const operation of ['detach', 'markDeleted', 'cancel']) assert.equal(await f.ledger[operation]({ owner, generation: stale }), false);
  assert.equal(await f.ledger.updateRoutes({ owner, generation: stale, routes: [] }), false);
  await f.post('p:new');
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch('p:new')).outcome, 'not-invoked');
  assert.equal(await f.ledger.updateRoutes({ owner, generation: fresh.generation, routes }), true);
  assert.equal(await f.ledger.markDeleted({ owner, generation: fresh.generation }), true);
  assert.equal(await f.ledger.attach({ owner, expectedGeneration: fresh.generation, routes }), false);
  assert.equal((await f.post('p:deleted')).status, 'deleted-session');
});

test('retraction cannot recall custody, and failed/released attempts release both tracks', async t => {
  const f = await fixture(t);
  await f.post('p:retract');
  assert.equal(await f.ledger.retract({ owner, key: 'p:retract' }), 'retracted');
  assert.equal(await f.claim(), undefined);
  await f.post('p:active');
  const batch = await f.claim();
  assert.equal(await f.ledger.retract({ owner, key: 'p:active' }), 'in-custody');
  assert.equal((await f.dispatch('p:active')).outcome, 'not-invoked');
  await batch.settle('released');
  assert.equal((await f.dispatch('p:active', 'failed')).outcome, 'failed');
  const retried = await f.claim();
  await retried.settle('failed');
  assert.equal((await f.dispatch('p:active', 'not-capable')).outcome, 'not-capable');
  assert.equal(await f.ledger.retract({ owner, key: 'p:active' }), 'retracted');
});

test('both tracks exclude custody in every blocking outcome, while exact handoff observation confirms once', async t => {
  const f = await fixture(t);
  for (const outcome of ['accepted', 'unknown']) {
    const key = 'p:' + outcome;
    await f.post(key);
    const result = await f.dispatch(key, outcome);
    assert.equal(result.persistence, 'recorded');
    assert.equal((await f.ledger.receipts(owner)).length, outcome === 'accepted' ? 0 : 1);
    assert.equal(await f.claim(), undefined);
    assert.equal((await f.dispatch(key)).outcome, 'not-invoked');
    assert.equal(await f.ledger.observePresentation(result.token), true);
    assert.equal(await f.ledger.observePresentation(result.token), true);
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, 1);
  }
  assert.equal(await f.ledger.observePresentation('missing'), false);
  for (const outcome of ['unknown', 'presented']) {
    const key = 'p:presentation-' + outcome;
    await f.post(key);
    const batch = await f.claim();
    assert.equal((await f.dispatch(key)).outcome, 'not-invoked');
    await batch.settle(outcome);
    assert.equal((await f.dispatch(key)).outcome, 'not-invoked');
    assert.equal(await f.claim(), undefined);
  }
});

test('in-flight handoff excludes pull and survives restart without automatic replay', async t => {
  const f = await fixture(t);
  await f.post('p:inflight');
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  let finish;
  const sending = f.ledger.dispatchHandoff(owner, 'p:inflight', { kind: push.kind, async send() {
    started(); return new Promise(resolve => { finish = resolve; });
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  await startedPromise;
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch('p:inflight')).outcome, 'not-invoked');
  finish('accepted');
  await sending;
  const reopened = await DeliveryLedger.open({ location: f.location });
  t.after(() => reopened.close());
  assert.equal(await reopened.claimPresentation(owner, { generation: f.session.generation, budgetChars: 1000 }), undefined);
  assert.equal((await f.ledger.receipts(owner)).length, 0);
});

test('receipt failure rolls back presentation outcome and every receipt in a batch', async t => {
  const f = await fixture(t);
  await f.post('p:1'); await f.post('p:2');
  const batch = await f.claim();
  const db = new DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const run = proto.run;
  let receipts = 0;
  const injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('INSERT INTO receipts') && ++receipts === 2) throw new Error('injected receipt write failure');
    return Reflect.apply(run, this, args);
  });
  try { await assert.rejects(batch.settle('presented'), /injected receipt write failure/); }
  finally { injection.mock.restore(); db.close(); }
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.deepEqual(f.read('SELECT outcome FROM attempts').map(r => r.outcome), ['dispatching', 'dispatching']);
  assert.equal(await batch.settle('presented'), true);
  assert.equal((await f.ledger.receipts(owner)).length, 2);
});

test('expiry becomes unknown without stealing custody, with late truthful settlement retained', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now, leaseMs: 10 });
  await f.post('p:expiry');
  const batch = await f.claim();
  now += 11;
  assert.equal(await f.claim(), undefined);
  assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'unknown');
  assert.equal((await f.ledger.health(owner)).unknownAttempts.length, 1);
  assert.equal(await batch.current(), false);
  assert.equal(await batch.settle('presented'), true);
  assert.equal((await f.ledger.receipts(owner)).length, 1);
});

test('batches fit whole rendered cards, skip non-fitting cards, and claim an oversized card alone', async t => {
  const f = await fixture(t);
  await f.post('p:a', 'aaa'); await f.post('p:b', 'b'.repeat(50)); await f.post('p:c', 'ccc');
  const budget = renderDeliveryBatch([{ text: 'aaa' }, { text: 'ccc' }]).length;
  const batch = await f.claim(budget);
  assert.deepEqual(batch.cards.map(c => c.key), ['p:a', 'p:c']);
  assert.equal(batch.text.length, budget);
  assert.equal(f.read('SELECT COUNT(*) AS n FROM attempts')[0].n, 2);
  await batch.settle('presented');
  const large = await f.claim(budget);
  assert.deepEqual(large.cards.map(c => c.key), ['p:b']);
  assert.ok(large.text.includes('b'.repeat(50)));
  assert.ok(large.text.length > budget);
  assert.equal(large.text.length, renderDeliveryBatch(large.cards).length);
});

test('cancel cutoff survives attachment rotation, fences stale writers, and consumes nothing', async t => {
  const f = await fixture(t);
  await f.post('p:before');
  const batch = await f.claim();
  assert.equal(await f.ledger.cancel({ owner, generation: f.session.generation }), true);
  assert.equal(await batch.current(), false);
  await batch.settle('released');
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch('p:before')).outcome, 'not-invoked');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.equal(await f.ledger.cancel({ owner, generation: f.session.generation }), false);
  assert.equal(await f.claim(1000, next.generation), undefined);
  await f.post('p:after');
  assert.deepEqual((await f.claim(1000, next.generation)).cards.map(c => c.key), ['p:after']);
});

test('late external results settle captured authority without authorizing sends in a new attachment', async t => {
  const f = await fixture(t);
  await f.post('p:late');
  let invoked;
  const started = new Promise(resolve => { invoked = resolve; });
  let complete;
  const result = f.ledger.dispatchHandoff(owner, 'p:late', { kind: push.kind, async send(_card, _address, ctx) {
    assert.equal(await ctx.prepare({ token: 'opaque', messageId: 'm:1', payloadHash: 'hash' }), true);
    invoked(); return new Promise(resolve => { complete = resolve; });
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  await started;
  const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.equal(f.read("SELECT outcome FROM attempts WHERE track='handoff'")[0].outcome, 'unknown');
  assert.equal((await f.dispatch('p:late', 'accepted', { generation: next.generation })).outcome, 'not-invoked');
  complete('presented');
  assert.equal((await result).persistence, 'recorded');
  assert.equal((await f.ledger.receipts(owner)).length, 1);
  assert.equal(await f.claim(1000, next.generation), undefined);
  await f.post('p:new');
  assert.equal((await f.dispatch('p:new')).outcome, 'not-invoked');
  assert.equal((await f.claim(1000, next.generation)).cards[0].key, 'p:new');
  assert.equal(f.read("SELECT correlation_json FROM attempts WHERE track='handoff'")[0].correlation_json, '{"token":"opaque","messageId":"m:1","payloadHash":"hash"}');
});

test('interrupted return retains late accepted/presented evidence under captured authority without resending', async t => {
  const f = await fixture(t);
  for (const outcome of ['accepted', 'presented']) {
    const key = 'p:after-return-' + outcome;
    const gate = await interruptedHandoff(f, key);
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, 0);
    let generation = f.session.generation;
    if (outcome === 'presented') generation = (await f.ledger.attach({ owner, expectedGeneration: generation, routes })).generation;
    gate.resolve(outcome);
    assert.deepEqual(await gate.result.lateSettlement, { outcome, persistence: { status: 'recorded' } });
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, outcome === 'presented' ? 1 : 0);
    assert.equal((await f.dispatch(key, 'accepted', { generation })).outcome, 'not-invoked');
    assert.equal(gate.calls(), 1);
    assert.equal(f.read('SELECT outcome FROM attempts WHERE token=?', gate.result.token)[0].outcome, 'accepted');
  }
});

test('late negative outcomes never release interrupted custody or permit automatic replay', async t => {
  const f = await fixture(t);
  for (const outcome of ['failed', 'not-capable', 'unknown']) {
    const key = 'p:late-' + outcome;
    const gate = await interruptedHandoff(f, key);
    gate.resolve(outcome);
    assert.deepEqual(await gate.result.lateSettlement, { outcome, persistence: { status: outcome === 'unknown' ? 'recorded' : 'not-recorded' } });
    assert.equal((await f.dispatch(key)).outcome, 'not-invoked');
    assert.equal(gate.calls(), 1);
    assert.equal(f.read('SELECT outcome FROM attempts WHERE token=?', gate.result.token)[0].outcome, 'unknown');
  }
  assert.equal((await f.ledger.receipts(owner)).length, 0);
});

test('late persistence failure resolves with its original error and rolls back receipt and presentation', async t => {
  const f = await fixture(t);
  const gate = await interruptedHandoff(f, 'p:late-error');
  const db = new DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const run = proto.run;
  const failure = new Error('late receipt persistence failed');
  const injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('INSERT INTO receipts')) throw failure;
    return Reflect.apply(run, this, args);
  });
  try {
    gate.resolve('presented');
    // Observe later: a rejected background settlement would fail the test as unhandled.
    await new Promise(resolve => setImmediate(resolve));
    const result = await gate.result.lateSettlement;
    assert.equal(result.outcome, 'presented');
    assert.equal(result.persistence.status, 'error');
    assert.equal(result.persistence.error, failure);
  } finally { injection.mock.restore(); db.close(); }
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.deepEqual(f.read('SELECT track,outcome FROM attempts').map(r => ({ ...r })), [{ track: 'handoff', outcome: 'unknown' }]);
  assert.equal((await f.dispatch('p:late-error')).outcome, 'not-invoked');
  assert.equal(gate.calls(), 1);
});

test('immediate completion settles once and completion during unknown persistence cannot outrun the late handle', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const run = proto.run;
  const writes = [];
  const completion = Promise.withResolvers();
  const injection = mock.method(proto, 'run', function (...args) {
    const result = Reflect.apply(run, this, args);
    if (this.sourceSQL.startsWith('UPDATE attempts SET outcome=?')) {
      writes.push(args[0]);
      if (args[0] === 'unknown') completion.resolve('presented');
    } else if (this.sourceSQL.startsWith("UPDATE attempts SET outcome='accepted'")) writes.push('accepted');
    return result;
  });
  try {
    await f.post('p:immediate');
    const immediate = await f.dispatch('p:immediate');
    assert.equal(immediate.lateSettlement, undefined);
    assert.deepEqual(writes, ['accepted']);
    await f.post('p:racing');
    const controller = new AbortController();
    const racing = await f.ledger.dispatchHandoff(owner, 'p:racing', { kind: push.kind, send() {
      controller.abort(); return completion.promise;
    } }, { generation: f.session.generation, timeoutMs: 60000, signal: controller.signal });
    assert.equal(racing.outcome, 'unknown');
    assert.deepEqual(await racing.lateSettlement, { outcome: 'presented', persistence: { status: 'recorded' } });
    assert.deepEqual(writes, ['accepted', 'unknown', 'accepted']);
    assert.equal((await f.ledger.receipts(owner, { keys: ['p:racing'] })).length, 1);
  } finally { injection.mock.restore(); db.close(); }
});

test('push persists before I/O, records uncertainty on failure/timeout and releases not-capable without retry', async t => {
  const f = await fixture(t);
  await f.post('p:push');
  let calls = 0;
  const result = await f.ledger.dispatchHandoff(owner, 'p:push', { kind: push.kind, async send(card, address, ctx) {
    calls++;
    assert.equal(card.text, 'p:push'); assert.deepEqual(address, push.address);
    assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'dispatching');
    assert.equal(await ctx.beforeSend(), true);
    return 'accepted';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'accepted'); assert.equal(calls, 1);
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  await f.post('p:timeout');
  const timeout = await f.ledger.dispatchHandoff(owner, 'p:timeout', { kind: push.kind, send: () => new Promise(() => {}) },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(timeout.outcome, 'unknown');
  assert.ok(timeout.lateSettlement instanceof Promise);
  assert.equal((await f.dispatch('p:timeout')).outcome, 'not-invoked');
  await f.post('p:throw');
  const thrown = await f.ledger.dispatchHandoff(owner, 'p:throw', { kind: push.kind, async send() { throw new Error('transport failed'); } },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(thrown.outcome, 'unknown');
});

test('retention expires completed cards/receipts at 30 days, keeps unconsumed cards and monotonic seq', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now });
  await f.post('p:done');
  await (await f.claim()).settle('presented');
  await f.post('p:retracted'); await f.ledger.retract({ owner, key: 'p:retracted' });
  await f.post('p:pending');
  await f.post('p:accepted');
  assert.equal((await f.dispatch('p:accepted')).outcome, 'accepted');
  await f.post('p:uncertain');
  assert.equal((await f.dispatch('p:uncertain', 'unknown')).outcome, 'unknown');
  const last = f.read('SELECT MAX(seq) AS seq FROM cards')[0].seq;
  await f.ledger.cancel({ owner, generation: f.session.generation });
  now += 30 * day;
  assert.equal((await f.ledger.receipts(owner)).length, 1); // reads never collect
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.equal((await f.ledger.receipts(owner)).length, 1); // exactly 30 days survives
  now++;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.deepEqual(f.read('SELECT key FROM cards ORDER BY seq').map(r => r.key), ['p:pending', 'p:accepted', 'p:uncertain']);
  assert.deepEqual(f.read("SELECT outcome FROM attempts WHERE outcome IN ('accepted','unknown') ORDER BY outcome").map(r => r.outcome), ['accepted', 'unknown']);
  await f.post('p:new');
  const batch = await f.claim();
  assert.equal(batch.cards[0].key, 'p:new');
  assert.ok(batch.cards[0].seq > last);
});

test('observation arms before reads, wakes on post, and is abortable; health contains neutral facts', async t => {
  const f = await fixture(t);
  const observer = await f.ledger.observe(owner);
  t.after(() => observer.close());
  const version = await observer.read();
  const changed = observer.changed(version, 3000);
  await f.post('p:changed');
  assert.equal(await changed, true);
  const controller = new AbortController();
  const waiting = observer.changed(await observer.read(), 3000, controller.signal);
  controller.abort(new Error('stop observing'));
  await assert.rejects(waiting, /stop observing/);
  await f.dispatch('p:changed', 'failed'); await f.dispatch('p:changed', 'failed');
  await f.ledger.attach({ owner: 'no-route', expectedGeneration: null, routes: [] });
  const health = await f.ledger.health();
  assert.deepEqual(health.repeatedFailures, [{ owner, key: 'p:changed', count: 2 }]);
  assert.deepEqual(health.sessionsWithoutRoute, ['no-route']);
});

test('caller chooses the exact registered route and local presentation needs no route registration', async t => {
  const f = await fixture(t);
  const chosen = { kind: 'second', address: { opaque: 'chosen destination' } };
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [...routes, chosen] });
  await f.post('p:chosen');
  let address;
  const result = await f.ledger.dispatchHandoff(owner, 'p:chosen', { kind: chosen.kind, async send(_card, destination) {
    address = destination; return 'accepted';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(address, chosen.address);
  assert.equal(f.read("SELECT route_kind FROM attempts WHERE track='handoff'")[0].route_kind, chosen.kind);
  await f.post('p:local');
  const absent = await f.ledger.dispatchHandoff(owner, 'p:local', { kind: 'absent', async send() { assert.fail('unregistered route invoked'); } },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(absent.outcome, 'not-invoked');
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [] });
  assert.deepEqual((await f.claim()).cards.map(c => c.key), ['p:local']);
});

test('adapter final checks reject route changes and owner cancellation after its own awaits', async t => {
  const f = await fixture(t);
  for (const cause of ['route-change', 'cancel']) {
    await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
    await f.post('p:' + cause);
    let sent = false;
    const result = await f.ledger.dispatchHandoff(owner, 'p:' + cause, { kind: push.kind, async send(_card, _address, ctx) {
      if (cause === 'cancel') await f.ledger.cancel({ owner, generation: f.session.generation });
      else await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [pull] });
      if (!await ctx.beforeSend()) return 'not-capable';
      sent = true; return 'accepted';
    } }, { generation: f.session.generation, timeoutMs: 1000 });
    assert.equal(sent, false);
    assert.equal(result.outcome, 'not-capable');
  }
  assert.equal((await f.ledger.receipts(owner)).length, 0);
});

test('dead attachment claims become unknown and cannot be automatically resent by a new attachment', async t => {
  const f = await fixture(t);
  await f.post('p:orphan');
  const abandoned = await f.claim();
  await f.ledger.detach({ owner, generation: f.session.generation });
  assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'unknown');
  const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.equal(await abandoned.current(), false);
  assert.equal(await f.claim(1000, next.generation), undefined);
  assert.equal((await f.dispatch('p:orphan', 'accepted', { generation: next.generation })).outcome, 'not-invoked');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.equal(await abandoned.settle('presented'), true);
  assert.equal((await f.ledger.receipts(owner)).length, 1);
});

test('persistence failure prevents I/O and settlement errors never report successful delivery', async t => {
  const f = await fixture(t);
  await f.post('p:claim');
  const db = new DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const run = proto.run;
  let invoked = 0;
  const transport = { kind: push.kind, async send() { invoked++; return 'accepted'; } };
  let injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('INSERT INTO attempts')) throw new Error('claim persistence failed');
    return Reflect.apply(run, this, args);
  });
  try {
    await assert.rejects(f.ledger.dispatchHandoff(owner, 'p:claim', transport, { generation: f.session.generation, timeoutMs: 1000 }), /claim persistence failed/);
  } finally { injection.mock.restore(); }
  assert.equal(invoked, 0);
  assert.equal(f.read('SELECT COUNT(*) AS n FROM attempts')[0].n, 0);
  injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('UPDATE attempts SET outcome=?')) throw new Error('settle persistence failed');
    return Reflect.apply(run, this, args);
  });
  try {
    await assert.rejects(f.ledger.dispatchHandoff(owner, 'p:claim', transport, { generation: f.session.generation, timeoutMs: 1000 }), /settle persistence failed/);
  } finally { injection.mock.restore(); }
  assert.equal(invoked, 1);
  assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'dispatching');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  await f.post('p:prepare');
  injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('UPDATE attempts SET correlation_json=')) throw new Error('correlation persistence failed');
    return Reflect.apply(run, this, args);
  });
  try {
    await assert.rejects(f.ledger.dispatchHandoff(owner, 'p:prepare', { kind: push.kind, async send(_card, _address, ctx) {
      await ctx.prepare({ token: 'opaque' }); return 'accepted';
    } }, { generation: f.session.generation, timeoutMs: 1000 }), /correlation persistence failed/);
  } finally { injection.mock.restore(); db.close(); }
});

test('GC is bounded and sequence/cancellation authority survives collection of every card', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now });
  for (let index = 0; index < 201; index++) await f.post('p:' + index);
  await (await f.claim()).settle('presented');
  await f.ledger.cancel({ owner, generation: f.session.generation });
  now += 31 * day;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.equal(f.read('SELECT COUNT(*) AS n FROM cards')[0].n, 101);
  for (let index = 0; index < 2; index++) await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.equal(f.read('SELECT COUNT(*) AS n FROM cards')[0].n, 0);
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  await f.post('p:later');
  const batch = await f.claim();
  assert.equal(batch.cards[0].seq, 202);
  assert.equal(batch.cards[0].key, 'p:later');
});

test('unsupported existing formats and foreign databases are refused without changing bytes', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.location);
  db.exec('UPDATE meta SET format=0'); db.close();
  const before = await fs.readFile(f.location);
  await assert.rejects(DeliveryLedger.open({ location: f.location }), /header/);
  assert.deepEqual(await fs.readFile(f.location), before);
  const foreign = path.join(path.dirname(f.location), 'foreign.sqlite');
  const other = new DatabaseSync(foreign); other.exec('CREATE TABLE private_data(value TEXT)'); other.close();
  const original = await fs.readFile(foreign);
  await assert.rejects(DeliveryLedger.open({ location: foreign }), /format/);
  assert.deepEqual(await fs.readFile(foreign), original);
  await assert.rejects(DeliveryLedger.open({ location: 'relative.sqlite' }), /absolute/);
});
