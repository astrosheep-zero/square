import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square, squareClock } from '../dist/square-api.js';

import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { createArtifactPort, readSquareSnapshot } from '../dist/artifact.js';
import { hostLedgerForEnv, readParticipantOwner } from '../dist/registry.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { recordCodexBoundary } from '../dist/codex-boundary-state.js';


test('resource operations use explicit context and return concrete results', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'application-test' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = (await Square.at({ cwd: root, env, path: './square.square', participant: 'rei' }));
  const joined = await app.join(undefined, { observe: true });
  assert.equal(joined.kind, 'joined');
  const landed = await (await app.participant()).express('literal body', { mentions: [], observe: true });
  assert.equal(landed.activity.body, 'literal body');
  assert.equal(landed.observation.participant, 'rei');
  assert.equal(landed.observation.standingCount, 1);
  assert.equal(landed.observation.ownActivityCount, 1);
  const history = await app.history({ observe: true });
  assert.equal(history.activities.at(-1).body, 'literal body');
  await (await app.participant()).express('bell body', { force: true, reach: 'bell', observe: true });
  assert.equal((await app.history({ observe: true })).activities.at(-1).reach, 'bell');
  const caught = await (await app.participant()).catch({ ...{}, observe: true });
  assert.ok(Array.isArray(caught.activities));
  assert.deepEqual((await app.history({ fixed: 'bell body', observe: true })).activities.map((activity) => activity.body), ['bell body']);
  assert.deepEqual((await app.history({ fixed: 'bell.body', observe: true })).activities, []);
  const reconnected = await app.join(undefined, { observe: true });
  assert.equal(reconnected.kind, 'reconnected');
  const status = await app.status({ observe: true });
  assert.equal('delivered' in status, false);
  assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  const archive = (await Square.at({ cwd: root, env, path: './square.square' }));
  const paged = await archive.history({ after: joined.activity.id, observe: true });
  assert.equal(paged.activities.at(-1).body, 'bell body');
  assert.equal(paged.activities.at(-1).reach, 'bell');
});

test('resource path resolution is per context', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-path-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const app = (await Square.at({ cwd: root, env: { ...process.env }, path: './square.square', participant: 'aoi' }));
  assert.equal((await app.join(undefined, { observe: true })).participant.name, 'aoi');
});

test('explicit identities stay isolated and reject a foreign owner', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-owner-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const ownerEnv = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'owner' };
  const foreignEnv = { ...ownerEnv, CODEX_THREAD_ID: 'foreign' };
  const owner = (await Square.at({ cwd: root, env: ownerEnv, path: squarePath, participant: 'rei' }));
  await owner.join(undefined, { observe: true });
  const foreign = (await Square.at({ cwd: root, env: foreignEnv, path: squarePath, participant: 'rei' }));
  await assert.rejects(() => foreign.join(undefined, { observe: true }), (error) => error.code === 'already_joined');
  assert.equal((await foreign.join(undefined, { takeover: true, observe: true })).kind, 'taken-over');
  assert.equal((await foreign.join(undefined, { observe: true })).kind, 'reconnected');
  await assert.rejects(() => owner.join(undefined, { observe: true }), (error) => error.code === 'already_joined');
});

test('participant defaults and native identities use the captured environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-snapshot-'));
  const squarePath = path.join(root, 'square.square');
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const env = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'first', SQUARE_PARTICIPANT_NAME: 'rei' };
  const first = (await Square.at({ cwd: root, env, path: squarePath }));
  env.CODEX_THREAD_ID = 'second';
  env.SQUARE_PARTICIPANT_NAME = 'aoi';
  const second = (await Square.at({ cwd: root, env, path: squarePath }));
  assert.equal((await first.join(undefined, { observe: true })).participant.name, 'rei');
  assert.equal((await second.join(undefined, { observe: true })).participant.name, 'aoi');
  assert.equal((await first.join(undefined, { observe: true })).kind, 'reconnected');
  assert.equal((await second.join(undefined, { observe: true })).kind, 'reconnected');
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
  const app = (await Square.at({ cwd: root, env, path: squarePath, hostLedger }));
  assert.equal((await app.join(undefined, { observe: true })).participant.name, 'rei');
  // The env-derived ledger knows nothing: only the injected ledger carries the name.
  const envOnly = (await Square.at({ cwd: root, env, path: squarePath }));
  await assert.rejects(() => envOnly.join(undefined, { observe: true }), (error) => error.code === 'invalid_args');
});

test('a reused resource discovers the current session binding on every operation', async (t) => {
  const { cwd, squarePath, env } = await fixture(t);
  const hostLedger = createHostLedgerPort({ rootPath: path.join(cwd, 'injected-discovery-ledger') });
  const context = { cwd, squarePath, env: { ...env, SQUARE_PARTICIPANT_NAME: '' }, hostLedger };
  const discovered = (await Square.at({ ...context, path: context.squarePath }));
  await (await Square.at({ ...context, path: context.squarePath, participant: 'Alice' })).join();
  assert.equal((await discovered.join(undefined, { observe: true })).participant.name, 'Alice');
  await (await discovered.participant()).done(undefined, { observe: true });
  assert.deepEqual(await hostLedger.listPresence({ location: squarePath, session: env.CODEX_THREAD_ID }), []);
  await (await Square.at({ ...context, path: context.squarePath, participant: 'Bob' })).join();

  const expressed = await (await discovered.participant()).express('new binding, same resource', { force: true, noMention: true, observe: true });
  assert.equal(expressed.activity.actor, 'Bob');
  assert.equal(expressed.observation.reentry, undefined);
  const bindings = await hostLedger.listPresence({ location: squarePath, session: env.CODEX_THREAD_ID });
  assert.deepEqual(bindings.map((binding) => binding.participant), ['Bob']);
  const history = (await discovered.history({ observe: true })).activities;
  assert.equal(history.filter((activity) => activity.kind === 'join' && activity.actor === 'Alice').length, 1);
  assert.equal(history.filter((activity) => activity.kind === 'join' && activity.actor === 'Bob').length, 1);
  assert.deepEqual((await discovered.status({ observe: true })).participants.map(({ name, state }) => ({ name, state })).sort((left, right) => left.name.localeCompare(right.name)), [
    { name: 'Alice', state: 'done' }, { name: 'Bob', state: 'active' },
  ]);
});

test('participant selection is nonmutating and open failure cannot claim a name', async (t) => {
  const { squarePath, env } = await fixture(t);
  const square = await Square.at({ path: squarePath, env });
  const before = (await readSquareSnapshot(squarePath)).state;
  const selected = await square.participant('Never');
  assert.equal(selected.name, 'Never');
  assert.deepEqual((await readSquareSnapshot(squarePath)).state, before);
  await square.close();
  const moved = `${squarePath}.unavailable`;
  await fs.promises.rename(squarePath, moved);
  try { await assert.rejects(Square.at({ path: squarePath, env }), (error) => error.code === 'unavailable'); }
  finally { await fs.promises.rename(moved, squarePath); }
  assert.deepEqual((await readSquareSnapshot(squarePath)).state, before);
});

test('express exposes held progress through control without printing or serializing it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-progress-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'progress' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const owner = (await Square.at({ cwd: root, env, path: squarePath, participant: 'owner' }));
  const speaker = (await Square.at({ cwd: root, env: { ...env, CODEX_THREAD_ID: 'speaker' }, path: squarePath, participant: 'speaker' }));
  await owner.join(undefined, { observe: true });
  await speaker.join(undefined, { observe: true });
  await (await owner.participant()).hold('pause', { observe: true });
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(async () => (await speaker.participant()).express('waiting', { mentions: ['owner'], observe: true }, { signal: controller.signal, onProgress: (event) => { progress.push(event); controller.abort(); } }));
  assert.deepEqual(progress, [{ kind: 'waiting', reason: 'held', holder: 'owner', holdReason: 'pause' }]);
});


test('express exposes throttled progress through control without a second retry loop', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-throttle-'));
  const squarePath = path.join(root, 'square.square');
  const env = { ...process.env, CODEX_THREAD_ID: 'throttle' };
  const built = await Square.build({ path: squarePath, markdown: 'context', throttlePerMinute: 1 });
  await built.close();
  const app = (await Square.at({ cwd: root, env, path: squarePath, participant: 'rei' }));
  await app.join(undefined, { observe: true });
  await (await app.participant()).express('first', { force: true, observe: true });
  const controller = new AbortController();
  const progress = [];
  await assert.rejects(async () => (await app.participant()).express('second', { force: true, observe: true }, { signal: controller.signal, onProgress: (event) => { progress.push(event); controller.abort(); } }));
  assert.equal(progress[0].kind, 'waiting');
  assert.equal(progress[0].reason, 'throttled');
  assert.ok(progress[0].delayMs > 0);
});


test('takeover option joins fresh and done names normally', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-application-fresh-kick-'));
  const squarePath = path.join(root, 'square.square');
  const ownerEnv = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), CODEX_THREAD_ID: 'owner' };
  const otherEnv = { ...ownerEnv, CODEX_THREAD_ID: 'other' };
  const built = await Square.build({ path: squarePath, markdown: 'context' });
  await built.close();
  const fresh = (await Square.at({ cwd: root, env: otherEnv, path: squarePath, participant: 'fresh' }));
  assert.equal((await fresh.join(undefined, { takeover: true, observe: true })).kind, 'joined');
  const owner = (await Square.at({ cwd: root, env: ownerEnv, path: squarePath, participant: 'done-name' }));
  await owner.join(undefined, { observe: true });
  await (await owner.participant()).done(undefined, { observe: true });
  const rejoin = (await Square.at({ cwd: root, env: otherEnv, path: squarePath, participant: 'done-name' }));
  assert.equal((await rejoin.join(undefined, { takeover: true, observe: true })).kind, 'joined');
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
  const app = async (participant, overrides = {}) => (await Square.at({ cwd, path: squarePath, env, clock, wakeTransport, participant, ...overrides }));
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
  const alice = (await app('Alice')), bob = (await app('Bob'));
  await alice.join(undefined, { observe: true });
  await bob.join(undefined, { observe: true });
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
  t.after(() => controller.abort());
  const firstReady = deferred();
  const first = (await alice.participant()).catch({ idle: 60_000, from: ['Bob'], observe: true }, started({ signal }, firstReady));
  assert.equal((await firstReady.promise).replaced, false);
  const active = await (await alice.participant()).catch({ idle: 60_000, observe: true });
  assert.equal(active.status, 'already-active');
  assert.equal(active.observation.stop, 'already-active');
  assert.equal(active.observation.waitStarted, false);
  const secondReady = deferred();
  const second = (await alice.participant()).catch({ idle: 60_000, replace: true, from: ['bob'], observe: true }, started({ signal }, secondReady));
  assert.equal((await secondReady.promise).replaced, true);
  const superseded = await first;
  assert.equal(superseded.status, 'replaced');
  assert.deepEqual(superseded.activities, []);
  assert.equal(superseded.observation.stop, 'replaced');
  // Old waiter cleanup must not erase the lease that now belongs to the replacement.
  assert.ok((await readSquareSnapshot(squarePath)).state.runtime.leases.Alice);
  const expressed = await (await bob.participant()).express('only the replacement consumes', { force: true, mentions: ['Alice'], observe: true });
  const caught = await second;
  assert.deepEqual(caught.activities.map((activity) => activity.id), [expressed.activity.id]);
  assert.equal(caught.observation.replaced, true);
  assert.equal((await readSquareSnapshot(squarePath)).state.runtime.leases.Alice, undefined);
  assert.deepEqual((await (await alice.participant()).catch({ observe: true })).activities, []);
});

test('cancelled leased catch releases its lease without consuming future attention', { timeout: 5000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = (await app('Alice')), bob = (await app('Bob'));
  await alice.join(undefined, { observe: true });
  await bob.join(undefined, { observe: true });
  const before = (await readSquareSnapshot(squarePath)).state.runtime.observations;
  const controller = new AbortController();
  await assert.rejects((await alice.participant()).catch({ idle: 60_000, observe: true }, {
    signal: controller.signal,
    onProgress: (event) => { if (event.kind === 'catch-started') controller.abort(new Error('cancelled catch')); },
  }), (error) => {
    assert.deepEqual(error.operation, { operation: 'catch', participant: 'Alice', subject: 'caller' });
    return true;
  });
  const cancelled = (await readSquareSnapshot(squarePath)).state;
  assert.equal(cancelled.runtime.leases.Alice, undefined);
  assert.deepEqual(cancelled.runtime.observations, before);
  const expressed = await (await bob.participant()).express('after cancellation', { force: true, mentions: ['Alice'], observe: true });
  assert.deepEqual((await (await alice.participant()).catch({ observe: true })).activities.map((activity) => activity.id), [expressed.activity.id]);
});

test('held catch does not expire or consume until the hold is released', { timeout: 5000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = (await app('Alice')), bob = (await app('Bob'));
  await alice.join(undefined, { observe: true });
  await bob.join(undefined, { observe: true });
  const expressed = await (await bob.participant()).express('pending during hold', { force: true, mentions: ['Alice'], observe: true });
  await (await bob.participant()).hold('pause consumption', { observe: true });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const ready = deferred();
  let finished = false;
  const waiting = (await alice.participant()).catch({ idle: 20, observe: true }, started({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) }, ready));
  waiting.then(() => { finished = true; }, () => { finished = true; });
  await ready.promise;
  await sleep(80);
  assert.equal(finished, false);
  const held = (await readSquareSnapshot(squarePath)).state;
  assert.ok(held.runtime.leases.Alice);
  assert.notEqual(held.runtime.observations.Alice?.[expressed.activity.id].state, 'seen');
  await (await bob.participant()).resume({ observe: true });
  const caught = await waiting;
  assert.equal(caught.idleExpired, false);
  assert.deepEqual(caught.activities.map((activity) => activity.id), [expressed.activity.id]);
  assert.equal((await readSquareSnapshot(squarePath)).state.runtime.leases.Alice, undefined);
});

test('quiet idle expiry is structured and leaves no lease or delivered receipt', async (t) => {
  let at = 0;
  const { app, squarePath } = await fixture(t, { clock: () => ++at });
  const alice = (await app('Alice'));
  await alice.join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  const before = (await readSquareSnapshot(squarePath)).state.runtime.observations;
  const caught = await (await alice.participant()).catch({ idle: 1, observe: true }, { signal: AbortSignal.timeout(2000) });
  const { observation: caughtObservation, ...caughtData } = caught;
  assert.deepEqual(caughtData, { activities: [], consumedThrough: 'act/1', idleExpired: true, remaining: 0 });
  assert.equal(caught.observation.stop, 'stale');
  assert.equal(caught.observation.waitStarted, true);
  const expired = (await readSquareSnapshot(squarePath)).state;
  assert.equal(expired.runtime.leases.Alice, undefined);
  assert.deepEqual(expired.runtime.observations, before);
  const expressed = await (await (await app('Bob')).participant()).express('consume before expiry', { force: true, mentions: ['Alice'], observe: true });
  assert.equal((await (await alice.participant()).catch({ observe: true })).consumedThrough, expressed.activity.id);
  const consumed = (await readSquareSnapshot(squarePath)).state.runtime.observations;
  const stale = await (await alice.participant()).catch({ idle: 1, observe: true }, { signal: AbortSignal.timeout(2000) });
  const { observation: staleObservation, ...staleData } = stale;
  assert.deepEqual(staleData, { activities: [], consumedThrough: expressed.activity.id, idleExpired: true, remaining: 0 });
  assert.deepEqual((await readSquareSnapshot(squarePath)).state.runtime.observations, consumed);
});

test('configured and discovered status viewers perceive directed activity without join or ownership writes', async (t) => {
  const { cwd, squarePath, env, app } = await fixture(t);
  await (await app('Alice')).join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  await (await app('Cara')).join(undefined, { observe: true });
  await (await (await app('Bob')).participant()).express('private for Alice', { force: true, mentions: ['Alice'], observe: true });
  const ledger = hostLedgerForEnv(env);
  // Discovery is unambiguous for this harness coordinate, independent of env's default name.
  await ledger.ensurePresence({ location: squarePath, participant: 'Alice', session: 'viewer-session', channel: 'codex' });
  const before = (await readSquareSnapshot(squarePath)).state;
  const presenceBefore = await ledger.listPresence({ location: squarePath });
  const configured = (await Square.at({ cwd, path: squarePath, env: { ...env, SQUARE_PARTICIPANT_NAME: 'alice' } }));
  const discovered = (await Square.at({ cwd, path: squarePath, env: { ...env, CODEX_THREAD_ID: 'viewer-session', SQUARE_PARTICIPANT_NAME: '' } }));
  for (const viewer of [configured, discovered]) {
    const result = await viewer.status({ observe: true });
    assert.equal(result.observation.viewer, 'Alice');
    assert.equal(result.observation.participant, 'Alice');
    assert.equal(result.observation.latestPerception, 'full');
    assert.deepEqual(result.observation.attentionNames, ['Alice']);
  }
  const other = await (await app('Cara')).status({ observe: true });
  assert.equal(other.observation.latestPerception, 'presence');
  assert.deepEqual(other.observation.attentionNames, ['Cara']);
  const explicit = await configured.status({ viewer: 'Cara', observe: true });
  assert.equal(explicit.observation.viewer, 'Cara');
  assert.equal(explicit.observation.latestPerception, 'presence');
  const blank = await configured.status({ viewer: '', observe: true });
  assert.equal(blank.observation.viewer, '');
  assert.equal(blank.observation.participant, undefined);
  assert.equal(blank.observation.latestPerception, 'presence');
  const ambient = await (await Square.at({ cwd, path: squarePath, env: { ...env, CODEX_THREAD_ID: '' } })).status({ observe: true });
  assert.equal(ambient.observation.viewer, '');
  assert.equal(ambient.observation.latestPerception, 'presence');
  assert.deepEqual(new Set(ambient.observation.attentionNames), new Set(['Alice', 'Bob', 'Cara']));
  assert.deepEqual((await readSquareSnapshot(squarePath)).state, before);
  assert.deepEqual(await ledger.listPresence({ location: squarePath }), presenceBefore);
});

test('structured express refusals distinguish caller/filter/recipient and do not land rejected bodies', async (t) => {
  const { app } = await fixture(t);
  const alice = (await app('Alice'));
  await alice.join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  await assert.rejects((await alice.participant()).express('unknown recipient', { mentions: ['Nobody'], force: true, observe: true }), (error) => {
    assert.equal(error.facts.activityUnsent, true);
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'recipient', expressEffect: 'unsent' });
    return true;
  });
  await assert.rejects((await alice.participant()).catch({ from: ['Nobody'], observe: true }), (error) => {
    assert.deepEqual(error.operation, { operation: 'catch', participant: 'Alice', subject: 'filter' });
    return true;
  });
  await (await alice.participant()).hold('no wait', { observe: true });
  await assert.rejects((await alice.participant()).express('held body', { noWait: true, force: true, observe: true }), (error) => {
    assert.equal(error.code, 'held');
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'caller', expressEffect: 'unsent' });
    return true;
  });
  assert.equal((await alice.history({ observe: true })).activities.some((activity) => activity.kind === 'say'), false);
});

test('malformed and blank environment clocks refuse with a code, while an injected clock wins', async (t) => {
  const { cwd, squarePath, env } = await fixture(t);
  for (const SQUARE_NOW_MS of ['not-a-clock', '']) {
    const invalid = (await Square.at({ cwd, path: squarePath, env: { ...env, SQUARE_NOW_MS }, participant: 'Alice' }));
    assert.throws(() => squareClock({ ...env, SQUARE_NOW_MS })(), (error) => error.code === 'invalid_args');
    await assert.rejects(invalid.join(undefined, { observe: true }), (error) => error.code === 'invalid_args');
  }
  assert.deepEqual((await readSquareSnapshot(squarePath)).state.acts, []);
  const injected = (await Square.at({ cwd, path: squarePath, env: { ...env, SQUARE_NOW_MS: 'not-a-clock' }, clock: () => 42, participant: 'Alice' }));
  assert.equal(squareClock(env, () => 42)(), 42);
  assert.equal((await injected.join(undefined, { observe: true })).activity.at, 42);
});

test('resource captures environment and honors an injected wake transport without changing process env', async (t) => {
  const { cwd, squarePath, env, app } = await fixture(t);
  await (await app('Bob')).join(undefined, { observe: true });
  const ledger = hostLedgerForEnv(env);
  const requests = [];
  const wakeTransport = { async attempt(request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    requests.push(request);
    return { outcome: 'accepted' };
  } };
  const suppliedEnv = { ...env };
  const context = { cwd, squarePath: './SQUARE.square', env: suppliedEnv, participant: 'Alice', hostLedger: ledger, wakeTransport };
  const captured = (await Square.at({ ...context, path: context.squarePath }));
  const processBefore = { ...process.env };
  suppliedEnv.CODEX_THREAD_ID = 'wrong-session';
  suppliedEnv.SQUARE_LOCATION = 'wrong.square';
  suppliedEnv.SQUARE_PARTICIPANT_NAME = 'Wrong';
  const joined = await captured.join(undefined, { observe: true });
  assert.equal(joined.participant.name, 'Alice');
  assert.equal(joined.observation.location, squarePath);
  assert.equal((await readParticipantOwner(squarePath, 'Alice', ledger)).session, 'alice-session');
  const expressed = await (await captured.participant()).express('captured delivery', { force: true, mentions: ['Bob'], observe: true });
  assert.equal(expressed.delivery.accepted, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].participant, 'Bob');
  assert.deepEqual({ ...process.env }, processBefore);
});

test('path-backed resource express uses default wake delivery when no port is supplied', async (t) => {
  const { env, app } = await fixture(t);
  await (await app('Alice')).join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  // There is deliberately no current Codex Stop boundary: the real default
  // adapter records its bounded refusal and cannot send to an external harness.
  const expressed = await (await (await app('Alice')).participant()).express('default wake', { force: true, mentions: ['Bob'], observe: true });
  assert.deepEqual(expressed.delivery, { attempted: 1, accepted: 0, failed: 1, unknown: 0, notCapable: 0 });
  // Unavailable transport attempts release custody; those diagnostics are
  // deliberately absent from ordinary behavior-safe evidence/attempt reads.
  const evidence = await hostLedgerForEnv(env).listEvidence({ kind: 'wake', participant: 'Bob', activity: expressed.activity.id, includeReleased: true });
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
  await (await app('Bob', { env: suppliedEnv })).join(undefined, { observe: true });
  const alice = (await Square.at({ cwd, path: squarePath, env: suppliedEnv, participant: 'Alice' }));
  const processBefore = { ...process.env };
  const threadId = suppliedEnv.CODEX_THREAD_ID;
  suppliedEnv.CODEX_THREAD_ID = 'changed-after-creation';
  suppliedEnv.SQUARE_CODEX_BOUNDARIES = path.join(cwd, 'wrong-boundaries.json');
  suppliedEnv.SQUARE_CODEX_BIN = path.join(cwd, 'missing-executable');
  suppliedEnv.SQUARE_CAPTURED_QUEUE_OUTPUT = path.join(cwd, 'wrong-output.json');
  suppliedEnv.SQUARE_CAPTURED_QUEUE_MARKER = 'changed-after-creation';
  await alice.join(undefined, { observe: true });
  const expressed = await (await alice.participant()).express('body must not enter queue awareness', { force: true, mentions: ['Bob'], observe: true });
  assert.deepEqual(expressed.delivery, { attempted: 1, accepted: 1, failed: 0, unknown: 0, notCapable: 0 });
  const sent = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(sent.args.slice(0, 4), ['queue', '--thread', threadId, '--message']);
  assert.equal(sent.args.length, 5);
  assert.equal(sent.marker, 'captured-child-env');
  assert.match(sent.args[4], /<square-activity square="[^"]*SQUARE\.square" as="Bob" id="act\/2" from="Alice">\nAlice spoke your name\./);
  assert.match(sent.args[4], /This is an external reminder from Square, not a direct message from the user\./);
  assert.match(sent.args[4], /Alice spoke your name\.\n\nbody must not enter queue awareness\n<\/square-activity>/);
  assert.equal(fs.existsSync(suppliedEnv.SQUARE_CAPTURED_QUEUE_OUTPUT), false);
  assert.deepEqual({ ...process.env }, processBefore);
});

test('express observations retain commit facts when a postcommit clock becomes unavailable', async (t) => {
  let enrichment = false;
  const wakeTransport = { async attempt(_request, _timeout, beforeSend) {
    assert.equal(await beforeSend(), true);
    enrichment = true;
    return { outcome: 'accepted' };
  } };
  const clock = () => { if (enrichment) throw new Error('projection clock unavailable'); return Date.now(); };
  const { app } = await fixture(t, { clock, wakeTransport });
  await (await app('Alice')).join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  const expressed = await (await (await app('Alice')).participant()).express('committed once', { force: true, mentions: ['Bob'], observe: true });
  assert.equal(expressed.activity.id, 'act/2');
  assert.equal(expressed.observation.ownActivityCount, 1);
  assert.equal(expressed.observation.standingCount, 2);
  enrichment = false;
  assert.deepEqual((await (await app()).history({ observe: true })).activities.filter((activity) => activity.kind === 'say').map((activity) => activity.id), ['act/2']);
});

test('host publication failure cannot erase a committed express result', async (t) => {
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
  const alice = (await Square.at({ cwd, path: squarePath, env, participant: 'Alice', hostLedger }));
  await alice.join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  armed = true;
  const expressed = await (await alice.participant()).express('runtime uncertain', { force: true, mentions: ['Bob'], observe: true });
  assert.equal(expressed.activity.id, 'act/2');
  armed = false;
  assert.equal((await (await app()).history({ observe: true })).activities.filter((activity) => activity.body === 'runtime uncertain').length, 1);
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
      if (armed && observations.Bob?.['act/2'].state === 'seen') {
        committed = true;
        throw new Error('postcommit publication unavailable');
      }
      return delegate.listPresence(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  await (await app('Alice')).join(undefined, { observe: true });
  const bob = (await Square.at({ cwd, path: squarePath, env, participant: 'Bob', hostLedger, clock }));
  await bob.join(undefined, { observe: true });
  const expressed = await (await (await app('Alice')).participant()).express('selected once', { force: true, mentions: ['Bob'], observe: true });
  armed = true;
  const caught = await (await bob.participant()).catch({ observe: true });
  assert.equal(committed, true, 'the injected failures begin only after the delivered receipt');
  const { observation, hint: _hint, ...receipt } = caught;
  assert.deepEqual(receipt, {
    activities: [{ ...expressed.activity, perception: 'full' }],
    consumedThrough: 'act/2', remaining: 0, idleExpired: false,
  });
  assert.equal(caught.observation.now, 100);
  assert.equal(caught.observation.standingCount, 2);
  assert.equal(caught.observation.ownActivityCount, 0);
  assert.equal(caught.observation.held, false);
  assert.deepEqual(caught.observation.sayNumbers, { 2: 1 });
  assert.equal(caught.observation.enrichmentUnavailable, true);
  assert.equal('activities' in caught.observation, false, 'the public page has no parallel raw projection');
  committed = false;
  armed = false;
  assert.deepEqual((await (await bob.participant()).catch({ observe: true })).activities, []);
});

test('resource selected-row corruption reports unknown, not a safely unsent refusal', async (t) => {
  const { app, squarePath } = await fixture(t);
  const alice = (await app('Alice'));
  await alice.join(undefined, { observe: true });
  await (await app('Bob')).join(undefined, { observe: true });
  const original = await (await alice.participant()).express('original', { force: true, mentions: ['Bob'], observe: true });
  await (await alice.participant()).catch({ observe: true });
  const database = new DatabaseSync(squarePath);
  const before = database.prepare('SELECT revision, next_act_index FROM square_meta').get();
  try {
    database.prepare('UPDATE activities SET payload_json=? WHERE act_index=2').run('{"body":42,"mentions":["Bob"]}');
  } finally { database.close(); }
  await assert.rejects((await alice.participant()).express('uncertain reply', { force: true, reply: original.activity.id, observe: true }), (error) => {
    assert.equal(error.code, 'invalid_args');
    assert.notEqual(error.facts?.activityUnsent, true);
    assert.deepEqual(error.operation, { operation: 'express', participant: 'Alice', subject: 'caller', expressEffect: 'unknown' });
    return true;
  });
  const after = new DatabaseSync(squarePath);
  try { assert.deepEqual(after.prepare('SELECT revision, next_act_index FROM square_meta').get(), before); }
  finally { after.close(); }
});

test('join, listener and lifecycle receipts survive cancellation and unavailable enrichment after commit', async (t) => {
  const { squarePath } = await fixture(t);
  const artifact = createArtifactPort(squarePath);
  let afterCommit = false;
  let controller;
  const resources = { artifact: () => ({
    ...artifact,
    read(select, signal) {
      if (afterCommit) throw new Error('optional read unavailable');
      return artifact.read(select, signal);
    },
    async transact(change, signal) {
      const before = (await artifact.read((facts) => facts.header().nextActIndex)).value;
      const result = await artifact.transact(change, signal);
      const after = (await artifact.read((facts) => facts.header().nextActIndex)).value;
      if (after !== before) {
        afterCommit = true;
        controller?.abort(new Error('cancelled after commit'));
      }
      return result;
    },
  }) };
  const square = await Square.at({ path: squarePath, env: {}, resources,
    clock: () => { if (afterCommit) throw new Error('postcommit clock unavailable'); return 100; },
  });
  t.after(async () => { await square.close(); await artifact.close(); });
  const operation = async (run) => {
    afterCommit = false;
    controller = new AbortController();
    const result = await run({ signal: controller.signal });
    assert.equal(controller.signal.aborted, true);
    assert.equal(result.observation.now, 100);
    return result;
  };
  const joined = await operation((control) => square.join('Alice', { observe: true }, control));
  assert.equal(joined.kind, 'joined');
  assert.equal(joined.observation.standingCount, 1);
  assert.equal(joined.observation.enrichmentUnavailable, true);
  assert.equal(joined.observation.entry, undefined);
  const alice = joined.participant;
  afterCommit = false;
  await square.join('Bob');
  const listened = await operation((control) => alice.listen('Bob', { observe: true }, control));
  assert.equal(listened.activity.kind, 'listen');
  assert.equal(listened.observation.target, 'Bob');
  const held = await operation((control) => alice.hold('pause', { observe: true }, control));
  assert.equal(held.observation.held, true);
  const resumed = await operation((control) => alice.resume({ observe: true }, control));
  assert.equal(resumed.observation.held, false);
  const left = await operation((control) => alice.done(undefined, { observe: true }, control));
  assert.equal(left.activity.kind, 'done');
  assert.equal(left.observation.standingCount, 1);
  const rows = (await artifact.read((facts) => facts.activityHeads({}, { edge: 'oldest', limit: 10 }))).value.items;
  assert.deepEqual(rows.map((row) => row.kind), ['join', 'join', 'listen', 'hold', 'resume', 'done']);
});

test('return disposes a quiet stream even while next is pending, without activity to wake it', { timeout: 4000 }, async (t) => {
  const { app, squarePath } = await fixture(t);
  const before = (await readSquareSnapshot(squarePath)).state;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const iterator = (await app()).stream({ start: { kind: 'tail', last: 0 } }, { signal: controller.signal })[Symbol.asyncIterator]();
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
