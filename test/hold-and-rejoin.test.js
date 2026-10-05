import assert from 'node:assert/strict';
import test from 'node:test';

import { loadSquare } from '../dist/artifact.js';
import { persistSquare, run, runAsync, withName, withPath } from './square-cli-helpers.js';

const HELD_BUDGET_ENV = { SQUARE_HELD_WAIT_BUDGET_MS: '300' };

test('a held express announces the holder, waits within a budget, then keeps a draft', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.hold('pause for thought');
  });

  const started = Date.now();
  const held = run(withName(file, 'Alice', ['express', '--mention', 'Bob', 'are you there @Bob']), { env: HELD_BUDGET_ENV });
  const elapsed = Date.now() - started;
  assert.equal(held.status, 1, held.stderr);
  assert.match(held.stdout, /✕ your activity doesn't land — @Bob raised a hand/);
  assert.match(held.stdout, /· pause for thought/);
  assert.match(held.stdout, /your activity is waiting — after .* it saves a draft and stops/);
  assert.match(held.stdout, /--no-wait saves a draft and returns now/);
  assert.match(held.stdout, /draft kept/);
  assert.match(held.stdout, /express --mention 'Bob' - </);
  assert.ok(elapsed >= 250, `expected a real wait, got ${elapsed}ms`);
  assert.ok(elapsed < 5000, `expected the wait to give up, got ${elapsed}ms`);

  const acts = (await loadSquare(file)).acts;
  assert.equal(acts.at(-1).kind, 'hold', 'no say may land while the hand is up');
});

test('a held express lands as soon as the hand lowers mid-wait', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.hold();
  });

  const waiting = runAsync(withName(file, 'Alice', ['express', '--no-mention', 'patient thought']), { env: { SQUARE_HELD_WAIT_BUDGET_MS: '30000' } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const resumed = run(withName(file, 'Bob', ['resume']));
  assert.equal(resumed.status, 0, resumed.stderr);
  const landed = await waiting;
  assert.equal(landed.status, 0, landed.stderr);
  assert.match(landed.stdout, /your activity is waiting/);
  assert.match(landed.stdout, /your activity lands/);
  assert.equal((await loadSquare(file)).acts.at(-1).kind, 'say');
});

test('express after done announces the return; a standing participant sees none', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.done();
  });

  const returned = run(withName(file, 'Bob', ['express', '--no-mention', 'i am back']));
  assert.equal(returned.status, 0, returned.stderr);
  assert.match(returned.stdout, /● you stepped back into the square/);
  assert.match(returned.stdout, /your activity lands/);

  const standing = run(withName(file, 'Alice', ['express', '--no-mention', 'still here']));
  assert.equal(standing.status, 0, standing.stderr);
  assert.doesNotMatch(standing.stdout, /stepped back into the square/);
});

test('history pairs holds with lowerings and departures with returns', async () => {
  const file = await persistSquare(async ({ square }) => {
    await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.hold('pause');
    await bob.resume();
    await bob.done();
    await square.join('Bob');
  });

  const history = run(withPath(file, ['history']));
  assert.equal(history.status, 0, history.stderr);
  assert.match(history.stdout, /@Alice stepped into the square/);
  assert.match(history.stdout, /@Bob raised a hand — pause/);
  assert.match(history.stdout, /@Bob lowered the hand/);
  assert.match(history.stdout, /@Bob stepped out of the square — done/);
  const joins = history.stdout.match(/@Bob stepped into the square/g) ?? [];
  assert.equal(joins.length, 2, 'both the arrival and the return stay on the record');

  const json = run(withPath(file, ['history', '--json']));
  assert.equal(json.status, 0, json.stderr);
  const kinds = json.stdout.trim().split('\n').map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['join', 'join', 'hold', 'resume', 'done', 'join']);
});
