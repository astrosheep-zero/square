import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/index.js';

const body = session => `test:${session}`;

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
