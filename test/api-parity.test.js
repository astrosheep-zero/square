import assert from 'node:assert/strict';
import test from 'node:test';

import { Square, selectOwnSeat } from '../dist/api/square-api.js';
import { renderJoinResult } from '../dist/surfaces/operation-presentation.js';

const owner = `test:${'api-parity'}`;

async function memory(t) {
  const square = Square.inMemory({ markdown: 'archive' });
  t.after(() => square.close());
  return square;
}

test('history defaults to ten, accepts a larger page, and leaves pending untouched', async (t) => {
  const square = await memory(t);
  const alice = (await square.join('Alice', { owner })).participant;
  const bob = (await square.join('Bob', { owner })).participant;
  for (let index = 0; index < 12; index++) await alice.express(`message ${index}`, { force: true });
  await bob.express('for Alice', { force: true, mentions: ['Alice'] });
  const pending = await alice.pending();
  assert.equal(pending.activities.length, 1);

  const recent = await square.history();
  assert.deepEqual(recent.activities.map((activity) => activity.id),
    Array.from({ length: 10 }, (_value, index) => `act/${index + 5}`));
  assert.equal(recent.totalMatches, 15);
  assert.deepEqual(recent.continuation, { direction: 'before', cursor: 'act/5', limit: 10 });
  assert.equal((await square.history({ limit: 20 })).activities.length, 15);
  assert.deepEqual(await alice.pending(), pending);
});

test('a stale participant handle cannot speak after done or rejoin', async (t) => {
  const square = await memory(t);
  const alice = (await square.join('Alice', { owner })).participant;
  await alice.done();
  await assert.rejects(alice.express('stale handle'), { code: 'already_joined' });
  const rejoined = (await square.join('Alice', { owner })).participant;
  await assert.rejects(alice.express('old generation after rejoin'), { code: 'already_joined' });
  assert.equal((await rejoined.express('back', { force: true })).activity.id, 'act/3');
});

test('join refuses an omitted or blank name without adding history', async (t) => {
  const square = Square.inMemory({ markdown: 'explicit-name' });
  t.after(() => square.close());
  const before = (await square.history()).activities.length;
  await assert.rejects(square.join(undefined, { owner }), { code: 'invalid_args' });
  await assert.rejects(square.join('', { owner }), { code: 'invalid_name' });
  await assert.rejects(square.join('   ', { owner }), { code: 'invalid_name' });
  assert.equal((await square.history()).activities.length, before);
  assert.equal((await square.join('Defaulted', { owner })).kind, 'joined');
  assert.equal((await selectOwnSeat(square, owner)).name, 'Defaulted');
  await assert.rejects(square.join(undefined, { owner }), { code: 'invalid_args' });
  assert.equal((await square.history()).activities.filter((activity) => activity.kind === 'join').length, 1);
});

test('perceive resolves caller and filters in one typed failure', async (t) => {
  const square = await memory(t);
  const alice = (await square.join('Alice', { owner })).participant;
  await assert.rejects(alice.perceive({ from: ['Unknown'] }), (error) => {
    assert.equal(error.code, 'invalid_args');
    assert.equal(error.facts.reason, 'never_joined');
    assert.equal(error.facts.activityId, undefined);
    assert.deepEqual(error.operation, { operation: 'perceive', subject: 'filter', participant: 'Alice' });
    return true;
  });
});

test('join returns the entry scene and perception-aware activity with its receipt', async t => {
  const square = await memory(t);
  const { participant: alice } = await square.join('Alice', { owner });
  const spoken = await alice.express('for other ears');
  const joined = await square.join('Bob', { owner });
  assert.equal(joined.standingCount, 2);
  assert.equal(joined.entry.joinContext, 'archive');
  assert.deepEqual(joined.entry.recentActivities.map(({ id, perception }) => [id, perception]), [[spoken.activity.id, 'presence']]);
  const again = await square.join('Bob', { owner });
  assert.equal(again.kind, 'reconnected');
  assert.equal(again.activity, null);
  assert.match(renderJoinResult(again), /you are already in the square/);
});
