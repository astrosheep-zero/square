import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/api/square-api.js';
import { renderExpression } from '../dist/surfaces/operation-presentation.js';

test('express previews only five latest unseen activities, keeps Unicode intact, and never consumes', async t => {
  const body = "test" + ":" + ('context');
  const square = Square.inMemory({ markdown: '', hardCap: 20 });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { owner: body })).participant;
  const bob = (await square.join('Bob', { owner: body })).participant;
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await bob.express(`${i}:` + '🐟'.repeat(600), { mentions: ['Alice'], force: true })).activity.id);
  await alice.perceive({ ids: [ids[10]] }); // A seen row beyond the oldest unread hole must stay excluded.

  const artifact = square.resource.artifact;
  const hydrated = [];
  const wrap = (facts, write) => ({ ...facts, activities(indexes) {
    hydrated.push(...indexes.map(index => [index, write]));
    return facts.activities(indexes);
  } });
  const read = artifact.read.bind(artifact), transactAs = artifact.transactAs.bind(artifact);
  const readSpy = t.mock.method(artifact, 'read', (select, signal) => read(facts => select(wrap(facts, false)), signal));
  const writeSpy = t.mock.method(artifact, 'transactAs', (authority, change, signal) =>
    transactAs(authority, facts => change(wrap(facts, authority.kind === 'participant')), signal));
  const sent = await alice.express('DO NOT ECHO THIS BODY', { force: true });
  readSpy.mock.restore();
  writeSpy.mock.restore();

  const { context } = sent;
  assert.deepEqual(hydrated, [ids[6], ids[7], ids[8], ids[9], ids[11]].map(id => [Number(id.slice(4)), true]));
  assert.equal(sent.standingCount, 2);
  assert.equal(sent.ownActivityCount, 1);
  assert.equal(sent.hardCap, 20);
  assert.deepEqual(context.activities.map(item => item.id), [ids[6], ids[7], ids[8], ids[9], ids[11]]);
  assert.equal(context.remaining, 6);
  assert.ok(context.activities.every(item => Array.from(item.preview).length === 400 && item.truncated));
  assert.ok(context.activities.every(item => !/[\uD800-\uDBFF]$/.test(item.preview)), 'no split surrogate');
  const result = renderExpression(sent);
  assert.ok(result.includes(sent.activity.id));
  assert.doesNotMatch(result, /DO NOT ECHO/);
  assert.match(result, /preview only, not consumed/);
  assert.match(result, /6 more unread activities/);
  assert.match(result, /perceive/);
  assert.equal((await alice.perceive({ limit: 100 })).activities.length, 11);
  assert.deepEqual((await alice.express('done')).context, { activities: [], remaining: 0 });
});
