import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';

const idsOf = (page) => page.activities.map((activity) => activity.id);

async function setup(t) {
  const square = Square.inMemory({ markdown: 'test' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  const ids = [];
  for (const body of ['one', 'two', 'three', 'four'])
    ids.push((await alice.express(body, { force: true, mentions: ['Bob'] })).activity.id);
  return { square, alice, bob, ids };
}

test('pending pages addressed says by act/N cursor and always selects oldest first', async (t) => {
  const { bob, ids } = await setup(t);
  assert.deepEqual(idsOf(await bob.pending()), ids);
  assert.deepEqual(idsOf(await bob.pending({ cursor: { id: ids[2], direction: 'after' } })), [ids[3]]);
  assert.deepEqual(idsOf(await bob.pending({ cursor: { id: ids[2], direction: 'before' } })), [ids[0], ids[1]]);
  // A before cursor keeps pending's oldest-first page, unlike history's newest page.
  assert.deepEqual(idsOf(await bob.pending({ cursor: { id: ids[2], direction: 'before' }, limit: 1 })), [ids[0]]);
  const page = await bob.pending({ cursor: { id: ids[0], direction: 'after' }, limit: 2 });
  assert.deepEqual(idsOf(page), [ids[1], ids[2]]);
  assert.equal(page.remaining, 1);
});

test('pending preserves unconsumed addressed says across a same-owner rejoin', async t => {
  const square = Square.inMemory({ markdown: 'test' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  const sent = await alice.express('hello', { force: true, mentions: ['Bob'] });
  assert.deepEqual(idsOf(await bob.pending()), [sent.activity.id]);
  await bob.done();
  const rejoined = (await square.join('Bob', { owner: 'test:bob' })).participant;
  assert.deepEqual(idsOf(await rejoined.pending()), [sent.activity.id]);
});

test('pending cursor counts only unconsumed says and refuses non-act coordinates', async (t) => {
  const { bob, ids } = await setup(t);
  assert.equal((await bob.ack([ids[0]])).consumed, 1);
  assert.deepEqual(idsOf(await bob.pending({ cursor: { id: ids[2], direction: 'before' } })), [ids[1]]);
  for (const cursor of [
    { id: 'msg/0', direction: 'after' },
    { id: 'act/nope', direction: 'after' },
    { id: ids[0], direction: 'sideways' },
    { id: ids[0], direction: 'after', extra: true },
    { direction: 'after' },
  ]) await assert.rejects(bob.pending({ cursor }), { code: 'invalid_args' });
});
