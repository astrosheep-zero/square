import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { recordLocalDone, recordLocalJoin } from '../dist/registry.js';
import { readWakeRoutes } from '../dist/routes.js';

function files() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-routes-'));
  return {
    root,
    square: path.join(root, 'square.md'),
    env: {
      SQUARE_REGISTRY: path.join(root, 'registry.ndjsonl'),
      SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    },
  };
}

test('explicit join publishes only its Paseo route and done retires it', () => {
  const item = files();
  const env = {
    ...item.env,
    CLAUDE_CODE_SESSION_ID: 'claude-session',
    PASEO_AGENT_ID: 'paseo-agent',
    OPENCODE_SESSION_ID: 'opencode-session',
  };
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = item.env.SQUARE_REGISTRY;
  try {
    recordLocalJoin('Bob', item.square, env);
    const routes = readWakeRoutes({ env, now: Date.now() + 1 });
    assert.deepEqual(routes.map((route) => route.kind), ['paseo']);
    assert.deepEqual(routes[0].address, { agentId: 'paseo-agent' });
    recordLocalDone('Bob', item.square, env);
    assert.deepEqual(readWakeRoutes({ env, now: Date.now() + 2 }), []);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
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
