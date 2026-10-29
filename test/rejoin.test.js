import assert from 'node:assert/strict';
import test from 'node:test';

import { readSquareSnapshot } from '../dist/artifact.js';
import { persistSquare, run, withName, withPath } from './square-cli-helpers.js';

test('a departed participant steps back in before speaking, and only the return announces itself', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    const bob = (await square.join('Bob', { owner: body })).participant;
    await bob.done();
  });

  // A completed seat cannot speak for its old body: the draft is kept, nothing lands.
  const refused = run(withName(file, 'Bob', ['express', '--no-mention', 'i am back']));
  const refusal = refused.stdout + refused.stderr;
  assert.equal(refused.status, 2, refusal);
  assert.match(refusal, /Bob needs a current attached seat/);
  assert.match(refusal, /draft kept/);
  assert.match(refusal.trim().split('\n').at(-1), /^square .* join$/);
  assert.equal((await readSquareSnapshot(file)).state.acts.at(-1).kind, 'done');

  const returned = run(withName(file, 'Bob', ['join']));
  assert.equal(returned.status, 0, returned.stderr);
  assert.match(returned.stdout, /● you stepped into the square/);
  assert.match(returned.stdout, /@Bob stepped out of the square — done/);

  const speaking = run(withName(file, 'Bob', ['express', '--no-mention', 'i am back']));
  assert.equal(speaking.status, 0, speaking.stderr);
  assert.match(speaking.stdout, /your words land/);
  assert.doesNotMatch(speaking.stdout, /stepped (back )?in/);

  const standing = run(withName(file, 'Alice', ['express', '--no-mention', 'still here']));
  assert.equal(standing.status, 0, standing.stderr);
  assert.doesNotMatch(standing.stdout, /stepped back into the square/);
});

test('history keeps departures and returns', async () => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
    const bob = (await square.join('Bob', { owner: body })).participant;
    await bob.done();
    await square.join('Bob', { owner: body });
  });

  const history = run(withPath(file, ['history']));
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /@Alice stepped into the square/);
  assert.match(history.stdout, /@Bob stepped out of the square — done/);
  const joins = history.stdout.match(/@Bob stepped into the square/g) ?? [];
  assert.equal(joins.length, 2, 'both the arrival and the return stay on the record');

  const json = run(withPath(file, ['history', '--json']));
  assert.equal(json.status, 0, json.stderr);
  const kinds = JSON.parse(json.stdout).activities.map((activity) => activity.kind);
  assert.deepEqual(kinds, ['join', 'join', 'done', 'join']);
});
