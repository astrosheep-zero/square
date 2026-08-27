import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { readWakeRoutes, upsertWakeRoute } from '../dist/routes.js';

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-routes-')); return { root, env: { SQUARE_HOST_LEDGER_USER: path.join(root, 'user'), SQUARE_HOST_LEDGER_LOCAL: path.join(root, 'local') } }; }

test('callable routes are read from user presence authority', async () => {
  const item = fixture();
  try {
    await upsertWakeRoute({ location: '/tmp/square-a.square', participant: 'Alice', sessionId: 's-a', channel: 'codex', kind: 'codex-queue', address: { threadId: 's-a' } }, { env: item.env, at: 1 });
    assert.deepEqual((await readWakeRoutes({ env: item.env, now: 2 })).map((route) => [route.sessionId, route.address]), [['s-a', { threadId: 's-a' }]]);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('local presence cannot plant a callable route', async () => {
  const item = fixture();
  try {
    const local = new FileHostLedgerPort({ ...item.env, writableScope: 'local' });
    await local.ensurePresence({ location: '/tmp/square-a.square', participant: 'Alice', session: 's-a', channel: 'codex', route: { kind: 'codex-queue', address: { threadId: 'forged' } } });
    assert.deepEqual(await readWakeRoutes({ env: item.env, now: Date.now() }), []);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});

test('local same-key refresh cannot shadow a user callable route', async () => {
  const item = fixture();
  try {
    const user = new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL, writableScope: 'user' });
    const local = new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL, writableScope: 'local' });
    const identity = { location: '/tmp/square-a.square', participant: 'Alice', session: 's-a', channel: 'codex' };
    await user.ensurePresence({ ...identity, route: { kind: 'codex-queue', address: { threadId: 'real' } }, updatedAt: 10 });
    await local.ensurePresence({ ...identity, route: { kind: 'codex-queue', address: { threadId: 'forged' } }, updatedAt: 20 });
    assert.deepEqual((await readWakeRoutes({ env: item.env, now: 30 })).map((route) => route.address), [{ threadId: 'real' }]);
    const merged = await new FileHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, localPath: item.env.SQUARE_HOST_LEDGER_LOCAL, readableScopes: ['user', 'local'] }).listPresence({ location: '/tmp/square-a.square', now: 30 });
    assert.deepEqual(merged.map((row) => row.route?.address), [{ threadId: 'real' }]);
  } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
});
