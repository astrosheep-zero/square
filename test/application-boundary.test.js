import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square } from '../dist/square-application.js';
import { createSquareApplication } from '../dist/square-application.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { readSquareSnapshot } from '../dist/artifact.js';
import { hostLedgerForEnv, readParticipantOwner } from '../dist/registry.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { recordCodexBoundary } from '../dist/codex-boundary-state.js';


test('application operations use explicit context and return plain data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'application-test' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = createSquareApplication({ cwd: root, env, squarePath: './square.square', participant: 'rei' });
  const joined = await app.join();
  assert.equal(joined.data.kind, 'joined');
  const landed = await app.express('literal body', { mentions: [] });
  assert.equal(landed.data.activity.body, 'literal body');
  assert.equal(landed.projection.participant, 'rei');
  assert.equal(landed.projection.standingCount, 1);
  assert.equal(landed.projection.ownActivityCount, 1);
  const history = await app.history();
  assert.equal(history.data.activities.at(-1)?.body, 'literal body');
  await app.express('bell body', { force: true, reach: 'bell' });
  assert.equal((await app.history()).data.activities.at(-1)?.reach, 'bell');
  const caught = await app.catch({});
  assert.ok(Array.isArray(caught.data.activities));
  assert.deepEqual((await app.history({ fixed: 'bell body' })).data.activities.map((activity) => activity.body), ['bell body']);
  assert.deepEqual((await app.history({ fixed: 'bell.body' })).data.activities, []);
  const reconnected = await app.join();
  assert.equal(reconnected.data.kind, 'reconnected');
  const status = await app.status();
  assert.equal('delivered' in status.data, false);
  assert.deepEqual(JSON.parse(JSON.stringify(status.data)), status.data);
  const archive = createSquareApplication({ cwd: root, env, squarePath: './square.square' });
  const paged = await archive.history({ after: joined.data.activity?.id });
  assert.equal(paged.data.activities.at(-1)?.body, 'bell body');
  assert.equal(paged.data.activities.at(-1)?.reach, 'bell');
});

test('application path resolution is per context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-path-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = createSquareApplication({ cwd: root, env: { ...process.env }, squarePath: './square.square', participant: 'aoi' });
  assert.equal((await app.join()).data.participant, 'aoi');
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
  assert.equal((await foreign.join({ takeover: true })).data.kind, 'taken-over');
  assert.equal((await foreign.join()).data.kind, 'reconnected');
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
  assert.equal((await first.join()).data.participant, 'rei');
  assert.equal((await second.join()).data.participant, 'aoi');
  assert.equal((await first.join()).data.kind, 'reconnected');
  assert.equal((await second.join()).data.kind, 'reconnected');
});

test('participant discovery reads the injected ledger for the current session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-discovery-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const env = {
    ...process.env,
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_PARTICIPANT_NAME: '',
    CLAUDE_CODE_SESSION_ID: '',
    OPENCODE_SESSION_ID: '',
    PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    CODEX_THREAD_ID: 'discovery-session',
  };
  // The injected ledger lives outside the env-derived root: discovery must read it, not env.
  const hostLedger = createHostLedgerPort({ rootPath: path.join(root, 'injected-ledger') });
  await hostLedger.ensurePresence({ location: squarePath, participant: 'rei', session: 'discovery-session', channel: 'codex' });
  const app = createSquareApplication({ cwd: root, env, squarePath, hostLedger });
  assert.equal((await app.join()).data.participant, 'rei');
  // The env-derived ledger knows nothing: only the injected ledger carries the name.
  const envOnly = createSquareApplication({ cwd: root, env, squarePath });
  await assert.rejects(() => envOnly.join(), (error) => error.code === 'invalid_args');
});

test('a reused application discovers the current session binding on every operation', async (t) => {
  const { cwd, squarePath, env } = await fixture(t);
  const hostLedger = createHostLedgerPort({ rootPath: path.join(cwd, 'injected-discovery-ledger') });
  const context = { cwd, squarePath, env: { ...env, SQUARE_PARTICIPANT_NAME: '' }, hostLedger };
  const discovered = createSquareApplication(context);
  await createSquareApplication({ ...context, participant: 'Alice' }).join();
  assert.equal((await discovered.join()).data.participant, 'Alice');
  await discovered.done();
  assert.deepEqual(await hostLedger.listPresence({ location: squarePath, session: env.CODEX_THREAD_ID }), []);
  await createSquareApplication({ ...context, participant: 'Bob' }).join();

  const expressed = await discovered.express('new binding, same application', { force: true, noMention: true });
  assert.equal(expressed.data.activity.actor, 'Bob');
  assert.equal(expressed.projection.reentry, undefined);
  const bindings = await hostLedger.listPresence({ location: squarePath, session: env.CODEX_THREAD_ID });
  assert.deepEqual(bindings.map((binding) => binding.participant), ['Bob']);
  const history = (await discovered.history()).data.activities;
  assert.equal(history.filter((activity) => activity.kind === 'join' && activity.actor === 'Alice').length, 1);
  assert.equal(history.filter((activity) => activity.kind === 'join' && activity.actor === 'Bob').length, 1);
  assert.deepEqual((await discovered.status()).data.participants.map(({ name, state }) => ({ name, state })).sort((left, right) => left.name.localeCompare(right.name)), [
    { name: 'Alice', state: 'done' }, { name: 'Bob', state: 'active' },
  ]);
});

test('open failure after explicit or discovered selection retains express unsent and the selected name', async (t) => {
  const { cwd, squarePath, env } = await fixture(t);
  const hostLedger = createHostLedgerPort({ rootPath: path.join(cwd, 'injected-open-failure-ledger') });
  const context = { cwd, squarePath, env: { ...env, SQUARE_PARTICIPANT_NAME: '' }, hostLedger };
  const explicit = createSquareApplication({ ...context, participant: 'Alice' });
  const discovered = createSquareApplication(context);
  await explicit.join();
  const before = (await readSquareSnapshot(squarePath)).state;
  const moved = `${squarePath}.unavailable`;
  await fs.promises.rename(squarePath, moved);
  try {
    for (const application of [explicit, discovered]) {
      await assert.rejects(application.express('must remain unsent', { force: true, noMention: true }), (error) => {
        assert.equal(error.code, 'unavailable');
        assert.deepEqual(error.operation, {
          operation: 'express', participant: 'Alice', subject: 'caller', expressEffect: 'unsent',
        });
        return true;
      });
    }
  } finally { await fs.promises.rename(moved, squarePath); }
  assert.deepEqual((await readSquareSnapshot(squarePath)).state, before);
  assert.deepEqual((await hostLedger.listPresence({ location: squarePath, session: env.CODEX_THREAD_ID })).map((binding) => binding.participant), ['Alice']);
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
  assert.deepEqual(progress, [{ kind: 'waiting', reason: 'held', holder: 'owner', holdReason: 'pause' }]);
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
  assert.equal((await fresh.join({ takeover: true })).data.kind, 'joined');
  const owner = createSquareApplication({ cwd: root, env: ownerEnv, squarePath, participant: 'done-name' });
  await owner.join();
  await owner.done();
  const rejoin = createSquareApplication({ cwd: root, env: otherEnv, squarePath, participant: 'done-name' });
  assert.equal((await rejoin.join({ takeover: true })).data.kind, 'joined');
});

async function fixture(t, { clock, wakeTransport } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-invariant-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const squarePath = path.join(cwd, 'SQUARE.square');
  const env = { ...process.env, SQUARE_REGISTRY: path.join(cwd, 'registry.ndjsonl'),
    SQUARE_HOST_LEDGER_ROOT: path.join(cwd, 'ledger'), SQUARE_DISABLE_PASEO_WAKE: '1',
    CLAUDE_CODE_SESSION_ID: '', OPENCODE_SESSION_ID: '', PI_SESSION_ID: '', PASEO_AGENT_ID: '',
    CODEX_THREAD_ID: 'alice-session', SQUARE_PARTICIPANT_NAME: undefined };
  const built = await Square.build({ path: squarePath, markdown: 'context', env, clock });
  await built.close();
  const app = (participant, overrides = {}) => createSquareApplication({ cwd, squarePath, env, clock, wakeTransport, participant, ...overrides });
  return { cwd, squarePath, env, app };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function started(control, readiness) {
  return { signal: control.signal, onProgress: (event) => {
    if (event.kind === 'catch-started') readiness.resolve(event);
  } };
}

test('leased catch replacement fences the old waiter and leaves consumption to the replacement', { timeout: 5000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = app('Alice'), bob = app('Bob');
  await alice.join();
  await bob.join();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
  t.after(() => controller.abort());
  const firstReady = deferred();
  const first = alice.catch({ idle: 60_000, from: ['Bob'] }, started({ signal }, firstReady));
  assert.equal((await firstReady.promise).replaced, false);
  const active = await alice.catch({ idle: 60_000 });
  assert.equal(active.data.status, 'already-active');
  assert.equal(active.projection.stop, 'already-active');
  assert.equal(active.projection.waitStarted, false);
  const secondReady = deferred();
  const second = alice.catch({ idle: 60_000, replace: true, from: ['bob'] }, started({ signal }, secondReady));
  assert.equal((await secondReady.promise).replaced, true);
  const superseded = await first;
  assert.equal(superseded.data.status, 'replaced');
  assert.deepEqual(superseded.data.activities, []);
  assert.equal(superseded.projection.stop, 'replaced');
  // Old waiter cleanup must not erase the lease that now belongs to the replacement.
  assert.ok((await readSquareSnapshot(squarePath)).state.runtime.leases.Alice);
  const expressed = await bob.express('only the replacement consumes', { force: true, mentions: ['Alice'] });
  const caught = await second;
  assert.deepEqual(caught.data.activities.map((activity) => activity.id), [expressed.data.activity.id]);
  assert.equal(caught.projection.replaced, true);
  assert.equal((await readSquareSnapshot(squarePath)).state.runtime.leases.Alice, undefined);
  assert.deepEqual((await alice.catch()).data.activities, []);
});

test('cancelled leased catch releases its lease without consuming future attention', { timeout: 5000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = app('Alice'), bob = app('Bob');
  await alice.join();
  await bob.join();
  const before = (await readSquareSnapshot(squarePath)).state.runtime.observations;
  const controller = new AbortController();
  await assert.rejects(alice.catch({ idle: 60_000 }, {
    signal: controller.signal,
    onProgress: (event) => { if (event.kind === 'catch-started') controller.abort(new Error('cancelled catch')); },
  }), (error) => {
    assert.deepEqual(error.operation, { operation: 'catch', participant: 'Alice', subject: 'caller' });
    return true;
  });
  const cancelled = (await readSquareSnapshot(squarePath)).state;
  assert.equal(cancelled.runtime.leases.Alice, undefined);
  assert.deepEqual(cancelled.runtime.observations, before);
  const expressed = await bob.express('after cancellation', { force: true, mentions: ['Alice'] });
  assert.deepEqual((await alice.catch()).data.activities.map((activity) => activity.id), [expressed.data.activity.id]);
});

test('held catch does not expire or consume until the hold is released', { timeout: 5000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = app('Alice'), bob = app('Bob');
  await alice.join();
  await bob.join();
  const expressed = await bob.express('pending during hold', { force: true, mentions: ['Alice'] });
  await bob.hold('pause consumption');
  const controller = new AbortController();
  t.after(() => controller.abort());
  const ready = deferred();
  let finished = false;
  const waiting = alice.catch({ idle: 20 }, started({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) }, ready));
  waiting.then(() => { finished = true; }, () => { finished = true; });
  await ready.promise;
  await sleep(80);
  assert.equal(finished, false);
  const held = (await readSquareSnapshot(squarePath)).state;
  assert.ok(held.runtime.leases.Alice);
  assert.notEqual(held.runtime.observations.Alice?.[expressed.data.activity.id]?.state, 'seen');
  await bob.resume();
  const caught = await waiting;
  assert.equal(caught.data.idleExpired, false);
  assert.deepEqual(caught.data.activities.map((activity) => activity.id), [expressed.data.activity.id]);
  assert.equal((await readSquareSnapshot(squarePath)).state.runtime.leases.Alice, undefined);
});

test('quiet idle expiry is structured and leaves no lease or delivered receipt', async (t) => {
  let at = 0;
  const { app, squarePath } = await fixture(t, { clock: () => ++at });
  const alice = app('Alice');
  await alice.join();
  await app('Bob').join();
  const before = (await readSquareSnapshot(squarePath)).state.runtime.observations;
  const caught = await alice.catch({ idle: 1 }, { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(caught.data, { activities: [], consumedThrough: 'act/1', idleExpired: true, remaining: 0 });
  assert.equal(caught.projection.stop, 'stale');
  assert.equal(caught.projection.waitStarted, true);
  const expired = (await readSquareSnapshot(squarePath)).state;
  assert.equal(expired.runtime.leases.Alice, undefined);
  assert.deepEqual(expired.runtime.observations, before);
  const expressed = await app('Bob').express('consume before expiry', { force: true, mentions: ['Alice'] });
  assert.equal((await alice.catch()).data.consumedThrough, expressed.data.activity.id);
  const consumed = (await readSquareSnapshot(squarePath)).state.runtime.observations;
  const stale = await alice.catch({ idle: 1 }, { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(stale.data, { activities: [], consumedThrough: expressed.data.activity.id, idleExpired: true, remaining: 0 });
  assert.deepEqual((await readSquareSnapshot(squarePath)).state.runtime.observations, consumed);
});

test('configured and discovered status viewers perceive directed activity without join or ownership writes', async (t) => {
  const { cwd, squarePath, env, app } = await fixture(t);
  await app('Alice').join();
  await app('Bob').join();
  await app('Cara').join();
  await app('Bob').express('private for Alice', { force: true, mentions: ['Alice'] });
  const ledger = hostLedgerForEnv(env);
  // Discovery is unambiguous for this harness coordinate, independent of env's default name.
  await ledger.ensurePresence({ location: squarePath, participant: 'Alice', session: 'viewer-session', channel: 'codex' });
  const before = (await readSquareSnapshot(squarePath)).state;
  const presenceBefore = await ledger.listPresence({ location: squarePath });
  const configured = createSquareApplication({ cwd, squarePath, env: { ...env, SQUARE_PARTICIPANT_NAME: 'alice' } });
  const discovered = createSquareApplication({ cwd, squarePath, env: { ...env, CODEX_THREAD_ID: 'viewer-session' } });
  for (const viewer of [configured, discovered]) {
    const result = await viewer.status();
    assert.equal(result.projection.viewer, 'Alice');
    assert.equal(result.projection.participant, 'Alice');
    assert.equal(result.projection.latestPerception, 'full');
    assert.deepEqual(result.projection.attentionNames, ['Alice']);
  }
  const other = await app('Cara').status();
  assert.equal(other.projection.latestPerception, 'presence');
  assert.deepEqual(other.projection.attentionNames, ['Cara']);
  const explicit = await configured.status('Cara');
  assert.equal(explicit.projection.viewer, 'Cara');
  assert.equal(explicit.projection.latestPerception, 'presence');
  const ambient = await createSquareApplication({ cwd, squarePath, env: { ...env, CODEX_THREAD_ID: '' } }).status();
  assert.equal(ambient.projection.viewer, '');
  assert.equal(ambient.projection.latestPerception, 'presence');
  assert.deepEqual(new Set(ambient.projection.attentionNames), new Set(['Alice', 'Bob', 'Cara']));
  assert.deepEqual((await readSquareSnapshot(squarePath)).state, before);
  assert.deepEqual(await ledger.listPresence({ location: squarePath }), presenceBefore);
});

test('structured express refusals distinguish caller/filter/recipient and do not land rejected bodies', async (t) => {
  const { app } = await fixture(t);
  const alice = app('Alice');
  await alice.join();
  await app('Bob').join();
  await assert.rejects(alice.express('unknown recipient', { mentions: ['Nobody'], force: true }), (error) => {
    assert.equal(error.facts.activityUnsent, true);
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'recipient', expressEffect: 'unsent' });
    return true;
  });
  await assert.rejects(alice.catch({ from: ['Nobody'] }), (error) => {
    assert.deepEqual(error.operation, { operation: 'catch', participant: 'Alice', subject: 'filter' });
    return true;
  });
  await alice.hold('no wait');
  await assert.rejects(alice.express('held body', { noWait: true, force: true }), (error) => {
    assert.equal(error.code, 'held');
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'caller', expressEffect: 'unsent' });
    return true;
  });
  assert.equal((await alice.history()).data.activities.some((activity) => activity.kind === 'say'), false);
});

test('malformed and blank environment clocks refuse with a code, while an injected clock wins', async (t) => {
  const { cwd, squarePath, env } = await fixture(t);
  for (const SQUARE_NOW_MS of ['not-a-clock', '']) {
    const invalid = createSquareApplication({ cwd, squarePath, env: { ...env, SQUARE_NOW_MS }, participant: 'Alice' });
    assert.throws(() => invalid.now(), (error) => error.code === 'invalid_args');
    await assert.rejects(invalid.join(), (error) => error.code === 'invalid_args');
  }
  assert.deepEqual((await readSquareSnapshot(squarePath)).state.acts, []);
  const injected = createSquareApplication({ cwd, squarePath, env: { ...env, SQUARE_NOW_MS: 'not-a-clock' }, clock: () => 42, participant: 'Alice' });
  assert.equal(injected.now(), 42);
  assert.equal((await injected.join()).data.activity.at, 42);
});

test('application captures environment and honors an injected wake transport without changing process env', async (t) => {
  const { cwd, squarePath, env, app } = await fixture(t);
  await app('Bob').join();
  const ledger = hostLedgerForEnv(env);
  const requests = [];
  const wakeTransport = { async attempt(request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    requests.push(request);
    return { outcome: 'accepted' };
  } };
  const suppliedEnv = { ...env };
  const context = { cwd, squarePath: './SQUARE.square', env: suppliedEnv, participant: 'Alice', hostLedger: ledger, wakeTransport };
  const captured = createSquareApplication(context);
  const processBefore = { ...process.env };
  suppliedEnv.CODEX_THREAD_ID = 'wrong-session';
  suppliedEnv.SQUARE_LOCATION = 'wrong.square';
  suppliedEnv.SQUARE_PARTICIPANT_NAME = 'Wrong';
  const joined = await captured.join();
  assert.equal(joined.data.participant, 'Alice');
  assert.equal(joined.projection.location, squarePath);
  assert.equal((await readParticipantOwner(squarePath, 'Alice', ledger)).session, 'alice-session');
  const expressed = await captured.express('captured delivery', { force: true, mentions: ['Bob'] });
  assert.equal(expressed.projection.delivery.accepted, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].participant, 'Bob');
  assert.deepEqual({ ...process.env }, processBefore);
});

test('path-backed application express uses default wake delivery when no port is supplied', async (t) => {
  const { env, app } = await fixture(t);
  await app('Alice').join();
  await app('Bob').join();
  // There is deliberately no current Codex Stop boundary: the real default
  // adapter records its bounded refusal and cannot send to an external harness.
  const expressed = await app('Alice').express('default wake', { force: true, mentions: ['Bob'] });
  assert.deepEqual(expressed.projection.delivery, { attempted: 1, accepted: 0, failed: 1, unknown: 0, notCapable: 0 });
  // Unavailable transport attempts release custody; those diagnostics are
  // deliberately absent from ordinary behavior-safe evidence/attempt reads.
  const evidence = await hostLedgerForEnv(env).listEvidence({ kind: 'wake', participant: 'Bob', activity: expressed.data.activity.id, includeReleased: true });
  assert.ok(evidence.some((row) => row.outcome === 'released' && row.routeKind === 'codex-queue' && row.signature === 'boundary_not_stopped'));
});

test('default Codex delivery uses the captured boundary, executable and child environment', { skip: process.platform === 'win32' }, async (t) => {
  const { cwd, squarePath, env, app } = await fixture(t);
  const output = path.join(cwd, 'captured-queue.json');
  const executable = path.join(cwd, 'captured-codex.cjs');
  fs.writeFileSync(executable, `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.SQUARE_CAPTURED_QUEUE_OUTPUT, JSON.stringify({
      args: process.argv.slice(2), marker: process.env.SQUARE_CAPTURED_QUEUE_MARKER,
    }));
  `, { mode: 0o700 });
  const suppliedEnv = { ...env,
    CODEX_THREAD_ID: `captured-default-${path.basename(cwd)}`,
    SQUARE_CODEX_BOUNDARIES: path.join(cwd, 'captured-boundaries.json'),
    SQUARE_CODEX_BIN: executable,
    SQUARE_CAPTURED_QUEUE_OUTPUT: output,
    SQUARE_CAPTURED_QUEUE_MARKER: 'captured-child-env',
  };
  await recordCodexBoundary(suppliedEnv.CODEX_THREAD_ID, 'Stop', suppliedEnv);
  await app('Bob', { env: suppliedEnv }).join();
  const alice = createSquareApplication({ cwd, squarePath, env: suppliedEnv, participant: 'Alice' });
  const processBefore = { ...process.env };
  const threadId = suppliedEnv.CODEX_THREAD_ID;
  suppliedEnv.CODEX_THREAD_ID = 'changed-after-creation';
  suppliedEnv.SQUARE_CODEX_BOUNDARIES = path.join(cwd, 'wrong-boundaries.json');
  suppliedEnv.SQUARE_CODEX_BIN = path.join(cwd, 'missing-executable');
  suppliedEnv.SQUARE_CAPTURED_QUEUE_OUTPUT = path.join(cwd, 'wrong-output.json');
  suppliedEnv.SQUARE_CAPTURED_QUEUE_MARKER = 'changed-after-creation';
  await alice.join();
  const expressed = await alice.express('body must not enter queue awareness', { force: true, mentions: ['Bob'] });
  assert.deepEqual(expressed.projection.delivery, { attempted: 1, accepted: 1, failed: 0, unknown: 0, notCapable: 0 });
  const sent = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(sent.args.slice(0, 4), ['queue', '--thread', threadId, '--message']);
  assert.equal(sent.args.length, 5);
  assert.equal(sent.marker, 'captured-child-env');
  assert.ok(sent.args[4].includes(`attention: ${expressed.data.activity.id} for Bob from Alice`));
  assert.equal(sent.args[4].includes('body must not enter queue awareness'), false);
  assert.equal(fs.existsSync(suppliedEnv.SQUARE_CAPTURED_QUEUE_OUTPUT), false);
  assert.deepEqual({ ...process.env }, processBefore);
});

test('application enrichment failure retains a landed ID and never repeats the expression', async (t) => {
  let enrichment = false;
  const wakeTransport = { async attempt(_request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    enrichment = true;
    return { outcome: 'accepted' };
  } };
  const clock = () => { if (enrichment) throw new Error('projection clock unavailable'); return Date.now(); };
  const { app } = await fixture(t, { clock, wakeTransport });
  await app('Alice').join();
  await app('Bob').join();
  await assert.rejects(app('Alice').express('committed once', { force: true, mentions: ['Bob'] }), (error) => {
    assert.equal(error.message, 'projection clock unavailable');
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'caller', expressEffect: 'landed', landedId: 'act/2' });
    return true;
  });
  enrichment = false;
  assert.deepEqual((await app().history()).data.activities.filter((activity) => activity.kind === 'say').map((activity) => activity.id), ['act/2']);
});

test('host publication failure cannot erase a committed application express result', async (t) => {
  const { cwd, squarePath, env, app } = await fixture(t);
  const delegate = hostLedgerForEnv(env);
  let armed = false;
  const listPresence = async (...args) => {
    if (armed && (await readSquareSnapshot(squarePath)).state.acts.some((activity) => activity.kind === 'say' && activity.body === 'runtime uncertain')) {
      throw new Error('post-commit owner observation unavailable');
    }
    return delegate.listPresence(...args);
  };
  // The real file port has prototype methods. Preserve its full capability
  // surface and receiver; object spread is not a HostLedgerPort decorator.
  const hostLedger = new Proxy(delegate, { get(target, key) {
    if (key === 'listPresence') return listPresence;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const alice = createSquareApplication({ cwd, squarePath, env, participant: 'Alice', hostLedger });
  await alice.join();
  await app('Bob').join();
  armed = true;
  const expressed = await alice.express('runtime uncertain', { force: true, mentions: ['Bob'] });
  assert.equal(expressed.data.activity.id, 'act/2');
  armed = false;
  assert.equal((await app().history()).data.activities.filter((activity) => activity.body === 'runtime uncertain').length, 1);
});

test('postcommit catch publication and presence failure cannot erase its consumed public page', async (t) => {
  let committed = false;
  const clock = () => { if (committed) throw new Error('postcommit clock unavailable'); return 100; };
  const { cwd, squarePath, env, app } = await fixture(t, { clock });
  const delegate = hostLedgerForEnv(env);
  let armed = false;
  const hostLedger = new Proxy(delegate, { get(target, key) {
    if (key === 'listPresence') return async (...args) => {
      const observations = (await readSquareSnapshot(squarePath)).state.runtime.observations;
      if (armed && observations.Bob?.['act/2']?.state === 'seen') {
        committed = true;
        throw new Error('postcommit publication unavailable');
      }
      return delegate.listPresence(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await app('Alice').join();
  const bob = createSquareApplication({ cwd, squarePath, env, participant: 'Bob', hostLedger, clock });
  await bob.join();
  const expressed = await app('Alice').express('selected once', { force: true, mentions: ['Bob'] });
  armed = true;
  const caught = await bob.catch();
  assert.equal(committed, true, 'the injected failures begin only after the delivered receipt');
  assert.deepEqual(caught.data, {
    activities: [{ ...expressed.data.activity, perception: 'full' }],
    consumedThrough: 'act/2', remaining: 0, idleExpired: false,
  });
  assert.equal(caught.projection.now, 100);
  assert.equal(caught.projection.standingCount, 2);
  assert.equal(caught.projection.ownActivityCount, 0);
  assert.equal(caught.projection.held, false);
  assert.deepEqual(caught.projection.sayNumbers, { 2: 1 });
  assert.equal(caught.projection.enrichmentUnavailable, true);
  assert.equal('activities' in caught.projection, false, 'the public page has no parallel raw projection');
  committed = false;
  armed = false;
  assert.deepEqual((await bob.catch()).data.activities, []);
});

test('application selected-row corruption reports unknown, not a safely unsent refusal', async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = app('Alice');
  await alice.join();
  await app('Bob').join();
  const original = await alice.express('original', { force: true, mentions: ['Bob'] });
  await alice.catch();
  const database = new DatabaseSync(squarePath);
  const before = database.prepare('SELECT revision, next_act_index FROM square_meta').get();
  try {
    database.prepare('UPDATE activities SET payload_json=? WHERE act_index=2').run('{"body":42,"mentions":["Bob"]}');
  } finally { database.close(); }
  await assert.rejects(alice.express('uncertain reply', { force: true, reply: original.data.activity.id }), (error) => {
    assert.equal(error.code, 'invalid_args');
    assert.notEqual(error.facts?.activityUnsent, true);
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'caller', expressEffect: 'unknown' });
    return true;
  });
  const after = new DatabaseSync(squarePath);
  try { assert.deepEqual(after.prepare('SELECT revision, next_act_index FROM square_meta').get(), before); }
  finally { after.close(); }
});

test('return disposes a quiet stream even while next is pending, without activity to wake it', { timeout: 4000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const before = (await readSquareSnapshot(squarePath)).state;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const iterator = app().stream({ start: { kind: 'tail', last: 0 } }, { signal: controller.signal })[Symbol.asyncIterator]();
  const pending = iterator.next();
  // Give the observer a chance to enter its quiet await; do not land any activity.
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await sleep(30);
  assert.equal(settled, false);
  let timer;
  try {
    const disposal = iterator.return();
    const results = await Promise.race([
      Promise.all([pending, disposal]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('quiet iterator.return deadlocked behind pending next')), 1500); }),
    ]);
    assert.deepEqual(results, [{ value: undefined, done: true }, { value: undefined, done: true }]);
    assert.deepEqual(await iterator.next(), { value: undefined, done: true });
  } finally { clearTimeout(timer); controller.abort(); }
  assert.deepEqual((await readSquareSnapshot(squarePath)).state, before);
});
