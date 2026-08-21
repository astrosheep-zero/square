import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square, SquareError } from '../dist/index.js';

test('fixed facade builds, opens, and exposes participant-scoped activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const wakes = [];
  const square = await Square.build({
    path: squarePath,
    markdown: '# context',
    clock: () => 10,
    notifier: { wake: (recipients, activity) => wakes.push({ recipients, activity }) },
  });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const expressed = await alice.express('hello @Bob', { force: true });
  assert.equal(expressed.activity.id, 'act/2');
  assert.deepEqual(wakes, [{ recipients: ['Bob'], activity: expressed.activity }]);
  assert.equal((await bob.history()).at(-1).perception, 'full');
  await square.close();

  const reopened = await Square.at({ path: squarePath });
  assert.deepEqual((await reopened.history()).map((activity) => activity.id), ['act/0', 'act/1', 'act/2']);
  await reopened.close();
});

test('participant history defaults to the recent ten activities in ascending order', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  for (let index = 0; index < 12; index += 1) {
    await alice.express(`message ${index} @Bob`, { force: true });
  }
  const recent = await bob.history();
  assert.equal(recent.length, 10);
  assert.deepEqual(recent.map((activity) => activity.id), Array.from({ length: 10 }, (_, index) => `act/${index + 4}`));
  assert.deepEqual((await bob.history({ limit: 3, order: 'desc' })).map((activity) => activity.id), ['act/13', 'act/12', 'act/11']);
  assert.equal((await bob.history({ all: true })).length, 14);
  await square.close();
});

test('idle catch wakes for a committed activity and expires while quiet', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await bob.catch();

  const waiting = bob.catch({ idle: 500, mention: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const expressed = await alice.express('wake @Bob', { force: true });
  const caught = await waiting;
  assert.deepEqual(caught.activities, [{ ...expressed.activity, perception: 'full' }]);
  assert.equal(caught.consumedThrough, expressed.activity.id);
  assert.equal(caught.idleExpired, false);

  const expired = await bob.catch({ idle: 20 });
  assert.deepEqual(expired.activities, []);
  assert.equal(expired.consumedThrough, expressed.activity.id);
  assert.equal(expired.idleExpired, true);
  await square.close();
});

test('invalid facade join retains the stable coded error and commits nothing', async () => {
  const square = Square.inMemory({ markdown: 'context' });
  await assert.rejects(square.join('bad name'), (error) => error instanceof SquareError && error.code === 'invalid_name');
  assert.equal((await square.snapshot()).actCount, 0);
  await square.close();
});
