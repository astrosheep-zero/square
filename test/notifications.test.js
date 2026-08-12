import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { emptyRuntimeState, loadSquare, renderSquareDoc, saveRuntimeSidecar } from '../dist/artifact.js';
import { processActNotificationsOnce } from '../dist/notifications.js';
import { PaseoAdapter } from '../dist/paseo-delivery.js';
import { presentOnce } from '../dist/presented.js';
import { recordJoin } from '../dist/registry.js';
import { upsertWakeRoute } from '../dist/routes.js';
import { PaseoWakeSendError } from '../dist/wake-sink.js';
import { readWakeAttempts } from '../dist/wake-attempts.js';
import { WakePort } from '../dist/wake-port.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-notify-'));
  const squarePath = path.join(root, 'square.md');
  const env = {
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
  };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, body: '', index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, body: '', index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'private payload @Bob', index: 2 },
  ];
  const doc = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts,
    runtime: { ...emptyRuntimeState(3), nextActIndex: 3 },
  };
  fs.writeFileSync(squarePath, renderSquareDoc(doc));
  saveRuntimeSidecar(squarePath, doc.runtime);
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
    source: 'join-env',
  }, { env: item.env, at: options.at });
}

function fakeAdapter(kind, dispatch) {
  return { kind, dispatch };
}

test('WakePort tries each eligible route once and stops globally on unknown', async () => {
  const item = fixture();
  const now = Date.now();
  for (const [kind, sessionId] of [['opencode-server', 'opencode'], ['paseo', 'paseo']]) {
    upsertWakeRoute({
      ownerId: 'bob-owner', sessionId, kind, address: { sessionId, agentId: sessionId }, source: 'join-env',
    }, { env: item.env, at: now });
  }
  const calls = [];
  const port = new WakePort([
    fakeAdapter('opencode-server', async () => {
      calls.push('opencode-server');
      return { outcome: 'failed', signature: 'refused', message: 'refused' };
    }),
    fakeAdapter('paseo', async () => {
      calls.push('paseo');
      return { outcome: 'unknown', signature: 'timeout', message: 'timeout' };
    }),
  ], item.env);

  const result = await port.dispatch(new Set(['bob-owner']), {
    squarePath: item.squarePath, actIndex: 2, recipient: 'Bob', actor: 'Alice', route: 'mention',
  }, {
    nextAttemptN: () => calls.length + 1,
    canAttempt: () => true,
    beforeSend: async () => true,
    record: async () => {},
  });

  assert.deepEqual(result, { outcome: 'unknown' });
  assert.deepEqual(calls, ['opencode-server', 'paseo']);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('PaseoAdapter waits for the current boundary and sends awareness only', async () => {
  const item = fixture();
  route(item, { agentId: 'exact-agent' });
  const registered = { ownerId: 'bob-owner', sessionId: 'exact-agent', kind: 'paseo', address: { agentId: 'exact-agent' }, source: 'join-env', updatedAt: Date.now() };
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
  const outcome = await withRegistry(item.env, () => adapter.dispatch(registered, {
    squarePath: item.squarePath, actIndex: 2, recipient: 'Bob', actor: 'Alice', route: 'mention',
  }, async () => true));

  assert.deepEqual(outcome, { outcome: 'accepted' });
  assert.equal(boundary, true);
  assert.equal(sent.agentId, 'exact-agent');
  assert.match(sent.prompt, /native adapter/);
  assert.match(sent.prompt, /catch --now/);
  assert.doesNotMatch(sent.prompt, /private payload/);
  assert.deepEqual(loadSquare(item.squarePath).runtime.deliveryReceipts, {});
  assert.equal(fs.existsSync(item.env.SQUARE_PRESENTED), false);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('PaseoAdapter records transport certainty without leaking retry policy', async () => {
  const item = fixture();
  route(item);
  const registered = { ownerId: 'bob-owner', sessionId: 'bob-agent', kind: 'paseo', address: { agentId: 'bob-agent' }, source: 'join-env', updatedAt: Date.now() };
  const request = { squarePath: item.squarePath, actIndex: 2, recipient: 'Bob', actor: 'Alice', route: 'mention' };
  const base = {
    discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'idle' }] }),
    waitForBoundary: async () => true,
  };
  const failed = await withRegistry(item.env, () => new PaseoAdapter({
    ...base,
    sendWake: () => { throw new PaseoWakeSendError('refused', 'transient'); },
  }).dispatch(registered, request, async () => true));
  const unknown = await withRegistry(item.env, () => new PaseoAdapter({
    ...base,
    sendWake: () => { throw new PaseoWakeSendError('timeout', 'unknown'); },
  }).dispatch(registered, request, async () => true));

  assert.deepEqual(failed.outcome, 'failed');
  assert.deepEqual(failed.signature, 'send_pre_accept_transient');
  assert.equal('retryable' in failed, false);
  assert.equal(unknown.outcome, 'unknown');
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('coordinator records one terminal wake across concurrent and later workers', async () => {
  const item = fixture();
  route(item);
  let sends = 0;
  const adapters = [fakeAdapter('paseo', async (_route, _request, beforeSend) => {
    if (!(await beforeSend())) return { outcome: 'cancelled' };
    sends += 1;
    return { outcome: 'accepted' };
  })];
  await withRegistry(item.env, () => Promise.all([
    processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }),
    processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }),
  ]));
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }));

  assert.equal(sends, 1);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => attempt.outcome), ['accepted']);
  assert.deepEqual(loadSquare(item.squarePath).runtime.notifyLeases, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('a send followed by ledger failure recovers unknown and never sends again', async () => {
  const item = fixture();
  route(item);
  let sends = 0;
  const adapters = [fakeAdapter('paseo', async (_route, _request, beforeSend) => {
    if (!(await beforeSend())) return { outcome: 'cancelled' };
    sends += 1;
    fs.mkdirSync(item.env.SQUARE_WAKE_ATTEMPTS);
    return { outcome: 'accepted' };
  })];

  await assert.rejects(
    withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters })),
    { code: 'EISDIR' },
  );
  const interrupted = loadSquare(item.squarePath).runtime;
  const key = JSON.stringify(['act_2', 'bob']);
  assert.equal(interrupted.notifyLeases[key].phase, 'dispatching');
  assert.equal(sends, 1);

  fs.rmdirSync(item.env.SQUARE_WAKE_ATTEMPTS);
  interrupted.notifyLeases[key].expiresAt = 2;
  saveRuntimeSidecar(item.squarePath, interrupted);
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }));

  assert.equal(sends, 1);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => [attempt.outcome, attempt.signature]), [
    ['unknown', 'worker_interrupted_during_dispatch'],
  ]);
  assert.deepEqual(loadSquare(item.squarePath).runtime.notifyLeases, {});
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

test('a failed route is retried only after its route fact is refreshed', async () => {
  const item = fixture();
  route(item);
  let sends = 0;
  const adapters = [fakeAdapter('paseo', async (_route, _request, beforeSend) => {
    if (!(await beforeSend())) return { outcome: 'cancelled' };
    sends += 1;
    return sends === 1
      ? { outcome: 'failed', signature: 'address_not_found', message: 'not found' }
      : { outcome: 'accepted' };
  })];

  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }));
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }));
  assert.equal(sends, 1);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => attempt.outcome), ['failed']);

  await sleep(2);
  upsertWakeRoute({
    ownerId: 'bob-owner', sessionId: 'bob-agent', kind: 'paseo', address: { agentId: 'bob-agent' }, source: 'join-env',
  }, { env: item.env, at: Date.now() });
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters }));

  assert.equal(sends, 2);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => attempt.outcome), ['failed', 'accepted']);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('presentation at the awaited boundary cancels wake without an attempt', async () => {
  const item = fixture();
  route(item, { sessionId: 'bob-session' });
  let sends = 0;
  const adapter = new PaseoAdapter({
    discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'running' }] }),
    waitForBoundary: async () => {
      presentOnce('bob-session', () => [{
        name: 'Bob',
        squarePath: item.squarePath,
        notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'private payload @Bob' }],
      }], () => true, item.env);
      return true;
    },
    sendWake: () => { sends += 1; },
  });
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters: [adapter] }));

  assert.equal(sends, 0);
  assert.deepEqual(readWakeAttempts({ env: item.env }), []);
  fs.rmSync(item.root, { recursive: true, force: true });
});
