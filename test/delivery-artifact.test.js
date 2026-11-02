import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Square, squareClock } from '../dist/square-api.js';
import { channelArtifact, createArtifactPort } from '../dist/artifact.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { wakePreview } from '../dist/wake-preview.js';
import { presentPending } from '../dist/presentation-operations.js';
import { PaseoWakeTransport } from '../dist/paseo-delivery.js';
import { createDefaultWakeTransport } from '../dist/notifications.js';
import { DeliveryError } from '../dist/packages/agent-delivery/src/index.js';

const empty = () => ({ hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });

async function fixture() {
  const artifact = createArtifactPort(':memory:', empty());
  const alice = "test" + ":" + ('alice'), bob = "test" + ":" + ('bob');
  const aliceSeat = (await artifact.transactAs({ kind: 'join', participant: 'Alice', owner: alice, wakeAddress: { kind: 'paseo', address: { agentId: 'alice' } } }, facts => {
    facts.land({ kind: 'join', actor: 'Alice', at: 1 });
    return facts.seat('Alice');
  })).value;
  const bobSeat = (await artifact.transactAs({ kind: 'join', participant: 'Bob', owner: bob, wakeAddress: { kind: 'paseo', address: { agentId: 'bob' } } }, facts => {
    facts.land({ kind: 'join', actor: 'Bob', at: 2 });
    return facts.seat('Bob');
  })).value;
  const landed = await artifact.transactAs({ kind: 'participant', seat: aliceSeat }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 3, mentions: ['Bob'], body: 'one artifact-owned notice' }));
  return { artifact, alice: aliceSeat, bob: bobSeat, activity: `msg/${landed.value.messageIndex}` };
}

test('file-backed public build and at retain injected delivery transport and commit accepted evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-injected-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'PUBLIC.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const body = "test" + ":" + ('alice');
  const calls = [];
  const wakeTransport = { async attempt(request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    assert.equal(request.participant, 'Bob');
    calls.push(request);
    return { outcome: 'accepted' };
  } };
  const built = await Square.build({ path: location, markdown: 'test', env, wakeTransport });
  const bob = await Square.at({ path: location, env });
  let reopened;
  try {
    await bob.join('Bob', { owner: ':',
      wakeAddress: { kind: 'paseo', address: { agentId: 'no-external-send' } } });
    const alice = (await built.join('Alice', { owner: body })).participant;
    const first = await alice.express('from build', { mentions: ['Bob'], force: true });
    assert.equal(calls.length, 1, 'Square.build must retain the supplied transport');
    assert.deepEqual(Object.keys(calls[0].route).sort(), ['address', 'kind', 'location', 'participant', 'updatedAt']);
    assert.deepEqual(calls[0].route.address, { agentId: 'no-external-send' });
    reopened = await Square.at({ path: location, env, wakeTransport });
    const second = await (await reopened.participant('Alice', { owner: body })).express('from at', { mentions: ['Bob'], force: true });
    assert.equal(calls.length, 2, 'Square.at must retain the supplied transport');
    const artifact = createArtifactPort(location);
    try {
      const evidence = (await artifact.read(facts => facts.deliveryEvidence('Bob', facts.seat('Bob').generation))).value;
      assert.deepEqual(evidence.map(row => [row.message, row.outcome, row.claimToken]),
        calls.map(request => [request.message, 'accepted', request.claimToken]));
      assert.deepEqual(calls.map(request => request.message), ['msg/0', 'msg/1']);
      assert.deepEqual([first.activity.id, second.activity.id], ['act/2', 'act/3']);
    } finally { await artifact.close(); }
  } finally { await reopened?.close(); await built.close(); await bob.close(); }
});

test('known-artifact participation survives an unavailable discovery home and keeps entry-resolved configuration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-entry-dependencies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unavailableHome = path.join(root, 'not-a-directory');
  fs.writeFileSync(unavailableHome, 'discovery cannot write through this file');
  const lateIndex = path.join(root, 'late-index.ndjsonl');
  const env = { ...process.env, HOME: unavailableHome,
    SQUARE_INDEX: path.join(unavailableHome, 'index.ndjsonl'), SQUARE_NOW_MS: '1000' };
  const location = path.join(root, 'KNOWN.square');
  const body = "test" + ":" + ('known');
  const wakeTransport = { async attempt() { assert.fail('no external sends'); } };
  const built = await Square.build({ path: location, markdown: 'known artifact', env, wakeTransport });
  try {
    // Neither discovery nor the clock may be resolved again during participant operations.
    env.SQUARE_INDEX = lateIndex;
    env.SQUARE_NOW_MS = 'not-a-clock';
    const alice = (await built.join('Alice', { owner: body })).participant;
    const expressed = await alice.express('committed despite unavailable HOME', { force: true });
    assert.equal(expressed.activity.at, 1000);
    assert.equal((await built.participant('Alice', { owner: body })).name, 'Alice');
    await alice.done();
    assert.equal(fs.existsSync(lateIndex), false);
  } finally { await built.close(); }
  const reopened = await Square.at({ path: location, wakeTransport,
    env: { ...env, SQUARE_INDEX: path.join(unavailableHome, 'index.ndjsonl'), SQUARE_NOW_MS: '2000' } });
  try {
    const alice = (await reopened.join('Alice', { owner: body })).participant;
    assert.equal((await alice.express('known artifact reconnect', { force: true })).activity.at, 2000);
    assert.deepEqual((await reopened.history()).activities.filter(row => row.kind === 'say').map(row => row.body),
      ['committed despite unavailable HOME', 'known artifact reconnect']);
  } finally { await reopened.close(); }
});

test('delivery claim, final revalidation, send outcome and presentation share only artifact evidence', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const before = (await artifact.read(facts => facts.header())).value;
  const sends = [];
  await deliverPending({ artifact: channelArtifact(artifact), location: '/tmp/one.square', message: activity,
    transport: { async attempt(request, _timeout, gate) {
      assert.equal(request.seat.generation, bob.generation);
      assert.equal(await gate(), true);
      sends.push(request.claimToken);
      return { outcome: 'accepted' };
    } }, now: 4 });
  assert.equal(sends.length, 1);
  const state = (await artifact.read(facts => ({ header: facts.header(), evidence: facts.deliveryEvidence('Bob', bob.generation, activity) }))).value;
  assert.equal(state.header.revision, before.revision);
  assert.ok(state.header.deliveryRevision > before.deliveryRevision);
  assert.deepEqual(state.evidence.map(row => [row.kind, row.outcome, row.claimToken]), [['wake', 'accepted', sends[0]]]);
  let replays = 0;
  await deliverPending({ artifact: channelArtifact(artifact), location: '/tmp/one.square', message: activity,
    transport: { async attempt() { replays++; return { outcome: 'accepted' }; } }, now: 5 });
  assert.equal(replays, 0, 'accepted evidence must prevent replay');

  const presented = await presentPending({ artifact, location: '/tmp/one.square', participant: 'Bob', message: activity,
    seat: bob, observationOf: sends[0], sink: { async present(item) { assert.equal(item.body, 'one artifact-owned notice'); } }, now: 6 });
  assert.equal(presented.presented, true);
  const final = (await artifact.read(facts => ({
    seen: facts.channel.receipt('Bob', Number(activity.slice(4))),
    evidence: facts.deliveryEvidence('Bob', bob.generation, activity),
    revision: facts.header().revision,
  }))).value;
  assert.ok(final.seen);
  assert.equal(final.revision, before.revision + 1);
  assert.deepEqual(final.evidence.map(row => [row.kind, row.outcome]).sort(), [['presentation', 'presented'], ['wake', 'accepted']]);
});

test('transport preparation stays bound to its captured seat and claim', async t => {
  const { artifact, alice, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const other = await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 4, mentions: ['Bob'], body: 'another notice' }));
  const otherMessage = `msg/${other.value.messageIndex}`;
  assert.equal((await artifact.claimDelivery({ seat: bob, message: otherMessage, kind: 'wake', at: 4,
    leaseMs: 10000, claimToken: 'other-claim' })).status, 'acquired');
  let token;
  await deliverPending({ artifact: channelArtifact(artifact), location: '/tmp/one.square', message: activity, now: 4,
    transport: { async attempt(request, _timeout, beforeSend) {
      token = request.claimToken;
      assert.equal(await request.channel.prepare({ correlation: { harness: 'pi', token: 'ordinary' }, coverage: 'full' }), true);
      Object.assign(request.seat, alice);
      assert.equal(await request.channel.prepare({ seat: bob, claimToken: 'other-claim',
        correlation: { harness: 'pi', token: 'bound' }, coverage: 'clipped', description: 'captured' }), true);
      assert.equal(await beforeSend(), true);
      return { outcome: 'accepted' };
    } } });
  const rows = (await artifact.read(facts => ({ bound: facts.deliveryByToken(token), other: facts.deliveryByToken('other-claim') }))).value;
  assert.equal(rows.bound.outcome, 'accepted');
  assert.deepEqual(rows.bound.correlation, { harness: 'pi', token: 'bound' });
  assert.equal(rows.bound.coverage, 'clipped');
  assert.equal(rows.bound.description, 'captured');
  assert.equal(rows.other.outcome, 'dispatching');
  assert.equal(rows.other.correlation, undefined);
});

test('a catch receipt committed before the final send gate suppresses the wake and releases its claim', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  let gateResult;
  let calls = 0;
  await deliverPending({ artifact: channelArtifact(artifact), location: '/tmp/one.square', message: activity,
    transport: { async attempt(request, _timeout, gate) {
      calls += 1;
      await artifact.transactAs({ kind: 'participant', seat: bob }, facts => facts.channel.markSeen('Bob', [Number(activity.slice(4))], 4));
      gateResult = await gate();
      return gateResult ? { outcome: 'accepted' } : { outcome: 'not-capable' };
    } }, now: 4 });
  assert.equal(calls, 1);
  assert.equal(gateResult, false);
  const state = (await artifact.read(facts => ({
    seen: facts.channel.receipt('Bob', Number(activity.slice(4))),
    evidence: facts.deliveryEvidence('Bob', bob.generation, activity),
  }))).value;
  assert.ok(state.seen);
  assert.deepEqual(state.evidence.map(row => [row.kind, row.outcome]), [['wake', 'released']]);
});

test('Paseo asynchronous readiness precedes the final gate; consumed attention releases the claim with zero sends', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  let ready = false, sends = 0;
  const transport = new PaseoWakeTransport({
    discover: () => ({ agents: [{ id: 'bob', status: 'idle' }] }),
    waitForBoundary: async () => {
      await artifact.transactAs({ kind: 'participant', seat: bob }, facts => facts.channel.markSeen('Bob', [0], 4));
      ready = true;
      return true;
    },
    sendWake: async () => { sends += 1; },
  });
  await deliverPending({ artifact: channelArtifact(artifact), preparePresentation: async context => (await artifact.read(facts => wakePreview(facts, context))).value, location: '/tmp/one.square', message: activity, now: 4, transport });
  assert.equal(ready, true);
  assert.equal(sends, 0);
  const rows = (await artifact.read(facts => facts.deliveryEvidence('Bob', bob.generation, activity))).value;
  assert.deepEqual(rows.map(row => [row.kind, row.outcome, row.signature]), [['wake', 'released', 'pre_send_revalidation_failed']]);
});

test('frozen semantic clock cannot freeze Paseo readiness elapsed budget or allow a late send', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const env = { SQUARE_NOW_MS: '100' };
  const semanticClock = squareClock(env);
  let wallNow = 1000, sends = 0, readiness = 0;
  t.mock.method(Date, 'now', () => wallNow);
  const paseo = new PaseoWakeTransport({
    discover: () => ({ agents: [{ id: 'bob', status: 'idle' }] }),
    waitForBoundary: async (_agent, remaining) => {
      readiness += 1;
      assert.equal(remaining, 321);
      await Promise.resolve();
      wallNow += 321;
      assert.equal(semanticClock(), 100);
      return true;
    },
    sendWake: async () => { sends += 1; },
  });
  const transport = await createDefaultWakeTransport(env, { paseo });
  const result = await transport.attempt({ channel: { prepare: async () => true }, presentation: { payload: 'notice', coverage: 'full' }, location: '/tmp/one.square', participant: 'Bob', seat: bob, message: activity,
    route: { kind: 'paseo', address: { agentId: 'bob' } } }, 321, async () => true);
  assert.equal(readiness, 1);
  assert.equal(sends, 0);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.signature, 'dispatch_budget_exhausted');
});

test('real Paseo outcomes retain distinct accepted, pre-accept failure and uncertain-send evidence without consuming', async t => {
  for (const expected of ['accepted', 'failed', 'unknown']) await t.test(expected, async t => {
    const { artifact, bob, activity } = await fixture();
    t.after(() => artifact.close());
    let ready = false, sends = 0;
    const transport = new PaseoWakeTransport({
      discover: () => ({ agents: [{ id: 'bob', status: 'idle' }] }),
      waitForBoundary: async () => { await Promise.resolve(); ready = true; return true; },
      sendWake: async (request) => {
        assert.equal(ready, true);
        assert.equal(request.participant, 'Bob');
        assert.equal(request.message, activity);
        assert.equal(request.attemptN, 0);
        assert.match(request.prompt, /one artifact-owned notice/);
        sends += 1;
        if (expected !== 'accepted') throw new DeliveryError('unavailable', expected === 'unknown');
      },
    });
    await deliverPending({ artifact: channelArtifact(artifact), preparePresentation: async context => (await artifact.read(facts => wakePreview(facts, context))).value, location: '/tmp/one.square', message: activity, now: 4, transport });
    assert.equal(sends, 1);
    const state = (await artifact.read(facts => ({ seen: facts.channel.receipt('Bob', 0), evidence: facts.deliveryEvidence('Bob', bob.generation, activity) }))).value;
    assert.equal(state.seen, undefined, 'wake acceptance is not presentation');
    assert.deepEqual(state.evidence.map(row => [row.kind, row.outcome]), [['wake', expected]]);
    if (expected !== 'failed') {
      await deliverPending({ artifact: channelArtifact(artifact), preparePresentation: async context => (await artifact.read(facts => wakePreview(facts, context))).value, location: '/tmp/one.square', message: activity, now: 5, transport });
      assert.equal(sends, 1, 'accepted and unknown sends are never safe replay');
    }
  });
});


test('dispatcher prepares Agora projection through the narrow callback', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  let context;
  let presentation;
  await deliverPending({ artifact: channelArtifact(artifact), location: '/tmp/one.square', message: activity, now: 4,
    preparePresentation: async captured => {
      context = captured;
      return (await artifact.read(facts => wakePreview(facts, captured))).value;
    },
    transport: { async attempt(request, _timeout, beforeSend) {
      assert.equal(await beforeSend(), true);
      presentation = request.presentation;
      return { outcome: 'accepted' };
    } } });
  assert.deepEqual(Object.keys(context).sort(), ['actor', 'location', 'message', 'participant', 'route', 'seat']);
  assert.deepEqual(context.seat, { participant: bob.participant, owner: bob.owner, generation: bob.generation });
  assert.match(presentation.payload, /one artifact-owned notice/);
  assert.match(presentation.payload, /Alice spoke your name/);
  assert.equal(presentation.coverage, 'full');
});

test('an upper projection veto suppresses transport even while the Channel message remains pending', async t => {
  const { artifact, activity } = await fixture();
  t.after(() => artifact.close());
  const channel = channelArtifact(artifact);
  let projections = 0, sends = 0;
  const transport = { async attempt(request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    assert.match(request.presentation.payload, /one artifact-owned notice/);
    sends++;
    return { outcome: 'accepted' };
  } };
  await deliverPending({ artifact: channel, location: '/tmp/one.square', message: activity, now: 4,
    preparePresentation: async () => { projections++; return undefined; }, transport });
  assert.equal(projections, 1);
  assert.equal(sends, 0);
  await deliverPending({ artifact: channel, location: '/tmp/one.square', message: activity, now: 5, transport });
  assert.equal(sends, 1, 'the raw Channel projection remains deliverable when no callback is supplied');
});

test('dispatcher prepares a Channel projection without Square facts', async t => {
  const { artifact, activity } = await fixture();
  t.after(() => artifact.close());
  const channel = channelArtifact(artifact);
  let presentation;
  await deliverPending({ artifact: channel, location: '/tmp/one.square', message: activity, now: 4,
    transport: { async attempt(request, _timeout, beforeSend) {
      assert.deepEqual(Object.keys(request.channel), ['prepare']);
      assert.equal(await beforeSend(), true);
      presentation = request.presentation;
      return { outcome: 'accepted' };
    } } });
  assert.match(presentation.payload, /one artifact-owned notice/);
  assert.doesNotMatch(presentation.payload, /Alice spoke your name/);
  assert.equal(presentation.coverage, 'full');
});

test('delivery evidence retains claim leases, token scoping and terminal transition conditions', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const input = { seat: bob, message: activity, kind: 'wake', at: 4, leaseMs: 10, claimToken: 'first' };
  assert.equal((await artifact.claimDelivery(input)).status, 'acquired');
  const correlation = { harness: 'pi', token: 'native-first' };
  assert.equal(await artifact.prepareDelivery({ seat: bob, claimToken: 'first', correlation, coverage: 'full' }), true);
  const preparedRevision = await artifact.deliveryRevision();
  assert.equal(await artifact.prepareDelivery({ seat: bob, claimToken: 'first', correlation, coverage: 'full' }), true);
  assert.equal(await artifact.deliveryRevision(), preparedRevision, 'unchanged preparation writes no revision');
  assert.equal((await artifact.claimDelivery({ ...input, at: 5, claimToken: 'busy' })).status, 'busy');
  assert.equal(await artifact.completeDelivery({ ...input, claimToken: 'wrong', outcome: 'accepted' }), false);
  const interrupted = await artifact.claimDelivery({ ...input, at: 14, claimToken: 'expired' });
  assert.equal(interrupted.status, 'terminal');
  assert.equal(interrupted.evidence.outcome, 'unknown');
  assert.equal(interrupted.evidence.diagnostic, 'interrupted dispatch');
  assert.deepEqual(interrupted.evidence.correlation, correlation);
  assert.equal(interrupted.evidence.expiresAt, undefined);
  assert.equal(await artifact.prepareDelivery({ seat: bob, claimToken: 'first', correlation: { harness: 'pi', token: 'late' }, coverage: 'full' }), false);
  assert.equal(await artifact.completeDelivery({ ...input, at: 15, outcome: 'failed' }), false);
  const unknownRevision = await artifact.deliveryRevision();
  assert.equal(await artifact.completeDelivery({ ...input, at: 15, outcome: 'presented' }), false);
  assert.equal(await artifact.deliveryRevision(), unknownRevision);
  assert.equal(await artifact.completeDelivery({ ...input, at: 16, outcome: 'accepted', signature: 'external-ack' }), true);
  const accepted = (await artifact.read(facts => facts.deliveryByToken('first'))).value;
  const acceptedRevision = await artifact.deliveryRevision();
  assert.equal(await artifact.completeDelivery({ ...input, at: 17, outcome: 'accepted', signature: 'must-not-change', diagnostic: 'must-not-change' }), true);
  assert.deepEqual((await artifact.read(facts => facts.deliveryByToken('first'))).value, accepted);
  assert.equal(await artifact.deliveryRevision(), acceptedRevision, 'accepted idempotence does not write payload, time or revision');
  assert.equal((await artifact.claimDelivery({ ...input, at: 18, claimToken: 'no-replay' })).status, 'terminal');
  assert.equal((await artifact.read(facts => facts.deliveryEvidence('Bob', bob.generation, activity))).value.length, 1);

  const presentation = { ...input, kind: 'presentation', observationOf: 'first', at: 20, claimToken: 'presentation' };
  assert.equal((await artifact.claimDelivery(presentation)).status, 'acquired');
  assert.equal(await artifact.completeDelivery({ ...presentation, at: 21, outcome: 'failed' }), true);
  const retry = await artifact.claimDelivery({ ...presentation, at: 22, claimToken: 'retry' });
  assert.equal(retry.status, 'acquired');
  assert.equal(retry.attemptN, 1);
  assert.equal(await artifact.completeDelivery({ ...presentation, at: 23, outcome: 'presented' }), false);
  assert.equal(await artifact.completeDelivery({ ...presentation, claimToken: 'retry', at: 24, outcome: 'presented' }), true);
});

test('wake revalidates the captured seat after asynchronous takeover and refuses stale completion', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  let sent = false;
  let oldToken;
  await deliverPending({ artifact: channelArtifact(artifact), location: '/tmp/one.square', message: activity, now: 4,
    transport: { async attempt(request, _timeout, beforeSend) {
      oldToken = request.claimToken;
      await artifact.transactAs({ kind: 'takeover', participant: 'Bob', owner: 'test:bob-replacement', expectedGeneration: bob.generation }, facts => {
        facts.land({ kind: 'done', actor: 'Bob', at: 5 });
        facts.land({ kind: 'join', actor: 'Bob', at: 6 });
      });
      sent = await beforeSend();
      return sent ? { outcome: 'accepted' } : { outcome: 'not-capable' };
    } } });
  assert.equal(sent, false);
  await assert.rejects(artifact.completeDelivery({ seat: bob, message: activity, claimToken: oldToken, at: 7, outcome: 'accepted' }),
    error => error.code === 'already_joined');
  assert.equal((await artifact.read(facts => facts.deliveryByToken(oldToken))).value.outcome, 'dispatching');
  assert.notEqual((await artifact.read(facts => facts.seat('Bob'))).value.generation, bob.generation);
});

test('presentation consumes only the captured seat generation', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const result = await presentPending({ artifact, location: '/tmp/one.square', participant: 'Bob', message: activity,
    seat: bob, sink: { async present() {
      await artifact.transactAs({ kind: 'takeover', participant: 'Bob', owner: ':', expectedGeneration: bob.generation }, facts => {
        facts.land({ kind: 'done', actor: 'Bob', at: 4 });
        facts.land({ kind: 'join', actor: 'Bob', at: 5 });
      });
    } }, now: 6 });
  assert.equal(result.presented, false);
  const state = (await artifact.read(facts => ({
    receipt: facts.channel.receipt('Bob', Number(activity.slice(4))),
    replacement: facts.seat('Bob'),
    evidence: facts.deliveryEvidence('Bob', bob.generation, activity),
  }))).value;
  assert.equal(state.receipt, undefined);
  assert.notEqual(state.replacement.generation, bob.generation);
  assert.equal(state.evidence[0].outcome, 'dispatching');
});

/** Counts what one delivery actually reads: body hydration and per-recipient directed history. */
function countingArtifact(artifact) {
  const counters = { hydrated: [], directedRecipients: [] };
  return {
    counters,
    port: {
      ...artifact,
      read: (select, signal) => artifact.read((facts) => select(Object.assign({}, facts, {
        channel: Object.assign({}, facts.channel, {
          directed: (recipient, filter, page) => { counters.directedRecipients.push(recipient); return facts.channel.directed(recipient, filter, page); },
        }),
        activities: (indexes) => { counters.hydrated.push([...indexes]); return facts.activities(indexes); },
        directed: (recipient, filter, page) => { counters.directedRecipients.push(recipient); return facts.directed(recipient, filter, page); },
        directedAt: (recipient, index) => { counters.directedRecipients.push(recipient); return facts.directedAt(recipient, index); },
      })), signal),
    },
  };
}

test('one requested activity wakes its landed audience without hydrating other unread history', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const bodyOf = (name) => ("test" + ":" + (name.toLowerCase()));
  const wake = (agentId) => ({ kind: 'paseo', address: { agentId } });
  const join = (name, at, wakeAddress) => artifact.transactAs({ kind: 'join', participant: name, owner: bodyOf(name), wakeAddress }, (facts) => {
    facts.land({ kind: 'join', actor: name, at });
    return facts.seat(name);
  }).then(({ value }) => value);
  const alice = await join('Alice', 1, wake('alice'));
  const bob = await join('Bob', 2, wake('bob'));
  const carol = await join('Carol', 3, wake('carol'));
  const others = [];
  for (let index = 0; index < 24; index += 1) others.push(await join(`Other${index}`, 4 + index, wake(`other${index}`)));
  await artifact.transactAs({ kind: 'participant', seat: alice }, (facts) => {
    for (let round = 0; round < 20; round += 1) {
      for (const { participant } of others) {
        facts.land({ kind: 'say', actor: 'Alice', at: 100 + round, body: `unread ${round} for ${participant}`, mentions: [participant] });
      }
    }
  });
  const caught = await artifact.transactAs({ kind: 'participant', seat: alice }, (facts) =>
    facts.land({ kind: 'say', actor: 'Alice', at: 200, body: 'caught before delivery', mentions: ['Bob'] }));
  await artifact.transactAs({ kind: 'participant', seat: bob }, (facts) => facts.channel.markSeen('Bob', [caught.value.messageIndex], 201));
  const beforeRejoin = await artifact.transactAs({ kind: 'participant', seat: alice }, (facts) =>
    facts.land({ kind: 'say', actor: 'Alice', at: 202, body: 'landed before the rejoin', mentions: ['Carol'] }));
  await artifact.transactAs({ kind: 'takeover', participant: 'Carol', owner: bodyOf('carol-rejoined'), expectedGeneration: carol.generation }, (facts) => {
    facts.land({ kind: 'done', actor: 'Carol', at: 203 });
    facts.land({ kind: 'join', actor: 'Carol', at: 204 });
  });
  const delivery = await artifact.transactAs({ kind: 'participant', seat: alice }, (facts) =>
    facts.land({ kind: 'say', actor: 'Alice', at: 205, body: 'the only delivery', mentions: ['Bob'] }));

  const { counters, port } = countingArtifact(artifact);
  const deliver = (message, attempt) => deliverPending({ artifact: channelArtifact(port), location: '/tmp/one.square', message, transport: { attempt }, now: 300 });
  let excludedSends = 0;
  const noWake = async () => { excludedSends++; return { outcome: 'accepted' }; };
  await deliver(`msg/${caught.value.messageIndex}`, noWake);
  await deliver(`msg/${beforeRejoin.value.messageIndex}`, noWake);
  assert.equal(excludedSends, 0, 'caught activity and replaced seat generation cannot wake');
  const sends = [];
  await deliver(`msg/${delivery.value.messageIndex}`, async (request, _timeout, gate) => {
    assert.equal(await gate(), true);
    sends.push(request.participant);
    return { outcome: 'accepted' };
  });
  assert.deepEqual(sends, ['Bob']);
  assert.deepEqual(counters.hydrated, [], 'a requested delivery must never hydrate activity bodies');
  assert.deepEqual([...new Set(counters.directedRecipients)], ['Bob'], 'only the landed audience is consulted');
});
