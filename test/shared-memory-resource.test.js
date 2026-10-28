import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';

const body = session => ({ channel: 'test', session });
const address = session => ({ kind: 'paseo', address: { agentId: session } });

test('borrowed identities share memory without sharing ownership or connection lifetime', async t => {
  const root = Square.inMemory({ markdown: 'shared' });
  t.after(() => root.close());
  const identity = body('alice');
  const a = root.forBody({ body: identity });
  identity.session = 'mutated';
  const b = root.forBody({ body: body('bob') });
  const alice = (await a.join('Alice')).participant;
  const bob = (await b.join('Bob')).participant;
  await alice.express('hello', { mentions: ['Bob'], force: true });
  assert.equal((await bob.catch()).activities.some(act => act.body === 'hello'), true);
  await assert.rejects((await b.participant('Alice')).express('impersonation'), { code: 'already_joined' });
  await b.join('Alice', { takeover: true });
  await assert.rejects(alice.express('stale'), { code: 'already_joined' });
  await a.close(); // Borrowed close cannot terminate the owner's connection.
  assert.equal((await b.history({ limit: null })).activities.some(act => act.body === 'hello'), true);
  await root.close();
  await assert.rejects(b.history());
});

test('injected memory transport preserves resource identity, deferrals and final custody checks', async t => {
  let attempts = 0;
  let observed;
  let steal = false;
  let foreign;
  const transport = {
    async attempt(request, _timeout, beforeSend) {
      attempts++;
      observed = request;
      if (steal) await foreign.join('Bob', { takeover: true });
      return await beforeSend() ? { outcome: 'accepted' } : { outcome: 'not-capable' };
    },
  };
  const root = Square.inMemory({ markdown: 'delivery', wakeTransport: transport });
  const other = Square.inMemory({ markdown: 'different resource' });
  t.after(async () => { await root.close(); await other.close(); });
  assert.notEqual(root.location, other.location);
  const a = root.forBody({ body: body('alice') });
  const b = root.forBody({ body: body('bob'), wakeAddress: address('bob') });
  foreign = root.forBody({ body: body('replacement'), wakeAddress: address('replacement') });
  const alice = (await a.join('Alice')).participant;
  const bob = (await b.join('Bob')).participant;
  const lease = await bob.deferDelivery({ match: { fields: [{ path: ['defer'], equals: true }] }, durationMs: 60000 });
  await alice.express({ body: 'deferred', metadata: { defer: true }, mentions: ['Bob'], force: true });
  assert.equal(attempts, 0);
  await bob.releaseDeliveryDeferral(lease.id);
  const sent = await alice.express('ready', { mentions: ['Bob'], force: true });
  assert.equal(observed.location, root.location);
  assert.equal(observed.route.location, root.location);
  assert.equal(observed.seat.body.session, 'bob');
  const evidence = (await observed.artifact.read(facts => facts.deliveryEvidence('Bob', observed.seat.generation, sent.activity.id))).value;
  assert.equal(evidence.some(row => row.kind === 'wake' && row.outcome === 'accepted'), true);
  steal = true;
  const suppressed = await alice.express('racing takeover', { mentions: ['Bob'], force: true });
  assert.equal(attempts, 2);
  const suppressedEvidence = (await observed.artifact.read(facts => facts.deliveryEvidence('Bob', observed.seat.generation, suppressed.activity.id))).value;
  assert.equal(suppressedEvidence.some(row => row.outcome === 'accepted'), false);
});
