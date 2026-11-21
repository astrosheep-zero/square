import { dispatchPostedCard } from '../dist/notifications.js';
import { deliveryKeyEqual } from '../dist/delivery-key.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dispatchEligibleCards, postAndDispatch } from '../dist/index.js';
import { DeliveryLedger, deliveryLedgerLocation } from '../dist/delivery-ledger.js';

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
    post: (key, text = key.join('/')) => ledger.post({ owner, key, text }),
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

test('card identity reads use an indexed literal prefix within one owner, including held and detached cards', async t => {
  const f = await fixture(t);
  const other = 'another:owner';
  const session = await f.ledger.attach({ owner: other, expectedGeneration: null, routes: [] });
  await f.post(["producer","%_","held"]);
  await f.dispatch(["producer","%_","held"], 'accepted');
  await f.ledger.post({ owner: other, key: ["producer","%_","detached"], text: 'not attached' });
  await f.ledger.detach({ owner: other, generation: session.generation });
  for (const key of [["producer","xx","not-a-literal-match"], ["鱼","猫"], ["鱼0"], ["􏿿","猫"]]) await f.post(key);
  assert.deepEqual(await f.ledger.cards({ owner, keyPrefix: ["producer","%_"] }), [{ owner, key: ["producer","%_","held"] }]);
  assert.deepEqual(await f.ledger.cards({ owner: other, keyPrefix: ["producer","%_"] }), [{ owner: other, key: ["producer","%_","detached"] }]);
  for (const keyPrefix of [["鱼"], ["􏿿"]])
    assert.equal((await f.ledger.cards({ owner, keyPrefix })).length, 1);
  assert.deepEqual(await f.ledger.cards({ owner, keyPrefix: ["absent"] }), []);
  assert.equal((await f.ledger.cards({ owner, keyPrefix: [] })).length, 5);
  assert.throws(() => f.ledger.cards({ keyPrefix: [] }), /owner/);
});

test('receipt cursors follow global commit order across owners and backward clocks', async t => {
  let now = 200;
  const f = await fixture(t, { clock: () => now });
  const other = 'native:other';
  const second = await DeliveryLedger.open({ location: f.location, clock: () => now });
  t.after(() => second.close());
  const session = await second.attach({ owner: other, expectedGeneration: null, routes: [] });
  await f.post(["old-card"]);
  const first = await f.claim();
  await second.post({ owner: other, key: ["new-card"], text: 'second' });
  const newer = await second.claimPresentation(other, { generation: session.generation, budgetChars: 100 });
  await newer.settle('presented');
  now = 100;
  await first.settle('presented');
  assert.deepEqual(await f.ledger.receipts(owner), [{ seq: 2, owner, key: ["old-card"], at: 100 }]);
  assert.deepEqual(await second.receipts(other), [{ seq: 1, owner: other, key: ["new-card"], at: 200 }]);
  assert.deepEqual(await f.ledger.receipts(owner, { afterSeq: 1, keys: [["old-card"]], since: 100 }), await f.ledger.receipts(owner));
  assert.deepEqual(await f.ledger.receipts(owner, { afterSeq: 2 }), []);
  assert.deepEqual(await f.ledger.receipts(owner, { afterSeq: 1, since: 101 }), []);
  assert.deepEqual(await f.ledger.receipts(owner, { keys: [] }), []);
  for (const afterSeq of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => f.ledger.receipts(owner, { afterSeq }), RangeError);
  now = 50;
  await f.post(["concurrent-a"]);
  await second.post({ owner: other, key: ["concurrent-b"], text: 'second' });
  const a = await f.claim();
  const b = await second.claimPresentation(other, { generation: session.generation, budgetChars: 100 });
  const committed = [];
  await Promise.all([[a, ['concurrent-a']], [b, ['concurrent-b']]].map(async ([claim, key]) => {
    assert.equal(await claim.settle('presented'), true); committed.push(key);
  }));
  const receipts = [...await f.ledger.receipts(owner, { afterSeq: 2 }), ...await second.receipts(other, { afterSeq: 2 })]
    .sort((a, b) => a.seq - b.seq);
  assert.deepEqual(receipts.map(receipt => receipt.seq), [3, 4]);
  assert.deepEqual(receipts.map(receipt => receipt.key), committed);
  const reopened = await DeliveryLedger.open({ location: f.location });
  try { assert.deepEqual(await reopened.receipts(owner, { afterSeq: 2 }), await f.ledger.receipts(owner, { afterSeq: 2 })); }
  finally { await reopened.close(); }
});

test('post caps retained cards per owner, withdrawing oldest noncustody even under cancellation or temporary holds', async t => {
  const f = await fixture(t);
  const other = 'native:other';
  await f.ledger.attach({ owner: other, expectedGeneration: null, routes: [] });
  await f.ledger.post({ owner: other, key: ["untouched"], text: 'other owner' });
  await f.post(["cancelled"]);
  await f.ledger.cancel({ owner, generation: f.session.generation });
  const hold = await f.ledger.suppress({ owner, key: ["temporary"], scope: 'exact', expiresAt: Date.now() + day });
  await f.post(["temporary"]);
  await f.post(["failed"]); await f.dispatch(["failed"], 'failed');
  await f.post(["released"]); await f.dispatch(["released"], 'not-capable');
  for (let index = 0; index < 196; index++) await f.post(["tail", String(index)]);
  assert.equal((await f.ledger.cards({ owner, keyPrefix: [] })).length, 200);
  assert.equal(f.read("SELECT COUNT(*) AS n FROM suppressions WHERE scope='exact' AND expires_at IS NULL")[0].n, 0);
  for (let index = 196; index < 200; index++) await f.post(["tail", String(index)]);
  for (const key of [["cancelled"], ["temporary"], ["failed"], ["released"]]) assert.equal((await f.post(key)).status, 'suppressed');
  await f.ledger.releaseSuppression({ owner, id: hold.id });
  assert.equal((await f.post(["temporary"])).status, 'suppressed');
  assert.equal((await f.ledger.cards({ owner, keyPrefix: [] })).length, 200);
  assert.deepEqual(await f.ledger.cards({ owner: other, keyPrefix: [] }), [{ owner: other, key: ["untouched"] }]);
  assert.deepEqual(await f.ledger.receipts(owner), []);
  for (let index = 0; index < 3; index++) {
    await f.ledger.cancel({ owner, generation: f.session.generation });
    await f.post(["after-cancel", String(index)]);
    assert.equal((await f.ledger.cards({ owner, keyPrefix: [] })).length, 200);
  }
});

test('post cap preserves all custody and late evidence through suppression, generation rotation and cancel', async t => {
  const f = await fixture(t);
  await f.post(["presentation"]);
  const presentation = await f.claim();
  await f.post(["accepted"]); await f.dispatch(["accepted"]);
  await f.post(["unknown"]); await f.dispatch(["unknown"], 'unknown');
  await f.post(["dispatching"]);
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  const running = f.ledger.dispatchHandoff(owner, ["dispatching"], { kind: push.kind, send() {
    started.resolve(); return finish.promise;
  } }, { generation: f.session.generation, timeoutMs: 60000 });
  await started.promise;
  try {
    for (let index = 0; index < 196; index++) await f.post(["protected", String(index)]);
    const protectedBatch = await f.claim();
    assert.equal(protectedBatch.cards.length, 196);
    assert.equal((await f.ledger.suppress({ owner, key: ["presentation"], scope: 'exact' })).status, 'in-custody');
    assert.equal((await f.post(["overflow"])).status, 'suppressed');
    assert.equal((await f.ledger.cards({ owner, keyPrefix: [] })).length, 200);
    assert.equal((await f.post(["overflow"])).status, 'suppressed');
    const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
    await f.ledger.cancel({ owner, generation: next.generation });
    assert.equal(await presentation.current(), false);
    assert.equal((await f.post(["new-generation"])).status, 'suppressed');
    assert.equal((await f.dispatch(["dispatching"], 'accepted', { generation: next.generation })).outcome, 'not-invoked');
    assert.equal(await presentation.settle('presented'), true);
    finish.resolve('presented');
    assert.equal((await running).persistence, 'recorded');
    assert.deepEqual((await f.ledger.receipts(owner)).map(receipt => receipt.key), [["presentation"], ["dispatching"]]);
    assert.deepEqual(f.read('SELECT key FROM cards WHERE key IN (?,?) ORDER BY key', '["accepted"]', '["unknown"]').map(row => JSON.parse(row.key)), [["accepted"], ["unknown"]]);
    assert.equal((await f.ledger.cards({ owner, keyPrefix: ["protected"] })).length, 196);
  } finally { finish.resolve('accepted'); await running; }
});

test('receipt, suppression and card lookups use indexes; permanent retention drains oldest scopes in bounded batches', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now });
  await f.ledger.suppressExact(owner, Array.from({ length: 100 }, (_, index) => ['old', String(index)]));
  await f.ledger.suppress({ owner, key: ["old-prefix"], scope: 'prefix' });
  await f.ledger.suppress({ owner, key: ["temporary"], scope: 'exact', expiresAt: 40 * day });
  await f.post(["card"]);
  await (await f.claim()).settle('presented');
  now += 31 * day;
  const db = new DatabaseSync(':memory:');
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
  const captured = [];
  const mocks = ['all', 'get', 'run'].map(method => {
    const original = proto[method];
    return mock.method(proto, method, function (...params) {
      if (this.sourceSQL.startsWith('SELECT * FROM cards WHERE owner=? AND key=? UNION ALL')
        || this.sourceSQL.startsWith('SELECT * FROM receipts WHERE owner=? AND seq>?')
        || this.sourceSQL.startsWith('SELECT * FROM receipts WHERE owner=? AND key=?')
        || this.sourceSQL.startsWith('SELECT 1 FROM suppressions WHERE owner=? AND key=? AND scope=')
        || this.sourceSQL.startsWith("SELECT key FROM suppressions WHERE owner=? AND scope='prefix'")
        || this.sourceSQL.startsWith('DELETE FROM suppressions WHERE id IN')) captured.push({ sql: this.sourceSQL, params });
      return Reflect.apply(original, this, params);
    });
  });
  try {
    await f.ledger.cards({ owner, keyPrefix: ["card"] });
    await f.ledger.receipts(owner, { afterSeq: 1 });
    await f.ledger.receipts(owner, { keys: [['card']] });
    assert.equal((await f.post(["young"])).status, 'posted');
  } finally { for (const entry of mocks) entry.mock.restore(); db.close(); }
  const plans = captured.map(({ sql, params }) => f.read('EXPLAIN QUERY PLAN ' + sql, ...params).map(row => row.detail).join('\n'));
  for (const plan of plans) assert.doesNotMatch(plan, /\bSCAN\b|USE TEMP B-TREE/);
  assert.ok(plans.some(plan => /cards.*\(owner=\? AND key>\? AND key<\?\)/.test(plan)), plans.join('\n'));
  assert.ok(plans.some(plan => /receipts_owner_seq.*\(owner=\? AND seq>\?\)/.test(plan)), plans.join('\n'));
  assert.ok(plans.some(plan => /receipts.*\(owner=\? AND key=\?\)/.test(plan)), plans.join('\n'));
  assert.ok(plans.some(plan => /suppressions_exact_key.*\(owner=\? AND key=\?\)/.test(plan)), plans.join('\n'));
  assert.ok(plans.some(plan => /suppressions_prefix_owner.*\(owner=\?\)/.test(plan)), plans.join('\n'));
  assert.ok(plans.some(plan => /suppressions_permanent_created.*\(created_at<\?\)/.test(plan)), plans.join('\n'));
  assert.equal(f.read('SELECT COUNT(*) AS n FROM suppressions WHERE expires_at IS NULL')[0].n, 2);
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT * FROM suppressions WHERE expires_at IS NULL'), []);
  assert.equal((await f.post(["old-prefix","released"])).status, 'posted');
  assert.equal((await f.post(["temporary"])).status, 'suppressed');
});

test('stable owner cards are idempotent, whole, and retained through detach and CAS reattach', async t => {
  const f = await fixture(t);
  assert.equal((await f.ledger.post({ owner: 'unknown', key: ["p","1"], text: 'x' })).status, 'unknown-session');
  const text = '<message>\n鱼 🐈\n</message>';
  assert.equal((await f.post(["p","1"], text)).status, 'posted');
  assert.equal((await f.post(["p","1"], text)).status, 'duplicate');
  assert.equal((await f.post(["p","1"], text + '!')).status, 'conflict');
  assert.equal(await f.ledger.detach({ owner, generation: f.session.generation }), true);
  await f.post(["p","2"]);
  assert.equal(await f.claim(), undefined);
  const resumed = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.notEqual(resumed.generation, f.session.generation);
  assert.equal(await f.claim(), undefined);
  const batch = await f.claim(1000, resumed.generation);
  assert.deepEqual(batch.cards.map(c => c.key), [["p","1"], ["p","2"]]);
  assert.equal(batch.cards[0].text, text);
  assert.equal(await batch.settle('presented'), true);
  assert.equal(await f.claim(1000, resumed.generation), undefined);
  assert.equal((await f.ledger.receipts(owner)).length, 2);
  assert.deepEqual((await f.ledger.receipts(owner, { keys: [["p","2"]] }))[0].key, ["p","2"]);
});

test('opaque details round-trip across reopen, compare canonically, and do not consume the text budget', async t => {
  const f = await fixture(t);
  const details = { z: ['opaque', { b: true, a: null }], a: { text: 'x'.repeat(20000), nested: 42 } };
  assert.equal((await f.ledger.post({ owner, key: ["details"], text: 'card', details })).status, 'posted');
  assert.equal((await f.ledger.post({ owner, key: ["details"], text: 'card', details: {
    a: { nested: 42, text: details.a.text }, z: ['opaque', { a: null, b: true }],
  } })).status, 'duplicate');
  for (const changed of [undefined, {}, { ...details, z: ['different'] }])
    assert.equal((await f.ledger.post({ owner, key: ["details"], text: 'card', details: changed })).status, 'conflict');
  assert.equal((await f.post(["details"], 'different text')).status, 'conflict');
  await f.post(["plain"], 'next');
  const reopened = await DeliveryLedger.open({ location: f.location });
  try {
    const pending = await reopened.pending(owner, { generation: f.session.generation });
    assert.deepEqual(pending[0].details, details);
    assert.equal(Object.hasOwn(pending[1], 'details'), false);
    const claim = await reopened.claimPresentation(owner, { generation: f.session.generation,
      budgetChars: 'card'.length + 'next'.length + 2 });
    assert.deepEqual(claim.cards.map(card => card.key), [["details"], ["plain"]]);
    assert.deepEqual(claim.cards[0].details, details);
    await claim.settle('released');
    await reopened.dispatchHandoff(owner, ["details"], { kind: push.kind, async send(card) {
      assert.deepEqual(card.details, details); return 'accepted';
    } }, { generation: f.session.generation, timeoutMs: 1000 });
  } finally { await reopened.close(); }
  const cyclic = {}; cyclic.self = cyclic;
  for (const invalid of [null, [], 'text', 1, cyclic, { value: undefined }, { value: Infinity },
    { value: 1n }, { value: () => 1 }, { value: Symbol('x') }, { value: new Date() }])
    assert.throws(() => f.ledger.post({ owner, key: ["invalid"], text: 'x', details: invalid }), TypeError);
});

test('format 5 defaults to delivery.v5.sqlite and leaves the old v4 ledger untouched; overrides still win', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-default-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const oldPath = path.join(root, '.square', 'delivery.v4.sqlite');
  const defaultPath = path.join(root, '.square', 'delivery.v5.sqlite');
  await fs.mkdir(path.dirname(oldPath));
  const old = new DatabaseSync(oldPath);
  old.exec('PRAGMA application_id=1145849682; PRAGMA user_version=4; CREATE TABLE cards (text TEXT);');
  old.close();
  const before = await fs.readFile(oldPath);
  const override = process.env.SQUARE_DELIVERY;
  const homedir = mock.method(os, 'homedir', () => root);
  try {
    delete process.env.SQUARE_DELIVERY;
    assert.equal(deliveryLedgerLocation(), defaultPath);
    const ledger = await DeliveryLedger.open();
    await ledger.close();
    const db = new DatabaseSync(defaultPath, { readOnly: true });
    try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5); }
    finally { db.close(); }
    assert.deepEqual(await fs.readFile(oldPath), before);
    assert.deepEqual(await fs.readdir(path.dirname(oldPath)), ['delivery.v4.sqlite', 'delivery.v5.sqlite']);
    await assert.rejects(DeliveryLedger.open({ location: oldPath }), /Unsupported delivery ledger format/);
    assert.deepEqual(await fs.readFile(oldPath), before);
    process.env.SQUARE_DELIVERY = path.join(root, 'custom.sqlite');
    const custom = await DeliveryLedger.open();
    await custom.close();
    assert.equal(deliveryLedgerLocation(), process.env.SQUARE_DELIVERY);
    await fs.access(process.env.SQUARE_DELIVERY);
    assert.deepEqual(await fs.readFile(oldPath), before);
  } finally {
    homedir.mock.restore();
    if (override === undefined) delete process.env.SQUARE_DELIVERY; else process.env.SQUARE_DELIVERY = override;
  }
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
  await f.post(["p","new"]);
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch(["p","new"])).outcome, 'not-invoked');
  assert.equal(await f.ledger.updateRoutes({ owner, generation: fresh.generation, routes }), true);
  assert.equal(await f.ledger.markDeleted({ owner, generation: fresh.generation }), true);
  assert.equal(await f.ledger.attach({ owner, expectedGeneration: fresh.generation, routes }), false);
  assert.equal((await f.post(["p","deleted"])).status, 'deleted-session');
});

test('suppression blocks before and after claim, then permanent exact tombstones delete cards', async t => {
  const f = await fixture(t);
  const hold = await f.ledger.suppress({ owner, key: ["p"], scope: 'prefix', expiresAt: Date.now() + day });
  assert.equal((await f.post(["p","1"])).status, 'suppressed');
  assert.deepEqual(await f.ledger.pending(owner, { generation: f.session.generation }), []);
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch(["p","1"])).outcome, 'not-invoked');
  const observer = await f.ledger.observe(owner);
  t.after(() => observer.close());
  const changed = observer.changed(await observer.read(), 3000);
  await f.ledger.releaseSuppression({ owner, id: hold.id });
  assert.equal(await changed, true);
  const batch = await f.claim();
  assert.equal(await f.ledger.suppress({ owner, key: ["p","1"], scope: 'exact' }).then(result => result.status), 'in-custody');
  assert.equal(await batch.current(), false);
  await batch.settle('released');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.equal(await f.ledger.pending(owner, { generation: f.session.generation }).then(cards => cards.length), 0);
  const matching = await f.ledger.suppress({ owner, key: ["p"], scope: 'prefix', expiresAt: Date.now() + day });
  await f.post(["p","2"]);
  const first = await f.ledger.suppress({ owner, key: ["p","2"], scope: 'exact' });
  const repeated = await f.ledger.suppress({ owner, key: ["p","2"], scope: 'exact' });
  assert.deepEqual(repeated, first);
  assert.equal(f.read("SELECT COUNT(*) AS n FROM suppressions WHERE owner=? AND key=? AND scope='exact' AND expires_at IS NULL", owner, '["p","2"]')[0].n, 1);
  assert.equal(first.status, 'suppressed');
  assert.equal(f.read('SELECT * FROM cards WHERE key=?', '["p","2"]').length, 0);
  await f.ledger.releaseSuppression({ owner, id: matching.id });
  assert.equal((await f.post(["p","3"])).status, 'posted');
  assert.equal((await f.post(["p","2"])).status, 'suppressed');
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(card => card.key), [["p","3"]]);
  const seq = f.read('SELECT next_seq FROM meta')[0].next_seq;
  const empty = new DatabaseSync(f.location);
  try { empty.prepare('INSERT INTO suppressions VALUES(?,?,?,?,?,?)').run('', owner, '["empty-id"]', 'exact', Date.now(), null); }
  finally { empty.close(); }
  assert.equal((await f.post(["empty-id"])).status, 'suppressed');
  assert.equal(f.read('SELECT next_seq FROM meta')[0].next_seq, seq);
  assert.equal(f.read('SELECT * FROM cards WHERE key=?', '["empty-id"]').length, 0);
});

test('batch exact suppression is idempotent, owner-scoped, and preserves held presentation evidence', async t => {
  const f = await fixture(t);
  await f.post(["held"]);
  const claim = await f.claim();
  await f.post(["withdraw"]);
  await f.post(["withdraw-more"]);
  const other = 'native:session/other';
  const session = await f.ledger.attach({ owner: other, expectedGeneration: null, routes });
  await f.ledger.post({ owner: other, key: ["withdraw"], text: 'other owner' });
  const keys = [['held'], ['withdraw'], ['future'], ['withdraw']];
  for (let i = 0; i < 2; i++) await f.ledger.suppressExact(owner, keys);
  assert.equal(await claim.current(), false);
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(card => card.key), [["withdraw-more"]]);
  assert.deepEqual((await f.ledger.pending(other, { generation: session.generation })).map(card => card.key), [["withdraw"]]);
  assert.equal((await f.post(["future"])).status, 'suppressed');
  assert.equal(await claim.settle('presented'), true);
  assert.deepEqual((await f.ledger.receipts(owner)).map(receipt => receipt.key), [["held"]]);
  assert.throws(() => f.ledger.suppressExact(owner, [["withdraw-more"], []]), TypeError);
  const abort = AbortSignal.abort(new Error('cancelled batch'));
  await assert.rejects(f.ledger.suppressExact(owner, [["withdraw-more"]], abort), /cancelled batch/);
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(card => card.key), [["withdraw-more"]]);
});

test('suppression preserves a truthful late presentation after timeout', async t => {
  const f = await fixture(t);
  await f.post(["p","late-presented"]);
  const started = Promise.withResolvers(), effect = Promise.withResolvers();
  const handoff = f.ledger.dispatchHandoff(owner, ["p","late-presented"], { kind: push.kind, send() {
    started.resolve(); return effect.promise;
  } }, { generation: f.session.generation, timeoutMs: 20 });
  await started.promise;
  const timedOut = await handoff;
  assert.equal(timedOut.outcome, 'unknown');
  const suppression = await f.ledger.suppress({ owner, key: ["p"], scope: 'prefix', expiresAt: Date.now() + day });
  assert.equal(suppression.status, 'in-custody');
  effect.resolve('presented');
  assert.deepEqual(await timedOut.lateSettlement, { outcome: 'presented', persistence: { status: 'recorded' } });
  assert.equal((await f.ledger.receipts(owner, { keys: [["p","late-presented"]] })).length, 1);
  await f.ledger.releaseSuppression({ owner, id: suppression.id });
  assert.equal((await f.ledger.pending(owner, { generation: f.session.generation })).some(card => deliveryKeyEqual(card.key, ['p', 'late-presented'])), false);
});

test('expiry restores eligibility and released suppression cannot be renewed', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now });
  const hold = await f.ledger.suppress({ owner, key: ["p"], scope: 'prefix', expiresAt: 110 });
  assert.equal(await f.ledger.renewSuppression({ owner, id: hold.id, expiresAt: 120 }), true);
  await f.post(["p","renewed"]);
  assert.deepEqual(await f.ledger.pending(owner, { generation: f.session.generation }), []);
  now = 121;
  assert.equal(await f.ledger.renewSuppression({ owner, id: hold.id, expiresAt: 130 }), false);
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(card => card.key), [["p","renewed"]]);
  const released = await f.ledger.suppress({ owner, key: ["x"], scope: 'exact', expiresAt: 200 });
  assert.equal(await f.ledger.releaseSuppression({ owner, id: released.id }), true);
  assert.equal(await f.ledger.renewSuppression({ owner, id: released.id, expiresAt: 300 }), false);
});

test('producer-neutral post helper dispatches a non-Square card through a supplied transport', async t => {
  const f = await fixture(t);
  const sent = [];
  const result = await postAndDispatch(f.ledger, { owner, key: ["producer","plain"], text: 'plain card' }, {
    transports: [{ kind: push.kind, async send(card) { sent.push(card.text); return 'presented'; } }],
  });
  assert.equal(result.status, 'posted');
  assert.deepEqual(sent, ['plain card']);
  const held = await f.ledger.suppress({ owner, key: ["held"], scope: 'prefix', expiresAt: Date.now() + day });
  await f.post(["held","one"]);
  assert.deepEqual(await f.ledger.pending(owner, { generation: f.session.generation }), []);
  await f.ledger.releaseSuppression({ owner, id: held.id });
  await dispatchEligibleCards(f.ledger, owner, { transports: [{ kind: push.kind, async send(card) { sent.push(card.text); return 'presented'; } }] });
  assert.deepEqual(sent, ['plain card', 'held/one']);
});

test('handoff final check refuses suppression added after claim', async t => {
  const f = await fixture(t);
  await f.post(["producer","guarded"]);
  let presented = false;
  const result = await f.ledger.dispatchHandoff(owner, ["producer","guarded"], { kind: push.kind, async send(_card, _address, context) {
    const suppression = await f.ledger.suppress({ owner, key: ["producer","guarded"], scope: 'exact' });
    assert.equal(suppression.status, 'in-custody');
    if (await context.beforeSend()) presented = true;
    return presented ? 'presented' : 'released';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(presented, false);
  assert.equal(result.outcome, 'released');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
});

test('failed/released attempts release both tracks and keep original content for retry', async t => {
  const f = await fixture(t);
  const details = { body: 'full body' };
  await f.ledger.post({ owner, key: ["p","active"], text: 'preview', details });
  const batch = await f.claim();
  await batch.settle('released');
  assert.equal((await f.dispatch(["p","active"], 'failed')).outcome, 'failed');
  const retried = await f.claim();
  assert.equal(retried.cards[0].text, 'preview');
  assert.deepEqual(retried.cards[0].details, details);
  await retried.settle('failed');
  assert.equal((await f.dispatch(["p","active"], 'not-capable')).outcome, 'not-capable');
  const [pending] = await f.ledger.pending(owner, { generation: f.session.generation });
  assert.equal(pending.text, 'preview');
  assert.deepEqual(pending.details, details);
});

test('both tracks exclude custody in every blocking outcome, while exact handoff observation confirms once', async t => {
  const f = await fixture(t);
  for (const outcome of ['accepted', 'unknown']) {
    const key = ["p", outcome];
    await f.post(key);
    const result = await f.dispatch(key, outcome);
    assert.equal(result.persistence, 'recorded');
    assert.equal((await f.ledger.receipts(owner)).length, outcome === 'accepted' ? 0 : 1);
    assert.equal(await f.claim(), undefined);
    assert.equal((await f.dispatch(key)).outcome, 'not-invoked');
    assert.equal(await f.ledger.observePresentation(result.token), true);
    assert.equal(await f.ledger.observePresentation(result.token), false);
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, 1);
  }
  assert.equal(await f.ledger.observePresentation('missing'), false);
  for (const outcome of ['unknown', 'presented']) {
    const key = ['p:presentation-' + outcome];
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
  await f.post(["p","inflight"]);
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  let finish;
  const sending = f.ledger.dispatchHandoff(owner, ["p","inflight"], { kind: push.kind, async send() {
    started(); return new Promise(resolve => { finish = resolve; });
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  await startedPromise;
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch(["p","inflight"])).outcome, 'not-invoked');
  finish('accepted');
  await sending;
  const reopened = await DeliveryLedger.open({ location: f.location });
  t.after(() => reopened.close());
  assert.equal(await reopened.claimPresentation(owner, { generation: f.session.generation, budgetChars: 1000 }), undefined);
  assert.equal((await f.ledger.receipts(owner)).length, 0);
});

test('receipt failure rolls back presentation outcome and every receipt in a batch', async t => {
  const f = await fixture(t);
  await f.post(["p","1"]); await f.post(["p","2"]);
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
  assert.equal(f.read('SELECT next_receipt_seq FROM meta')[0].next_receipt_seq, 1);
  assert.equal(await batch.settle('presented'), true);
  assert.deepEqual((await f.ledger.receipts(owner)).map(({ seq, key }) => ({ seq, key })), [
    { seq: 1, key: ["p","1"] }, { seq: 2, key: ["p","2"] },
  ]);
  assert.equal(f.read('SELECT next_receipt_seq FROM meta')[0].next_receipt_seq, 3);
});

test('expiry becomes unknown without stealing custody, with late truthful settlement retained', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now, leaseMs: 10 });
  await f.post(["p","expiry"]);
  const batch = await f.claim();
  now += 11;
  assert.equal(await f.claim(), undefined);
  assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'unknown');
  assert.equal((await f.ledger.health(owner)).unknownAttempts.length, 1);
  assert.equal(await batch.current(), false);
  assert.equal(await batch.settle('presented'), true);
  assert.equal((await f.ledger.receipts(owner)).length, 1);
});

test('batches count only card text and separators, stop at overflow, and admit an oversized first card alone', async t => {
  const f = await fixture(t);
  await f.post(["p","a"], 'aaa'); await f.post(["p","b"], 'bbb');
  await f.post(["p","c"], 'c'.repeat(50)); await f.post(["p","d"], 'ddd');
  const narrow = await f.claim(7);
  assert.deepEqual(narrow.cards.map(c => c.key), [["p","a"]]);
  await narrow.settle('released');
  const batch = await f.claim(8);
  assert.deepEqual(batch.cards.map(c => c.key), [["p","a"], ["p","b"]]);
  await batch.settle('presented');
  const large = await f.claim(8);
  assert.deepEqual(large.cards.map(c => c.key), [["p","c"]]);
  assert.equal(large.cards[0].text, 'c'.repeat(50));
  await large.settle('presented');
  assert.deepEqual((await f.claim(8)).cards.map(c => c.key), [["p","d"]]);
});

test('cancel cutoff survives attachment rotation, fences stale writers, and consumes nothing', async t => {
  const f = await fixture(t);
  await f.post(["p","before"]);
  const batch = await f.claim();
  assert.equal(await f.ledger.cancel({ owner, generation: f.session.generation }), true);
  assert.equal(await batch.current(), false);
  await batch.settle('released');
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch(["p","before"])).outcome, 'not-invoked');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.equal(await f.ledger.cancel({ owner, generation: f.session.generation }), false);
  assert.equal(await f.claim(1000, next.generation), undefined);
  await f.post(["p","after"]);
  assert.deepEqual((await f.claim(1000, next.generation)).cards.map(c => c.key), [["p","after"]]);
});

test('late external results settle captured authority without authorizing sends in a new attachment', async t => {
  const f = await fixture(t);
  await f.post(["p","late"]);
  let invoked;
  const started = new Promise(resolve => { invoked = resolve; });
  let complete;
  const result = f.ledger.dispatchHandoff(owner, ["p","late"], { kind: push.kind, async send(_card, _address, ctx) {
    assert.equal(await ctx.prepare({ token: 'opaque', messageId: 'm:1', payloadHash: 'hash' }), true);
    invoked(); return new Promise(resolve => { complete = resolve; });
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  await started;
  const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.equal(f.read("SELECT outcome FROM attempts WHERE track='handoff'")[0].outcome, 'unknown');
  assert.equal((await f.dispatch(["p","late"], 'accepted', { generation: next.generation })).outcome, 'not-invoked');
  complete('presented');
  assert.equal((await result).persistence, 'recorded');
  assert.equal((await f.ledger.receipts(owner)).length, 1);
  assert.equal(await f.claim(1000, next.generation), undefined);
  await f.post(["p","new"]);
  assert.equal((await f.dispatch(["p","new"])).outcome, 'not-invoked');
  assert.deepEqual((await f.claim(1000, next.generation)).cards[0].key, ["p","new"]);
  assert.equal(f.read("SELECT correlation_json FROM attempts WHERE track='handoff'").length, 0);
});

test('interrupted return retains late accepted/presented evidence under captured authority without resending', async t => {
  const f = await fixture(t);
  for (const outcome of ['accepted', 'presented']) {
    const key = ['p:after-return-' + outcome];
    const gate = await interruptedHandoff(f, key);
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, 0);
    let generation = f.session.generation;
    if (outcome === 'presented') generation = (await f.ledger.attach({ owner, expectedGeneration: generation, routes })).generation;
    gate.resolve(outcome);
    assert.deepEqual(await gate.result.lateSettlement, { outcome, persistence: { status: 'recorded' } });
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, outcome === 'presented' ? 1 : 0);
    assert.equal((await f.dispatch(key, 'accepted', { generation })).outcome, 'not-invoked');
    assert.equal(gate.calls(), 1);
    const stored = f.read('SELECT outcome FROM attempts WHERE token=?', gate.result.token);
    assert.deepEqual(stored.map(row => row.outcome), outcome === 'presented' ? [] : ['accepted']);
  }
});

test('late negative outcomes never release interrupted custody or permit automatic replay', async t => {
  const f = await fixture(t);
  for (const outcome of ['failed', 'not-capable', 'unknown']) {
    const key = ['p:late-' + outcome];
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
  const gate = await interruptedHandoff(f, ["p","late-error"]);
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
  assert.equal((await f.dispatch(["p","late-error"])).outcome, 'not-invoked');
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
    await f.post(["p","immediate"]);
    const immediate = await f.dispatch(["p","immediate"]);
    assert.equal(immediate.lateSettlement, undefined);
    assert.deepEqual(writes, ['accepted']);
    await f.post(["p","racing"]);
    const controller = new AbortController();
    const racing = await f.ledger.dispatchHandoff(owner, ["p","racing"], { kind: push.kind, send() {
      controller.abort(); return completion.promise;
    } }, { generation: f.session.generation, timeoutMs: 60000, signal: controller.signal });
    assert.equal(racing.outcome, 'unknown');
    assert.deepEqual(await racing.lateSettlement, { outcome: 'presented', persistence: { status: 'recorded' } });
    assert.deepEqual(writes, ['accepted', 'unknown', 'accepted']);
    assert.equal((await f.ledger.receipts(owner, { keys: [["p","racing"]] })).length, 1);
  } finally { injection.mock.restore(); db.close(); }
});

test('push persists before I/O, records uncertainty on failure/timeout and releases not-capable without retry', async t => {
  const f = await fixture(t);
  await f.post(["p","push"]);
  let calls = 0;
  const result = await f.ledger.dispatchHandoff(owner, ["p","push"], { kind: push.kind, async send(card, address, ctx) {
    calls++;
    assert.equal(card.text, 'p/push'); assert.deepEqual(address, push.address);
    assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'dispatching');
    assert.equal(await ctx.beforeSend(), true);
    return 'accepted';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'accepted'); assert.equal(calls, 1);
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  await f.post(["p","timeout"]);
  const timeout = await f.ledger.dispatchHandoff(owner, ["p","timeout"], { kind: push.kind, send: () => new Promise(() => {}) },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(timeout.outcome, 'unknown');
  assert.ok(timeout.lateSettlement instanceof Promise);
  assert.equal((await f.dispatch(["p","timeout"])).outcome, 'not-invoked');
  await f.post(["p","throw"]);
  const thrown = await f.ledger.dispatchHandoff(owner, ["p","throw"], { kind: push.kind, async send() { throw new Error('transport failed'); } },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(thrown.outcome, 'unknown');
});

test('retention expires receipts, undelivered cards and unconfirmed custody at 30 days while preserving monotonic seq', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now });
  await f.post(["p","done"]);
  await (await f.claim()).settle('presented');
  await f.post(["p","withdrawn"]); await f.ledger.suppress({ owner, key: ["p","withdrawn"], scope: 'exact' });
  await f.post(["p","pending"]);
  await f.post(["p","accepted"]);
  assert.equal((await f.dispatch(["p","accepted"])).outcome, 'accepted');
  await f.post(["p","uncertain"]);
  assert.equal((await f.dispatch(["p","uncertain"], 'unknown')).outcome, 'unknown');
  const last = f.read('SELECT MAX(seq) AS seq FROM cards')[0].seq;
  await f.ledger.cancel({ owner, generation: f.session.generation });
  now += 30 * day;
  assert.equal((await f.ledger.receipts(owner)).length, 1); // reads never collect
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.equal((await f.ledger.receipts(owner)).length, 1); // exactly 30 days survives
  now++;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
  assert.deepEqual(f.read('SELECT * FROM attempts'), []);
  assert.equal((await f.post(["p","accepted"])).status, 'suppressed');
  assert.equal((await f.post(["p","uncertain"])).status, 'suppressed');
  await f.post(["p","new"]);
  const batch = await f.claim();
  assert.deepEqual(batch.cards[0].key, ["p","new"]);
  assert.ok(batch.cards[0].seq > last);
});

test('never-attempted cards expire from posting with retained exact tombstones, not on reads', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now });
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [] });
  await f.post(["old"]);
  now += 30 * day;
  await f.post(["young"]);
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(c => c.key), [["old"], ["young"]]);
  now++;
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(c => c.key), [["old"], ["young"]]);
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [] });
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(c => c.key), [["young"]]);
  assert.equal((await f.post(["old"])).status, 'suppressed');
  now += 30 * day + 1;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [] });
  assert.equal((await f.post(["old"])).status, 'posted');
});

test('failed and released cards expire from posting without shortening custody or dispatching retention', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now, leaseMs: 60 * day });
  await f.post(["in-flight"]);
  const claim = await f.claim();
  for (const key of [["failed"], ["released"], ["accepted"], ["unknown"]]) await f.post(key);
  now += day;
  for (const [key, outcome] of [[['failed'], 'failed'], [['released'], 'not-capable'], [['accepted'], 'accepted'], [['unknown'], 'unknown']])
    assert.equal((await f.dispatch(key, outcome)).outcome, outcome);
  now = 30 * day + 2;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT key FROM cards ORDER BY seq').map(c => JSON.parse(c.key)), [["in-flight"], ["accepted"], ["unknown"]]);
  for (const key of [["failed"], ["released"]]) assert.equal((await f.post(key)).status, 'suppressed');
  assert.equal(await claim.current(), true);
  now += day;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT key FROM cards ORDER BY seq').map(c => JSON.parse(c.key)), [["in-flight"]]);
  for (const key of [["accepted"], ["unknown"]]) assert.equal((await f.post(key)).status, 'suppressed');
  assert.equal(await claim.current(), true);
});

test('observation arms before reads, wakes on post, and is abortable; health contains neutral facts', async t => {
  const f = await fixture(t);
  const observer = await f.ledger.observe(owner);
  t.after(() => observer.close());
  const version = await observer.read();
  const changed = observer.changed(version, 3000);
  await f.post(["p","changed"]);
  assert.equal(await changed, true);
  const controller = new AbortController();
  const waiting = observer.changed(await observer.read(), 3000, controller.signal);
  controller.abort(new Error('stop observing'));
  await assert.rejects(waiting, /stop observing/);
  await f.dispatch(["p","changed"], 'failed'); await f.dispatch(["p","changed"], 'failed');
  await f.ledger.attach({ owner: 'no-route', expectedGeneration: null, routes: [] });
  const health = await f.ledger.health();
  assert.deepEqual(health.repeatedFailures, [{ owner, key: ["p","changed"], count: 2 }]);
  assert.deepEqual(health.sessionsWithoutRoute, ['no-route']);
});

test('caller chooses the exact registered route and local presentation needs no route registration', async t => {
  const f = await fixture(t);
  const chosen = { kind: 'second', address: { opaque: 'chosen destination' } };
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [...routes, chosen] });
  await f.post(["p","chosen"]);
  let address;
  const result = await f.ledger.dispatchHandoff(owner, ["p","chosen"], { kind: chosen.kind, async send(_card, destination) {
    address = destination; return 'accepted';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'accepted');
  assert.deepEqual(address, chosen.address);
  assert.equal(f.read("SELECT route_kind FROM attempts WHERE track='handoff'")[0].route_kind, chosen.kind);
  await f.post(["p","local"]);
  const absent = await f.ledger.dispatchHandoff(owner, ["p","local"], { kind: 'absent', async send() { assert.fail('unregistered route invoked'); } },
    { generation: f.session.generation, timeoutMs: 1000 });
  assert.equal(absent.outcome, 'not-invoked');
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes: [] });
  assert.deepEqual((await f.claim()).cards.map(c => c.key), [["p","local"]]);
});

test('adapter final checks reject route changes and owner cancellation after its own awaits', async t => {
  const f = await fixture(t);
  for (const cause of ['route-change', 'cancel']) {
    await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
    await f.post(["p", cause]);
    let sent = false;
    const result = await f.ledger.dispatchHandoff(owner, ["p", cause], { kind: push.kind, async send(_card, _address, ctx) {
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
  await f.post(["p","orphan"]);
  const abandoned = await f.claim();
  await f.ledger.detach({ owner, generation: f.session.generation });
  assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'unknown');
  const next = await f.ledger.attach({ owner, expectedGeneration: f.session.generation, routes });
  assert.equal(await abandoned.current(), false);
  assert.equal(await f.claim(1000, next.generation), undefined);
  assert.equal((await f.dispatch(["p","orphan"], 'accepted', { generation: next.generation })).outcome, 'not-invoked');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  assert.equal(await abandoned.settle('presented'), true);
  assert.equal((await f.ledger.receipts(owner)).length, 1);
});

test('persistence failure prevents I/O and settlement errors never report successful delivery', async t => {
  const f = await fixture(t);
  await f.post(["p","claim"]);
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
    await assert.rejects(f.ledger.dispatchHandoff(owner, ["p","claim"], transport, { generation: f.session.generation, timeoutMs: 1000 }), /claim persistence failed/);
  } finally { injection.mock.restore(); }
  assert.equal(invoked, 0);
  assert.equal(f.read('SELECT COUNT(*) AS n FROM attempts')[0].n, 0);
  injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('UPDATE attempts SET outcome=?')) throw new Error('settle persistence failed');
    return Reflect.apply(run, this, args);
  });
  try {
    await assert.rejects(f.ledger.dispatchHandoff(owner, ["p","claim"], transport, { generation: f.session.generation, timeoutMs: 1000 }), /settle persistence failed/);
  } finally { injection.mock.restore(); }
  assert.equal(invoked, 1);
  assert.equal(f.read('SELECT outcome FROM attempts')[0].outcome, 'dispatching');
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  await f.post(["p","prepare"]);
  injection = mock.method(proto, 'run', function (...args) {
    if (this.sourceSQL.startsWith('UPDATE attempts SET correlation_json=')) throw new Error('correlation persistence failed');
    return Reflect.apply(run, this, args);
  });
  try {
    await assert.rejects(f.ledger.dispatchHandoff(owner, ["p","prepare"], { kind: push.kind, async send(_card, _address, ctx) {
      await ctx.prepare({ token: 'opaque' }); return 'accepted';
    } }, { generation: f.session.generation, timeoutMs: 1000 }), /correlation persistence failed/);
  } finally { injection.mock.restore(); db.close(); }
});

test('GC is bounded and sequence/cancellation authority survives collection of every card', async t => {
  let now = 1;
  const f = await fixture(t, { clock: () => now });
  for (let index = 0; index < 201; index++) {
    await f.post(["p", String(index)]);
    if (index === 99) await (await f.claim()).settle('presented');
  }
  await (await f.claim()).settle('presented');
  assert.equal((await f.ledger.receipts(owner)).at(-1).seq, 201);
  await f.ledger.cancel({ owner, generation: f.session.generation });
  now += 31 * day;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
  assert.deepEqual(f.read('SELECT * FROM attempts'), []);
  assert.equal(f.read('SELECT COUNT(*) AS n FROM suppressions')[0].n, 101);
  assert.equal((await f.ledger.receipts(owner)).length, 101);
  for (let index = 0; index < 2; index++) await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT * FROM suppressions'), []);
  assert.equal((await f.ledger.receipts(owner)).length, 0);
  await f.post(["p","later"]);
  const batch = await f.claim();
  assert.equal(batch.cards[0].seq, 202);
  assert.deepEqual(batch.cards[0].key, ["p","later"]);
  await batch.settle('presented');
  assert.deepEqual((await f.ledger.receipts(owner)).map(receipt => receipt.seq), [202]);
});

test('prepared handoff references fence admission and preserve separate late presentation evidence', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now, leaseMs: 10 });
  assert.equal(await f.ledger.handoff('missing'), undefined);
  for (const cause of ['cancel', 'rotation', 'delete', 'deadline', 'route']) {
    const own = `${owner}/${cause}`;
    const initial = await f.ledger.attach({ owner: own, expectedGeneration: null, routes });
    await f.ledger.post({ owner: own, key: [cause], text: cause });
    const ready = Promise.withResolvers(), done = Promise.withResolvers();
    const running = f.ledger.dispatchHandoff(own, [cause], { kind: push.kind, async send(_card, _address, ctx) {
      assert.equal(await f.ledger.handoff(ctx.token), undefined);
      assert.equal(await ctx.prepare({ payloadHash: 'hash' }), true);
      assert.equal(await ctx.prepare({ payloadHash: 'other' }), false);
      ready.resolve(ctx.token); return done.promise;
    } }, { generation: initial.generation, timeoutMs: 60000 });
    const token = await ready.promise;
    const ref = await f.ledger.handoff(token);
    assert.deepEqual(ref, { token, owner: own, generation: initial.generation, payloadHash: 'hash', routeKind: push.kind });
    assert.equal(await f.ledger.guardHandoff(ref), true);
    for (const patch of [{ token: 'other' }, { owner }, { generation: 'other' }, { payloadHash: 'other' }, { routeKind: 'other' }]) {
      const wrong = { ...ref, ...patch };
      assert.equal(await f.ledger.guardHandoff(wrong), false);
      assert.equal(await f.ledger.acceptHandoff(wrong), false);
      assert.equal(await f.ledger.observePresentation(wrong), false);
    }
    if (cause === 'cancel') await f.ledger.cancel({ owner: own, generation: initial.generation });
    if (cause === 'rotation') await f.ledger.attach({ owner: own, expectedGeneration: initial.generation, routes });
    if (cause === 'delete') await f.ledger.markDeleted({ owner: own, generation: initial.generation });
    if (cause === 'deadline') now += 60001;
    if (cause === 'route') await f.ledger.updateRoutes({ owner: own, generation: initial.generation, routes: [pull] });
    assert.equal(await f.ledger.guardHandoff(ref), false);
    if (cause === 'delete') {
      assert.equal(await f.ledger.acceptHandoff(ref), false);
      assert.equal(await f.ledger.observePresentation(ref), false);
      done.resolve('accepted'); await running;
      continue;
    }
    assert.equal(await f.ledger.acceptHandoff(ref), true);
    assert.equal(await f.ledger.acceptHandoff(ref), true);
    assert.equal(await f.ledger.guardHandoff(ref), false);
    assert.equal((await f.ledger.receipts(own)).length, 0);
    if (['cancel', 'rotation', 'delete', 'route'].includes(cause)) assert.equal(await f.ledger.observePresentation(ref, { requireCurrent: true }), false);
    assert.equal(await f.ledger.observePresentation(ref), true);
    assert.equal(await f.ledger.acceptHandoff(ref), false);
    assert.equal((await f.ledger.receipts(own)).length, 1);
    done.resolve('accepted'); await running;
  }
});

test('stored evidence before the admitted callback retains its receipt', async t => {
  const f = await fixture(t);
  await f.post(["stored-first"]);
  const ready = Promise.withResolvers(), done = Promise.withResolvers();
  const running = f.ledger.dispatchHandoff(owner, ["stored-first"], { kind: push.kind, async send(_card, _address, ctx) {
    await ctx.prepare({ payloadHash: 'hash' }); ready.resolve(ctx.token); return done.promise;
  } }, { generation: f.session.generation, timeoutMs: 60000 });
  const ref = await f.ledger.handoff(await ready.promise);
  assert.equal(await f.ledger.observePresentation(ref, { requireCurrent: true }), true);
  assert.equal(await f.ledger.acceptHandoff(ref), true);
  assert.equal((await f.ledger.receipts(owner)).length, 1);
  assert.equal(await f.ledger.observePresentation(ref, { requireCurrent: true }), false);
  done.resolve('accepted'); await running;
});

test('handoff query facts and failed or released evidence remain distinct', async t => {
  const f = await fixture(t);
  for (const outcome of ['failed', 'not-capable']) {
    await f.post([outcome]);
    const result = await f.ledger.dispatchHandoff(owner, [outcome], { kind: push.kind, async send(_card, _address, ctx) {
      await ctx.prepare({ payloadHash: outcome }); return outcome;
    } }, { generation: f.session.generation, timeoutMs: 1000 });
    const ref = await f.ledger.handoff(result.token);
    assert.equal(await f.ledger.acceptHandoff(ref), false);
    assert.equal(await f.ledger.observePresentation(ref), false);
  }
  const list = await f.ledger.handoffs(owner, { generation: f.session.generation });
  assert.deepEqual(list.map(a => a.outcome), ['failed', 'released']);
  assert.deepEqual((await f.ledger.pending(owner, { generation: f.session.generation })).map(c => c.key), [["failed"], ["not-capable"]]);
  await f.ledger.detach({ owner, generation: f.session.generation });
  assert.equal((await f.ledger.sessions())[0].state, 'detached');
  assert.deepEqual(await f.ledger.pending(owner, { generation: f.session.generation }), []);
  assert.equal((await f.ledger.handoffs(owner, { generation: f.session.generation })).length, 2);
});

test('presentation writes receipts, deletes cards and attempts, and tombstones the exact key', async t => {
  const f = await fixture(t);
  await f.post(["completed"], 'preview');
  const claim = await f.claim();
  assert.equal(await claim.settle('presented'), true);
  assert.deepEqual((await f.ledger.receipts(owner)).map(receipt => receipt.key), [["completed"]]);
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
  assert.deepEqual(f.read('SELECT * FROM attempts'), []);
  assert.equal((await f.post(["completed"], 'preview')).status, 'suppressed');
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
});

test('accepted admission drops content while exact custody confirms later, including under suppression', async t => {
  const f = await fixture(t);
  for (const suppressed of [false, true]) {
    const key = [`admitted:${suppressed}`];
    const details = { kind: 'presentation', origin: 'producer', body: 'full body' };
    await f.ledger.post({ owner, key, text: 'preview', details });
    const ready = Promise.withResolvers(), finish = Promise.withResolvers();
    const dispatch = f.ledger.dispatchHandoff(owner, key, { kind: push.kind, async send(_card, _address, context) {
      await context.prepare({ payloadHash: JSON.stringify(key) });
      ready.resolve(context.token);
      return finish.promise;
    } }, { generation: f.session.generation, timeoutMs: 60000 });
    const token = await ready.promise;
    try {
      const ref = await f.ledger.handoff(token);
      assert.equal(await f.ledger.guardHandoff(ref), true);
      assert.equal(await f.ledger.acceptHandoff(ref), true);
      assert.deepEqual(f.read('SELECT text,details FROM cards WHERE key=?', JSON.stringify(key)).map(row => ({ ...row })), [{ text: '', details: null }]);
      assert.equal((await f.ledger.handoffs(owner, { generation: f.session.generation })).some(a => a.token === token && a.outcome === 'accepted'), true);
      assert.equal(await f.claim(), undefined);
      assert.equal((await f.ledger.post({ owner, key, text: 'preview', details })).status, 'duplicate');
      if (suppressed) {
        assert.equal((await f.ledger.suppress({ owner, key, scope: 'exact' })).status, 'in-custody');
        assert.equal(await f.ledger.observePresentation(ref, { requireCurrent: true }), false);
      }
      assert.equal(await f.ledger.observePresentation(ref, { requireCurrent: !suppressed }), true);
      assert.equal(await f.ledger.handoff(token), undefined);
      assert.equal(await f.ledger.observePresentation(ref), false);
      assert.deepEqual(f.read('SELECT * FROM attempts WHERE token=?', token), []);
      assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, 1);
      assert.equal((await f.post(key)).status, 'suppressed');
    } finally { finish.resolve('accepted'); await dispatch; }
  }
});

test('unknown outcomes drop content at settlement, lease expiry and detach while preserving late evidence', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now, leaseMs: 10 });
  let generation = f.session.generation;
  for (const cause of ['settle', 'expiry', 'detach']) {
    const key = [`unknown:${cause}`];
    const details = { body: 'full body' };
    await f.ledger.post({ owner, key, text: 'preview', details });
    const claim = await f.claim(1000, generation);
    if (cause === 'settle') await claim.settle('unknown');
    if (cause === 'expiry') { now += 11; await f.claim(1000, generation); }
    if (cause === 'detach') {
      await f.ledger.detach({ owner, generation });
      generation = (await f.ledger.attach({ owner, expectedGeneration: generation, routes })).generation;
    }
    assert.deepEqual(f.read('SELECT text,details FROM cards WHERE key=?', JSON.stringify(key)).map(row => ({ ...row })), [{ text: '', details: null }]);
    assert.equal((await f.ledger.health(owner)).unknownAttempts.some(a => a.token === claim.attempts[0].token), true);
    assert.equal((await f.ledger.post({ owner, key, text: 'preview', details })).status, 'duplicate');
    assert.equal(await f.claim(1000, generation), undefined);
    assert.equal(await claim.settle('presented'), true);
    assert.equal((await f.ledger.receipts(owner, { keys: [key] })).length, 1);
  }
});

test('unconfirmed custody survives suppression until retention after the latest settlement', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now });
  for (const key of [["accepted"], ["suppressed"]]) await f.post(key);
  now += day;
  for (const key of [["accepted"], ["suppressed"]]) await f.dispatch(key);
  await f.ledger.suppress({ owner, key: ["suppressed"], scope: 'exact' });
  now += 30 * day - 1;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT key FROM cards ORDER BY seq').map(row => JSON.parse(row.key)), [["accepted"], ["suppressed"]]);
  now += 2;
  await f.ledger.updateRoutes({ owner, generation: f.session.generation, routes });
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
  assert.deepEqual(f.read('SELECT * FROM attempts'), []);
  assert.equal((await f.post(["accepted"])).status, 'suppressed');
  assert.equal((await f.post(["suppressed"])).status, 'suppressed');
});

test('deleted and long-detached sessions lose cards without losing session authority', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now });
  await f.post(["deleted"]);
  const claim = await f.claim();
  await f.ledger.suppress({ owner, key: ["deleted"], scope: 'prefix' });
  await f.ledger.markDeleted({ owner, generation: f.session.generation });
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
  assert.deepEqual(f.read('SELECT * FROM attempts'), []);
  assert.deepEqual(f.read('SELECT * FROM suppressions'), []);
  assert.equal((await f.ledger.session(owner)).state, 'deleted');
  assert.equal(await claim.settle('presented'), false);
  const other = 'detached-owner';
  const session = await f.ledger.attach({ owner: other, expectedGeneration: null, routes });
  await f.ledger.post({ owner: other, key: ["away"], text: 'body' });
  await f.ledger.claimPresentation(other, { generation: session.generation, budgetChars: 1000 });
  await f.ledger.detach({ owner: other, generation: session.generation });
  now += 30 * day - 1;
  await f.ledger.attach({ owner: 'trigger', expectedGeneration: null, routes: [] });
  assert.equal(f.read('SELECT * FROM cards WHERE owner=?', other).length, 1);
  now += 2;
  await f.ledger.updateRoutes({ owner: 'trigger', generation: (await f.ledger.session('trigger')).generation, routes: [] });
  assert.deepEqual(f.read('SELECT * FROM cards'), []);
  assert.deepEqual(f.read('SELECT * FROM attempts'), []);
  assert.equal((await f.ledger.session(other)).state, 'detached');
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
  const plain = path.join(path.dirname(f.location), 'plain.sqlite');
  await fs.writeFile(plain, 'not a database');
  await assert.rejects(DeliveryLedger.open({ location: plain }));
  assert.equal(await fs.readFile(plain, 'utf8'), 'not a database');
  await assert.rejects(DeliveryLedger.open({ location: 'relative.sqlite' }), /absolute/);
});

test('array identities preserve every string segment and match only complete element prefixes', async t => {
  const f = await fixture(t);
  const paths = [['a'], ['ab'], ['a', 'b'], ['a', 'b2'], ['a', ''], [''], ['', ''],
    ['quote"/\\', 'child'], ['nul\u0000', '\ud800'], ['nul\u0000x'], ['\ud800'], ['😀', '𐀀']];
  for (const key of paths) assert.equal((await f.post(key, 'body')).status, 'posted');
  const other = 'array:other';
  await f.ledger.attach({ owner: other, expectedGeneration: null, routes: [] });
  await f.ledger.post({ owner: other, key: ['a', 'foreign'], text: 'other owner' });
  assert.deepEqual((await f.ledger.cards({ owner, keyPrefix: [] })).map(c => c.key),
    [...paths].sort((a, b) => Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b)))));
  assert.deepEqual((await f.ledger.cards({ owner, keyPrefix: ['a'] })).map(c => c.key), [['a', ''], ['a', 'b'], ['a', 'b2'], ['a']]);
  for (const keyPrefix of [[''], ['quote"/\\'], ['nul\u0000'], ['\ud800'], ['😀']])
    assert.ok((await f.ledger.cards({ owner, keyPrefix })).every(c => keyPrefix.every((s, i) => c.key[i] === s)));
  assert.equal((await f.post(['a', 'b'], 'body')).status, 'duplicate');
  await f.ledger.suppress({ owner, key: ['a', 'b'], scope: 'prefix', expiresAt: Date.now() + day });
  const pending = await f.ledger.pending(owner, { generation: f.session.generation });
  assert.equal(pending.some(c => JSON.stringify(c.key) === '["a","b"]'), false);
  assert.ok(pending.some(c => JSON.stringify(c.key) === '["a","b2"]'));
  const malformed = ['string', [], ['nested', []], [undefined], [1], new Array(1)];
  for (const key of malformed) assert.throws(() => f.ledger.post({ owner, key, text: 'bad' }), TypeError);
  for (const keyPrefix of ['string', [null], new Array(1)]) assert.throws(() => f.ledger.cards({ owner, keyPrefix }), TypeError);
});

test('queued operations snapshot input arrays synchronously and outputs never alias ledger keys', async t => {
  const f = await fixture(t);
  await f.post(['receipt'], 'receipt');
  await (await f.claim()).settle('presented');
  const lock = new DatabaseSync(f.location);
  lock.exec('BEGIN IMMEDIATE');
  const key = ['queued', 'card'], prefix = ['queued'], receiptKeys = [['receipt']], exactKeys = [['withdraw']];
  const posted = f.ledger.post({ owner, key, text: 'original key' });
  const cards = f.ledger.cards({ owner, keyPrefix: prefix });
  const receipts = f.ledger.receipts(owner, { keys: receiptKeys });
  const withdrawn = f.ledger.suppressExact(owner, exactKeys);
  const holdKey = ['held'];
  const hold = f.ledger.setSuppression({ owner, id: 'snapshot-hold', key: holdKey, scope: 'prefix', expiresAt: Date.now() + day });
  key[0] = 'mutated'; prefix[0] = 'mutated'; receiptKeys[0][0] = 'mutated'; exactKeys[0][0] = 'mutated'; holdKey[0] = 'mutated';
  lock.exec('ROLLBACK'); lock.close();
  assert.equal((await posted).status, 'posted');
  const selected = await cards;
  assert.deepEqual(selected.map(c => c.key), [['queued', 'card']]);
  assert.deepEqual((await receipts).map(r => r.key), [['receipt']]);
  await withdrawn; await hold;
  assert.equal((await f.post(['withdraw'])).status, 'suppressed');
  const suppression = await f.ledger.suppression({ owner, id: 'snapshot-hold' });
  assert.deepEqual(suppression.key, ['held']);
  suppression.key[0] = 'changed'; selected[0].key[0] = 'changed';
  assert.deepEqual((await f.ledger.suppression({ owner, id: 'snapshot-hold' })).key, ['held']);
  assert.deepEqual((await f.ledger.cards({ owner, keyPrefix: ['queued'] }))[0].key, ['queued', 'card']);
  const sendKey = ['queued', 'card'];
  const dispatch = f.ledger.dispatchHandoff(owner, sendKey, { kind: push.kind, send: async c => {
    assert.deepEqual(c.key, ['queued', 'card']); return 'presented';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  sendKey[0] = 'changed';
  assert.equal((await dispatch).outcome, 'presented');
  assert.deepEqual((await f.ledger.receipts(owner, { keys: [['queued', 'card']] }))[0].key, ['queued', 'card']);
});

test('notification helper snapshots the key before its first session await', async t => {
  const f = await fixture(t);
  await f.post(['helper', 'card']);
  const key = ['helper', 'card'];
  const tracked = [];
  const sending = dispatchPostedCard(f.ledger, owner, key, {
    track: result => tracked.push(result), transports: [{ kind: push.kind, send: async card => {
      assert.deepEqual(card.key, ['helper', 'card']); return 'presented';
    } }],
  });
  key[0] = 'changed';
  await sending;
  assert.equal(tracked[0].outcome, 'presented');
  assert.deepEqual((await f.ledger.receipts(owner)).map(r => r.key), [['helper', 'card']]);
});

test('one finite global named hold retains new work, preserves late receipts and expires independently of GC', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now });
  const other = 'global:other';
  const session = await f.ledger.attach({ owner: other, expectedGeneration: null, routes });
  const independent = await f.ledger.suppress({ owner, key: ['independent'], scope: 'prefix', expiresAt: 500 });
  const tombstone = await f.ledger.suppress({ owner, key: ['withdrawn'], scope: 'exact' });
  await f.post(['captured']);
  const captured = await f.claim();
  const input = { owner: null, id: 'ledger-mute', key: [], scope: 'prefix', expiresAt: 200 };
  assert.deepEqual(await f.ledger.setSuppression(input), { id: 'ledger-mute', status: 'in-custody' });
  assert.equal(await captured.current(), false);
  assert.equal((await f.post(['new-producer', 'one'])).status, 'suppressed');
  assert.equal((await f.ledger.post({ owner: other, key: ['other-producer'], text: 'retained' })).status, 'suppressed');
  assert.deepEqual(await f.ledger.pending(owner, { generation: f.session.generation }), []);
  assert.deepEqual(await f.ledger.pending(other, { generation: session.generation }), []);
  assert.equal(await f.claim(), undefined);
  assert.equal((await f.dispatch(['new-producer', 'one'])).outcome, 'not-invoked');
  assert.equal(await captured.settle('presented'), true);
  assert.deepEqual((await f.ledger.receipts(owner)).map(r => r.key), [['captured']]);
  now = 110;
  await f.ledger.setSuppression({ ...input, expiresAt: 150 });
  assert.deepEqual(await f.ledger.suppression({ owner: null, id: 'ledger-mute' }),
    { owner: null, id: 'ledger-mute', key: [], scope: 'prefix', createdAt: 110, expiresAt: 150 });
  assert.equal(f.read("SELECT COUNT(*) AS n FROM suppressions WHERE owner IS NULL")[0].n, 1);
  assert.equal((await f.ledger.suppression({ owner, id: independent.id })).expiresAt, 500);
  await assert.rejects(f.ledger.setSuppression({ owner, id: tombstone.id, key: ['withdrawn'], scope: 'exact', expiresAt: 600 }), /different hold/);
  assert.equal(await f.ledger.releaseSuppression({ owner, id: 'ledger-mute' }), false);
  await f.ledger.markDeleted({ owner: other, generation: session.generation });
  assert.ok(await f.ledger.suppression({ owner: null, id: 'ledger-mute' }));
  now = 150;
  assert.equal(await f.ledger.suppression({ owner: null, id: 'ledger-mute' }), undefined);
  assert.equal(f.read("SELECT COUNT(*) AS n FROM suppressions WHERE owner IS NULL")[0].n, 1, 'reads did not collect expiry');
  assert.equal(await f.ledger.renewSuppression({ owner: null, id: 'ledger-mute', expiresAt: 300 }), false);
  const resumed = await f.claim();
  assert.deepEqual(resumed.cards.map(c => c.key), [['new-producer', 'one']]);
  await resumed.settle('released');
  await f.ledger.setSuppression({ ...input, expiresAt: 300 });
  assert.equal(await f.ledger.renewSuppression({ owner: null, id: 'ledger-mute', expiresAt: 350 }), true);
  assert.equal(await f.ledger.releaseSuppression({ owner: null, id: 'ledger-mute' }), true);
  assert.equal(await f.ledger.renewSuppression({ owner: null, id: 'ledger-mute', expiresAt: 400 }), false);
  assert.ok(await f.ledger.suppression({ owner, id: independent.id }));
});

test('named owner holds upsert only the same timed identity and refuse invalid global combinations', async t => {
  let now = 100;
  const f = await fixture(t, { clock: () => now });
  const hold = { owner, id: 'seat-hold', key: ['a'], scope: 'prefix', expiresAt: 200 };
  await f.ledger.setSuppression(hold);
  const before = f.read('SELECT * FROM suppressions');
  for (const patch of [{ owner: 'other' }, { key: ['ab'] }, { scope: 'exact' }])
    await assert.rejects(f.ledger.setSuppression({ ...hold, ...patch }), /different hold/);
  assert.deepEqual(f.read('SELECT * FROM suppressions'), before);
  now = 201;
  assert.equal(await f.ledger.suppression({ owner, id: hold.id }), undefined);
  await f.ledger.setSuppression({ ...hold, key: ['a'], expiresAt: 300 });
  assert.equal((await f.ledger.suppression({ owner, id: hold.id })).createdAt, 201);
  for (const patch of [{ id: 'wrong' }, { key: ['a'] }, { scope: 'exact' }, { expiresAt: Infinity }, { owner }])
    assert.throws(() => f.ledger.setSuppression({ owner: null, id: 'ledger-mute', key: [], scope: 'prefix', expiresAt: 300, ...patch }), TypeError);
  const db = new DatabaseSync(f.location);
  try {
    for (const [id, key, scope, expiry] of [['other', '[]', 'prefix', 300], ['ledger-mute', '["a"]', 'prefix', 300], ['ledger-mute', '[]', 'prefix', null], ['ledger-mute', '[]', 'prefix', Infinity]])
      assert.throws(() => db.prepare('INSERT INTO suppressions VALUES(?,NULL,?,?,100,?)').run(id, key, scope, expiry), /CHECK/);
  } finally { db.close(); }
});

test('global holds fence prepared handoff and beforeSend without recalling captured external custody', async t => {
  const f = await fixture(t);
  await f.post(['prepared']);
  const result = await f.ledger.dispatchHandoff(owner, ['prepared'], { kind: push.kind, async send(_card, _address, context) {
    assert.equal(await context.prepare({ payloadHash: 'hash' }), true);
    const ref = await f.ledger.handoff(context.token);
    assert.equal(await f.ledger.guardHandoff(ref), true);
    await f.ledger.setSuppression({ owner: null, id: 'ledger-mute', key: [], scope: 'prefix', expiresAt: Date.now() + day });
    assert.equal(await context.beforeSend(), false);
    assert.equal(await f.ledger.guardHandoff(ref), false);
    assert.equal(await f.ledger.acceptHandoff(ref), true);
    assert.equal(await f.ledger.observePresentation(ref, { requireCurrent: true }), false);
    assert.equal(await f.ledger.observePresentation(ref), true);
    return 'presented';
  } }, { generation: f.session.generation, timeoutMs: 1000 });
  // The receiver's truthful observation already retired this exact attempt.
  assert.equal(result.outcome, 'presented');
  assert.deepEqual((await f.ledger.receipts(owner)).map(r => r.key), [['prepared']]);
});
