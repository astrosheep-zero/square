import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/index.js';
import { loadSquare } from '../dist/artifact.js';
import { run, tempSquare, withName } from './square-cli-helpers.js';

async function setup(t, file) {
  const square = file ? await Square.build({ path: file, markdown: 'test' }) : Square.inMemory({ markdown: 'test' });
  t.after(() => square.close());
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const first = await alice.express('first', { force: true, mentions: ['Bob'] });
  const body = 'complete-body-'.repeat(500) + 'END-OF-BODY';
  const second = await alice.express(body, { force: true, mentions: ['Bob'] });
  return { square, alice, bob, first: first.activity, second: second.activity, body };
}

test('exact catch acknowledges only its id and repeats without changing observations', async (t) => {
  const file = tempSquare();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { bob, first, second, body } = await setup(t, file);
  const caught = await bob.catch({ id: second.id });
  assert.deepEqual(caught.activities.map((item) => item.id), [second.id]);
  assert.equal(caught.activities[0].body, body);
  assert.equal(caught.remaining, 1);
  assert.equal(caught.consumedThrough, 'act/1');
  assert.equal(caught.idleExpired, false);
  const before = (await loadSquare(file)).runtime.observations;
  assert.deepEqual(await bob.catch({ id: second.id }), caught);
  assert.deepEqual((await loadSquare(file)).runtime.observations, before);
  assert.deepEqual((await bob.catch()).activities.map((item) => item.id), [first.id]);
});

test('exact catch refuses unavailable activities and incompatible library options without consuming', async (t) => {
  const { bob, alice, second } = await setup(t);
  const bare = await alice.express('not addressed to Bob', { force: true });
  const errors = [];
  for (const id of ['act/9999', 'act/0', bare.activity.id]) {
    await assert.rejects(bob.catch({ id }), (error) => { errors.push(error.message); return error.code === 'invalid_args'; });
  }
  assert.equal(new Set(errors).size, 1);
  for (const extra of [{ idle: 0 }, { from: [] }, { mention: false }, { limit: 1 }, { limit: undefined }]) {
    await assert.rejects(bob.catch({ id: second.id, ...extra }), { code: 'invalid_args' });
  }
  await assert.rejects(bob.catch({ id: 'garbage' }), { code: 'invalid_args' });
  assert.equal((await bob.catch()).activities.length, 2);
});

test('exact catch preserves bell and standing-listener audience after listening changes', async (t) => {
  const { bob, alice } = await setup(t);
  await bob.listen('Alice');
  const bare = await alice.express('heard while listening', { force: true });
  await bob.ignore('Alice');
  const bell = await alice.express('bell', { force: true, reach: 'bell' });
  for (const activity of [bare.activity, bell.activity]) {
    assert.equal((await bob.catch({ id: activity.id })).activities[0].body, activity.body);
  }
});

test('CLI exact catch returns the full body and rejects conflicting flags before consumption', async (t) => {
  const file = tempSquare();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const { bob, first, second, body } = await setup(t, file);
  for (const args of [
    ['--id'], ['--id', 'bad'], ['--id', second.id, '--id', second.id],
    ...[['--idle', '1s'], ['--from', 'Alice'], ['--mention'], ['--limit', '1'], ['--replace']]
      .map((flags) => ['--id', second.id, ...flags]),
  ]) {
    const result = run(withName(file, 'Bob', ['catch', ...args]));
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.ok(!result.stdout.includes(body));
  }
  for (const flags of [[], ['--now']]) {
    const result = run(withName(file, 'Bob', ['catch', '--id', second.id, ...flags]));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(body), 'exact catch must not clip the body');
  }
  assert.deepEqual((await bob.catch()).activities.map((activity) => activity.id), [first.id]);
});
