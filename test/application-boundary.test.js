import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-wiring.js';
import { createSquareApplication } from '../dist/square-application.js';
import { lookupSession } from '../dist/registry.js';

test('application operations use explicit context and return plain data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'application-test' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = createSquareApplication({ cwd: root, env, squarePath: './square.square', participant: 'rei' });
  const joined = await app.join();
  assert.equal(joined.kind, 'joined');
  const landed = await app.express('literal body', { mentions: [] });
  assert.equal(landed.activity.body, 'literal body');
  const history = await app.history();
  assert.equal(history.at(-1)?.body, 'literal body');
  const bell = await app.express('bell body', { force: true, reach: 'bell' });
  assert.equal((await app.history()).at(-1)?.reach, 'bell');
  const caught = await app.catch({});
  assert.ok(Array.isArray(caught.activities));
  assert.deepEqual((await app.history({ fixed: 'bell body' })).map((activity) => activity.body), ['bell body']);
  assert.deepEqual(await app.history({ fixed: 'bell.body' }), []);
  const reconnected = await app.join();
  assert.equal(reconnected.kind, 'reconnected');
  const status = await app.status();
  assert.equal('delivered' in status, false);
  const archive = createSquareApplication({ cwd: root, env, squarePath: './square.square' });
  const paged = await archive.history({ after: joined.activity?.id });
  assert.equal(paged.at(-1)?.body, 'bell body');
  assert.equal(paged.at(-1)?.reach, 'bell');
});

test('application path resolution is per context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-path-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = createSquareApplication({ cwd: root, env: { ...process.env }, squarePath: './square.square', participant: 'aoi' });
  assert.equal((await app.join()).participant, 'aoi');
});

test('explicit identities stay isolated and reject a foreign owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-owner-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const ownerEnv = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'owner' };
  const foreignEnv = { ...ownerEnv, CODEX_THREAD_ID: 'foreign' };
  const owner = createSquareApplication({ cwd: root, env: ownerEnv, squarePath, participant: 'rei' });
  await owner.join();
  const foreign = createSquareApplication({ cwd: root, env: foreignEnv, squarePath, participant: 'rei' });
  await assert.rejects(() => foreign.join(), (error) => error.code === 'already_joined');
  assert.equal((await foreign.join({ takeover: true })).kind, 'taken-over');
  assert.equal((await foreign.join()).kind, 'reconnected');
  await assert.rejects(() => owner.join(), (error) => error.code === 'already_joined');
});

test('participant defaults and native identities use the captured environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-snapshot-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const env = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'first', SQUARE_PARTICIPANT_NAME: 'rei' };
  const first = createSquareApplication({ cwd: root, env, squarePath });
  env.CODEX_THREAD_ID = 'second';
  env.SQUARE_PARTICIPANT_NAME = 'aoi';
  const second = createSquareApplication({ cwd: root, env, squarePath });
  assert.equal((await first.join()).participant, 'rei');
  assert.equal((await second.join()).participant, 'aoi');
  assert.equal((await first.join()).kind, 'reconnected');
  assert.equal((await second.join()).kind, 'reconnected');
});

test('done keeps a same-session rejoin that happens after serialized cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-rejoin-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'same-session' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = createSquareApplication({ cwd: root, env, squarePath, participant: 'rei' });
  await app.join();
  const originalDone = Square.prototype.doneOwnedSession;
  Square.prototype.doneOwnedSession = async function(name, body, epoch, control) {
    const result = await originalDone.call(this, name, body, epoch, control);
    await this.join(name);
    return result;
  };
  try {
    await app.done('finished');
    assert.deepEqual(await lookupSession('same-session', Date.now(), env), [{ name: 'rei', squarePath: await fs.promises.realpath(squarePath) }]);
  } finally {
    Square.prototype.doneOwnedSession = originalDone;
  }
});

test('committed takeover returns its result when cancellation arrives after commit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-takeover-'));
  const squarePath = path.join(root, 'square.square');
  const ownerEnv = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'owner' };
  const foreignEnv = { ...ownerEnv, CODEX_THREAD_ID: 'foreign' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const owner = createSquareApplication({ cwd: root, env: ownerEnv, squarePath, participant: 'rei' });
  await owner.join();
  const app = createSquareApplication({ cwd: root, env: foreignEnv, squarePath, participant: 'rei' });
  const original = Square.prototype.takeoverWithActivity;
  const controller = new AbortController();
  Square.prototype.takeoverWithActivity = async function(name, control) {
    const result = await original.call(this, name, control);
    controller.abort();
    return result;
  };
  try {
    const result = await app.join({ takeover: true }, { signal: controller.signal });
    assert.equal(result.kind, 'taken-over');
  } finally {
    Square.prototype.takeoverWithActivity = original;
  }
});


test('express exposes held progress through control without printing or serializing it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-progress-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'progress' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const owner = createSquareApplication({ cwd: root, env, squarePath, participant: 'owner' });
  const speaker = createSquareApplication({ cwd: root, env: { ...env, CODEX_THREAD_ID: 'speaker' }, squarePath, participant: 'speaker' });
  await owner.join();
  await speaker.join();
  await owner.hold('pause');
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(() => speaker.express('waiting', { mentions: ['owner'] }, { signal: controller.signal, onProgress: (event) => { progress.push(event); controller.abort(); } }));
  assert.deepEqual(progress, [{ kind: 'waiting', reason: 'held' }]);
});


test('express exposes throttled progress through control without a second retry loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-throttle-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'throttle' };
  const built = await Square.build({ path: squarePath, markdown: 'context', throttlePerMinute: 1 });
  await built.close();
  const app = createSquareApplication({ cwd: root, env, squarePath, participant: 'rei' });
  await app.join();
  await app.express('first', { force: true });
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(() => app.express('second', { force: true }, { signal: controller.signal, onProgress: (event) => { progress.push(event); controller.abort(); } }));
  assert.equal(progress[0]?.kind, 'waiting');
  assert.equal(progress[0]?.reason, 'throttled');
  assert.ok(progress[0]?.delayMs > 0);
});


test('takeover option joins fresh and done names normally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-fresh-kick-'));
  const squarePath = path.join(root, 'square.square');
  const ownerEnv = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'owner' };
  const otherEnv = { ...ownerEnv, CODEX_THREAD_ID: 'other' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const fresh = createSquareApplication({ cwd: root, env: otherEnv, squarePath, participant: 'fresh' });
  assert.equal((await fresh.join({ takeover: true })).kind, 'joined');
  const owner = createSquareApplication({ cwd: root, env: ownerEnv, squarePath, participant: 'done-name' });
  await owner.join();
  await owner.done('left');
  const rejoin = createSquareApplication({ cwd: root, env: otherEnv, squarePath, participant: 'done-name' });
  assert.equal((await rejoin.join({ takeover: true })).kind, 'joined');
});
