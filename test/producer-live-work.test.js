import { deliveryKeyEqual, encodeDeliveryKey } from '../dist/core/delivery-key.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Square } from '../dist/api/square-api.js';
import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';
import { squarePostKey, parseSquarePostKey } from '../dist/core/delivery-key.js';
import { nameKey } from '../dist/core/model.js';
import { flushSquarePosts, reconcileSquareDelivery, ensureInitialDeliverySession } from '../dist/app/square-posting.js';
import { dispatchPostedCard } from '../dist/hosts/notifications.js';

test('receipt folds and owner watermarks commit atomically, replay safely and skip retained history', async t => {
  const c = await fixture(t);
  await c.insert({ body: 'first full receipt' });
  await c.insert({ body: 'second full receipt' });
  await c.flush();
  const truncated = await c.alice.express('long '.repeat(100), { mentions: ['Bob'], force: true });
  await c.ledger.post({ owner: c.session.owner, key: ["another-producer","key"], text: 'foreign receipt' });
  const claim = await c.ledger.claimPresentation(c.session.owner, { generation: c.session.generation, budgetChars: 100000 });
  await claim.settle('presented');
  const receipts = await c.ledger.receipts(c.session.owner);
  const last = receipts.at(-1).seq;
  const ids = receipts.flatMap(receipt => { const id = parseSquarePostKey(c.location, receipt.key); return id ? [id] : []; });
  const snapshot = () => c.artifact.read(facts => ({
    watermark: facts.receiptWatermark(c.session.owner),
    other: facts.receiptWatermark(c.alice.seat.owner),
    consumed: facts.postsAt(ids).map(post => !!post.consumed),
  })).then(result => result.value);
  const transact = c.artifact.transactAs.bind(c.artifact);
  const failure = new Error('crash before artifact commit');
  const intercept = t.mock.method(c.artifact, 'transactAs', (authority, change, signal) => transact(authority, facts => change(new Proxy(facts, {
    get(target, key) {
      if (key === 'advanceReceiptWatermark') return (...args) => { target.advanceReceiptWatermark(...args); throw failure; };
      return target[key];
    },
  })), signal));
  await assert.rejects(c.reconcile(), error => error === failure);
  assert.deepEqual(await snapshot(), { watermark: 0, other: 0, consumed: [false, false, false] });
  intercept.mock.restore();
  await Promise.all([c.reconcile(), c.reconcile()]);
  assert.deepEqual(await snapshot(), { watermark: last, other: 0, consumed: [false, true, true] });
  await c.artifact.transactAs({ kind: 'producer' }, facts => facts.advanceReceiptWatermark(c.session.owner, last - 1));
  assert.equal((await snapshot()).watermark, last, 'a stale reconciler cannot lower the watermark');
  const readReceipts = DeliveryLedger.prototype.receipts;
  const reads = [];
  t.mock.method(DeliveryLedger.prototype, 'receipts', async function (owner, options, signal) {
    const result = await readReceipts.call(this, owner, options, signal);
    if (owner === c.session.owner) reads.push({ after: options.afterSeq, count: result.length });
    return result;
  });
  await c.reconcile();
  assert.deepEqual(reads, [{ after: last, count: 0 }], 'retained receipts are behind the cursor');
  // Rebuilding the cursor reproduces a full scan without changing established consumption.
  const db = new DatabaseSync(c.square.location);
  try { db.prepare('DELETE FROM producer_receipt_watermarks WHERE owner_json=?').run(JSON.stringify(c.session.owner)); }
  finally { db.close(); }
  await c.reconcile();
  assert.equal(reads.at(-1).after, 0);
  assert.equal(reads.at(-1).count, receipts.length);
  assert.deepEqual(await snapshot(), { watermark: last, other: 0, consumed: [false, true, true] });
  assert.deepEqual((await c.bob.pending()).activities.map(activity => activity.id), [truncated.activity.id]);
  await assert.rejects(c.artifact.transactAs({ kind: 'participant', seat: c.bob.seat }, facts => facts.advanceReceiptWatermark(c.session.owner, last + 1)), /authority/);
});

test('durable departure cleanup survives interrupted suppression and fences late exports without clearing a newer intent', async t => {
  const c = await fixture(t);
  await c.square.send({ from: 'notice', to: 'Bob', body: 'posted before departure' });
  const oldKey = (await c.cards())[0].key;
  await c.insert({ body: 'in-flight before departure' });
  const captured = (await c.artifact.read(facts => facts.pendingPosts()[0])).value;
  await c.artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...captured, full: true }, 'late-export', process.pid, Date.now()));
  await c.artifact.transactAs({ kind: 'participant', seat: c.bob.seat }, facts => facts.land({ kind: 'done', actor: 'Bob', at: Date.now() }));
  assert.deepEqual((await c.artifact.read(facts => facts.departedSeats())).value.map(seatIdentity), [
    { participant: 'Bob', owner: c.session.owner, generation: c.bob.generation },
  ]);
  const peer = await Square.at({ path: c.square.location, ledgerLocation: c.ledgerLocation });
  t.after(() => peer.close());
  const suppress = DeliveryLedger.prototype.suppressExact;
  const interruption = new Error('ledger suppression interrupted');
  const reject = t.mock.method(DeliveryLedger.prototype, 'suppressExact', async () => { throw interruption; });
  await assert.rejects(peer.join('Alice', { owner: c.alice.seat.owner }), error => error === interruption);
  assert.equal((await c.artifact.read(facts => facts.departedSeats())).value.length, 1);
  reject.mock.restore();
  let newer;
  t.mock.method(DeliveryLedger.prototype, 'suppressExact', async function (owner, keys, signal) {
    await suppress.call(this, owner, keys, signal);
    if (newer) return;
    // A second departure commits after the cleanup snapshot; clearing the first must leave it intact.
    await c.artifact.transactAs({ kind: 'join', participant: 'Bob', owner: c.session.owner }, facts => facts.land({ kind: 'join', actor: 'Bob', at: Date.now() }));
    newer = (await c.artifact.read(facts => facts.seat('Bob'))).value;
    await c.artifact.transactAs({ kind: 'participant', seat: newer }, facts => facts.land({ kind: 'done', actor: 'Bob', at: Date.now() }));
  });
  await reconcileSquareDelivery(peer.resource.artifact, c.location, Date.now, undefined, c.ledgerLocation);
  assert.deepEqual(await c.cards(), []);
  assert.ok(c.suppressions().includes(encodeDeliveryKey(oldKey)));
  assert.equal((await c.ledger.post({ owner: captured.owner, key: c.key(captured), text: captured.body })).status, 'suppressed');
  assert.deepEqual((await c.artifact.read(facts => facts.departedSeats())).value.map(seatIdentity),
    [{ participant: 'Bob', owner: newer.owner, generation: newer.generation }]);
  await c.reconcile();
  assert.deepEqual((await c.artifact.read(facts => facts.departedSeats())).value, []);
});

test('late export settlement refreshes departure cleanup after the ledger snapshot and before claim selection', async t => {
  const c = await fixture(t);
  await c.insert({ body: 'late insertion into old seat' });
  const post = (await c.artifact.read(facts => facts.pendingPosts()[0])).value;
  await c.artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...post, full: true }, 'late-race', process.pid, Date.now()));
  await c.artifact.transactAs({ kind: 'participant', seat: c.bob.seat }, facts => facts.land({ kind: 'done', actor: 'Bob', at: Date.now() }));
  const before = (await c.artifact.read(facts => facts.departedSeats())).value[0];
  const cards = DeliveryLedger.prototype.cards;
  let inserted = false;
  t.mock.method(DeliveryLedger.prototype, 'cards', async function (options, signal) {
    const snapshot = await cards.call(this, options, signal);
    if (options.owner === post.owner && !inserted) {
      inserted = true;
      await c.ledger.post({ owner: post.owner, key: c.key(post), text: post.body });
      await c.artifact.settleAs({ kind: 'producer' }, facts => facts.settlePost('late-race', true, 'uncertain'));
    }
    return snapshot;
  });
  await c.reconcile();
  const refreshed = (await c.artifact.read(facts => facts.departedSeats())).value;
  assert.equal(refreshed.length, 1);
  assert.notEqual(refreshed[0].token, before.token, 'settlement survives a cleanup that captured the old intent');
  assert.equal((await c.cards()).length, 1, 'the late insertion missed the first ledger snapshot');
  await c.reconcile();
  assert.deepEqual(await c.cards(), []);
  assert.deepEqual((await c.artifact.read(facts => facts.departedSeats())).value, []);
  assert.equal((await c.ledger.post({ owner: post.owner, key: c.key(post), text: post.body })).status, 'suppressed');
});

test('cap withdrawal leaves producer activity unread and available to pending and perceive', async t => {
  const c = await fixture(t);
  const activity = (await c.alice.express('oldest card remains unread', { mentions: ['Bob'], force: true })).activity;
  for (let i = 0; i < 200; i++) await c.ledger.post({ owner: c.session.owner, key: [`other:${i}`], text: 'newer notification' });
  assert.deepEqual(await c.cards(), []);
  assert.deepEqual((await c.bob.pending()).activities.map(item => item.id), [activity.id]);
  assert.deepEqual((await c.bob.perceive({ ids: [activity.id] })).activities.map(item => item.id), [activity.id]);
});

test('internal delivery entry points refuse omitted locations before accessing storage; public resources capture resolution once', async t => {
  const c = await fixture(t);
  const open = t.mock.method(DeliveryLedger, 'open', () => { throw new Error('must not open a ledger'); });
  await assert.rejects(ensureInitialDeliverySession('owner'), /resolved absolute/);
  await assert.rejects(reconcileSquareDelivery(undefined, c.location, Date.now), /resolved absolute/);
  await assert.rejects(flushSquarePosts(undefined, c.location, Date.now, undefined, undefined, dispatchPostedCard), /resolved absolute/);
  await assert.rejects(Square.at({ path: c.location, ledgerLocation: 'relative.sqlite' }), /absolute/);
  assert.equal(open.mock.callCount(), 0);
  open.mock.restore();
  const previous = process.env.SQUARE_DELIVERY;
  try {
    process.env.SQUARE_DELIVERY = c.ledgerLocation;
    const resource = await Square.at({ path: c.square.location });
    t.after(() => resource.close());
    process.env.SQUARE_DELIVERY = path.join(path.dirname(c.ledgerLocation), 'later-env.sqlite');
    await resource.send({ from: 'notice', to: 'Bob', body: 'captured ledger location' });
    assert.ok((await c.cards()).length);
    await assert.rejects(fs.access(process.env.SQUARE_DELIVERY), { code: 'ENOENT' });
  } finally { process.env.SQUARE_DELIVERY = previous; }
});

const DAY = 86_400_000;
const seatIdentity = ({ participant, owner, generation }) => ({ participant, owner, generation });
const disposition = ({ kind, index, recipient, owner, generation, consumed }) => ({ kind, index, recipient, owner, generation, consumed });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-live-work-'));
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  const square = await Square.build({ path: path.join(root, 'world.square'), ledgerLocation, markdown: '', clock: () => Date.now() });
  const alice = (await square.join('Alice', { owner: 'live:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'live:bob' })).participant;
  const artifact = square.resource.artifact;
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
    cards: async () => (await Promise.all([alice.seat.owner, bob.seat.owner].map(owner => ledger.cards({ owner, keyPrefix: ['square', location] })))).flat(),
    insert: input => artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => facts.insertNotice({ from: 'notice', to: 'Bob', ...input }, Date.now())),
    reconcile: () => reconcileSquareDelivery(artifact, location, Date.now, undefined, ledgerLocation),
    flush: () => flushSquarePosts(artifact, location, Date.now, undefined, ledgerLocation, dispatchPostedCard),
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
  for (const key of [[...valid.slice(0, 7), '01'], [...valid, 'extra'], [...valid.slice(0, 3), 'Alice', ...valid.slice(4)],
    [...valid.slice(0, 7), '9007199254740992'], ['square', location, 'act', '0', 'recipient', 'alice', 'join', valid[5]], ['another-producer', 'key']])
    assert.equal(parseSquarePostKey(location, key), undefined);
  assert.equal(parseSquarePostKey(location + '/other', valid), undefined);
});

test('gone consumed cards do not recreate suppressions after ledger retention', async t => {
  const c = await fixture(t);
  const sent = (await c.alice.express('consume this card', { mentions: ['Bob'], force: true })).activity;
  const key = (await c.cards())[0].key;
  await c.bob.perceive({ ids: [sent.id] });
  assert.deepEqual(await c.cards(), []);
  assert.ok(c.suppressions().includes(encodeDeliveryKey(key)));
  const future = Date.now() + 31 * DAY;
  t.mock.method(Date, 'now', () => future);
  await c.ledger.post({ owner: c.session.owner, key: ["gc-trigger"], text: 'unrelated producer' });
  assert.equal(c.suppressions().includes(encodeDeliveryKey(key)), false);
  await c.square.join('Bob', { owner: c.session.owner });
  await c.alice.express('no directed audience', { force: true });
  await c.bob.perceive();
  assert.equal(c.suppressions().includes(encodeDeliveryKey(key)), false);
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
  assert.ok((await c.cards()).some(card => deliveryKeyEqual(card.key, liveKey)), 'local ACK leaves ledger maintenance to a privileged operation');
  const claims = (await c.artifact.read(facts => {
    const ids = [parseSquarePostKey(c.location, claimKey)];
    assert.deepEqual(facts.postDispositionsAt(ids), facts.postsAt(ids).map(disposition));
    return facts.withdrawnClaims(Date.now());
  })).value;
  assert.deepEqual(claims, [{ ...disposition(claim), consumed: true }]);
  await c.reconcile();
  assert.deepEqual(await c.cards(), []);
  assert.deepEqual(new Set(c.suppressions()), new Set([liveKey, claimKey].map(key => encodeDeliveryKey(key))));
  assert.equal((await c.ledger.post({ owner: claim.owner, key: claimKey, text: claim.body })).status, 'suppressed');
  assert.equal((await c.artifact.read(facts => facts.withdrawnClaims(Date.now() + 30 * DAY))).value.length, 0);

  // Many cards share one current seat; lookup work is bounded by membership, not card count.
  await c.artifact.transactAs({ kind: 'send', actor: 'notice' }, facts => {
    for (let i = 0; i < 32; i++) facts.insertNotice({ from: 'notice', to: 'Bob', body: `live-${i}` }, Date.now());
  });
  await c.flush();
  const liveKeys = (await c.cards()).map(card => card.key);
  const reads = [], read = c.artifact.read.bind(c.artifact);
  t.mock.method(c.artifact, 'read', (select, signal) => read(facts => {
    const counts = { posts: 0, seat: 0, participant: 0 };
    const value = select(new Proxy(facts, {
      get(target, key) {
        if (key === 'postDispositionsAt') return (...args) => { counts.posts += args[0].length; return target.postDispositionsAt(...args); };
        if (key === 'seat' || key === 'participant') return (...args) => { counts[key]++; return target[key](...args); };
        return target[key];
      },
    }));
    if (counts.posts >= liveKeys.length) {
      const members = facts.roster().length;
      assert.ok(counts.seat <= members && counts.participant <= members, 'withdrawal reads current membership, not each card seat');
      reads.push(counts);
    }
    return value;
  }, signal));
  await c.reconcile();
  assert.deepEqual((await c.cards()).map(card => card.key), liveKeys, 'canonical joined-seat identity keeps live cards');

  // Departure also fences an unconsumed claim, and a never-exported source stays out of a replacement seat.
  await c.insert({ body: 'old seat, captured' });
  const oldSeatClaim = (await c.artifact.read(facts => facts.pendingPosts()[0])).value;
  await c.artifact.transactAs({ kind: 'producer' }, facts => facts.acquirePost({ ...oldSeatClaim, full: true }, 'old-seat', process.pid, Date.now()));
  await c.insert({ body: 'old seat, never exported' });
  await c.bob.done();
  assert.ok(c.suppressions().includes(encodeDeliveryKey(c.key(oldSeatClaim))));
  assert.ok(liveKeys.every(key => c.suppressions().includes(encodeDeliveryKey(key))), 'departure sees fresh membership for every old-generation card');
  assert.ok(reads.length >= 2, 'joined and departed callbacks independently read current membership');
  await c.square.join('Bob', { owner: c.session.owner });
  assert.deepEqual((await c.artifact.read(facts => facts.pendingPosts())).value, []);
  await c.insert({ body: 'replacement seat' });
  await c.flush();
  assert.equal((await c.cards()).length, 1, 'a later transaction retains the replacement generation');
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
      if (key === 'postDispositionsAt') return (...args) => { lookups.push(args[0].length); return target.postDispositionsAt(...args); };
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
  await flushSquarePosts(c.artifact, c.location, () => 0, undefined, c.ledgerLocation, dispatchPostedCard);
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
  for (let i = 0; i < 2; i++) await c.ledger.post({ owner: c.session.owner, key: [`other-producer:${i}`], text: 'collect expired evidence' });
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
  const receiptCalls = [], suppressCalls = [], lookedUp = [], dispositionLookups = [], pendingRows = [];
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
  const read = c.artifact.read.bind(c.artifact), transact = c.artifact.transactAs.bind(c.artifact);
  const observe = facts => new Proxy(facts, {
    get(target, key) {
      if (key === 'postsAt') return (...args) => { lookedUp.push(...args[0]); return target.postsAt(...args); };
      if (key === 'postDispositionsAt') return (...args) => { dispositionLookups.push(...args[0]); return target.postDispositionsAt(...args); };
      if (key === 'pendingPosts') return () => { const rows = target.pendingPosts(); pendingRows.push(...rows); return rows; };
      return target[key];
    },
  });
  t.mock.method(c.artifact, 'read', (select, signal) => read(facts => select(observe(facts)), signal));
  t.mock.method(c.artifact, 'transactAs', (authority, change, signal) => transact(authority, facts => change(observe(facts)), signal));
  await c.bob.perceive({ ids: [`act/${target}`] });
  assert.ok(receiptCalls.length > 0);
  assert.ok(receiptCalls.every(call => call.options?.keys === undefined), 'receipt reads never carry historical artifact key lists');
  const bobReceipts = receiptCalls.find(call => call.owner === c.session.owner).keys;
  assert.deepEqual(bobReceipts.filter(key => parseSquarePostKey(c.location, key)).map(key => parseSquarePostKey(c.location, key).index).sort((a, b) => a - b),
    [Number(full.id.slice(4)), Number(truncated.id.slice(4))]);
  assert.ok(lookedUp.length > 0, 'receipt hydration remains covered');
  assert.ok(dispositionLookups.length > 0, 'live withdrawal uses the narrow read');
  assert.ok([...lookedUp, ...dispositionLookups].every(id => !history.includes(id.index)), 'gone old full cards, even unconsumed ones, are never looked up');
  assert.deepEqual(pendingRows, []);
  assert.deepEqual(new Set(suppressCalls.map(key => encodeDeliveryKey(key))), new Set([ackedKey, targetKey].map(key => encodeDeliveryKey(key))));
  assert.ok((await read(facts => facts.receipt('Bob', Number(full.id.slice(4))))).value);
  assert.equal((await read(facts => facts.receipt('Bob', Number(truncated.id.slice(4))))).value, undefined);
});
