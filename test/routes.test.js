import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { writeSquareFile } from '../dist/artifact.js';
import { openSquare } from '../dist/square-file-adapter.js';
import { closeOpenSquare } from '../dist/open-square.js';
import { express, join } from '../dist/square-actions.js';
import { readWakeRoutes, selectPrimaryWakeRoute, upsertWakeRoute } from '../dist/routes.js';

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
test('express refreshes the current caller artifact route timestamp', async () => {
  const item = await openExpressFixture();
  try {
    await join(item.square, 'Alice');
    const before = (await readWakeRoutes({ location: item.location, participant: 'Alice', sessionId: 'alice-session' }))[0];
    assert.equal(before?.kind, 'codex-queue');
    item.setNow(500);
    const result = await express(item.square, 'Alice', 'fresh route', { force: true });
    assert.equal(result.activity.actor, 'Alice');
    const routes = await readWakeRoutes({ location: item.location, participant: 'Alice', sessionId: 'alice-session' });
    assert.equal(routes.length, 1);
    assert.ok(routes[0].updatedAt >= 500);
    assert.equal(routes[0].address.threadId, 'alice-session');
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
