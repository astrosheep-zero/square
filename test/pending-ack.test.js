import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createArtifactPort } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';

const state = { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } };
async function setup(t) {
  const artifact = createArtifactPort(':memory:', state);
  const square = await Square.at({ path: `/tmp/square-ack-${randomUUID()}.square`, resources: { artifact: () => artifact, close: async () => {} } });
  t.after(async () => { await square.close(); await artifact.close(); });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  return { square, alice, bob };
}

test('exact activity ACK consumes only the selected addressed activity', async t => {
  const { alice, bob } = await setup(t);
  const one = (await alice.express('one', { force: true, mentions: ['Bob'], metadata: { job: 1 } })).activity;
  const two = (await alice.express('two', { force: true, mentions: ['Bob'], metadata: { job: 2 } })).activity;
  assert.deepEqual(await bob.ack([one.id]), { consumed: 1 });
  assert.deepEqual(await bob.ack([one.id]), { consumed: 0 });
  assert.deepEqual((await bob.pending()).activities.map(a => a.id), [two.id]);
  assert.deepEqual((await bob.catch()).activities.map(a => a.id), [two.id]);
});

test('send returns a notice, not a participant or a say activity', async t => {
  const { square } = await setup(t);
  const metadata = { job: { id: 7 } };
  const result = await square.send({ from: 'Coordinator', to: 'Bob', body: 'notice', metadata });
  assert.match(result.id, /^notice\/\d+$/);
  assert.equal(result.body, 'notice');
  assert.deepEqual(result.metadata, metadata);
  assert.equal((await square.history({ limit: null })).activities.some(a => a.actor === 'Coordinator'), false);
  assert.equal((await square.participants()).participants.some(p => p.name === 'Coordinator'), false);
});
