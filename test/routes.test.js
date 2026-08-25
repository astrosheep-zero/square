import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordLocalDone, recordLocalJoin } from '../dist/registry.js';
import { publishWakeRoutesFrom, readWakeRoutes, WAKE_ROUTE_PROBES } from '../dist/routes.js';
import { WAKE_ROUTE_KINDS } from '../dist/model.js';

function files() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-routes-'));
  return {
    root,
    square: path.join(root, 'SQUARE.square'),
    env: {
      SQUARE_REGISTRY: path.join(root, 'registry.ndjsonl'),
      SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    },
  };
}

test('explicit join publishes only complete provider evidence and done retires it', () => {
  const item = files();
  const env = {
    ...item.env,
    CLAUDE_CODE_SESSION_ID: 'claude-session',
    CODEX_THREAD_ID: 'codex-thread',
    OPENCODE_SESSION_ID: 'opencode-session',
    SQUARE_PI_SESSION_ID: 'pi-session',
    PASEO_AGENT_ID: 'paseo-agent',
  };
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = item.env.SQUARE_REGISTRY;
  try {
    recordLocalJoin('Bob', item.square, env);
    const routes = readWakeRoutes({ env, now: Date.now() + 1 });
    assert.deepEqual(routes.map((route) => route.kind), ['codex-queue', 'paseo']);
    assert.deepEqual(routes[0].address, { threadId: 'codex-thread' });
    assert.deepEqual(routes[1].address, { agentId: 'paseo-agent' });
    recordLocalDone('Bob', item.square, env);
    assert.deepEqual(readWakeRoutes({ env, now: Date.now() + 2 }), []);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('a same-name takeover retires the old route and leaves the new route active', () => {
  const item = files();
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = item.env.SQUARE_REGISTRY;
  try {
    recordLocalJoin('Bob', item.square, {
      ...item.env,
      CODEX_THREAD_ID: 'old-codex',
      PASEO_AGENT_ID: 'old-paseo',
    });
    recordLocalJoin('Bob', item.square, {
      ...item.env,
      CODEX_THREAD_ID: 'new-codex',
      PASEO_AGENT_ID: 'new-paseo',
    });
    assert.deepEqual(readWakeRoutes({ env: item.env, now: Date.now() }).map((route) => [route.kind, route.address]), [
      ['codex-queue', { threadId: 'new-codex' }],
      ['paseo', { agentId: 'new-paseo' }],
    ]);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('Codex session identity publishes a queue route', () => {
  const item = files();
  const env = {
    ...item.env,
    CLAUDE_CODE_SESSION_ID: 'claude-session',
    CODEX_THREAD_ID: 'codex-thread',
    OPENCODE_SESSION_ID: 'opencode-session',
    SQUARE_PI_SESSION_ID: 'pi-session',
  };
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = item.env.SQUARE_REGISTRY;
  try {
    recordLocalJoin('Bob', item.square, env);
    assert.deepEqual(readWakeRoutes({ env, now: Date.now() + 1 }).map((route) => [route.kind, route.address]), [
      ['codex-queue', { threadId: 'codex-thread' }],
    ]);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('probe table covers exactly the five required route kinds', () => {
  assert.deepEqual(Object.keys(WAKE_ROUTE_PROBES).sort(), [...WAKE_ROUTE_KINDS].sort());
});

test('the publication boundary publishes complete provider evidence for any kind', () => {
  const item = files();
  const probes = {
    ...WAKE_ROUTE_PROBES,
    'pi-extension': (env) => {
      const endpoint = env.SQUARE_TEST_PI_ENDPOINT?.trim();
      return endpoint ? { sessionId: env.SQUARE_PI_SESSION_ID ?? '', address: { endpoint } } : undefined;
    },
  };
  publishWakeRoutesFrom('owner', probes, {
    at: 1,
    env: { ...item.env, SQUARE_PI_SESSION_ID: 'pi-session', SQUARE_TEST_PI_ENDPOINT: '/tmp/square-pi.ipc' },
  });
  const routes = readWakeRoutes({ env: item.env, now: 2 });
  assert.deepEqual(routes.map((route) => route.kind), ['pi-extension']);
  assert.deepEqual(routes[0], {
    ownerId: 'owner',
    sessionId: 'pi-session',
    kind: 'pi-extension',
    address: { endpoint: '/tmp/square-pi.ipc' },
    updatedAt: 1,
  });

  // The same identity without the endpoint evidence publishes nothing.
  publishWakeRoutesFrom('owner-2', probes, {
    at: 3,
    env: { ...item.env, SQUARE_PI_SESSION_ID: 'pi-session' },
  });
  assert.deepEqual(readWakeRoutes({ ownerId: 'owner-2', env: item.env, now: 4 }), []);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('route ledger folds every required kind with the same schema', () => {
  const item = files();
  const rows = WAKE_ROUTE_KINDS.map((kind, i) =>
    JSON.stringify({ v: 1, ts: 10 + i, op: 'upsert', owner_id: 'owner', session_id: `${kind}-session`, kind, address: { endpoint: kind } })
  );
  fs.writeFileSync(item.env.SQUARE_ROUTES, rows.join('\n') + '\n');
  const routes = readWakeRoutes({ ownerId: 'owner', env: item.env, now: 100 });
  assert.deepEqual(routes.map((route) => route.kind).sort(), [...WAKE_ROUTE_KINDS].sort());
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('an older native route sorts before a fresher paseo route', () => {
  const item = files();
  fs.writeFileSync(item.env.SQUARE_ROUTES, [
    JSON.stringify({ v: 1, ts: 1, op: 'upsert', owner_id: 'owner', session_id: 'pi-old', kind: 'pi-extension', address: { endpoint: '/tmp/pi.ipc' } }),
    JSON.stringify({ v: 1, ts: 2, op: 'upsert', owner_id: 'owner', session_id: 'paseo-new', kind: 'paseo', address: { agentId: 'paseo-new' } }),
  ].join('\n') + '\n');
  assert.deepEqual(
    readWakeRoutes({ ownerId: 'owner', env: item.env, now: 3 }).map((route) => route.kind),
    ['pi-extension', 'paseo']
  );
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('incomplete provider evidence never publishes a wake route', () => {
  const item = files();
  const probes = {
    ...WAKE_ROUTE_PROBES,
    'pi-extension': (env) => ({
      sessionId: env.SQUARE_PI_SESSION_ID,
      address: { endpoint: env.SQUARE_TEST_PI_ENDPOINT ?? '' },
    }),
  };
  // Blank address value.
  publishWakeRoutesFrom('owner-value', probes, {
    at: 1,
    env: { ...item.env, SQUARE_PI_SESSION_ID: 'pi-session' },
  });
  // Blank session id.
  publishWakeRoutesFrom('owner-session', probes, {
    at: 2,
    env: { ...item.env, SQUARE_PI_SESSION_ID: '', SQUARE_TEST_PI_ENDPOINT: '/tmp/pi.ipc' },
  });
  // Whitespace session id and value.
  publishWakeRoutesFrom('owner-blank', probes, {
    at: 3,
    env: { ...item.env, SQUARE_PI_SESSION_ID: '  ', SQUARE_TEST_PI_ENDPOINT: '  ' },
  });
  // Empty address record.
  const emptyAddressProbes = {
    ...WAKE_ROUTE_PROBES,
    'pi-extension': () => ({ sessionId: 'pi-session', address: {} }),
  };
  publishWakeRoutesFrom('owner-empty-address', emptyAddressProbes, { at: 4, env: item.env });
  // Blank address key.
  const blankKeyProbes = {
    ...WAKE_ROUTE_PROBES,
    'pi-extension': () => ({ sessionId: 'pi-session', address: { '  ': '/tmp/pi.ipc' } }),
  };
  publishWakeRoutesFrom('owner-blank-key', blankKeyProbes, { at: 5, env: item.env });

  for (const ownerId of ['owner-value', 'owner-session', 'owner-blank', 'owner-empty-address', 'owner-blank-key']) {
    assert.deepEqual(readWakeRoutes({ ownerId, env: item.env, now: 6 }), [], `${ownerId} must not publish`);
  }
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('only routes refreshed within 24 hours are eligible', () => {
  const item = files();
  fs.writeFileSync(item.env.SQUARE_ROUTES, [
    JSON.stringify({ v: 1, ts: 1, op: 'upsert', owner_id: 'owner-old', session_id: 'old', kind: 'paseo', address: { agentId: 'old' } }),
    JSON.stringify({ v: 1, ts: 24 * 60 * 60 * 1000, op: 'upsert', owner_id: 'owner', session_id: 'fresh', kind: 'paseo', address: { agentId: 'fresh' } }),
  ].join('\n') + '\n');
  assert.deepEqual(
    readWakeRoutes({ ownerId: 'owner', freshOnly: true, now: 24 * 60 * 60 * 1000 + 1, env: item.env }).map((route) => route.sessionId),
    ['fresh']
  );
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('route folding uses timestamps and ignores malformed, future, and expired rows', () => {
  const item = files();
  const day = 24 * 60 * 60 * 1000;
  const now = 8 * day;
  fs.writeFileSync(item.env.SQUARE_ROUTES, [
    JSON.stringify({ v: 1, ts: now - day, op: 'upsert', owner_id: 'owner', session_id: 'new', kind: 'paseo', address: { agentId: 'new' } }),
    JSON.stringify({ v: 1, ts: now - 2 * day, op: 'retire', owner_id: 'owner', session_id: 'old', kind: 'paseo' }),
    JSON.stringify({ v: 1, ts: 0, op: 'retire', owner_id: 'owner', session_id: 'expired', kind: 'paseo' }),
    JSON.stringify({ v: 1, ts: now + 1, op: 'retire', owner_id: 'owner', session_id: 'future', kind: 'paseo' }),
    '{bad json}',
  ].join('\n') + '\n');
  assert.deepEqual(readWakeRoutes({ ownerId: 'owner', now, env: item.env }).map((route) => route.sessionId), ['new']);
  fs.rmSync(item.root, { recursive: true, force: true });
});
