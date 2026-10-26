import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { readSquareSnapshot } from '../dist/artifact.js';
import { Square, SquareError } from '../dist/index.js';
import { build, persistSquare, run, tempSquare, withName } from './square-cli-helpers.js';

function rejectsDoneBody(error) {
  return error instanceof SquareError && error.code === 'invalid_args'
    && /done only leaves the square and does not accept a message/.test(error.message);
}

test('done rejects supplied bodies without changing participation or history', async () => {
  const square = Square.inMemory({ markdown: 'context', body: { channel: 'test', session: 'done-bodies' } });
  try {
    const alice = (await square.join('Alice')).participant;
    await square.join('Bob');
    await alice.listen('Bob');
    const before = (await square.history({ limit: 100 })).activities;
    for (const body of ['a message', ' \r\n', null, 0, {}]) {
      await assert.rejects(() => alice.done(body), rejectsDoneBody);
      assert.deepEqual((await square.history({ limit: 100 })).activities, before);
      assert.deepEqual((await alice.listening()).listening, ['Bob']);
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
    const alice = (await square.join('Alice')).participant;
    const bob = (await square.join('Bob')).participant;
    await alice.express('the one activity');
    await bob.hold('pause');
    await alice.done('');
  }, { hardCap: 1 });
  const state = (await readSquareSnapshot(file)).state;
  assert.deepEqual(state.acts.map((activity) => activity.kind), ['join', 'join', 'say', 'hold', 'done']);
  assert.equal(Object.hasOwn(state.acts.at(-1), 'body'), false);
});

test('participant done rejects bodies before joining or rejoining', async () => {
  const file = tempSquare();
  assert.equal(build(file).status, 0);
  const square = await Square.at({ path: file, env: { ...process.env }, body: { channel: 'test', session: 'done-before-join' } });
  const app = await square.participant('Alice');
  for (const body of ['a message', ' \n', null, false]) {
    await assert.rejects(() => app.done(body), rejectsDoneBody);
    assert.deepEqual((await readSquareSnapshot(file)).state.acts, []);
  }
  await square.join('Alice');
  const joined = await square.participant('Alice');
  await joined.done();
  const before = (await readSquareSnapshot(file)).state.acts;
  await assert.rejects(() => joined.done('another message'), rejectsDoneBody);
  assert.deepEqual((await readSquareSnapshot(file)).state.acts, before);
  await square.close();
});

test('CLI done rejects argument and stdin payloads without leaving or posting', async () => {
  const file = await persistSquare(async ({ square }) => { await square.join('Alice'); });
  const before = (await readSquareSnapshot(file)).state.acts;
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
    assert.deepEqual((await readSquareSnapshot(file)).state.acts, before);
  }
  const result = run(withName(file, 'Alice', ['done']));
  assert.equal(result.status, 0, result.stderr);
  const acts = (await readSquareSnapshot(file)).state.acts;
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
