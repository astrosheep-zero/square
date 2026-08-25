import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { emptyRuntimeState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { processActNotificationsOnce } from '../dist/notifications.js';
import { PaseoAdapter } from '../dist/paseo-delivery.js';
import { recordJoin } from '../dist/registry.js';
import { upsertWakeRoute } from '../dist/routes.js';
import { PaseoWakeSendError } from '../dist/wake-sink.js';
import { readWakeAttempts } from '../dist/wake-attempts.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-notify-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const env = {
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
  };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'private payload @Bob', index: 2 },
  ];
  const squareState = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts,
    runtime: { ...emptyRuntimeState(3), nextActIndex: 3 },
  };
  writeSquareFile(squarePath, squareState);
  return { root, squarePath, env };
}

function withRegistry(env, fn) {
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = env.SQUARE_REGISTRY;
  const restore = () => {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function route(item, options = {}) {
  const ownerId = options.ownerId ?? 'bob-owner';
  const agentId = options.agentId ?? 'bob-agent';
  const sessionId = options.sessionId ?? agentId;
  withRegistry(item.env, () => recordJoin(sessionId, 'Bob', item.squarePath, {
    channel: 'paseo',
    paseoAgentId: agentId,
    ownerId,
  }));
  upsertWakeRoute({
    ownerId,
    sessionId,
    kind: 'paseo',
    address: { agentId },
  }, { env: item.env, at: options.at });
}

function fakeAdapter(kind, dispatch) {
  return { kind, dispatch };
}

test('PaseoAdapter waits for the current boundary and sends supplied awareness only', async () => {
  const item = fixture();
  route(item, { agentId: 'exact-agent' });
  const registered = { ownerId: 'bob-owner', sessionId: 'exact-agent', kind: 'paseo', address: { agentId: 'exact-agent' }, updatedAt: Date.now() };
  let boundary = false;
  let sent;
  const adapter = new PaseoAdapter({
    discover: () => ({ agents: [
      { id: 'decoy', name: 'Bob', status: 'idle' },
      { id: 'exact-agent', name: 'Other', status: 'running' },
    ] }),
    waitForBoundary: async () => { boundary = true; return true; },
    sendWake: (request) => { sent = request; },
  });
  const payload = '<system-reminder source="square">awareness</system-reminder>';
  const outcome = await adapter.dispatch(registered.address, payload, async () => true);

  assert.deepEqual(outcome, { outcome: 'accepted' });
  assert.equal(boundary, true);
  assert.equal(sent.agentId, 'exact-agent');
  assert.equal(sent.prompt, payload);
  assert.doesNotMatch(sent.prompt, /private payload/);
  assert.deepEqual(loadSquare(item.squarePath).runtime.deliveryReceipts, {});
  assert.equal(fs.existsSync(item.env.SQUARE_PRESENTED), false);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('the notification worker records an accepted wake through the real Paseo adapter', async () => {
  const item = fixture();
  route(item, { agentId: 'integrated-agent' });
  let sent;
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({
      discover: () => ({ agents: [{ id: 'integrated-agent', name: 'Bob', status: 'idle' }] }),
      sendWake: (request) => { sent = request; },
    })],
  }));

  assert.equal(sent.agentId, 'integrated-agent');
  assert.match(sent.prompt, /<system-reminder source="square">/);
  assert.match(sent.prompt, /private payload @Bob/);
  assert.match(sent.prompt, /catch --now/);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map(({ outcome }) => outcome), ['accepted']);
  assert.deepEqual(loadSquare(item.squarePath).runtime.notifyLeases, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('PaseoAdapter records transport certainty without leaking retry policy', async () => {
  const item = fixture();
  route(item);
  const registered = { ownerId: 'bob-owner', sessionId: 'bob-agent', kind: 'paseo', address: { agentId: 'bob-agent' }, updatedAt: Date.now() };
  const payload = '<system-reminder source="square">awareness</system-reminder>';
  const base = {
    discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'idle' }] }),
    waitForBoundary: async () => true,
  };
  const failed = await withRegistry(item.env, () => new PaseoAdapter({
    ...base,
    sendWake: () => { throw new PaseoWakeSendError('refused', 'transient'); },
  }).dispatch(registered.address, payload, async () => true));
  const unknown = await withRegistry(item.env, () => new PaseoAdapter({
    ...base,
    sendWake: () => { throw new PaseoWakeSendError('timeout', 'unknown'); },
  }).dispatch(registered.address, payload, async () => true));

  assert.deepEqual(failed.outcome, 'failed');
  assert.deepEqual(failed.signature, 'send_pre_accept_transient');
  assert.equal('retryable' in failed, false);
  assert.equal(unknown.outcome, 'unknown');
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('PaseoAdapter treats a closed agent as unavailable instead of a failed send', async () => {
  const item = fixture();
  route(item, { agentId: 'closed-agent' });
  const registered = { ownerId: 'bob-owner', sessionId: 'closed-agent', kind: 'paseo', address: { agentId: 'closed-agent' }, updatedAt: Date.now() };
  const outcome = await new PaseoAdapter({
    discover: () => ({ agents: [] }),
  }).dispatch(registered.address, '<system-reminder source="square">awareness</system-reminder>', async () => true);
  assert.equal(outcome.outcome, 'unavailable');
  assert.equal(outcome.signature, 'address_not_found');
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a closed Paseo route is retired without consuming pending attention', async () => {
  const item = fixture();
  route(item, { agentId: 'gone-agent' });
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({ discover: () => ({ agents: [] }) })],
  }));
  assert.deepEqual(readWakeAttempts({ env: item.env }), []);
  const { readWakeRoutes } = await import('../dist/routes.js');
  assert.deepEqual(readWakeRoutes({ env: item.env, now: Date.now() }), []);
  assert.deepEqual(loadSquare(item.squarePath).runtime.deliveryReceipts, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a refreshed Paseo route wakes the old pending notification', async () => {
  const item = fixture();
  route(item, { agentId: 'gone-agent' });
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({ discover: () => ({ agents: [] }) })],
  }));

  const refreshedAt = Date.now();
  upsertWakeRoute({
    ownerId: 'bob-owner',
    sessionId: 'gone-agent',
    kind: 'paseo',
    address: { agentId: 'gone-agent' },
  }, { env: item.env, at: refreshedAt });
  let sent;
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({
      discover: () => ({ agents: [{ id: 'gone-agent', name: 'Bob', status: 'idle' }] }),
      sendWake: (request) => { sent = request; },
    })],
  }));

  assert.equal(sent.agentId, 'gone-agent');
  assert.deepEqual(readWakeAttempts({ env: item.env }).map(({ outcome }) => outcome), ['accepted']);
  assert.deepEqual(loadSquare(item.squarePath).runtime.deliveryReceipts, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a worker with no route writes no synthetic attempt', async () => {
  const item = fixture();
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [fakeAdapter('paseo', async () => { throw new Error('no route must not dispatch'); })],
  }));

  assert.deepEqual(readWakeAttempts({ env: item.env }), []);
  assert.deepEqual(loadSquare(item.squarePath).runtime.notifyLeases, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});
