import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { deliverPending, sweepPending } from '../dist/delivery-operations.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { presentPending } from '../dist/presentation-operations.js';
import { observeSessionPending, sessionInbox, nativePendingPreview, projectBoundaryEligibility } from '../dist/inbox.js';
import { matchesMetadata, validateMetadataMatch, MAX_DELIVERY_DEFERRAL_MS } from '../dist/delivery-deferral.js';

const match = { fields: [{ path: ['job', 'kind'], equals: 'outcome' }, { path: ['job', 'id'], equals: 7 }] };
const metadata = { job: { kind: 'outcome', id: 7 } };
const invalid = error => error.code === 'invalid_args';
const replaced = error => error.code === 'already_joined';

async function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-deferral-'));
  const location = path.join(root, 'test.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl'), SQUARE_NOW_MS: undefined };
  const resources = [];
  t.after(async () => { for (const resource of resources) await resource.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = async (name, options = {}) => {
    const square = await Square.at({ path: location, env, body: { channel: 'pi', session: name }, ...options });
    resources.push(square);
    return square;
  };
  const square = await Square.build({ path: location, env, markdown: 'Deferral tests', body: { channel: 'pi', session: 'Alice' },
    wakeTransport: { probe: async () => false, attempt: () => assert.fail('fixture must never perform I/O') }, ...extra });
  resources.push(square);
  const alice = (await square.join('Alice')).participant;
  const receiver = await open('Bob', { wakeAddress: { kind: 'paseo', address: { agentId: 'bob' } }, ...extra });
  const bob = (await receiver.join('Bob')).participant;
  const artifact = createArtifactPort(location);
  resources.push(artifact);
  const seat = (await artifact.read(facts => facts.seat('Bob'))).value;
  const say = async (value = metadata, mentions = ['Bob']) => (await alice.express({ body: 'ready', metadata: value, mentions, force: true })).activity;
  return { root, location, env, square, alice, receiver, bob, artifact, seat, say, open };
}

function armed(observer, timeoutMs = 2000, options = {}) {
  let ready;
  const armed = new Promise(resolve => { ready = resolve; });
  const result = observer.wait(timeoutMs, { ...options, onChangeArmed: ready });
  return { armed, result };
}

test('nested matching is exact scalar AND over object own properties, not an array or query language', () => {
  const validated = validateMetadataMatch(match);
  assert.equal(matchesMetadata(metadata, validated), true);
  for (const value of [undefined, {}, { job: null }, { job: [] }, { job: { kind: 'outcome', id: '7' } }, { job: { kind: 'other', id: 7 } }])
    assert.equal(matchesMetadata(value, validated), false);
  assert.equal(matchesMetadata(Object.create(metadata), validated), false);
  assert.equal(matchesMetadata({ 'job.id': 7 }, { fields: [{ path: ['job.id'], equals: 7 }] }), true);
  assert.equal(matchesMetadata({ 'job.id': 7 }, { fields: [{ path: ['job', 'id'], equals: 7 }] }), false);
  assert.equal(matchesMetadata({ x: [7] }, { fields: [{ path: ['x', '0'], equals: 7 }] }), false);
  for (const equals of [null, false, true, 0, '']) {
    assert.equal(matchesMetadata({ x: equals }, { fields: [{ path: ['x'], equals }] }), true);
    assert.equal(matchesMetadata({}, { fields: [{ path: ['x'], equals }] }), false);
  }
  for (const value of [null, {}, { fields: [] }, { fields: Array(1) }, { fields: [{ path: [], equals: 1 }] },
    { fields: [{ path: [''], equals: 1 }] }, { fields: [{ path: Array(1), equals: 1 }] },
    { fields: [{ path: ['x'], equals: undefined }] }, { fields: [{ path: ['x'], equals: NaN }] },
    { fields: [{ path: ['x'], equals: Infinity }] }, { fields: [{ path: ['x'], equals: {} }] },
    { fields: [{ path: ['x'], equals: [] }] }, { fields: [{ path: ['x'], equals: 1 }, { path: ['x'], equals: 2 }] }])
    assert.throws(() => validateMetadataMatch(value), invalid);
});

test('local leases are independent, operation-clock bounded, delivery-only state with exact expiry', async t => {
  let now = 1000;
  const f = await fixture(t, { clock: () => now });
  const initial = (await f.artifact.read(facts => facts.header())).value;
  const one = await f.bob.deferDelivery({ match, durationMs: 100 });
  const two = await f.bob.deferDelivery({ match, durationMs: Number.MAX_SAFE_INTEGER });
  assert.notEqual(one.id, two.id);
  assert.deepEqual(Object.keys(one).sort(), ['expiresAt', 'id']);
  assert.equal(Date.parse(one.expiresAt), 1100);
  assert.equal(Date.parse(two.expiresAt), now + MAX_DELIVERY_DEFERRAL_MS);
  const created = (await f.artifact.read(facts => ({ header: facts.header(), leases: facts.deliveryDeferrals('Bob', f.seat.generation), lease: facts.lease('Bob') }))).value;
  assert.equal(created.header.revision, initial.revision);
  assert.equal(created.header.nextActIndex, initial.nextActIndex);
  assert.equal(created.header.deliveryRevision, initial.deliveryRevision + 2);
  assert.equal(created.leases.length, 2);
  assert.equal(created.lease, undefined);
  for (const durationMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.bob.deferDelivery({ match, durationMs }), invalid);
  await assert.rejects(f.bob.releaseDeliveryDeferral('not-an-id'), invalid);
  await assert.rejects(f.bob.renewDeliveryDeferral(one.id, 0), invalid);
  now = 1050;
  assert.equal(Date.parse((await f.bob.renewDeliveryDeferral(one.id, 200)).expiresAt), 1250);
  assert.equal(await f.bob.releaseDeliveryDeferral(two.id), true);
  assert.equal(await f.bob.releaseDeliveryDeferral(two.id), false);
  now = 1250;
  assert.equal(await f.bob.renewDeliveryDeferral(one.id, 10), null);
  assert.equal(await f.bob.releaseDeliveryDeferral(one.id), false);
  assert.equal(await f.bob.renewDeliveryDeferral(randomUUID(), 10), null);
  assert.equal((await f.artifact.read(facts => facts.header())).value.revision, initial.revision);
});

test('memory and persisted handles require captured current ownership, never a name or retired generation', async t => {
  const memory = Square.inMemory({ markdown: 'memory', body: { channel: 'test', session: 'one' }, clock: () => 1000 });
  t.after(() => memory.close());
  const old = (await memory.join('Local')).participant;
  const lease = await old.deferDelivery({ match, durationMs: 100 });
  await old.done();
  const fresh = (await memory.join('Local')).participant;
  for (const work of [() => old.deferDelivery({ match, durationMs: 100 }), () => old.renewDeliveryDeferral(lease.id, 100), () => old.releaseDeliveryDeferral(lease.id)])
    await assert.rejects(work(), replaced);
  assert.equal(await fresh.renewDeliveryDeferral(lease.id, 100), null);
  const f = await fixture(t);
  const saved = await f.bob.deferDelivery({ match, durationMs: 10000 });
  const reconnected = await f.open('Bob');
  assert.equal(await (await reconnected.participant('Bob')).renewDeliveryDeferral(saved.id, 10000) !== null, true);
  const foreign = await f.open('Other');
  await assert.rejects((await foreign.participant('Bob')).releaseDeliveryDeferral(saved.id), replaced);
  const thief = (await foreign.join('Bob', { takeover: true })).participant;
  await assert.rejects(f.bob.renewDeliveryDeferral(saved.id, 10000), replaced);
  assert.equal(await thief.releaseDeliveryDeferral(saved.id), false);
  assert.deepEqual((await f.artifact.read(facts => facts.deliveryDeferrals('Bob', f.seat.generation))).value, []);
});

test('producer, sweep and session projection suppress OR leases without consumption; catch remains explicit', async t => {
  const f = await fixture(t);
  const one = await f.bob.deferDelivery({ match, durationMs: 10000 });
  const two = await f.bob.deferDelivery({ match, durationMs: 10000 });
  const activity = await f.say();
  let sends = 0;
  const input = { artifact: f.artifact, location: f.location, transport: { attempt: async (_request, _timeout, beforeSend) => {
    assert.equal(await beforeSend(), true); sends++; return { outcome: 'accepted' };
  } } };
  assert.equal((await deliverPending(input)).attempted, 0);
  assert.deepEqual(await sweepPending({ ...input, now: Date.now(), graceMs: -1, limit: 10 }), []);
  assert.deepEqual((await sessionInbox(f.seat.body, f.env)).flatMap(member => member.notifications), []);
  assert.equal((await f.receiver.status()).participants.find(person => person.name === 'Bob').unreadActivityCount, 1);
  assert.equal((await f.receiver.history()).activities.some(item => item.id === activity.id), true);
  assert.equal((await f.artifact.read(facts => facts.receipt('Bob', Number(activity.id.slice(4))))).value, undefined);
  await f.bob.releaseDeliveryDeferral(one.id);
  assert.equal((await deliverPending(input)).attempted, 0);
  await f.bob.releaseDeliveryDeferral(two.id);
  assert.equal((await deliverPending(input)).accepted, 1);
  assert.equal(sends, 1);
  const nextLease = await f.bob.deferDelivery({ match, durationMs: 10000 });
  const next = await f.say();
  assert.deepEqual((await f.bob.catch({ id: next.id })).activities.map(item => item.id), [next.id]);
  await f.bob.releaseDeliveryDeferral(nextLease.id);
  await deliverPending(input);
  assert.equal(sends, 1, 'explicit consumption prevents a later replay');
  const unmatchedLease = await f.bob.deferDelivery({ match, durationMs: 10000 });
  await f.say({ job: { kind: 'other', id: 7 } });
  assert.equal((await deliverPending(input)).accepted, 1, 'nonmatching metadata remains eligible');
  await f.bob.releaseDeliveryDeferral(unmatchedLease.id);
});

test('atomic claims and final transport checks stop races, while already dispatched sends are not recalled', async t => {
  const f = await fixture(t);
  const activity = await f.say();
  let lease;
  const claimedRace = await deliverPending({ artifact: f.artifact, location: f.location, transport: {
    probe: async () => { lease = await f.bob.deferDelivery({ match, durationMs: 10000 }); return true; },
    attempt: async () => { assert.fail('claim must recheck deferral'); },
  } });
  assert.equal(claimedRace.attempted, 0);
  assert.deepEqual((await f.artifact.read(facts => facts.deliveryEvidence('Bob', f.seat.generation))).value, []);
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.equal((await deliverPending({ artifact: f.artifact, location: f.location, transport: {
    attempt: async (_request, _timeout, beforeSend) => {
      lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
      assert.equal(await beforeSend(), false);
      return { outcome: 'accepted' }; // a refused pre-send gate is not an accepted send
    },
  } })).attempted, 0);
  assert.equal((await f.artifact.read(facts => facts.deliveryEvidence('Bob', f.seat.generation))).value.every(row => row.outcome === 'released'), true);
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.equal((await deliverPending({ artifact: f.artifact, location: f.location, transport: {
    attempt: async (_request, _timeout, beforeSend) => {
      assert.equal(await beforeSend(), true);
      // The external send is already past its last gate when this lease commits.
      lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
      return { outcome: 'accepted' };
    },
  } })).accepted, 1);
  assert.equal((await f.artifact.read(facts => facts.receipt('Bob', Number(activity.id.slice(4))))).value, undefined);
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.equal((await deliverPending({ artifact: f.artifact, location: f.location, transport: { attempt: () => assert.fail('no replay') } })).attempted, 0);
});

test('presentation suppresses before the sink but retains successful post-sink evidence without replay', async t => {
  const f = await fixture(t);
  const activity = await f.say();
  let writes = 0;
  const input = { artifact: f.artifact, location: f.location, participant: 'Bob', activity: activity.id, seat: f.seat,
    sink: { present: () => { writes++; } } };
  const batch = await sessionInbox(f.seat.body, f.env);
  let lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
  assert.deepEqual(await projectBoundaryEligibility(batch), []);
  assert.equal((await presentPending(input)).presented, false);
  assert.equal(writes, 0);
  await f.bob.releaseDeliveryDeferral(lease.id);
  const racingArtifact = { ...f.artifact, claimDelivery: async (...args) => {
    const claim = await f.artifact.claimDelivery(...args);
    lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
    return claim;
  } };
  assert.equal((await presentPending({ ...input, artifact: racingArtifact })).presented, false);
  assert.equal(writes, 0);
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.equal((await presentPending({ ...input, sink: { present: async () => {
    writes++;
    lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
  } } })).presented, true);
  assert.equal(writes, 1, 'an already-dispatched sink effect is not recalled');
  assert.ok((await f.artifact.read(facts => facts.receipt('Bob', Number(activity.id.slice(4))))).value);
  const evidence = (await f.artifact.read(facts => facts.deliveryEvidence('Bob', f.seat.generation))).value;
  assert.equal(evidence.filter(row => row.outcome === 'presented').length, 1);
  assert.equal(evidence.some(row => row.outcome === 'dispatching'), false);
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.equal((await presentPending(input)).presented, false);
  assert.equal(writes, 1, 'lease release cannot replay an already successful sink');
  assert.equal((await deliverPending({ artifact: f.artifact, location: f.location,
    transport: { attempt: () => assert.fail('a successful presentation must prevent wake replay') },
  })).attempted, 0);
});

test('every item in a successful batch retains truthful receipts despite post-sink deferrals', async t => {
  const f = await fixture(t);
  const cara = (await f.receiver.join('Cara')).participant;
  const first = await f.say(metadata, ['Bob', 'Cara']);
  const second = await f.say(metadata, ['Bob', 'Cara']);
  let sends = 0;
  const leases = [];
  const output = await presentPendingAtBoundary(f.seat.body, async context => {
    sends++;
    for (const activity of [first, second]) assert.match(context, new RegExp(activity.id));
    leases.push(await f.bob.deferDelivery({ match, durationMs: 10000 }));
    leases.push(await cara.deferDelivery({ match, durationMs: 10000 }));
    return context;
  }, sessionInbox, f.env);
  assert.ok(output);
  for (const participant of ['Bob', 'Cara']) {
    const recorded = (await f.artifact.read(facts => {
      const seat = facts.seat(participant);
      return { receipts: [first, second].map(activity => facts.receipt(participant, Number(activity.id.slice(4)))),
        evidence: facts.deliveryEvidence(participant, seat.generation).filter(row => row.kind === 'presentation') };
    })).value;
    assert.equal(recorded.receipts.every(Boolean), true, 'later batch items were already rendered, not fresh attempts');
    assert.deepEqual(recorded.evidence.map(row => row.outcome), ['presented', 'presented']);
  }
  await f.bob.releaseDeliveryDeferral(leases[0].id);
  await cara.releaseDeliveryDeferral(leases[1].id);
  assert.equal(await presentPendingAtBoundary(f.seat.body, () => { sends++; }, sessionInbox, f.env), undefined);
  assert.equal(sends, 1, 'post-sink deferral release never repeats the batch');
});

test('a successful single sink settles despite cancellation of both operation and artifact work', async t => {
  for (const captured of [false, true]) await t.test(captured ? 'artifact captures the signal' : 'operation signal only', async t => {
    const f = await fixture(t);
    const activity = await f.say();
    const controller = new AbortController();
    const artifact = captured ? createArtifactPort(f.location, undefined, controller.signal) : f.artifact;
    if (captured) t.after(() => artifact.close());
    let effects = 0;
    const result = await presentPending({ artifact, location: f.location, participant: 'Bob', activity: activity.id,
      seat: f.seat, signal: controller.signal, sink: { present() { effects++; controller.abort(new Error('after success')); } } });
    assert.equal(result.presented, true);
    assert.equal(effects, 1);
    const state = (await f.artifact.read(facts => ({
      receipt: facts.receipt('Bob', Number(activity.id.slice(4))),
      evidence: facts.deliveryEvidence('Bob', f.seat.generation).map(row => row.outcome),
    }))).value;
    assert.ok(state.receipt);
    assert.deepEqual(state.evidence, ['presented']);
    assert.equal((await presentPending({ artifact: f.artifact, location: f.location, participant: 'Bob', activity: activity.id,
      sink: { present() { assert.fail('successful effect must not replay'); } } })).presented, false);
  });
});

test('pre-sink cancellation and rejected sinks release custody without a success receipt', async t => {
  for (const phase of ['before', 'rejected']) await t.test(phase, async t => {
    const f = await fixture(t);
    const activity = await f.say();
    const controller = new AbortController();
    const artifact = createArtifactPort(f.location, undefined, controller.signal);
    t.after(() => artifact.close());
    const cancelled = new Error('cancelled presentation');
    let reads = 0;
    const input = { artifact: phase === 'before' ? { ...artifact, read: async (...args) => {
      const result = await artifact.read(...args);
      if (++reads === 2) controller.abort(cancelled); // final eligibility read succeeded, sink has not run
      return result;
    } } : artifact, location: f.location, participant: 'Bob', activity: activity.id, seat: f.seat, signal: controller.signal,
    sink: { present() {
      assert.equal(phase, 'rejected', 'cancellation before the sink must suppress the effect');
      controller.abort(cancelled);
      throw cancelled;
    } } };
    if (phase === 'before') assert.equal((await presentPending(input)).presented, false);
    else await assert.rejects(presentPending(input), error => error === cancelled);
    const state = (await f.artifact.read(facts => ({
      receipt: facts.receipt('Bob', Number(activity.id.slice(4))),
      evidence: facts.deliveryEvidence('Bob', f.seat.generation).map(row => row.outcome),
    }))).value;
    assert.equal(state.receipt, undefined);
    assert.deepEqual(state.evidence, [phase === 'before' ? 'released' : 'failed']);
  });
});

test('a successful batch settles every rendered item after cancellation without replay', async t => {
  const f = await fixture(t);
  await f.receiver.join('Cara');
  const activities = [await f.say(metadata, ['Bob', 'Cara']), await f.say(metadata, ['Bob', 'Cara'])];
  const controller = new AbortController();
  let effects = 0;
  const result = await presentPendingAtBoundary(f.seat.body, context => {
    effects++;
    for (const activity of activities) assert.match(context, new RegExp(activity.id));
    controller.abort(new Error('cancel after batch success'));
    return 'landed';
  }, sessionInbox, f.env, controller.signal);
  assert.equal(result, 'landed');
  assert.equal(effects, 1);
  for (const participant of ['Bob', 'Cara']) {
    const state = (await f.artifact.read(facts => ({
      receipts: activities.map(activity => facts.receipt(participant, Number(activity.id.slice(4)))),
      evidence: facts.deliveryEvidence(participant, facts.seat(participant).generation).map(row => row.outcome),
    }))).value;
    assert.equal(state.receipts.every(Boolean), true);
    assert.deepEqual(state.evidence, ['presented', 'presented']);
  }
  assert.equal(await presentPendingAtBoundary(f.seat.body, () => assert.fail('batch must not replay'), sessionInbox, f.env), undefined);
});

test('a rejected batch sink leaves every rendered item unconsumed, even when cancelled', async t => {
  const f = await fixture(t);
  const activities = [await f.say(), await f.say()];
  const controller = new AbortController();
  const rejected = new Error('batch did not land');
  await assert.rejects(presentPendingAtBoundary(f.seat.body, () => {
    controller.abort(rejected);
    throw rejected;
  }, sessionInbox, f.env, controller.signal), error => error === rejected);
  const state = (await f.artifact.read(facts => ({
    receipts: activities.map(activity => facts.receipt('Bob', Number(activity.id.slice(4)))),
    evidence: facts.deliveryEvidence('Bob', f.seat.generation).map(row => row.outcome),
  }))).value;
  assert.equal(state.receipts.every(receipt => receipt === undefined), true);
  assert.deepEqual(state.evidence, ['failed', 'failed']);
});

test('a final batch sink excludes a newly deferred peer item and receipts only the rendered items', async t => {
  const f = await fixture(t);
  const ordinary = (await f.alice.express({ body: 'ordinary batch item', metadata: { job: { kind: 'other' } }, mentions: ['Bob'], force: true })).activity;
  const protectedItem = (await f.alice.express({ body: 'protected batch item', metadata, mentions: ['Bob'], force: true })).activity;
  const batch = await sessionInbox(f.seat.body, f.env);
  let acquiring;
  const first = batch[0].notifications[0];
  const body = first.body;
  // Start acquisition after initial eligibility projection, while preparing the first batch.
  Object.defineProperty(first, 'body', { get() {
    acquiring ??= f.bob.deferDelivery({ match, durationMs: 10000 });
    return body;
  } });
  const rendered = await presentPendingAtBoundary(f.seat.body, async context => {
    await acquiring;
    return context;
  }, () => batch, f.env);
  assert.match(rendered, /ordinary batch item/);
  assert.doesNotMatch(rendered, /protected batch item/);
  const receipts = (await f.artifact.read(facts => ({
    ordinary: facts.receipt('Bob', Number(ordinary.id.slice(4))), protected: facts.receipt('Bob', Number(protectedItem.id.slice(4))),
  }))).value;
  assert.ok(receipts.ordinary);
  assert.equal(receipts.protected, undefined);
});

test('a matching lease affects only its recipient, not other current recipients', async t => {
  const f = await fixture(t);
  const caraSquare = await f.open('Cara', { wakeAddress: { kind: 'paseo', address: { agentId: 'cara' } } });
  await caraSquare.join('Cara');
  await f.bob.deferDelivery({ match, durationMs: 10000 });
  await f.say(metadata, ['Bob', 'Cara']);
  const recipients = [];
  await deliverPending({ artifact: f.artifact, location: f.location, transport: {
    attempt: async (request, _timeout, beforeSend) => {
      assert.equal(await beforeSend(), true);
      recipients.push(request.participant);
      return { outcome: 'accepted' };
    },
  } });
  assert.deepEqual(recipients, ['Cara']);
});

test('native previews for both native addresses revalidate current-generation deferrals', async t => {
  const f = await fixture(t);
  const activity = await f.say();
  const lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
  for (const [routeKind, address] of [['claude-native', { endpoint: '/tmp/unused-deferral-test.sock' }], ['opencode-server', { sessionId: 'Bob' }]]) {
    await f.artifact.transactAs({ kind: 'participant', seat: f.seat }, facts => facts.updateWakeAddress(f.seat, { kind: routeKind, address }));
    const input = { location: f.location, participant: 'Bob', sessionId: 'Bob', actIndex: Number(activity.id.slice(4)), now: Date.now(), routeKind, address };
    assert.equal((await f.artifact.read(facts => nativePendingPreview(facts, input))).value, undefined);
  }
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.ok((await f.artifact.read(facts => nativePendingPreview(facts, { location: f.location, participant: 'Bob', sessionId: 'Bob',
    actIndex: Number(activity.id.slice(4)), now: Date.now(), routeKind: 'opencode-server', address: { sessionId: 'Bob' } }))).value);
});

test('active observers restore eligibility on release without another conversation activity', async t => {
  const f = await fixture(t);
  const lease = await f.bob.deferDelivery({ match, durationMs: 10000 });
  const activity = await f.say();
  const observer = await observeSessionPending(f.seat.body, f.env);
  t.after(() => observer.close());
  assert.deepEqual(await observer.read(), []);
  const waiting = armed(observer);
  assert.equal(await waiting.armed, true);
  await f.bob.releaseDeliveryDeferral(lease.id);
  assert.equal((await waiting.result)[0].notifications[0].actIndex, Number(activity.id.slice(4)));
});

test('active observer expiry follows renewal while a one-shot producer never sleeps for that expiry', async t => {
  const f = await fixture(t);
  const lease = await f.bob.deferDelivery({ match, durationMs: 250 });
  const activity = await f.say();
  const observer = await observeSessionPending(f.seat.body, f.env);
  t.after(() => observer.close());
  const waiting = armed(observer);
  assert.equal(await waiting.armed, true);
  const renewed = await f.bob.renewDeliveryDeferral(lease.id, 400);
  assert.ok(renewed);
  const result = await deliverPending({ artifact: f.artifact, location: f.location, transport: { attempt: () => assert.fail('deferred producer') } });
  assert.equal(result.attempted, 0);
  assert.ok(Date.now() < Date.parse(renewed.expiresAt), 'producer returns while the lease is still live');
  const eligible = await waiting.result;
  assert.equal(eligible[0].notifications[0].actIndex, Number(activity.id.slice(4)));
  assert.ok(Date.now() >= Date.parse(renewed.expiresAt), 'renewal moves the observer deadline');
});
