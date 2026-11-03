import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Square } from '../dist/square-api.js';
import { channelArtifact, createArtifactPort } from '../dist/artifact.js';
import { deliverPending } from '../dist/delivery-operations.js';
import { squareWakeProjection } from '../dist/wake-preview.js';
import { presentPending } from '../dist/presentation-operations.js';
import { PaseoWakeTransport } from '../dist/paseo-delivery.js';
import { observeSessionPending } from '../dist/inbox.js';
import { formatMessageId } from '../dist/message.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-content-custody-'));
  const location = path.join(root, 'test.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index') };
  const square = await Square.build({ path: location, env, markdown: '', wakeTransport: false });
  const owner = 'test:content-custody';
  await square.join('Bob', { owner, wakeAddress: { kind: 'paseo', address: { agentId: 'fake-bob' } } });
  const { id: activity } = await square.send({ from: 'Worker', to: 'Bob', body: 'report/519', truncate: false });
  const producer = createArtifactPort(location), receiver = createArtifactPort(location);
  const seat = (await producer.read(f => f.seat('Bob'))).value;
  const observer = await observeSessionPending(owner, env);
  t.after(async () => {
    observer.close();
    await Promise.all([producer.close(), receiver.close(), square.close()]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { location, producer, receiver, seat, activity, observer,
    claim: (kind, token, extra = {}) => producer.claimDelivery({ seat, message: activity, kind, claimToken: token, at: 10, leaseMs: 10, ...extra }),
    settle: (token, outcome) => producer.completeDelivery({ seat, message: activity, claimToken: token, outcome, at: 12 }),
    evidence: async () => (await producer.read(f => f.deliveryEvidence('Bob', seat.generation, activity))).value,
    seen: async () => (await producer.read(f => f.channel.receipt('Bob', Number(activity.slice(4))))).value,
    present: (sink, extra = {}) => presentPending({ artifact: receiver, location, seat, participant: 'Bob', message: activity, sink: { present: sink }, ...extra }),
  };
}

// Hold the actual transport after its final gate: moving that gate cannot fix this race.
for (const first of ['paseo', 'presentation']) test(`${first} wins content custody across two artifact connections`, async t => {
  const f = await fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const effects = [];
  const transport = new PaseoWakeTransport({
    discover: async () => ({ agents: [{ id: 'fake-bob', status: 'idle' }] }),
    waitForBoundary: async () => true,
    sendWake: async () => {
      if (first === 'paseo') { entered.resolve(); await release.promise; }
      effects.push('paseo');
    },
  });
  const wake = () => deliverPending({ artifact: channelArtifact(f.producer), preparePresentation: squareWakeProjection(f.producer), location: f.location, message: f.activity, transport });
  const native = () => f.present(async () => {
    if (first === 'presentation') { entered.resolve(); await release.promise; }
    effects.push('presentation');
  });
  const pending = first === 'paseo' ? wake() : native();
  await entered.promise;
  try {
    if (first === 'paseo') assert.equal((await native()).presented, false);
    else await wake();
    assert.deepEqual(effects, []);
  } finally { release.resolve(); }
  await pending;
  await wake();
  assert.equal((await native()).presented, false);
  assert.deepEqual(effects, [first]);
  assert.deepEqual((await f.evidence()).map(r => [r.kind, r.outcome]),
    [[first === 'presentation' ? 'presentation' : 'wake', first === 'presentation' ? 'presented' : 'accepted']]);
  assert.equal(Boolean(await f.seen()), first === 'presentation', 'wake acceptance must not fabricate consumption');
});

for (const first of ['wake', 'presentation']) test(`${first} custody survives expiry and uncertainty; only proven failure releases it`, async t => {
  for (const outcome of ['dispatching', 'unknown', 'failed', 'released', first === 'wake' ? 'accepted' : 'clipped']) {
    await t.test(outcome, async t => {
      const f = await fixture(t);
      assert.equal((await f.claim(first, 'first')).status, 'acquired');
      if (outcome !== 'dispatching') assert.equal(await f.settle('first', outcome), true);
      const other = first === 'wake' ? 'presentation' : 'wake';
      const result = await f.claim(other, 'second', { at: 30 });
      const safe = outcome === 'failed' || outcome === 'released';
      assert.equal(result.status, safe ? 'acquired' : 'terminal');
      if (outcome === 'dispatching') assert.equal((await f.evidence())[0].outcome, 'unknown');
      assert.equal(await f.seen(), undefined);
    });
  }
});

test('failed wake wakes the native observer again without another activity', async t => {
  const f = await fixture(t);
  assert.equal((await f.claim('wake', 'first')).status, 'acquired');
  assert.deepEqual(await f.observer.read(), []);
  const armed = Promise.withResolvers();
  const waiting = f.observer.wait(1000, { onChangeArmed: armed.resolve });
  await armed.promise;
  assert.equal(await f.settle('first', 'failed'), true);
  assert.equal((await waiting)[0].notifications[0].messageIndex, Number(f.activity.slice(4)));
  let sends = 0;
  assert.equal((await f.present(() => { sends++; })).presented, true);
  assert.equal(sends, 1);
});

test('observation refers to an exact existing wake, without granting another injection', async t => {
  const f = await fixture(t);
  assert.equal((await f.claim('wake', 'wake-token')).status, 'acquired');
  await f.settle('wake-token', 'accepted');
  assert.equal((await f.claim('presentation', 'bad-observation', { observationOf: 'wrong-token' })).status, 'stale');
  assert.equal((await f.claim('wake', 'invalid-observation', { observationOf: 'wake-token' })).status, 'stale');
  const foreign = await f.producer.transactAs({ kind: 'send', actor: 'Worker' }, facts =>
    facts.channel.publishMessage({ from: 'Worker', at: 13, body: 'different report', to: [{ recipient: 'Bob' }] }));
  assert.equal((await f.claim('presentation', 'wrong-activity', {
    message: formatMessageId(foreign.value.index), observationOf: 'wake-token',
  })).status, 'stale');
  assert.equal((await f.present(() => assert.fail('no second injection'))).presented, false);
  assert.equal(await f.seen(), undefined);
  assert.equal((await f.present(() => {}, { observationOf: 'wake-token' })).presented, true);
  assert.ok(await f.seen());
});

test('a throwing presentation remains uncertain and cannot fall back to a wake', async t => {
  const f = await fixture(t);
  await assert.rejects(f.present(() => { throw new Error('lost acknowledgement'); }), /lost acknowledgement/);
  assert.equal((await f.evidence())[0].outcome, 'unknown');
  assert.equal((await f.claim('wake', 'fallback')).status, 'terminal');
  assert.deepEqual(await f.observer.read(), []);
  assert.equal(await f.seen(), undefined);
});
