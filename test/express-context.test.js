import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { renderExpression } from '../dist/operation-presentation.js';

test('express previews only five latest unseen activities, keeps Unicode intact, and never consumes', async t => {
  const body = "test" + ":" + ('context');
  const square = Square.inMemory({ markdown: '' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: body })).participant;
  const bob = (await square.join('Bob', { owner: body })).participant;
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await bob.express(`${i}:` + '🐟'.repeat(600), { mentions: ['Alice'], force: true })).activity.id);
  await alice.perceive({ id: ids[10] }); // A seen row beyond the oldest unread hole must stay excluded.

  // Count hydration through the real artifact port while express observes its own unread feed.
  const hydrated = [];
  const original = square.artifact.read.bind(square.artifact);
  let sent;
  square.artifact.read = (select, signal) => original(facts => select({
    ...facts,
    activities: indexes => { hydrated.push(...indexes); return facts.activities(indexes); },
  }), signal);
  try {
    sent = await alice.express('DO NOT ECHO THIS BODY', { force: true, observe: true });
  } finally {
    square.artifact.read = original;
  }

  const context = sent.observation.context;
  assert.equal(hydrated.length, 5, 'only the selected page may hydrate bodies');
  assert.deepEqual(context.activities.map(item => item.id), [ids[6], ids[7], ids[8], ids[9], ids[11]]);
  assert.equal(context.remaining, 6);
  assert.ok(context.activities.every(item => Array.from(item.preview).length === 400 && item.truncated));
  assert.ok(context.activities.every(item => !/[\uD800-\uDBFF]$/.test(item.preview)), 'no split surrogate');
  const result = renderExpression(square.location, sent);
  assert.match(result, /act\/\d+/);
  assert.doesNotMatch(result, /DO NOT ECHO|sayNumbers|perceptions|pendingPublic/);
  assert.match(result, /preview only, not consumed/);
  assert.match(result, /6 more unread activities/);
  assert.match(result, /perceive/);
  assert.ok(Buffer.byteLength(result) < 10000);
  assert.equal((await alice.perceive({ limit: 100 })).activities.length, 11);
  const after = renderExpression(square.location, await alice.express('done', { force: true, observe: true }));
  assert.doesNotMatch(after, /Unread context/);
});
