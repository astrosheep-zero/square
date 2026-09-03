import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square, SquareError } from '../dist/index.js';
import { loadSquare, writeSquareFile } from '../dist/artifact.js';
import { recordJoin } from '../dist/registry.js';
import { ROUTE_FRESH_MS, upsertWakeRoute } from '../dist/routes.js';

test('fixed facade builds, opens, and exposes participant activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const square = await Square.build({
    path: squarePath,
    markdown: '# context',
    clock: () => 10,
  });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  const expressed = await alice.express('hello @Bob', { force: true, mentions: ['Bob'] });
  assert.equal(expressed.activity.id, 'act/2');
  assert.equal((await bob.history()).at(-1).body, 'hello @Bob');
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
    await alice.express(`message ${index} @Bob`, { force: true, mentions: ['Bob'] });
  }
  const recent = await bob.history();
  assert.equal(recent.length, 10);
  assert.deepEqual(recent.map((activity) => activity.id), Array.from({ length: 10 }, (_, index) => `act/${index + 4}`));
  assert.deepEqual((await bob.history({ limit: 3, order: 'desc' })).map((activity) => activity.id), ['act/13', 'act/12', 'act/11']);
  assert.equal((await bob.history({ limit: 14 })).length, 14);
  await square.close();
});

test('participant history reads the full archive', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  const bob = await square.join('Bob');
  await alice.express('before listening', { force: true });
  await bob.listen('Alice');
  await alice.express('after listening', { force: true });

  const history = await bob.history({ limit: 20 });
  const before = history.find((activity) => activity.body === 'before listening');
  const after = history.find((activity) => activity.body === 'after listening');
  assert.equal(before?.body, 'before listening');
  assert.equal(after?.body, 'after listening');
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
  const expressed = await alice.express('wake @Bob', { force: true, mentions: ['Bob'] });
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

test('idle catch with a stable route stays quiet and wakes once for an external activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-idle-quiet-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const presenceFile = path.join(root, 'host-ledger-local', 'presence.ndjsonl');
  const env = {
    ...process.env,
    HOME: root,
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: 'codex-session',
    OPENCODE_SESSION_ID: '',
    SQUARE_PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_DISABLE_PASEO_WAKE: '1',
    SQUARE_REGISTRY: path.join(root, 'registry.ndjsonl'),
    SQUARE_HOST_LEDGER_USER: path.join(root, 'host-ledger-user'),
    SQUARE_HOST_LEDGER_LOCAL: path.join(root, 'host-ledger-local'),
  };
  const square = await Square.build({ path: squarePath, markdown: 'context', env });
  try {
    const alice = await square.join('Alice');
    const bob = await square.join('Bob');
    await bob.catch();
    const routeBefore = (await loadSquare(squarePath)).routes.find((route) => route.participant === 'Bob');
    assert.ok(routeBefore);

    const snapshot = () => ({
      artifact: fs.readFileSync(squarePath),
      presence: fs.existsSync(presenceFile) ? fs.readFileSync(presenceFile) : Buffer.alloc(0),
    });
    const waiting = bob.catch({ idle: 900 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const during = snapshot();
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Self-side publication must not rewrite the artifact or the presence file while quiet.
    assert.deepEqual(snapshot(), during);

    const expressed = await alice.express('wake @Bob', { force: true, mentions: ['Bob'] });
    const caught = await waiting;
    assert.deepEqual(caught.activities, [{ ...expressed.activity, perception: 'full' }]);
    assert.equal(caught.consumedThrough, expressed.activity.id);
    assert.equal(caught.idleExpired, false);

    const routeAfter = (await loadSquare(squarePath)).routes.find((route) => route.participant === 'Bob');
    assert.equal(routeAfter.updatedAt, routeBefore.updatedAt);

    const quietExpiry = await bob.catch({ idle: 80 });
    assert.deepEqual(quietExpiry.activities, []);
    assert.equal(quietExpiry.consumedThrough, expressed.activity.id);
    assert.equal(quietExpiry.idleExpired, true);
  } finally {
    await square.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('publishing an unchanged fresh route is a no-op and expiry still refreshes once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-route-idempotent-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  try {
    const route = { location: squarePath, participant: 'Bob', sessionId: 'route-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'route-session' } };
    await upsertWakeRoute(route, { at: 5_000 });
    const bytes = fs.readFileSync(squarePath);
    assert.equal((await loadSquare(squarePath)).routes.length, 1);

    await upsertWakeRoute(route, { at: 5_000 + 3_600_000 });
    assert.equal(fs.readFileSync(squarePath).equals(bytes), true);
    assert.equal((await loadSquare(squarePath)).routes[0].updatedAt, 5_000);

    // A changed address is a meaningful publication and still replaces the standing route.
    await upsertWakeRoute({ ...route, address: { threadId: 'other-session' } }, { at: 6_000 });
    const replaced = await loadSquare(squarePath);
    assert.equal(replaced.routes[0].address.threadId, 'other-session');
    assert.equal(replaced.routes[0].updatedAt, 6_000);

    // An expired route must still be refreshed so a standing publication never goes stale.
    const stale = await loadSquare(squarePath);
    stale.routes[0].updatedAt = 6_000 - ROUTE_FRESH_MS;
    await writeSquareFile(squarePath, stale);
    await upsertWakeRoute({ ...route, address: { threadId: 'other-session' } }, { at: 7_000 });
    assert.equal((await loadSquare(squarePath)).routes[0].updatedAt, 7_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid facade join retains the stable coded error and commits nothing', async () => {
  const square = Square.inMemory({ markdown: 'context' });
  await assert.rejects(square.join('bad name'), (error) => error instanceof SquareError && error.code === 'invalid_name');
  assert.equal((await square.snapshot()).actCount, 0);
  await square.close();
});

test('concurrent facade joins for one participant keep a single live owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-cas-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registryPath = path.join(root, 'sessions.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registryPath;
  try {
    const { createHostLedgerPort } = await import('../dist/host-ledger-file-adapter.js');
    const { lookupParticipant } = await import('../dist/registry.js');
    const hostLedger = createHostLedgerPort();
    const base = await Square.build({ path: squarePath, markdown: 'context', hostLedger });
    await base.close();

    const [left, right] = await Promise.allSettled([
      (async () => {
        const env = { SQUARE_REGISTRY: registryPath, CODEX_THREAD_ID: 'facade-a', CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', SQUARE_PI_SESSION_ID: '', PASEO_AGENT_ID: '' };
        const square = await Square.at({ path: squarePath, hostLedger: createHostLedgerPort(), env });
        try { return await square.join('Alice'); }
        finally { await square.close(); }
      })(),
      (async () => {
        const env = { SQUARE_REGISTRY: registryPath, CODEX_THREAD_ID: 'facade-b', CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', SQUARE_PI_SESSION_ID: '', PASEO_AGENT_ID: '' };
        const square = await Square.at({ path: squarePath, hostLedger: createHostLedgerPort(), env });
        try { return await square.join('Alice'); }
        finally { await square.close(); }
      })(),
    ]);
    const accepted = [left, right].filter((result) => result.status === 'fulfilled');
    const refused = [left, right].filter((result) => result.status === 'rejected');
    assert.equal(accepted.length, 1);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].reason?.code, 'already_joined');
    assert.equal((await lookupParticipant(squarePath, 'Alice')).length, 1);
    const reopened = await Square.at({ path: squarePath });
    assert.equal((await reopened.snapshot()).actCount, 1);
    await reopened.close();
  } finally {
    if (previousRegistry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previousRegistry;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listener facade commits only edge changes and exposes canonical listener state', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = await square.join('Alice');
  const emojiAkuId = 'aku/🕷️/1234abcd';
  await square.join('Bob');
  await square.join(emojiAkuId);

  const first = await alice.listen('bob');
  assert.deepEqual(first.activity && { kind: first.activity.kind, actor: first.activity.actor, target: first.activity.target }, { kind: 'listen', actor: 'Alice', target: 'bob' });
  assert.equal((await alice.listen('BOB')).activity, null);
  assert.deepEqual(await alice.listening(), ['bob']);
  assert.deepEqual((await square.snapshot()).participants.find((participant) => participant.name === 'Alice')?.listening, ['bob']);
  assert.equal((await alice.ignore('Bob')).activity?.kind, 'ignore');
  assert.equal((await alice.ignore('Bob')).activity, null);
  assert.deepEqual(await alice.listening(), []);

  assert.equal((await alice.listen(emojiAkuId)).activity?.kind, 'listen');
  assert.deepEqual(await alice.listening(), [emojiAkuId]);
  assert.equal((await alice.ignore(emojiAkuId)).activity?.kind, 'ignore');
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
