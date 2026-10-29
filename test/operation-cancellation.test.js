import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Square } from '../dist/square-api.js';
import { createArtifactPort, prepareSquareBuild, readSquareSnapshot } from '../dist/artifact.js';
import { resourceWithArtifact } from './fixtures/resource-with-artifact.js';

function aborted(message = 'cancelled') {
  const controller = new AbortController();
  controller.abort(new Error(message));
  return controller;
}

const body = (session) => ({ channel: 'test', session });

async function tempDirectory(prefix) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { fs, path, root };
}

test('pre-aborted lifecycle operations do not mutate the artifact', async () => {
  const square = Square.inMemory({ markdown: 'context' });
  const before = await square.snapshot();
  await assert.rejects(() => square.join('Alice', { body: body('memory') }, { signal: aborted().signal }), /cancelled/);
  await assert.rejects(() => square.reattach('Bob', { body: body('memory') }, { signal: aborted().signal }), /cancelled/);
  assert.equal((await square.snapshot()).actCount, before.actCount);
  await square.close();
});

test('request operations abort under an exclusive artifact lock without a deferred mutation', async () => {
  const { fs, path, root } = await tempDirectory('square-request-cancel-');
  const location = path.join(root, 'SQUARE.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const writerBody = body('writer');
  const readerBody = body('reader');
  const built = await Square.build({ path: location, markdown: 'context', env });
  const writer = (await built.join('Writer', { body: writerBody })).participant;
  await built.close();
  const readerSquare = await Square.at({ path: location, env });
  await readerSquare.join('Reader', { body: readerBody });
  await readerSquare.close();
  const writerSquare = await Square.at({ path: location, env });
  await (await writerSquare.participant('Writer', { body: writerBody })).express('unread', { force: true, mentions: ['Reader'] });
  await writerSquare.close();

  const before = await readSquareSnapshot(location);
  const database = new DatabaseSync(location);
  database.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  const requests = [
    async square => (await square.participant('Reader', { body: readerBody })).catch({}, { signal: controller.signal }),
    async square => (await square.participant('Writer', { body: writerBody })).express('cancelled', { force: true }, { signal: controller.signal }),
    async square => square.join('Newcomer', { body: body('newcomer') }),
  ];
  const pending = requests.map(async operate => {
    const square = await Square.at({ cwd: root, env, path: location }, { signal: controller.signal });
    try { await operate(square); } finally { await square.close(); }
  });
  const abort = setTimeout(() => controller.abort(new Error('cancelled')), 50);
  let deadline;
  try {
    await Promise.race([
      Promise.all(pending.map(operation => assert.rejects(operation, /cancelled/))),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('cancellation waited for the artifact lock')), 1000); }),
    ]);
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
    database.exec('ROLLBACK');
    database.close();
    await Promise.allSettled(pending);
    try { assert.deepEqual(await readSquareSnapshot(location), before); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

test('cancelled force-build leaves no replacement after the artifact lock is released', async t => {
  const { fs, path, root } = await tempDirectory('square-build-cancel-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'SQUARE.square');
  const built = await Square.build({ cwd: root, path: location, markdown: 'original', hardCap: 7 });
  await built.close();
  const before = await readSquareSnapshot(location);
  const lock = new DatabaseSync(location);
  lock.exec('BEGIN EXCLUSIVE');
  const controller = new AbortController();
  const pending = Square.build({ path: location, markdown: 'must not replace original', hardCap: 2, force: true }, { signal: controller.signal });
  const abort = setTimeout(() => controller.abort(new Error('force-build cancelled')), 50);
  let deadline;
  try {
    await Promise.race([
      assert.rejects(pending, /force-build cancelled/),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('force-build ignored cancellation while locked')), 1000); }),
    ]);
  } finally {
    clearTimeout(abort);
    clearTimeout(deadline);
    lock.exec('ROLLBACK');
    lock.close();
    await Promise.allSettled([pending]);
  }
  assert.deepEqual(await readSquareSnapshot(location), before);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith('.tmp')), []);
});

test('a published build keeps its result when cancellation follows publication', async t => {
  const fs = (await import('node:fs')).default;
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'square-build-committed-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'SQUARE.square');
  const controller = new AbortController();
  const link = fs.promises.link;
  fs.promises.link = async (...args) => { await link(...args); controller.abort(new Error('late response cancellation')); };
  try {
    const result = await Square.build({ path: location, env: {}, markdown: 'published', hardCap: 3 }, { signal: controller.signal });
    assert.equal(result.location, location);
    assert.equal((await result.status()).hardCap, 3);
    await result.close();
  } finally { fs.promises.link = link; }
  assert.equal(controller.signal.aborted, true);
  assert.equal((await readSquareSnapshot(location)).state.hardCap, 3);
});

test('idle catch aborts without consuming activity added later', async () => {
  const square = Square.inMemory({ markdown: 'context' });
  const alice = (await square.join('Alice', { body: body('memory') })).participant;
  const bob = (await square.join('Bob', { body: body('memory') })).participant;
  await bob.catch();
  const controller = new AbortController();
  const waiting = bob.catch({ idle: 60_000 }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/);
  const activity = await alice.express('after cancellation', { force: true, mentions: ['Bob'] });
  const caught = await bob.catch();
  assert.equal(caught.activities[0].id, activity.activity.id);
  await square.close();
});

test('memory change wait removes abort listeners on normal settlement', async () => {
  const cell = createArtifactPort(':memory:', prepareSquareBuild({ force: false, hardCap: null }, 'context'));
  const body = { channel: 'test', session: 'watcher' };
  await cell.transactAs({ kind: 'join', participant: 'Watcher', body }, facts => facts.land({ kind: 'join', actor: 'Watcher', at: 0 }));
  const seat = (await cell.read(facts => facts.seat('Watcher'))).value;
  const baseline = await cell.revision();
  const controller = new AbortController();
  const waiting = cell.changed(baseline, 60_000, controller.signal);
  await cell.transactAs({ kind: 'participant', seat }, facts => facts.putLease('Watcher', { leaseId: 'lease', heartbeatAt: 1, expiresAt: 60_000 }));
  assert.equal(await waiting, true);
  controller.abort(new Error('late cancellation'));
  await cell.close();
});

test('abort inside a transition before commit rolls back the whole change', async () => {
  const cell = createArtifactPort(':memory:', prepareSquareBuild({ force: false, hardCap: null }, 'context'));
  const controller = new AbortController();
  const authority = { kind: 'join', participant: 'Alice', body: body('alice') };
  await assert.rejects(() => cell.transactAs(authority, facts => {
    facts.land({ kind: 'join', actor: 'Alice', at: 1 });
    controller.abort(new Error('response discarded'));
  }, controller.signal), /response discarded/);
  const header = (await cell.read(facts => facts.header())).value;
  assert.equal(header.revision, 0);
  assert.equal(header.lastActIndex, -1);
  assert.equal(header.nextActIndex, 0);
  await cell.close();
});

test('post-commit express preserves its result after response cancellation', async t => {
  const artifact = createArtifactPort(':memory:', prepareSquareBuild({}, 'context'));
  t.after(() => artifact.close());
  const square = await resourceWithArtifact(t, artifact);
  const writer = (await square.join('Writer', { body: body('memory') })).participant;
  const controller = new AbortController();
  const transactAs = artifact.transactAs.bind(artifact);
  artifact.transactAs = async (authority, fn, signal) => {
    const result = await transactAs(authority, fn, signal);
    controller.abort(new Error('response discarded'));
    return result;
  };
  const result = await writer.express('committed', { force: true }, { signal: controller.signal });
  assert.equal(result.activity.body, 'committed');
  assert.equal((await square.history()).activities.at(-1).body, 'committed');
});

test('post-commit catch preserves its receipt and result before return cancellation', async t => {
  const artifact = createArtifactPort(':memory:', prepareSquareBuild({}, 'context'));
  t.after(() => artifact.close());
  const square = await resourceWithArtifact(t, artifact);
  const alice = (await square.join('Alice', { body: body('memory') })).participant;
  const bob = (await square.join('Bob', { body: body('memory') })).participant;
  await bob.catch();
  await alice.express('boundary catch', { force: true, mentions: ['Bob'] });
  const controller = new AbortController();
  const transactAs = artifact.transactAs.bind(artifact);
  artifact.transactAs = async (authority, fn, signal) => {
    const result = await transactAs(authority, fn, signal);
    controller.abort(new Error('response discarded'));
    return result;
  };
  const result = await bob.catch({ observe: true }, { signal: controller.signal });
  assert.equal(result.activities[0].body, 'boundary catch');
  assert.equal(result.observation.enrichmentUnavailable, true);
  assert.deepEqual((await bob.catch()).activities, []);
});

test('a result-assembly failure after express commit retains landed certainty and its activity id', async t => {
  const artifact = createArtifactPort(':memory:', prepareSquareBuild({}, 'context'));
  t.after(() => artifact.close());
  const square = await resourceWithArtifact(t, artifact);
  const writer = (await square.join('Writer', { body: body('memory') })).participant;
  const transactAs = artifact.transactAs.bind(artifact);
  artifact.transactAs = async (...args) => {
    const result = await transactAs(...args);
    return { ...result, value: { ...result.value, stored: { ...result.value.stored,
      get kind() { throw new Error('public conversion failed after landing'); },
    } } };
  };
  await assert.rejects(writer.express('landed despite assembly failure'), error => {
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Writer', subject: 'caller', expressEffect: 'landed', landedId: 'act/1' });
    return /public conversion failed/.test(error.message);
  });
  assert.equal((await square.history()).activities.at(-1).body, 'landed despite assembly failure');
});

test('concurrent joins from one body establish one artifact seat and one join activity', async t => {
  const { fs, path, root } = await tempDirectory('square-concurrent-join-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'SQUARE.square');
  const coordinate = body('same-session');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const square = await Square.build({ path: location, markdown: 'context', env });
  const peer = await Square.at({ path: location, env });
  try {
    await Promise.all([square.join('Same', { body: coordinate }), peer.join('Same', { body: coordinate })]);
    assert.equal((await square.history()).activities.filter(activity => activity.kind === 'join').length, 1);
    const artifact = createArtifactPort(location);
    try { assert.deepEqual((await artifact.read(facts => facts.seatsForBody(coordinate))).value.map(seat => seat.participant), ['Same']); }
    finally { await artifact.close(); }
  } finally { await Promise.all([square.close(), peer.close()]); }
});
