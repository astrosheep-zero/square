import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Square, squareClock } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { presentPending } from '../dist/presentation-operations.js';
import { PaseoWakeTransport } from '../dist/paseo-delivery.js';
import { createDefaultWakeTransport } from '../dist/notifications.js';
import { DeliveryError } from '../dist/packages/agent-delivery/src/index.js';

const empty = () => ({ hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });

async function fixture() {
  const artifact = createArtifactPort(':memory:', empty());
  const alice = { channel: 'test', session: 'alice' }, bob = { channel: 'test', session: 'bob' };
  const aliceSeat = (await artifact.transactAs({ kind: 'join', participant: 'Alice', body: alice, wakeAddress: { kind: 'paseo', address: { agentId: 'alice' } } }, facts => {
    facts.land({ kind: 'join', actor: 'Alice', at: 1 });
    return facts.seat('Alice');
  })).value;
  const bobSeat = (await artifact.transactAs({ kind: 'join', participant: 'Bob', body: bob, wakeAddress: { kind: 'paseo', address: { agentId: 'bob' } } }, facts => {
    facts.land({ kind: 'join', actor: 'Bob', at: 2 });
    return facts.seat('Bob');
  })).value;
  const landed = await artifact.transactAs({ kind: 'participant', seat: aliceSeat }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 3, mentions: ['Bob'], body: 'one artifact-owned notice' }));
  return { artifact, alice: aliceSeat, bob: bobSeat, activity: `act/${landed.value.index}` };
}

test('file-backed public build and at retain injected delivery transport and commit accepted evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-injected-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const location = path.join(root, 'PUBLIC.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const body = { channel: 'test', session: 'alice' };
  const calls = [];
  const wakeTransport = { async attempt(request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    assert.equal(request.participant, 'Bob');
    calls.push(request);
    return { outcome: 'accepted' };
  } };
  const built = await Square.build({ path: location, markdown: 'test', body, env, wakeTransport });
  const bob = await Square.at({ path: location, env, body: { channel: 'test', session: 'bob' },
    wakeAddress: { kind: 'paseo', address: { agentId: 'no-external-send' } } });
  let reopened;
  try {
    await bob.join('Bob');
    const alice = (await built.join('Alice')).participant;
    const first = await alice.express('from build', { mentions: ['Bob'], force: true });
    assert.equal(calls.length, 1, 'Square.build must retain the supplied transport');
    assert.deepEqual(Object.keys(calls[0].route).sort(), ['address', 'kind', 'location', 'participant', 'updatedAt']);
    assert.deepEqual(calls[0].route.address, { agentId: 'no-external-send' });
    reopened = await Square.at({ path: location, body, env, wakeTransport });
    const second = await (await reopened.participant()).express('from at', { mentions: ['Bob'], force: true });
    assert.equal(calls.length, 2, 'Square.at must retain the supplied transport');
    const artifact = createArtifactPort(location);
    try {
      const evidence = (await artifact.read(facts => facts.deliveryEvidence('Bob', facts.seat('Bob').generation))).value;
      assert.deepEqual(evidence.map(row => [row.activity, row.outcome, row.claimToken]),
        calls.map(request => [request.activity, 'accepted', request.claimToken]));
      assert.deepEqual(calls.map(request => request.activity), [first.activity.id, second.activity.id]);
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
  const body = { channel: 'test', session: 'known' };
  const wakeTransport = { async attempt() { assert.fail('no external sends'); } };
  const built = await Square.build({ path: location, markdown: 'known artifact', env, body, wakeTransport });
  try {
    // Neither discovery nor the clock may be resolved again during participant operations.
    env.SQUARE_INDEX = lateIndex;
    env.SQUARE_NOW_MS = 'not-a-clock';
    const alice = (await built.join('Alice')).participant;
    const expressed = await alice.express('committed despite unavailable HOME', { force: true });
    assert.equal(expressed.activity.at, 1000);
    assert.equal((await built.participant()).name, 'Alice');
    await alice.done();
    assert.equal(fs.existsSync(lateIndex), false);
  } finally { await built.close(); }
  const reopened = await Square.at({ path: location, body, wakeTransport,
    env: { ...env, SQUARE_INDEX: path.join(unavailableHome, 'index.ndjsonl'), SQUARE_NOW_MS: '2000' } });
  try {
    const alice = (await reopened.join('Alice')).participant;
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
  await deliverPending({ artifact, location: '/tmp/one.square', activity,
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
  await deliverPending({ artifact, location: '/tmp/one.square', activity,
    transport: { async attempt() { replays++; return { outcome: 'accepted' }; } }, now: 5 });
  assert.equal(replays, 0, 'accepted evidence must prevent replay');

  const presented = await presentPending({ artifact, location: '/tmp/one.square', participant: 'Bob', activity,
    seat: bob, sink: { async present(item) { assert.equal(item.body, 'one artifact-owned notice'); } }, now: 6 });
  assert.equal(presented.presented, true);
  const final = (await artifact.read(facts => ({
    seen: facts.receipt('Bob', Number(activity.slice(4))),
    evidence: facts.deliveryEvidence('Bob', bob.generation, activity),
    revision: facts.header().revision,
  }))).value;
  assert.ok(final.seen);
  assert.equal(final.revision, before.revision + 1);
  assert.deepEqual(final.evidence.map(row => [row.kind, row.outcome]).sort(), [['presentation', 'presented'], ['wake', 'accepted']]);
});

test('a catch receipt committed before the final send gate suppresses the wake and releases its claim', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  let gateResult;
  let calls = 0;
  await deliverPending({ artifact, location: '/tmp/one.square', activity,
    transport: { async attempt(request, _timeout, gate) {
      calls += 1;
      await artifact.transactAs({ kind: 'participant', seat: bob }, facts => facts.markSeen('Bob', [Number(activity.slice(4))], 4));
      gateResult = await gate();
      return gateResult ? { outcome: 'accepted' } : { outcome: 'not-capable' };
    } }, now: 4 });
  assert.equal(calls, 1);
  assert.equal(gateResult, false);
  const state = (await artifact.read(facts => ({
    seen: facts.receipt('Bob', Number(activity.slice(4))),
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
      await artifact.transactAs({ kind: 'participant', seat: bob }, facts => facts.markSeen('Bob', [2], 4));
      ready = true;
      return true;
    },
    sendWake: async () => { sends += 1; },
  });
  await deliverPending({ artifact, location: '/tmp/one.square', activity, now: 4, transport });
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
  const result = await transport.attempt({ artifact, location: '/tmp/one.square', participant: 'Bob', seat: bob, activity,
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
        assert.equal(request.activity, activity);
        assert.equal(request.attemptN, 0);
        assert.match(request.prompt, /one artifact-owned notice/);
        sends += 1;
        if (expected !== 'accepted') throw new DeliveryError('unavailable', expected === 'unknown');
      },
    });
    await deliverPending({ artifact, location: '/tmp/one.square', activity, now: 4, transport });
    assert.equal(sends, 1);
    const state = (await artifact.read(facts => ({ seen: facts.receipt('Bob', 2), evidence: facts.deliveryEvidence('Bob', bob.generation, activity) }))).value;
    assert.equal(state.seen, undefined, 'wake acceptance is not presentation');
    assert.deepEqual(state.evidence.map(row => [row.kind, row.outcome]), [['wake', expected]]);
    if (expected !== 'failed') {
      await deliverPending({ artifact, location: '/tmp/one.square', activity, now: 5, transport });
      assert.equal(sends, 1, 'accepted and unknown sends are never safe replay');
    }
  });
});

test('delivery evidence retains claim leases, token scoping and terminal transition conditions', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const input = { seat: bob, activity, kind: 'wake', at: 4, leaseMs: 10, claimToken: 'first' };
  assert.equal((await artifact.claimDelivery(input)).status, 'acquired');
  assert.equal((await artifact.claimDelivery({ ...input, at: 5, claimToken: 'busy' })).status, 'busy');
  assert.equal(await artifact.completeDelivery({ ...input, claimToken: 'wrong', outcome: 'accepted' }), false);
  const interrupted = await artifact.claimDelivery({ ...input, at: 14, claimToken: 'expired' });
  assert.equal(interrupted.status, 'terminal');
  assert.equal(interrupted.evidence.outcome, 'unknown');
  assert.equal(interrupted.evidence.diagnostic, 'interrupted dispatch');
  assert.equal(await artifact.prepareDelivery({ seat: bob, claimToken: 'first', correlation: { harness: 'pi', token: 'late' } }), false);
  assert.equal(await artifact.completeDelivery({ ...input, at: 15, outcome: 'failed' }), false);
  assert.equal(await artifact.completeDelivery({ ...input, at: 16, outcome: 'accepted' }), true);
  assert.equal(await artifact.completeDelivery({ ...input, at: 17, outcome: 'accepted' }), true);
  assert.equal((await artifact.claimDelivery({ ...input, at: 18, claimToken: 'no-replay' })).status, 'terminal');
  assert.equal((await artifact.read(facts => facts.deliveryEvidence('Bob', bob.generation, activity))).value.length, 1);

  const presentation = { ...input, kind: 'presentation', at: 20, claimToken: 'presentation' };
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
  await deliverPending({ artifact, location: '/tmp/one.square', activity, now: 4,
    transport: { async attempt(request, _timeout, beforeSend) {
      oldToken = request.claimToken;
      await artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: { ...bob.body, agent: 'replacement' }, expectedGeneration: bob.generation }, facts => {
        facts.land({ kind: 'done', actor: 'Bob', at: 5 });
        facts.land({ kind: 'join', actor: 'Bob', at: 6 });
      });
      sent = await beforeSend();
      return sent ? { outcome: 'accepted' } : { outcome: 'not-capable' };
    } } });
  assert.equal(sent, false);
  await assert.rejects(artifact.completeDelivery({ seat: bob, activity, claimToken: oldToken, at: 7, outcome: 'accepted' }),
    error => error.code === 'already_joined');
  assert.equal((await artifact.read(facts => facts.deliveryByToken(oldToken))).value.outcome, 'dispatching');
  assert.notEqual((await artifact.read(facts => facts.seat('Bob'))).value.generation, bob.generation);
});

test('presentation consumes only the captured seat generation', async t => {
  const { artifact, bob, activity } = await fixture();
  t.after(() => artifact.close());
  const result = await presentPending({ artifact, location: '/tmp/one.square', participant: 'Bob', activity,
    seat: bob, sink: { async present() {
      await artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: { channel: 'test', session: 'replacement' }, expectedGeneration: bob.generation }, facts => {
        facts.land({ kind: 'done', actor: 'Bob', at: 4 });
        facts.land({ kind: 'join', actor: 'Bob', at: 5 });
      });
    } }, now: 6 });
  assert.equal(result.presented, false);
  const state = (await artifact.read(facts => ({
    receipt: facts.receipt('Bob', Number(activity.slice(4))),
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
        activities: (indexes) => { counters.hydrated.push([...indexes]); return facts.activities(indexes); },
        directedAt: (recipient, index) => { counters.directedRecipients.push(recipient); return facts.directedAt(recipient, index); },
      })), signal),
    },
  };
}

test('one requested activity wakes its landed audience without hydrating other unread history', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const bodyOf = (name) => ({ channel: 'test', session: name.toLowerCase() });
  const wake = (agentId) => ({ kind: 'paseo', address: { agentId } });
  const join = (name, at, wakeAddress) => artifact.transactAs({ kind: 'join', participant: name, body: bodyOf(name), wakeAddress }, (facts) => {
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
  await artifact.transactAs({ kind: 'participant', seat: bob }, (facts) => facts.markSeen('Bob', [caught.value.index], 201));
  const beforeRejoin = await artifact.transactAs({ kind: 'participant', seat: alice }, (facts) =>
    facts.land({ kind: 'say', actor: 'Alice', at: 202, body: 'landed before the rejoin', mentions: ['Carol'] }));
  await artifact.transactAs({ kind: 'takeover', participant: 'Carol', body: bodyOf('carol-rejoined'), expectedGeneration: carol.generation }, (facts) => {
    facts.land({ kind: 'done', actor: 'Carol', at: 203 });
    facts.land({ kind: 'join', actor: 'Carol', at: 204 });
  });
  const delivery = await artifact.transactAs({ kind: 'participant', seat: alice }, (facts) =>
    facts.land({ kind: 'say', actor: 'Alice', at: 205, body: 'the only delivery', mentions: ['Bob'] }));

  const { counters, port } = countingArtifact(artifact);
  const deliver = (activity, attempt) => deliverPending({ artifact: port, location: '/tmp/one.square', activity, transport: { attempt }, now: 300 });
  let excludedSends = 0;
  const noWake = async () => { excludedSends++; return { outcome: 'accepted' }; };
  await deliver(`act/${caught.value.index}`, noWake);
  await deliver(`act/${beforeRejoin.value.index}`, noWake);
  assert.equal(excludedSends, 0, 'caught activity and replaced seat generation cannot wake');
  const sends = [];
  await deliver(`act/${delivery.value.index}`, async (request, _timeout, gate) => {
    assert.equal(await gate(), true);
    sends.push(request.participant);
    return { outcome: 'accepted' };
  });
  assert.deepEqual(sends, ['Bob']);
  assert.deepEqual(counters.hydrated, [], 'a requested delivery must never hydrate activity bodies');
  assert.deepEqual([...new Set(counters.directedRecipients)], ['Bob'], 'only the landed audience is consulted');
});
