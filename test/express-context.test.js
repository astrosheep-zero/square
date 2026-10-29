import assert from 'node:assert/strict';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { SQUARE_TOOLS } from '../dist/square-tools.js';
import { expressionContext } from '../dist/activity-feed.js';

const express = SQUARE_TOOLS.find(tool => tool.name === 'express');

test('express previews only five latest unseen activities, keeps Unicode intact, and never consumes', async t => {
  const body = { channel: 'test', session: 'context' };
  const square = Square.inMemory({ markdown: '' });
  t.after(() => square.close());
  const alice = (await square.join('Alice', { body })).participant;
  const bob = (await square.join('Bob', { body })).participant;
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await bob.express(`${i}:` + '🐟'.repeat(600), { mentions: ['Alice'], force: true })).activity.id);
  await alice.catch({ id: ids[10] }); // A seen row beyond the oldest unread hole must stay excluded.
  const hydrated = [];
  const original = square.artifact.read.bind(square.artifact);
  const context = (await original(facts => expressionContext({
    ...facts,
    activities: indexes => { hydrated.push(...indexes); return facts.activities(indexes); },
  }, 'Alice'))).value;
  assert.equal(hydrated.length, 5, 'only the selected page may hydrate bodies');
  assert.deepEqual(context.activities.map(item => item.id), [ids[6], ids[7], ids[8], ids[9], ids[11]]);
  assert.equal(context.remaining, 6);
  assert.ok(context.activities.every(item => Array.from(item.preview).length === 400 && item.truncated));
  assert.ok(context.activities.every(item => !/[\uD800-\uDBFF]$/.test(item.preview)), 'no split surrogate');
  const result = await express.run(square, { as: 'Alice', body: 'DO NOT ECHO THIS BODY', force: true }, {}, { body });
  assert.equal(typeof result, 'string');
  assert.match(result, /act\/\d+/);
  assert.doesNotMatch(result, /DO NOT ECHO|sayNumbers|perceptions|pendingPublic/);
  assert.match(result, /preview only, not consumed/);
  assert.match(result, /6 more unread activities/);
  assert.match(result, /catch/);
  assert.ok(Buffer.byteLength(result) < 10000);
  assert.equal((await alice.catch({ limit: 100 })).activities.length, 11);
  const after = await express.run(square, { as: 'Alice', body: 'done', force: true }, {}, { body });
  assert.doesNotMatch(after, /Unread context/);
});

test('text confirmation retains reach warnings without claiming a receiver heard it', async t => {
  const body = { channel: 'test', session: 'warnings' };
  const square = Square.inMemory({ markdown: '' });
  t.after(() => square.close());
  await square.join('Alice', { body });
  const bob = (await square.join('Bob', { body })).participant;
  const question = await bob.express('question');
  await bob.done();
  const result = await express.run(square, { as: 'Alice', body: '@Absent answer', reply: question.activity.id, force: true }, {}, { body });
  assert.equal((await square.history()).activities.at(-1).reply, question.activity.id);
  assert.match(result, /@Bob.*reply landed without reaching them/);
  assert.match(result, /@Absent isn't standing here/);
});
