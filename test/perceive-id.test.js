import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/api/square-api.js';
import { persistSquare, run, withName } from './square-cli-helpers.js';

test('perceive filters the unread inbox by IDs before limiting; history can reread them', async t => {
  const square = Square.inMemory({ markdown: 'test' });
  t.after(() => square.close());
  const owner = 'test:perceive-ids';
  const { participant: alice } = await square.join('Alice', { owner });
  const { participant: bob } = await square.join('Bob', { owner });
  const first = (await alice.express('first @Bob')).activity;
  const second = (await alice.express('second @Bob')).activity;
  const bare = (await alice.express('not directed')).activity;
  const selection = { ids: [second.id, bare.id, 'act/9999'], from: ['Alice'], mention: true, limit: 1 };
  const perceived = await bob.perceive(selection);
  assert.deepEqual(perceived.activities.map(a => a.id), [second.id]);
  assert.equal(perceived.remaining, 0);
  assert.deepEqual((await bob.perceive(selection)).activities, []);
  assert.deepEqual((await bob.perceive()).activities.map(a => a.id), [first.id]);
  assert.deepEqual((await square.history({ ids: [second.id] })).activities, [second]);
});

test('CLI can wait with an ID filter and replace', async () => {
  let id;
  const file = await persistSquare(async ({ square, body: owner }) => {
    const { participant: alice } = await square.join('Alice', { owner });
    await square.join('Bob', { owner });
    id = (await alice.express('directed words @Bob')).activity.id;
  });
  const result = run(withName(file, 'Bob', ['perceive', '--ids', id, '--wait', '1s', '--replace']));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /directed words/);
});
