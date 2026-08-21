import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSquareState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { createApplication } from '../dist/square-engine.js';
import { createFileCell, createMemoryCell } from '../dist/square-storage.js';

function emptyState() {
  return createSquareState({ force: false, hardCap: null }, 'warmup');
}

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function memoryFixture() {
  const cell = createMemoryCell(emptyState());
  return { cell, persisted: async () => (await cell.read()).state };
}

function fileFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-'));
  const squarePath = path.join(root, 'SQUARE.square');
  writeSquareFile(squarePath, emptyState());
  return { cell: createFileCell(squarePath), persisted: async () => loadSquare(squarePath) };
}

async function exerciseApplication(makeFixture) {
  const fixture = makeFixture();
  const { cell } = fixture;
  let now = 100;
  const wakes = [];
  const app = createApplication({
    cell,
    clock: () => (now += 1),
    notifier: {
      wake(recipients, activity) {
        wakes.push({ recipients: [...recipients], activity });
        throw new Error('wake endpoint unavailable');
      },
    },
  });

  const initial = await cell.read();
  await rejectsWithCode(() => app.join('bad name'), 'invalid_name');
  const afterInvalidJoin = await cell.read();
  assert.equal(afterInvalidJoin.version, initial.version);
  assert.deepEqual(afterInvalidJoin.state.acts, []);

  const alice = await app.join('Alice');
  const bob = await app.join('Bob');
  await app.join('Cara');
  assert.deepEqual([alice.activity.id, bob.activity.id], ['act/0', 'act/1']);
  const duplicateJoin = await app.join('alice');
  assert.equal(duplicateJoin.name, 'Alice');
  assert.equal(duplicateJoin.activity, null);
  assert.equal((await cell.read()).state.acts.length, 3);

  const expressed = await app.express('Alice', 'private @Bob', { force: true, reply: 'act/1' });
  assert.deepEqual(expressed, {
    activity: {
      id: 'act/3', at: 106, kind: 'say', actor: 'Alice', body: 'private @Bob', mentions: ['Bob'], reply: 'act/1',
    },
  });
  assert.deepEqual(wakes, [{ recipients: ['Bob'], activity: expressed.activity }]);

  const beforeHistory = await cell.read();
  const anonymous = await app.history({ order: 'asc' });
  const bobHistory = await app.participantHistory('Bob');
  const caraHistory = await app.participantHistory('Cara');
  assert.equal(anonymous.at(-1).body, 'private @Bob');
  assert.equal(bobHistory.at(-1).perception, 'full');
  assert.equal(bobHistory.at(-1).body, 'private @Bob');
  assert.equal(caraHistory.at(-1).perception, 'presence');
  assert.equal('body' in caraHistory.at(-1), false);
  const bobPresentation = await app.historyPresentation({ viewer: 'Bob', lastN: null });
  const caraPresentation = await app.historyPresentation({ viewer: 'Cara', lastN: null });
  const anonymousPresentation = await app.historyPresentation({ lastN: null });
  assert.equal(bobPresentation.activities.at(-1).perception, 'full');
  assert.equal(caraPresentation.activities.at(-1).perception, 'presence');
  assert.equal(anonymousPresentation.activities.at(-1).perception, 'full');
  const afterHistory = await cell.read();
  assert.equal(afterHistory.version, beforeHistory.version);
  assert.deepEqual(afterHistory.state.runtime.cursors, beforeHistory.state.runtime.cursors);
  assert.deepEqual(afterHistory.state.runtime.deliveryReceipts, beforeHistory.state.runtime.deliveryReceipts);

  const caught = await app.catch('Bob', { mention: true });
  assert.deepEqual(caught.activities.at(-1), { ...expressed.activity, perception: 'full' });
  assert.equal(caught.consumedThrough, 'act/3');
  assert.equal(caught.idleExpired, false);
  const committedCatch = await cell.read();
  assert.equal(committedCatch.version, beforeHistory.version + 1);
  assert.equal(committedCatch.state.runtime.cursors.Bob.consumedThroughIndex, 3);
  assert.equal(committedCatch.state.runtime.deliveryReceipts.Bob['act/3'].status, 'delivered');

  const snapshot = await app.snapshot();
  assert.equal(snapshot.delivered('Bob', 'act/3'), true);
  assert.deepEqual(snapshot.participants.map(({ name, consumedThrough }) => [name, consumedThrough]), [
    ['Alice', 'act/3'], ['Bob', 'act/3'], ['Cara', 'act/2'],
  ]);

  await rejectsWithCode(() => app.express('Ghost', 'hello @Alice'), 'not_joined');
  await rejectsWithCode(() => app.done('Ghost'), 'not_joined');
  await rejectsWithCode(() => app.hold('Ghost'), 'not_joined');
  await rejectsWithCode(() => app.resume('Ghost'), 'not_joined');

  const done = await app.done('Alice');
  assert.equal(done.activity.id, 'act/4');
  await rejectsWithCode(() => app.express('Alice', 'again @Bob'), 'already_done');
  await rejectsWithCode(() => app.done('Alice'), 'already_done');
  await rejectsWithCode(() => app.hold('Alice'), 'already_done');
  await rejectsWithCode(() => app.resume('Alice'), 'already_done');
  const rejoined = await app.join('Alice');
  assert.equal(rejoined.activity.id, 'act/5');

  assert.deepEqual((await fixture.persisted()).acts.map((activity) => activity.index), [0, 1, 2, 3, 4, 5]);
  await app.close();
}

for (const [name, makeFixture] of [['memory', memoryFixture], ['file', fileFixture]]) {
  test(`${name} StateCell satisfies the application contract`, async () => {
    await exerciseApplication(makeFixture);
  });
}

test('memory StateCell changed wakes only after a committed version', async () => {
  const cell = createMemoryCell(emptyState());
  const before = await cell.read();
  const waiting = cell.changed(before.version, 500);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cell.transact((state) => ({ state, result: undefined }));
  assert.equal(await waiting, true);
  await cell.close();
});

test('memory StateCell makes a throwing transaction invisible', async () => {
  const cell = createMemoryCell(emptyState());
  const before = await cell.read();
  await assert.rejects(cell.transact((state) => {
    state.acts.push({ kind: 'join', actor: 'lost', at: 1, index: 0 });
    throw new Error('abort');
  }), /abort/);
  const after = await cell.read();
  assert.equal(after.version, before.version);
  assert.deepEqual(after.state.acts, []);
  await cell.close();
});

test('file StateCell serializes concurrent writers in the existing binary artifact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-concurrent-'));
  const squarePath = path.join(root, 'SQUARE.square');
  writeSquareFile(squarePath, emptyState());
  const first = createApplication({ cell: createFileCell(squarePath), clock: () => 100 });
  const second = createApplication({ cell: createFileCell(squarePath), clock: () => 200 });

  await Promise.all([first.join('Alice'), second.join('Bob')]);
  assert.deepEqual(loadSquare(squarePath).acts.map((act) => act.actor).sort(), ['Alice', 'Bob']);
  await first.close();
  await second.close();
});
