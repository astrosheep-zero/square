import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/index.js';

const body = session => `test:${session}`;
const address = session => ({ kind: 'paseo', address: { agentId: session } });

test('one memory resource shares activity without sharing seat authority', async t => {
  const square = Square.inMemory({ markdown: 'shared' });
  t.after(() => square.close());
  const a = body('alice'), b = body('bob');
  const alice = (await square.join('Alice', { owner: a })).participant;
  const bob = (await square.join('Bob', { owner: b })).participant;
  await alice.express('hello', { mentions: ['Bob'], force: true });
  assert.equal((await bob.catch()).activities.some(act => act.body === 'hello'), true);
  await assert.rejects(square.participant('Alice', { owner: b }), { code: 'already_joined' });
  await square.join('Alice', { owner: b, takeover: true });
  await assert.rejects(alice.express('stale'), { code: 'already_joined' });
  assert.equal((await square.history({ limit: null })).activities.some(act => act.body === 'hello'), true);
  await square.close();
  await assert.rejects(bob.catch());
});

test('injected memory transport preserves resource identity, deferrals and final custody checks', async t => {
  let attempts = 0;
  let observed;
  let steal = false;
  const transport = {
    async attempt(request, _timeout, beforeSend) {
      attempts++;
      observed = request;
      if (steal) await square.join('Bob', { owner: body('replacement'), wakeAddress: address('replacement'), takeover: true });
      return await beforeSend() ? { outcome: 'accepted' } : { outcome: 'not-capable' };
    },
  };
  const square = Square.inMemory({ markdown: 'delivery', wakeTransport: transport });
  const other = Square.inMemory({ markdown: 'different resource' });
  t.after(async () => { await square.close(); await other.close(); });
  assert.notEqual(square.location, other.location);
  const alice = (await square.join('Alice', { owner: body('alice') })).participant;
  const bob = (await square.join('Bob', { owner: body('bob'), wakeAddress: address('bob') })).participant;
  const lease = await bob.deferDelivery({ match: { fields: [{ path: ['defer'], equals: true }] }, durationMs: 60000 });
  await alice.express({ body: 'deferred', metadata: { defer: true }, mentions: ['Bob'], force: true });
  assert.equal(attempts, 0);
  await bob.releaseDeliveryDeferral(lease.id);
  const sent = await alice.express('ready', { mentions: ['Bob'], force: true });
  assert.equal(observed.location, square.location);
  assert.equal(observed.route.location, square.location);
  assert.equal(observed.seat.owner, body('bob'));
  const evidence = (await observed.artifact.read(facts => facts.deliveryEvidence('Bob', observed.seat.generation, sent.activity.id))).value;
  assert.equal(evidence.some(row => row.kind === 'wake' && row.outcome === 'accepted'), true);
  steal = true;
  const suppressed = await alice.express('racing takeover', { mentions: ['Bob'], force: true });
  assert.equal(attempts, 2);
  const suppressedEvidence = (await observed.artifact.read(facts => facts.deliveryEvidence('Bob', observed.seat.generation, suppressed.activity.id))).value;
  assert.equal(suppressedEvidence.some(row => row.outcome === 'accepted'), false);
});
