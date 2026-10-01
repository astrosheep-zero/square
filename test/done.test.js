import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { loadSquare } from '../dist/artifact.js';
import { Square, SquareError } from '../dist/index.js';
import { createSquareApplication } from '../dist/square-application.js';
import { build, persistSquare, run, tempSquare, withName } from './square-cli-helpers.js';

function rejectsDoneBody(error) {
  return error instanceof SquareError && error.code === 'invalid_args'
    && /done only leaves the square and does not accept a message/.test(error.message);
}

test('done rejects supplied bodies without changing participation or history', async () => {
  const square = Square.inMemory({ markdown: 'context' });
  try {
    const alice = await square.join('Alice');
    await square.join('Bob');
    await alice.listen('Bob');
    const before = await square.history({ limit: 100 });
    for (const body of ['a message', ' \r\n', null, 0, {}]) {
      await assert.rejects(() => alice.done(body), rejectsDoneBody);
      assert.deepEqual(await square.history({ limit: 100 }), before);
      assert.deepEqual(await alice.listening(), ['Bob']);
      assert.equal((await square.snapshot()).participants.find((participant) => participant.name === 'Alice').state, 'joined');
    }
    const result = await alice.done();
    assert.equal(result.activity.kind, 'done');
    assert.equal(result.activity.body, undefined);
    assert.equal(Object.hasOwn(result.activity, 'body'), false);
    assert.deepEqual((await square.snapshot()).participants.find((participant) => participant.name === 'Alice').listening, []);
  } finally {
    await square.close();
  }
});

test('done remains bodyless after reaching the cap and while a hand is raised', async () => {
  const file = await persistSquare(async ({ square }) => {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await alice.express('the one activity');
    await bob.hold('pause');
    await alice.done('');
  }, { hardCap: 1 });
  const state = await loadSquare(file);
  assert.deepEqual(state.acts.map((activity) => activity.kind), ['join', 'join', 'say', 'hold', 'done']);
  assert.equal(Object.hasOwn(state.acts.at(-1), 'body'), false);
});

test('application rejects done bodies before joining or rejoining', async () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const app = createSquareApplication({ cwd: path.dirname(file), env: { ...process.env }, squarePath: file, participant: 'Alice' });
  for (const body of ['a message', ' \n', null, false]) {
    await assert.rejects(() => app.done(body), rejectsDoneBody);
    assert.deepEqual((await loadSquare(file)).acts, []);
  }
  await app.join();
  await app.done();
  const before = (await loadSquare(file)).acts;
  await assert.rejects(() => app.done('another message'), rejectsDoneBody);
  assert.deepEqual((await loadSquare(file)).acts, before);
});

test('CLI done rejects argument and stdin payloads without leaving or posting', async () => {
  const file = await persistSquare(async ({ square }) => { await square.join('Alice'); });
  const before = (await loadSquare(file)).acts;
  const attempts = [
    { args: ['done', 'a message'] },
    { args: ['done', ' \n'] },
    { args: ['done', '-'], input: 'piped message\n' },
    { args: ['done'], input: 'implicit piped message\n' },
    { args: ['done', ''], input: 'piped message with empty argument\n' },
    { args: ['done'], input: ' \r\n' },
  ];
  for (const { args, input } of attempts) {
    const result = run(withName(file, 'Alice', args), { input });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /done only leaves the square and does not accept a message/);
    assert.match(result.stderr, /square done --help\n$/);
    assert.deepEqual((await loadSquare(file)).acts, before);
  }
  const result = run(withName(file, 'Alice', ['done']));
  assert.equal(result.status, 0, result.stderr);
  const acts = (await loadSquare(file)).acts;
  assert.deepEqual(acts.map((activity) => activity.kind), ['join', 'done']);
  assert.equal(Object.hasOwn(acts.at(-1), 'body'), false);
});

test('done help teaches leaving with no message argument', () => {
  const result = run(['done', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--as <name> done\n/);
  assert.match(result.stdout, /done takes no message/);
  assert.doesNotMatch(result.stdout, /final|handoff|done \[/);
});
