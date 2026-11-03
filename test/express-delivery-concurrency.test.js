import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';

test('concurrent expressions land exactly once with distinct activities and their frozen audiences', async t => {
  const square = Square.inMemory({ markdown: 'concurrent producers' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  const cara = (await square.join('Cara', { owner: 'test:cara' })).participant;
  const sent = await Promise.all([
    alice.express('for Bob', { mentions: ['Bob'], force: true }),
    alice.express('for Cara', { mentions: ['Cara'], force: true }),
  ]);
  assert.notEqual(sent[0].activity.id, sent[1].activity.id);
  assert.deepEqual((await bob.catch()).activities.map(item => item.body), ['for Bob']);
  assert.deepEqual((await cara.catch()).activities.map(item => item.body), ['for Cara']);
  const says = (await square.history({ limit: null })).activities.filter(item => item.kind === 'say');
  assert.deepEqual(says.map(item => item.body).sort(), ['for Bob', 'for Cara']);
});
