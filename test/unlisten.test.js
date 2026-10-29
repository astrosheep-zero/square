import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { diagnoseSquareFile, readSquareSnapshot } from '../dist/artifact.js';

// One real file exercises the operation, persisted audience, and rebuild together.
test('unlisten removes only its listen edge, preserves landed audience, and keeps mentions and replies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-unlisten-'));
  const location = path.join(root, 'PUBLIC.square');
  const body = "test" + ":" + ('unlisten');
  const square = await Square.build({ path: location, markdown: 'Unlisten' });
  t.after(async () => { await square.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const name of ['Alice', 'Bob', 'Cara']) await square.join(name, { owner: body });
  const alice = await square.participant('Alice', { owner: body }), bob = await square.participant('Bob', { owner: body });
  await bob.listen('Alice');
  await bob.listen('Cara');
  const before = await alice.express('before unlisten', { mentions: ['Cara'], force: true });
  const stopped = await bob.unlisten('ALICE');
  assert.equal(stopped.activity.kind, 'unlisten');
  assert.deepEqual((await bob.listening()).listening, ['Cara']);
  const revision = (await readSquareSnapshot(location)).revision;
  assert.equal((await bob.unlisten('Alice')).activity, null);
  assert.equal((await bob.unlisten('Missing')).activity, null);
  assert.equal((await readSquareSnapshot(location)).revision, revision);

  await alice.express('bare after unlisten', { force: true });
  await alice.express('for Cara after unlisten', { mentions: ['Cara'], force: true });
  await alice.express('direct @Bob after unlisten', { force: true });
  const question = await bob.express('a question', { force: true });
  await alice.express('reply after unlisten', { reply: question.activity.id, force: true });
  assert.deepEqual((await bob.catch()).activities.map(activity => activity.body), [
    'before unlisten', 'direct @Bob after unlisten', 'reply after unlisten',
  ]);

  await bob.ignore('Alice');
  const ignoredRevision = (await readSquareSnapshot(location)).revision;
  assert.equal((await bob.unlisten('Alice')).activity, null);
  assert.equal((await readSquareSnapshot(location)).revision, ignoredRevision);
  await alice.express('blocked @Bob', { force: true });
  assert.deepEqual((await bob.catch()).activities, []);
  await bob.listen('Alice');
  await alice.express('listening again', { force: true });
  assert.deepEqual((await bob.catch()).activities.map(activity => activity.body), ['listening again']);
  assert.equal((await bob.catch({ id: before.activity.id })).activities[0].body, 'before unlisten');
  const history = (await square.history({ limit: null })).activities;
  assert.equal(history.filter(activity => activity.kind === 'unlisten').length, 1);
  assert.equal(history.filter(activity => activity.kind === 'join').length, 3);
  assert.equal(history.some(activity => activity.kind === 'done'), false);
  assert.deepEqual(await diagnoseSquareFile(location), { problems: [], standingCount: 3 });
});
