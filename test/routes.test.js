import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { loadSquare, writeSquareFile } from '../dist/artifact.js';
import { openSquare } from '../dist/square-file-adapter.js';
import { closeOpenSquare } from '../dist/open-square.js';
import { express, join } from '../dist/square-actions.js';
import { publishWakeRoute, readWakeRoutes, retireWakeRouteFromArtifact, retireWakeRoutesForSessionFromArtifact, ROUTE_FRESH_MS, selectPrimaryWakeRoute, sessionCanEndParticipant, sessionOwnsParticipantRoutes, upsertWakeRoute } from '../dist/routes.js';

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-routes-')); return { root, env: { SQUARE_HOST_LEDGER_USER: path.join(root, 'user'), SQUARE_HOST_LEDGER_LOCAL: path.join(root, 'local') } }; }

function emptyState() {
  return { hardCap: null, preamble: [], warmup: [], acts: [], routes: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } };
}

async function openExpressFixture() {
  const item = fixture();
  const location = path.join(item.root, 'square.square');
  await writeSquareFile(location, emptyState());
  const ledger = new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL });
  let now = 100;
  const env = { ...process.env, ...item.env, CODEX_THREAD_ID: 'alice-session', PASEO_AGENT_ID: '' };
  const square = await openSquare(location, { clock: () => now, hostLedger: ledger, env });
  return { item, location, ledger, square, setNow: (value) => { now = value; } };
}
test('callable routes are read from receiver-owned square artifact', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], routes: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
    await upsertWakeRoute({ location, participant: 'Alice', sessionId: 's-a', channel: 'codex', kind: 'codex-queue', address: { threadId: 's-a' } }, { env: item.env, at: 1 });
    assert.deepEqual((await readWakeRoutes({ location, now: 2 })).map((route) => [route.sessionId, route.address]), [['s-a', { threadId: 's-a' }]]);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});
test('local presence cannot plant a callable route', async () => {
  const item = fixture();
  try {
    const local = new FileHostLedgerPort({ ...item.env, writableScope: 'local' });
    await local.ensurePresence({ location: '/tmp/square-a.square', participant: 'Alice', session: 's-a', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'forged' } } });
    assert.deepEqual(await readWakeRoutes({ location: '/tmp/square-a.square', env: item.env, now: Date.now() }), []);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});
test('uncapable native sessions keep ownership in presence without a callable route', async () => {
  for (const [provider, sessionKey, channel] of [
    ['pi', 'SQUARE_PI_SESSION_ID', 'pi'],
    ['claude', 'CLAUDE_CODE_SESSION_ID', 'claude-code'],
  ]) {
    const item = fixture();
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, emptyState());
    const ledger = new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL });
    const env = {
      ...process.env,
      ...item.env,
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      SQUARE_PI_SESSION_ID: '',
      PASEO_AGENT_ID: '',
      [sessionKey]: `${provider}-session`,
    };
    const square = await openSquare(location, { hostLedger: ledger, env });
    try { await join(square, 'Agent'); } finally { await closeOpenSquare(square); }
    assert.deepEqual(await readWakeRoutes({ location }), []);
    const presence = await ledger.listPresence({ location, session: `${provider}-session`, scopes: ['local', 'user'] });
    assert.equal(presence.length, 1);
    assert.equal(presence[0].channel, channel);
    assert.equal(presence[0].route, undefined);
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
test('local registry cannot plant or shadow an artifact route', async () => {
  const item = fixture();
  try {
    const user = new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL, writableScope: 'user' });
    const local = new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL, writableScope: 'local' });
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], routes: [{ location, participant: 'Alice', sessionId: 's-a', channel: 'codex', kind: 'codex-queue', address: { threadId: 'real' }, updatedAt: 10 }], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
    await local.ensurePresence({ location, participant: 'Alice', session: 's-a', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'forged' } }, updatedAt: 20 });
    assert.deepEqual((await readWakeRoutes({ location, env: item.env, now: 30 })).map((route) => route.address), [{ threadId: 'real' }]);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('same participant keeps independent routes for multiple sessions', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], routes: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
    await upsertWakeRoute({ location, participant: 'Bob', sessionId: 's1', channel: 'codex', kind: 'codex-queue', address: { threadId: 's1' } }, { at: 1 });
    await upsertWakeRoute({ location, participant: 'Bob', sessionId: 's2', channel: 'codex', kind: 'codex-queue', address: { threadId: 's2' } }, { at: 2 });
    assert.deepEqual((await readWakeRoutes({ location })).map((route) => route.sessionId), ['s1', 's2']);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('session route cleanup compares canonical locations', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    const alias = path.join(item.root, 'alias.square');
    fs.symlinkSync(location, alias);
    await writeSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], routes: [
      { location: alias, participant: 'Codex', sessionId: 'old-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'old-session' }, updatedAt: 1 },
      { location, participant: 'Codex', sessionId: 'new-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'new-session' }, updatedAt: 2 },
    ], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
    const square = await openSquare(location);
    try { await retireWakeRoutesForSessionFromArtifact(square.artifact, { location, sessionId: 'old-session' }); } finally { await closeOpenSquare(square); }
    assert.deepEqual((await readWakeRoutes({ location })).map((route) => route.sessionId), ['new-session']);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('session route cleanup stays atomic with concurrent publication', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], routes: [
      { location, participant: 'Codex', sessionId: 'old-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'old-session' }, updatedAt: 1 },
    ], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
    const square = await openSquare(location);
    try {
      await Promise.all([
        retireWakeRoutesForSessionFromArtifact(square.artifact, { location, sessionId: 'old-session' }),
        publishWakeRoute(square.artifact, { location, participant: 'Codex', sessionId: 'new-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'new-session' } }, { at: 2 }),
      ]);
    } finally { await closeOpenSquare(square); }
    assert.deepEqual((await readWakeRoutes({ location })).map((route) => route.sessionId), ['new-session']);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('session route cleanup matches live transaction state instead of a prior snapshot order', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    const oldRoute = { location, participant: 'Codex', sessionId: 'old-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'old-session' }, updatedAt: 1 };
    const newRoute = { location, participant: 'Codex', sessionId: 'new-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'new-session' }, updatedAt: 2 };
    const extraRoute = { location, participant: 'Other', sessionId: 'extra-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'extra-session' }, updatedAt: 3 };
    await writeSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], routes: [extraRoute, newRoute, oldRoute], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
    const square = await openSquare(location);
    const read = square.artifact.read.bind(square.artifact);
    square.artifact.read = async () => {
      const snapshot = await read();
      return { ...snapshot, state: { ...snapshot.state, routes: [oldRoute] } };
    };
    try { await retireWakeRoutesForSessionFromArtifact(square.artifact, { location, sessionId: 'old-session' }); } finally { await closeOpenSquare(square); }
    assert.deepEqual((await readWakeRoutes({ location })).map((route) => route.sessionId), ['extra-session', 'new-session']);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('session ownership is exclusive session identity, not a refreshable updatedAt race', () => {
  const location = '/square.square';
  const state = {
    hardCap: null, preamble: [], warmup: [], acts: [],
    routes: [
      { location, participant: 'shared', sessionId: 'new-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'new-session' }, updatedAt: 1 },
      { location, participant: 'shared', sessionId: 'old-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'old-session' }, updatedAt: 99 },
    ],
    runtime: { nextActIndex: 0, observations: {}, leases: {} },
  };
  assert.equal(sessionOwnsParticipantRoutes(state, location, 'shared', 'old-session'), false);
  assert.equal(sessionOwnsParticipantRoutes(state, location, 'shared', 'new-session'), false);
  assert.equal(sessionOwnsParticipantRoutes({ ...state, routes: state.routes.filter((route) => route.sessionId === 'new-session') }, location, 'shared', 'new-session'), true);
});

test('missing participant routes require current session proof before SessionEnd can write done', () => {
  const state = emptyState();
  assert.equal(sessionCanEndParticipant(state, '/square.square', 'shared', 'old-session'), false);
  assert.equal(sessionCanEndParticipant(state, '/square.square', 'shared', 'old-session', 'new-session'), false);
  assert.equal(sessionCanEndParticipant(state, '/square.square', 'shared', 'old-session', 'old-session'), true);
});

test('done to joined clears stale participant routes before publishing the current route', async () => {
  const item = await openExpressFixture();
  try {
    const oldRoute = { location: item.location, participant: 'Alice', sessionId: 'old-session', channel: 'codex', kind: 'codex-queue', address: { threadId: 'old-session' }, updatedAt: 1 };
    await item.square.artifact.transact((state) => {
      state.acts.push(
        { kind: 'join', actor: 'Alice', at: 1, index: 0 },
        { kind: 'done', actor: 'Alice', at: 2, body: '', index: 1 },
      );
      state.runtime.nextActIndex = 2;
      state.routes = [oldRoute];
      return { state, result: undefined };
    });
    const replacementEnv = { ...item.square.env, CODEX_THREAD_ID: 'new-session' };
    const replacement = await openSquare(item.location, { clock: item.square.clock, hostLedger: item.ledger, env: replacementEnv });
    try { await join(replacement, 'Alice'); } finally { await closeOpenSquare(replacement); }
    assert.deepEqual((await readWakeRoutes({ location: item.location, participant: 'Alice' })).map((route) => route.sessionId), ['new-session']);
    assert.equal((await loadSquare(item.location)).acts.at(-1)?.kind, 'join');
  } finally { await closeOpenSquare(item.square); fs.rmSync(item.item.root, { recursive: true, force: true }); }
});

test('primary route selection gives Paseo global precedence without changing session key', () => {
  const route = selectPrimaryWakeRoute({
    boundary: { location: '/square', participant: 'Bob', sessionId: 'thread-1', provider: 'codex' },
    env: { PASEO_AGENT_ID: ' agent-1 ', CODEX_THREAD_ID: 'thread-1' },
    capabilities: { canUse: (kind) => kind === 'paseo' || kind === 'codex-queue' },
  });
  assert.deepEqual(route, { location: '/square', participant: 'Bob', sessionId: 'thread-1', channel: 'codex', kind: 'paseo', address: { agentId: 'agent-1' } });
});

test('primary route selection falls back to native only when capable', () => {
  const native = selectPrimaryWakeRoute({
    boundary: { location: '/square', participant: 'Bob', sessionId: 'thread-1', provider: 'codex' },
    env: {},
    capabilities: { canUse: (kind) => kind === 'codex-queue' },
  });
  assert.equal(native?.kind, 'codex-queue');
  const none = selectPrimaryWakeRoute({
    boundary: { location: '/square', participant: 'Bob', sessionId: 'thread-1', provider: 'claude' },
    env: {},
    capabilities: { canUse: () => false },
  });
  assert.equal(none, undefined);
});

test('primary route selection is independent for same participant sessions', () => {
  const capabilities = { canUse: (kind) => kind === 'codex-queue' };
  const one = selectPrimaryWakeRoute({ boundary: { location: '/square', participant: 'Bob', sessionId: 's1', provider: 'codex' }, env: {}, capabilities });
  const two = selectPrimaryWakeRoute({ boundary: { location: '/square', participant: 'Bob', sessionId: 's2', provider: 'codex' }, env: {}, capabilities });
  assert.equal(one?.sessionId, 's1');
  assert.equal(two?.sessionId, 's2');
});
test('route retirement with an old epoch leaves the current owner route in place', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, emptyState());
    const square = await openSquare(location);
    try {
      await publishWakeRoute(square.artifact, {
        location,
        participant: 'Alice',
        sessionId: 'current',
        channel: 'codex',
        kind: 'codex-queue',
        address: { threadId: 'current' },
        epoch: 2,
      }, { at: 20 });
      await retireWakeRouteFromArtifact(
        square.artifact,
        { location, participant: 'Alice', sessionId: 'current' },
        { expectedEpoch: 1 },
      );
      const routes = await readWakeRoutes({ location, now: 30 });
      assert.equal(routes.length, 1);
      assert.equal(routes[0].sessionId, 'current');
      assert.equal(routes[0].epoch, 2);
    } finally {
      await closeOpenSquare(square);
    }
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('route retirement with an expected epoch does not remove a route missing its epoch', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    await writeSquareFile(location, emptyState());
    const square = await openSquare(location);
    try {
      await publishWakeRoute(square.artifact, {
        location,
        participant: 'Alice',
        sessionId: 'current',
        channel: 'codex',
        kind: 'codex-queue',
        address: { threadId: 'current' },
      }, { at: 20 });
      await retireWakeRouteFromArtifact(
        square.artifact,
        { location, participant: 'Alice', sessionId: 'current' },
        { expectedEpoch: 1 },
      );
      const routes = await readWakeRoutes({ location, now: 30 });
      assert.equal(routes.length, 1);
      assert.equal(routes[0].epoch, undefined);
    } finally {
      await closeOpenSquare(square);
    }
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('route retirement canonicalizes an aliased item location', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    const alias = path.join(item.root, 'alias.square');
    fs.symlinkSync(location, alias);
    await writeSquareFile(location, emptyState());
    const square = await openSquare(location);
    try {
      await square.artifact.transact((state) => ({
        state: {
          ...state,
          routes: [{
            location: alias,
            participant: 'Alice',
            sessionId: 'session-a',
            channel: 'codex',
            kind: 'codex-queue',
            address: { threadId: 'session-a' },
            updatedAt: 1,
          }],
        },
        result: undefined,
      }));
      await retireWakeRouteFromArtifact(square.artifact, { location, participant: 'Alice', sessionId: 'session-a' });
      assert.deepEqual(await readWakeRoutes({ location }), []);
    } finally {
      await closeOpenSquare(square);
    }
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('route publication replaces an aliased persisted identity', async () => {
  const item = fixture();
  try {
    const location = path.join(item.root, 'square.square');
    const alias = path.join(item.root, 'alias.square');
    await writeSquareFile(location, emptyState());
    fs.symlinkSync(location, alias);
    const square = await openSquare(location);
    try {
      await square.artifact.transact((state) => ({
        state: { ...state, routes: [{ location: alias, participant: 'Alice', sessionId: 'session-a', channel: 'codex', kind: 'codex-queue', address: { threadId: 'session-a' }, updatedAt: 1 }] },
        result: undefined,
      }));
      await publishWakeRoute(square.artifact, {
        location,
        participant: 'Alice',
        sessionId: 'session-a',
        channel: 'codex',
        kind: 'codex-queue',
        address: { threadId: 'session-a' },
      }, { at: 2 });
      const routes = await readWakeRoutes({ location });
      assert.deepEqual(routes.map((route) => [route.location, route.sessionId]), [[fs.realpathSync(location), 'session-a']]);
    } finally { await closeOpenSquare(square); }
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('express refreshes only an expired or changed caller artifact route', async () => {
  const item = await openExpressFixture();
  try {
    await join(item.square, 'Alice');
    const before = (await readWakeRoutes({ location: item.location, participant: 'Alice', sessionId: 'alice-session' }))[0];
    assert.equal(before?.kind, 'codex-queue');
    item.setNow(500);
    const result = await express(item.square, 'Alice', 'fresh route', { force: true });
    assert.equal(result.activity.actor, 'Alice');
    const standing = await readWakeRoutes({ location: item.location, participant: 'Alice', sessionId: 'alice-session' });
    assert.equal(standing.length, 1);
    // Publication is a semantic no-op while the same route stands unexpired.
    assert.equal(standing[0].updatedAt, before.updatedAt);
    assert.equal(standing[0].address.threadId, 'alice-session');

    // A route past its freshness horizon is refreshed by the next publication.
    const { state } = await item.square.artifact.read();
    state.routes[0].updatedAt = before.updatedAt - ROUTE_FRESH_MS;
    await writeSquareFile(item.location, state);
    item.setNow(700);
    await express(item.square, 'Alice', 'expired route refreshed', { force: true });
    const refreshed = (await readWakeRoutes({ location: item.location, participant: 'Alice', sessionId: 'alice-session' }))[0];
    assert.equal(refreshed.updatedAt, 700);
    assert.equal(refreshed.address.threadId, 'alice-session');
  } finally {
    await closeOpenSquare(item.square);
    fs.rmSync(item.item.root, { recursive: true, force: true });
  }
});

test('express publication failure does not affect the committed activity or delivery result', async () => {
  const item = await openExpressFixture();
  try {
    await join(item.square, 'Alice');
    const transact = item.square.artifact.transact.bind(item.square.artifact);
    let calls = 0;
    let failPublication = false;
    item.square.artifact.transact = async (fn) => {
      calls += 1;
      if (failPublication && calls === 4) throw new Error('publication unavailable');
      return transact(fn);
    };
    failPublication = true;
    const result = await express(item.square, 'Alice', 'committed despite route failure', { force: true });
    assert.equal(result.activity.body, 'committed despite route failure');
    assert.deepEqual(result.delivery, { attempted: 0, accepted: 0, failed: 0, unknown: 0, notCapable: 1 });
    const state = (await item.square.artifact.read()).state;
    assert.equal(state.acts.at(-1).body, 'committed despite route failure');
  } finally {
    await closeOpenSquare(item.square);
    fs.rmSync(item.item.root, { recursive: true, force: true });
  }
});
