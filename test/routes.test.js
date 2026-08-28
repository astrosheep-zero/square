import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { writeSquareFile } from '../dist/artifact.js';
import { readWakeRoutes, selectPrimaryWakeRoute, upsertWakeRoute } from '../dist/routes.js';

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-routes-')); return { root, env: { SQUARE_HOST_LEDGER_USER: path.join(root, 'user'), SQUARE_HOST_LEDGER_LOCAL: path.join(root, 'local') } }; }

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
