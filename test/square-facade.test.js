import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Square, SquareError } from '../dist/index.js';
import { readSquareSnapshot, writeSquareFile } from '../dist/artifact.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { sweepPending } from '../dist/delivery-operations.js';
import { wakeGraceMs } from '../dist/notifications.js';
import { ROUTE_FRESH_MS } from '../dist/routes.js';
import { upsertWakeRoute } from './wake-routes.js';
import { readLedgerRecords } from './host-ledger-fixtures.js';

test('fixed facade builds, opens, and exposes participant activity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const square = await Square.build({
    path: squarePath,
    markdown: '# context',
    clock: () => 10,
  });
  const alice = (await square.join('Alice')).participant;
  const bob = (await square.join('Bob')).participant;
  const expressed = await alice.express('hello @Bob', { force: true, mentions: ['Bob'] });
  assert.equal(expressed.activity.id, 'act/2');
  assert.equal(((await bob.history({ limit: null })).activities).at(-1).body, 'hello @Bob');
  await square.close();

  const reopened = await Square.at({ path: squarePath });
  assert.deepEqual(((await reopened.history({ limit: null })).activities).map((activity) => activity.id), ['act/0', 'act/1', 'act/2']);
  await reopened.close();
});

test('opening a file square validates and projects unchanged persisted state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-facade-cache-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const built = await Square.build({ path: squarePath, markdown: '# context' });
  await built.close();

  const persisted = (await readSquareSnapshot(squarePath)).state;
  try {
    const square = await Square.at({ path: squarePath });
    const snapshot = await square.snapshot();
    assert.match(snapshot.context, /^# context(?:\n|$)/);
    assert.equal(snapshot.actCount, 0);
    assert.deepEqual((await square.history({ limit: null })).activities, []);
    assert.deepEqual((await square.participants()).participants, []);
    await square.close();
    assert.deepEqual((await readSquareSnapshot(squarePath)).state, persisted);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('participant history defaults to the recent ten activities in ascending order', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = (await square.join('Alice')).participant;
  const bob = (await square.join('Bob')).participant;
  for (let index = 0; index < 12; index += 1) {
    await alice.express(`message ${index} @Bob`, { force: true, mentions: ['Bob'] });
  }
  const recent = (await bob.history()).activities;
  assert.equal(recent.length, 10);
  assert.deepEqual(recent.map((activity) => activity.id), Array.from({ length: 10 }, (_, index) => `act/${index + 4}`));
  assert.deepEqual(((await bob.history({ limit: 3, order: 'desc' })).activities).map((activity) => activity.id), ['act/13', 'act/12', 'act/11']);
  assert.equal(((await bob.history({ limit: 14 })).activities).length, 14);
  await square.close();
});

test('participant history reads the full archive', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = (await square.join('Alice')).participant;
  const bob = (await square.join('Bob')).participant;
  await alice.express('before listening', { force: true });
  await bob.listen('Alice');
  await alice.express('after listening', { force: true });

  const history = (await bob.history({ limit: 20 })).activities;
  const before = history.find((activity) => activity.body === 'before listening');
  const after = history.find((activity) => activity.body === 'after listening');
  assert.equal(before?.body, 'before listening');
  assert.equal(after?.body, 'after listening');
  await square.close();
});

test('participant history pages around stable activity ids without overlap', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = (await square.join('Alice')).participant;
  for (let index = 0; index < 6; index += 1) await alice.express(`message ${index}`, { force: true });
  assert.deepEqual(((await alice.history({ limit: 3 })).activities).map((activity) => activity.id), ['act/4', 'act/5', 'act/6']);
  assert.deepEqual(((await alice.history({ before: 'act/4', limit: 3 })).activities).map((activity) => activity.id), ['act/1', 'act/2', 'act/3']);
  assert.deepEqual(((await alice.history({ before: 'act/4', limit: 3, order: 'desc' })).activities).map((activity) => activity.id), ['act/3', 'act/2', 'act/1']);
  assert.deepEqual(((await alice.history({ after: 'act/3', limit: 3 })).activities).map((activity) => activity.id), ['act/4', 'act/5', 'act/6']);
  await assert.rejects(() => alice.history({ before: 'act/4', after: 'act/3', limit: 3 }), /cannot combine before and after cursors/);
  await square.close();
});

test('idle catch wakes for a committed activity and expires while quiet', async () => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  const alice = (await square.join('Alice')).participant;
  const bob = (await square.join('Bob')).participant;
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
  const env = {
    ...process.env,
    HOME: root,
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: 'codex-session',
    OPENCODE_SESSION_ID: '',
    PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_DISABLE_PASEO_WAKE: '1',
    SQUARE_REGISTRY: path.join(root, 'registry.ndjsonl'),
    SQUARE_HOST_LEDGER_ROOT: path.join(root, 'host-ledger-user'),
  };
  const square = await Square.build({ path: squarePath, markdown: 'context', env });
  try {
    const alice = (await square.join('Alice')).participant;
    const bob = (await square.join('Bob')).participant;
    await bob.catch();
    const routeBefore = (await readSquareSnapshot(squarePath)).state.routes.find((route) => route.participant === 'Bob');
    assert.ok(routeBefore);

    const snapshot = () => ({
      artifact: fs.readFileSync(squarePath),
      presence: readLedgerRecords(env.SQUARE_HOST_LEDGER_ROOT, 'presence'),
    });
    const waiting = bob.catch({ idle: 900 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const during = snapshot();
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Self-side publication must not rewrite the artifact or presence records while quiet.
    assert.deepEqual(snapshot(), during);

    const expressed = await alice.express('wake @Bob', { force: true, mentions: ['Bob'] });
    const caught = await waiting;
    assert.deepEqual(caught.activities, [{ ...expressed.activity, perception: 'full' }]);
    assert.equal(caught.consumedThrough, expressed.activity.id);
    assert.equal(caught.idleExpired, false);

    const routeAfter = (await readSquareSnapshot(squarePath)).state.routes.find((route) => route.participant === 'Bob');
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
    assert.equal((await readSquareSnapshot(squarePath)).state.routes.length, 1);

    await upsertWakeRoute(route, { at: 5_000 + 3_600_000 });
    assert.equal(fs.readFileSync(squarePath).equals(bytes), true);
    assert.equal((await readSquareSnapshot(squarePath)).state.routes[0].updatedAt, 5_000);

    // A changed address is a meaningful publication and still replaces the standing route.
    await upsertWakeRoute({ ...route, address: { threadId: 'other-session' } }, { at: 6_000 });
    const replaced = (await readSquareSnapshot(squarePath)).state;
    assert.equal(replaced.routes[0].address.threadId, 'other-session');
    assert.equal(replaced.routes[0].updatedAt, 6_000);

    // An expired route must still be refreshed so a standing publication never goes stale.
    const stale = (await readSquareSnapshot(squarePath)).state;
    stale.routes[0].updatedAt = 6_000 - ROUTE_FRESH_MS;
    await writeSquareFile(squarePath, stale);
    await upsertWakeRoute({ ...route, address: { threadId: 'other-session' } }, { at: 7_000 });
    assert.equal((await readSquareSnapshot(squarePath)).state.routes[0].updatedAt, 7_000);
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
    const hostLedger = createHostLedgerPort();
    const base = await Square.build({ path: squarePath, markdown: 'context', hostLedger });
    await base.close();

    const [left, right] = await Promise.allSettled([
      (async () => {
        const env = { SQUARE_REGISTRY: registryPath, CODEX_THREAD_ID: 'facade-a', CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '' };
        const square = await Square.at({ path: squarePath, hostLedger: createHostLedgerPort(), env });
        try { return await square.join('Alice'); }
        finally { await square.close(); }
      })(),
      (async () => {
        const env = { SQUARE_REGISTRY: registryPath, CODEX_THREAD_ID: 'facade-b', CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '' };
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
    assert.equal((await hostLedger.listPresence({ location: squarePath, participant: 'Alice' })).length, 1);
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
  const alice = (await square.join('Alice')).participant;
  const emojiAkuId = 'aku/🕷️/1234abcd';
  await square.join('Bob');
  await square.join(emojiAkuId);

  const first = await alice.listen('bob');
  assert.deepEqual(first.activity && { kind: first.activity.kind, actor: first.activity.actor, target: first.activity.target }, { kind: 'listen', actor: 'Alice', target: 'bob' });
  assert.equal((await alice.listen('BOB')).activity, null);
  assert.deepEqual((await alice.listening()).listening, ['bob']);
  assert.deepEqual((await square.snapshot()).participants.find((participant) => participant.name === 'Alice')?.listening, ['bob']);
  assert.equal((await alice.ignore('Bob')).activity?.kind, 'ignore');
  assert.equal((await alice.ignore('Bob')).activity, null);
  assert.deepEqual((await alice.listening()).listening, []);

  assert.equal((await alice.listen(emojiAkuId)).activity?.kind, 'listen');
  assert.deepEqual((await alice.listening()).listening, [emojiAkuId]);
  assert.equal((await alice.ignore(emojiAkuId)).activity?.kind, 'ignore');
  assert.deepEqual((await alice.listening()).listening, []);
  await square.close();
});

test('SDK express reenters a departed handle once and SDK catch avoids application body projections', async (t) => {
  let at = 0;
  const square = Square.inMemory({ markdown: 'context', clock: () => ++at });
  t.after(() => square.close());
  const alice = (await square.join('Alice')).participant;
  const bob = (await square.join('Bob')).participant;
  await alice.done();
  // Instrument only read capabilities on this test-owned resource. Mutation
  // hydration belongs in the transaction; SDK calls must not hydrate another
  // full body projection merely to throw it away.
  const artifact = square.square.artifact;
  const read = artifact.read.bind(artifact);
  const projectionReads = [];
  t.mock.method(artifact, 'read', (select, signal) => read((facts) => select(new Proxy(facts, {
    get(target, key) {
      const method = target[key];
      return (...args) => {
        if (key === 'activities' || key === 'sayOrdinals' || key === 'receiptAssignments') projectionReads.push(key);
        return method.apply(target, args);
      };
    },
  })), signal));
  const expressed = await alice.express('back once', { force: true, mentions: ['Bob'] });
  assert.equal(expressed.activity.id, 'act/4');
  assert.deepEqual(projectionReads, []);
  const caught = await bob.catch();
  assert.deepEqual(caught.activities.map((activity) => activity.id), [expressed.activity.id]);
  assert.deepEqual(projectionReads, []);
  const stale = await bob.catch({ idle: 1 }, { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(stale, { activities: [], consumedThrough: expressed.activity.id, idleExpired: true, remaining: 0 });
  assert.deepEqual(projectionReads, []);
  t.mock.restoreAll();
  assert.deepEqual(((await square.history({ limit: null })).activities).map((activity) => activity.kind), ['join', 'join', 'done', 'join', 'say']);
  assert.equal((await square.snapshot()).delivered('Bob', expressed.activity.id), true);
});

test('path-backed SDK uses default wake delivery unless an injected port overrides it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-sdk-wake-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger'), SQUARE_REGISTRY: path.join(root, 'registry.ndjsonl'),
    CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '',
    CODEX_THREAD_ID: 'sdk-default-session', SQUARE_DISABLE_PASEO_WAKE: '1' };
  const square = await Square.build({ path: squarePath, markdown: 'default SDK wake', env });
  let overridden;
  t.after(async () => {
    await overridden?.close();
    await square.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const alice = (await square.join('Alice')).participant;
  await square.join('Bob');
  // An absent Stop boundary prevents external sending while still proving that
  // the default transport, rather than an undefined port, ran its real adapter.
  const first = await alice.express('default adapter', { force: true, mentions: ['Bob'] });
  assert.deepEqual(first.delivery, { attempted: 1, accepted: 0, failed: 1, unknown: 0, notCapable: 0 });
  const requests = [];
  overridden = await Square.at({ path: squarePath, env, wakeTransport: {
    async attempt(request, _timeout, beforeSend) {
      assert.equal(await beforeSend(), true);
      requests.push(request);
      return { outcome: 'accepted' };
    },
  } });
  const second = await ((await overridden.join('Alice')).participant).express('injected adapter', { force: true, mentions: ['Bob'] });
  assert.deepEqual(second.delivery, { attempted: 1, accepted: 1, failed: 0, unknown: 0, notCapable: 0 });
  assert.deepEqual(requests.map((request) => [request.participant, request.activity]), [['Bob', second.activity.id]]);
});

test('recognize returns only the current locally bound participant without changing presence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-recognize-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registryPath = path.join(root, 'sessions.ndjsonl');
  const previousRegistry = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registryPath;
  try {
    const square = await Square.build({ path: squarePath, markdown: 'context' });
    const alice = (await square.join('Alice')).participant;
    const before = (await square.snapshot()).actCount;
    await createHostLedgerPort().ensurePresence({ location: squarePath, participant: alice.name, session: 'alice-session', channel: 'codex' });
    assert.equal((await square.recognize({ CODEX_THREAD_ID: 'alice-session' }))?.name, 'Alice');
    assert.equal(await square.recognize({ CODEX_THREAD_ID: 'missing-session' }), null);
    assert.equal((await square.snapshot()).actCount, before);
    await square.join('Bob');
    await createHostLedgerPort().ensurePresence({ location: squarePath, participant: 'Bob', session: 'alice-session', channel: 'codex' });
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

test('a completed catch reads no sweep evidence and leaves unrelated eligible work selectable', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-catch-completion-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const env = {
    ...process.env,
    SQUARE_HOST_LEDGER_ROOT: path.join(root, 'host-ledger'),
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
    CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '',
    SQUARE_DISABLE_PASEO_WAKE: '0',
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const built = await Square.build({ path: squarePath, markdown: 'context', env });
  const alice = (await built.join('Alice')).participant;
  await built.join('Bob');
  await built.join('Carol');
  const forBob = await alice.express('for Bob @Bob', { force: true, mentions: ['Bob'] });
  const forCarol = await alice.express('for Carol @Carol', { force: true, mentions: ['Carol'] });
  await built.close();

  // Bob's attention is genuine eligible wake work: a live route and a live owner session.
  await upsertWakeRoute({
    location: squarePath, participant: 'Bob', sessionId: 'bob-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'bob-session' },
  }, { env });
  await createHostLedgerPort({ rootPath: env.SQUARE_HOST_LEDGER_ROOT })
    .ensurePresence({ location: squarePath, participant: 'Bob', session: 'bob-session', channel: 'paseo' });

  // Wake evidence is the sweep's input. Recording only evidence access keeps this
  // probe about notification selection, not about the ownership reads catch needs.
  const EVIDENCE_ACCESS = new Set(['listEvidence', 'listWakeAttempts', 'claimWakeAttempt']);
  const evidenceReads = [];
  const ledger = createHostLedgerPort({ rootPath: env.SQUARE_HOST_LEDGER_ROOT });
  const observed = new Proxy(ledger, {
    get(target, key) {
      const member = target[key];
      if (typeof member !== 'function') return member;
      return (...args) => {
        if (EVIDENCE_ACCESS.has(String(key))) evidenceReads.push(String(key));
        return member.apply(target, args);
      };
    },
  });
  const square = await Square.at({ path: squarePath, hostLedger: observed, env });
  t.after(() => square.close());
  const carol = (await square.join('Carol')).participant;
  evidenceReads.length = 0;
  const caught = await carol.catch();
  assert.deepEqual(caught.activities.map((activity) => activity.id), [forCarol.activity.id]);
  assert.equal(caught.remaining, 0);
  assert.deepEqual(evidenceReads, []);

  // Bob's unrelated work is genuinely selectable: the same recorder sees the real
  // selector read evidence and return his activity once completion is out of the way.
  const selected = await sweepPending({
    artifact: square.square.artifact, hostLedger: observed, location: squarePath,
    now: Date.now() + 10_000, graceMs: wakeGraceMs(env), limit: 8,
  });
  assert.equal(evidenceReads.includes('listEvidence'), true);
  assert.deepEqual(selected, [Number(forBob.activity.id.slice('act/'.length))]);
});
