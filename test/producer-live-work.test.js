import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Square } from '../dist/square-api.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { squarePostKey, parseSquarePostKey } from '../dist/square-post.js';
import { nameKey } from '../dist/model.js';
import { flushSquarePosts, reconcileSquareDelivery } from '../dist/square-posting.js';

const DAY = 86_400_000;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-live-work-'));
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  const square = await Square.build({ path: path.join(root, 'world.square'), ledgerLocation, markdown: '', clock: () => Date.now() });
  const alice = (await square.join('Alice', { owner: 'live:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'live:bob' })).participant;
  const artifact = square.artifact;
  const location = await fs.realpath(square.location);
  const ledger = await DeliveryLedger.open({ location: ledgerLocation, clock: () => Date.now() });
  t.after(async () => { await ledger.close(); await square.close(); await fs.rm(root, { recursive: true, force: true }); });
  const session = await ledger.session(bob.seat.owner);
  const suppressions = () => {
    const db = new DatabaseSync(ledgerLocation, { readOnly: true });
    try { return db.prepare('SELECT key FROM suppressions WHERE owner=?').all(session.owner).map(row => row.key); }
    finally { db.close(); }
  };
  return { square, location, alice, bob, artifact, ledger, ledgerLocation, session, suppressions,
    key: post => squarePostKey(location, post),
    cards: () => ledger.cards({ keyPrefix: `square:${location}#` }),
    insert: input => artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => facts.insertNotice({ from: 'notice', to: 'Bob', ...input }, Date.now())),
    reconcile: () => reconcileSquareDelivery(artifact, location, Date.now, undefined, ledgerLocation),
    flush: () => flushSquarePosts(artifact, location, Date.now, undefined, ledgerLocation),
  };
}

test('Square post keys round-trip canonical recipient identity and opaque generation, rejecting foreign or malformed keys', () => {
  const location = '/tmp/a#b/%_世界.square';
  const cases = [
    { kind: 'activity', index: 0, recipient: 'Alice', generation: 'join/with#%and空格' },
    { kind: 'notice', index: Number.MAX_SAFE_INTEGER, recipient: '猫/👩🏽‍💻/É', generation: '' },
    { kind: 'activity', index: 42, recipient: 'E\u0301/中_文', generation: 'a/b/👨‍👩‍👧‍👦' },
  ];
  for (const post of cases) assert.deepEqual(parseSquarePostKey(location, squarePostKey(location, post)),
    { kind: post.kind, index: post.index, recipientKey: nameKey(post.recipient), generation: post.generation });
  const valid = squarePostKey(location, cases[0]);
  for (const key of [valid.replace('#act/0/', '#act/01/'), valid + '/extra', valid.replace('/recipient/alice/', '/recipient/%xx/'),
    valid.replace('/recipient/alice/', '/recipient/Alice/'), valid.replace('#act/0/', '#act/9007199254740992/'), 'another-producer:key'])
    assert.equal(parseSquarePostKey(location, key), undefined);
  assert.equal(parseSquarePostKey(location + '/other', valid), undefined);
});

test('gone consumed cards do not recreate suppressions after ledger retention', async t => {
  const c = await fixture(t);
  const sent = (await c.alice.express('consume this card', { mentions: ['Bob'], force: true })).activity;
  const key = (await c.cards())[0].key;
  await c.bob.perceive({ id: sent.id });
  assert.deepEqual(await c.cards(), []);
  assert.ok(c.suppressions().includes(key));
  const future = Date.now() + 31 * DAY;
  t.mock.method(Date, 'now', () => future);
  await c.ledger.post({ owner: c.session.owner, key: 'gc-trigger', text: 'unrelated producer' });
  assert.equal(c.suppressions().includes(key), false);
  await c.square.join('Bob', { owner: c.session.owner });
  await c.alice.express('no directed audience', { force: true });
  await c.bob.perceive();
  assert.equal(c.suppressions().includes(key), false);
  assert.deepEqual(await c.cards(), []);
});

test('withdrawal suppresses live cards and in-window claims before a captured exporter can post', async t => {
  const c = await fixture(t);
  const metadata = { outcome: 'withdraw' };
  await c.square.send({ from: 'notice', to: 'Bob', body: 'already in ledger', metadata });
  const liveKey = (await c.cards())[0].key;
  await c.insert({ body: 'captured before insertion', metadata });
  const claim = (await c.artifact.read(facts => facts.pendingPosts()[0])).value;
  const claimKey = c.key(claim);
  await c.artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...claim, full: true }, 'in-flight', process.pid, Date.now()));
  await c.bob.ack({ from: 'notice', match: { fields: [{ path: ['outcome'], equals: 'withdraw' }] }, future: 'exact' });
  assert.ok((await c.cards()).some(card => card.key === liveKey), 'local ACK leaves ledger maintenance to a privileged operation');
  await c.reconcile();
  assert.deepEqual(await c.cards(), []);
  assert.deepEqual(new Set(c.suppressions()), new Set([liveKey, claimKey]));
  assert.equal((await c.ledger.post({ owner: claim.owner, key: claimKey, text: claim.body })).status, 'suppressed');
  assert.equal((await c.artifact.read(facts => facts.withdrawnClaims(Date.now() + 30 * DAY))).value.length, 0);

  // Departure also fences an unconsumed claim, and a never-exported source stays out of a replacement seat.
  await c.insert({ body: 'old seat, captured' });
  const oldSeatClaim = (await c.artifact.read(facts => facts.pendingPosts()[0])).value;
  await c.artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...oldSeatClaim, full: true }, 'old-seat', process.pid, Date.now()));
  await c.insert({ body: 'old seat, never exported' });
  await c.bob.done();
  assert.ok(c.suppressions().includes(c.key(oldSeatClaim)));
  await c.square.join('Bob', { owner: c.session.owner });
  assert.deepEqual((await c.artifact.read(facts => facts.pendingPosts())).value, []);
});

test('no-route and native-only owners export cards without entering producer pending or dispatch', async t => {
  const c = await fixture(t);
  const alice = await c.ledger.session(c.alice.seat.owner);
  await c.ledger.updateRoutes({ owner: alice.owner, generation: alice.generation, routes: [{ kind: 'pi-native', address: {} }] });
  await c.insert({ to: ['Alice', 'Bob'], body: 'receiver-owned delivery' });
  const pending = t.mock.method(DeliveryLedger.prototype, 'pending', () => { throw Error('producer must not enumerate receiver-owned cards'); });
  const dispatch = t.mock.method(DeliveryLedger.prototype, 'dispatchHandoff', () => { throw Error('producer must not acquire native custody'); });
  const lookups = [], read = c.artifact.read.bind(c.artifact);
  t.mock.method(c.artifact, 'read', (select, signal) => read(facts => select(new Proxy(facts, {
    get(target, key) {
      if (key === 'postsAt') return ids => { lookups.push(ids.length); return target.postsAt(ids); };
      return target[key];
    },
  })), signal));
  await c.flush();
  assert.equal((await c.cards()).length, 2, 'route gating never prevents producer export');
  assert.equal(pending.mock.callCount(), 0);
  assert.equal(dispatch.mock.callCount(), 0);
  assert.deepEqual(lookups, [2], 'only withdrawal examines these live cards; dispatch does not look them up');
});

test('flush omits expired and future-clock claims but retries live identities and never-exported ancient sources', async t => {
  const c = await fixture(t), now = Date.now();
  await c.artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => {
    for (let i = 0; i < 64; i++) facts.insertNotice({ from: 'notice', to: 'Bob', body: `expired-${i}` }, 0);
    for (const body of ['future-first', 'future-claim', 'live-retry', 'never-exported'])
      facts.insertNotice({ from: 'notice', to: 'Bob', body }, 0);
  });
  const posts = (await c.artifact.read(facts => facts.pendingPosts(now))).value;
  await c.artifact.transactAs({ kind: 'producer' }, facts => {
    for (const post of posts.filter(post => post.body !== 'never-exported')) {
      const first = post.body.startsWith('expired-') ? now - 30 * DAY : post.body === 'future-first' ? now + 60_000 : now - DAY;
      const token = `claim-${post.index}`;
      assert.equal(facts.acquirePost({ ...post, full: true }, token, process.pid, 0, first), 'initial');
      if (post.body === 'future-claim') {
        assert.equal(facts.acquirePost({ ...post, full: true }, 'recovered-future', process.pid, 0, now + 60_000), 'recovered');
        facts.settlePost('recovered-future', true, 'uncertain');
      } else facts.settlePost(token, true, 'uncertain');
    }
  });
  assert.deepEqual((await c.artifact.read(facts => facts.pendingPosts(now))).value.map(post => post.body), ['live-retry', 'never-exported']);
  const acquires = [], transact = c.artifact.transactAs.bind(c.artifact);
  t.mock.method(c.artifact, 'transactAs', (authority, change, signal) => transact(authority, facts => change(new Proxy(facts, {
    get(target, key) {
      if (key === 'acquirePost') return (...args) => { acquires.push(args[0].body); return target.acquirePost(...args); };
      return target[key];
    },
  })), signal));
  await flushSquarePosts(c.artifact, c.location, () => 0, undefined, c.ledgerLocation);
  assert.deepEqual(acquires, ['live-retry', 'never-exported'], 'selection uses host time, not the deliberately ancient social clock');
  assert.equal((await c.cards()).length, 2);
  const retained = (await c.artifact.read(facts => facts.postsAt(posts.map(post => parseSquarePostKey(c.location, c.key(post)))))).value;
  assert.equal(retained.length, posts.length, 'excluded identities remain in producer storage');
  assert.ok(retained.every(post => !post.consumed));
});

test('perceive maintenance is driven by live ledger evidence, not consumed or unconsumed producer history', async t => {
  const c = await fixture(t);
  const history = (await c.artifact.transactAs({ kind: 'participant', seat: c.alice.seat }, facts => {
    return Array.from({ length: 128 }, (_, i) => facts.land({ kind: 'say', actor: 'Alice', at: i, body: 'old full card', mentions: ['Bob'] }).index);
  })).value;
  const historicalPosts = (await c.artifact.read(facts => facts.pendingPosts())).value;
  await c.artifact.transactAs({ kind: 'producer' }, facts => {
    for (const post of historicalPosts) {
      const token = `old-${post.index}`;
      assert.equal(facts.acquirePost({ ...post, full: true }, token, process.pid, Date.now()), 'initial');
      facts.settlePost(token, true, 'posted');
    }
  });
  for (const post of historicalPosts) await c.ledger.post({ owner: post.owner, key: c.key(post), text: post.body });
  const presentedHistory = await c.ledger.claimPresentation(c.session.owner, { generation: c.session.generation, budgetChars: 100000 });
  assert.equal(presentedHistory.cards.length, 128);
  await presentedHistory.settle('presented');
  await c.bob.ack(history.slice(0, 64).map(index => `act/${index}`));
  const future = Date.now() + 31 * DAY;
  t.mock.method(Date, 'now', () => future);
  for (let i = 0; i < 2; i++) await c.ledger.post({ owner: c.session.owner, key: `other-producer:${i}`, text: 'collect expired evidence' });
  assert.deepEqual(await c.ledger.receipts(c.session.owner), []);
  assert.deepEqual(await c.cards(), []);

  const full = (await c.alice.express('full receipt', { mentions: ['Bob'], force: true })).activity;
  const truncated = (await c.alice.express('long '.repeat(100), { mentions: ['Bob'], force: true })).activity;
  const claim = await c.ledger.claimPresentation(c.session.owner, { generation: c.session.generation, budgetChars: 100000 });
  await claim.settle('presented');
  const [target, acked] = (await c.artifact.transactAs({ kind: 'participant', seat: c.alice.seat }, facts =>
    ['perceive this exact card', 'live withdrawal at perceive'].map(body => facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body, mentions: ['Bob'] }).index))).value;
  await c.flush();
  await c.bob.ack([`act/${acked}`]);
  const liveBefore = await c.cards();
  const ackedKey = liveBefore.find(card => parseSquarePostKey(c.location, card.key).index === acked).key;
  const targetKey = liveBefore.find(card => parseSquarePostKey(c.location, card.key).index === target).key;
  const receiptCalls = [], suppressCalls = [], lookedUp = [], pendingRows = [];
  const receipts = DeliveryLedger.prototype.receipts, suppress = DeliveryLedger.prototype.suppressExact;
  t.mock.method(DeliveryLedger.prototype, 'receipts', async function (owner, options, signal) {
    const result = await receipts.call(this, owner, options, signal);
    receiptCalls.push({ owner, options, keys: result.map(receipt => receipt.key) });
    return result;
  });
  t.mock.method(DeliveryLedger.prototype, 'suppressExact', function (owner, keys, signal) {
    suppressCalls.push(...keys);
    return suppress.call(this, owner, keys, signal);
  });
  const read = c.artifact.read.bind(c.artifact);
  t.mock.method(c.artifact, 'read', (select, signal) => read(facts => select(new Proxy(facts, {
    get(target, key) {
      if (key === 'postsAt') return ids => { lookedUp.push(...ids); return target.postsAt(ids); };
      if (key === 'pendingPosts') return () => { const rows = target.pendingPosts(); pendingRows.push(...rows); return rows; };
      return target[key];
    },
  })), signal));
  await c.bob.perceive({ id: `act/${target}` });
  assert.ok(receiptCalls.length > 0);
  assert.ok(receiptCalls.every(call => call.options?.keys === undefined), 'receipt reads never carry historical artifact key lists');
  const bobReceipts = receiptCalls.find(call => call.owner === c.session.owner).keys;
  assert.deepEqual(bobReceipts.filter(key => key.startsWith(`square:${c.location}#`)).map(key => parseSquarePostKey(c.location, key).index).sort((a, b) => a - b),
    [Number(full.id.slice(4)), Number(truncated.id.slice(4))]);
  assert.ok(lookedUp.length > 0);
  assert.ok(lookedUp.every(id => !history.includes(id.index)), 'gone old full cards, even unconsumed ones, are never looked up');
  assert.deepEqual(pendingRows, []);
  assert.deepEqual(new Set(suppressCalls), new Set([ackedKey, targetKey]));
  assert.ok((await read(facts => facts.receipt('Bob', Number(full.id.slice(4))))).value);
  assert.equal((await read(facts => facts.receipt('Bob', Number(truncated.id.slice(4))))).value, undefined);
});
