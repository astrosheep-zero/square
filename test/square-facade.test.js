import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square, SquareError } from '../dist/index.js';
import { recordJoin } from '../dist/registry.js';

test('fixed facade builds, opens, and exposes participant-scoped activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const square = await Square.build({
    path: squarePath,
    markdown: '# context',
    clock: () => 10,
  });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const expressed = await alice.express('hello @Bob', { force: true });
  assert.equal(expressed.activity.id, 'act/2');
  assert.equal((await bob.history()).at(-1).perception, 'full');
  await square.close();

  const reopened = await Square.at({ path: squarePath });
  assert.deepEqual((await reopened.history()).map((activity) => activity.id), ['act/0', 'act/1', 'act/2']);
  await reopened.close();
});

test('opening a file square validates and projects one unchanged artifact snapshot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-cache-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const built = await Square.build({ path: squarePath, markdown: '# context' });
  await built.close();

  const originalReadFile = fs.promises.readFile;
  let artifactReads = 0;
  fs.promises.readFile = async function (...args) {
    if (args[0] === squarePath) artifactReads += 1;
    return originalReadFile.apply(this, args);
  };
  try {
    const square = await Square.at({ path: squarePath });
    await square.snapshot();
    await square.history();
    await square.participants();
    assert.equal(artifactReads, 1);
    await square.close();
  } finally {
    fs.promises.readFile = originalReadFile;
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal((await bob.history({ limit: 14 })).length, 14);
  await square.close();
});

test('participant history uses listener attention at each activity boundary', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await alice.express('before listening', { force: true });
  await bob.listen('Alice');
  await alice.express('after listening', { force: true });

  const history = await bob.history({ limit: 20 });
  const before = history.find((activity) => activity.body === undefined && activity.kind === 'say');
  const after = history.find((activity) => activity.body === 'after listening');
  assert.equal(before?.perception, 'presence');
  assert.equal(after?.perception, 'full');
  assert.deepEqual((await bob.history({ mention: true })).map((activity) => activity.body), ['after listening']);
  await square.close();
});

test('participant history pages around stable activity ids without overlap', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  for (let index = 0; index < 6; index += 1) await alice.express(`message ${index}`, { force: true });
  assert.deepEqual((await alice.history({ limit: 3 })).map((activity) => activity.id), ['act/4', 'act/5', 'act/6']);
  assert.deepEqual((await alice.history({ before: 'act/4', limit: 3 })).map((activity) => activity.id), ['act/1', 'act/2', 'act/3']);
  assert.deepEqual((await alice.history({ before: 'act/4', limit: 3, order: 'desc' })).map((activity) => activity.id), ['act/3', 'act/2', 'act/1']);
  assert.deepEqual((await alice.history({ after: 'act/3', limit: 3 })).map((activity) => activity.id), ['act/4', 'act/5', 'act/6']);
  await assert.rejects(() => alice.history({ before: 'act/4', after: 'act/3', limit: 3 }), /cannot combine before and after cursors/);
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

test('listener facade commits only edge changes and exposes canonical listener state', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  await square.join('Bob');

  const first = await alice.listen('bob');
  assert.deepEqual(first.activity && { kind: first.activity.kind, actor: first.activity.actor, target: first.activity.target }, { kind: 'listen', actor: 'Alice', target: 'bob' });
  assert.equal((await alice.listen('BOB')).activity, null);
  assert.deepEqual(await alice.listening(), ['bob']);
  assert.deepEqual((await square.snapshot()).participants.find((participant) => participant.name === 'Alice')?.listening, ['bob']);
  assert.equal((await alice.ignore('Bob')).activity?.kind, 'ignore');
  assert.equal((await alice.ignore('Bob')).activity, null);
  assert.deepEqual(await alice.listening(), []);
  await square.close();
});

test('recognize returns only the current locally bound participant without changing presence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-recognize-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registryPath = path.join(root, 'sessions.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registryPath;
  try {
    const square = await Square.build({ path: squarePath, markdown: 'context' });
    const alice = await square.join('Alice');
    const before = (await square.snapshot()).actCount;
    await recordJoin('alice-session', alice.name, squarePath, { channel: 'codex' });
    assert.equal((await square.recognize({ CODEX_THREAD_ID: 'alice-session' }))?.name, 'Alice');
    assert.equal(await square.recognize({ CODEX_THREAD_ID: 'missing-session' }), null);
    assert.equal((await square.snapshot()).actCount, before);
    await square.join('Bob');
    await recordJoin('alice-session', 'Bob', squarePath, { channel: 'codex' });
    assert.equal(await square.recognize({ CODEX_THREAD_ID: 'alice-session' }), null);
    await alice.done();
    assert.equal(await square.recognize({ CODEX_THREAD_ID: 'missing-session' }), null);
    await square.close();
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
