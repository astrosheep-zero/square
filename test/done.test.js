import assert from 'node:assert/strict';
import test from 'node:test';

import { Square } from '../dist/api/square-api.js';
import { persistSquare, run, withName } from './square-cli-helpers.js';

test('done refuses argument and stdin bodies, then leaves without one', async (t) => {
  const file = await persistSquare(async ({ square, body }) => {
    await square.join('Alice', { owner: body });
  });
  const square = await Square.at({ path: file });
  t.after(() => square.close());
  const before = (await square.history({ limit: null })).activities;

  const argument = run(withName(file, 'Alice', ['done', 'a message']));
  assert.equal(argument.status, 2, argument.stdout + argument.stderr);
  assert.match(argument.stderr, /done only leaves the square and does not accept a message/);
  assert.match(argument.stderr, /square done --help\n$/);
  assert.deepEqual((await square.history({ limit: null })).activities, before);

  const implicit = run(withName(file, 'Alice', ['done']), { input: 'implicit piped message\n' });
  assert.equal(implicit.status, 2, implicit.stdout + implicit.stderr);
  assert.match(implicit.stderr, /does not accept a message/);
  assert.deepEqual((await square.history({ limit: null })).activities, before);

  const done = run(withName(file, 'Alice', ['done']));
  assert.equal(done.status, 0, done.stderr);
  const acts = (await square.history({ limit: null })).activities;
  assert.deepEqual(acts.map((activity) => activity.kind), ['join', 'done']);
  assert.equal(Object.hasOwn(acts.at(-1), 'body'), false);
  assert.match(done.stdout, new RegExp(`— your footsteps fade · ${acts.at(-1).id}`));
});
