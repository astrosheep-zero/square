import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  return { root, squarePath, env, doc };
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

function registerRoute(item, options = {}) {
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
  }, { env: item.env });
}

function fakeAdapter(dispatch) {
  return { kind: 'paseo', dispatch };
}

test('WakePort retries only pre-accept failures and stops globally on accepted or unknown', async () => {
  const item = fixture();
  registerRoute(item);
  const route = { ownerId: 'bob-owner', sessionId: 'bob-agent', kind: 'paseo', address: { agentId: 'bob-agent' }, source: 'join-env', updatedAt: Date.now() };
  const request = { squarePath: item.squarePath, actIndex: 2, recipient: 'Bob', actor: 'Alice', route: 'mention' };
  const outcomes = [];
  let calls = 0;
  const port = new WakePort([fakeAdapter(async () => {
    calls += 1;
    return calls === 1
      ? { outcome: 'failed', signature: 'refused', message: 'refused', retryable: true }
      : { outcome: 'accepted' };
  })], item.env);
  const result = await port.dispatch(new Set(['bob-owner']), request, {
    nextAttemptN: () => calls + 1,
    beforeSend: async () => true,
    record: async (_route, _attempt, outcome) => outcomes.push(outcome.outcome),
  }, { retryDelaysMs: [1], delay: async () => {} });
  assert.deepEqual(result, { outcome: 'accepted' });
  assert.deepEqual(outcomes, ['failed', 'accepted']);

  const unknown = new WakePort([fakeAdapter(async () => ({
    outcome: 'unknown', signature: 'timeout', message: 'timeout',
  }))], item.env);
  assert.deepEqual(await unknown.dispatch(new Set([route.ownerId]), request, {
    nextAttemptN: () => 1,
    beforeSend: async () => true,
    record: async () => {},
  }, { retryDelaysMs: [1], delay: async () => { throw new Error('unknown must not retry'); } }), { outcome: 'unknown' });
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('PaseoAdapter proves the registered route live, waits for the current boundary, and sends awareness only', async () => {
  const item = fixture();
  registerRoute(item, { agentId: 'exact-agent' });
  const route = { ownerId: 'bob-owner', sessionId: 'exact-agent', kind: 'paseo', address: { agentId: 'exact-agent' }, source: 'join-env', updatedAt: Date.now() };
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
  let beforeSend = false;
  const outcome = await withRegistry(item.env, () => adapter.dispatch(route, {
    squarePath: item.squarePath,
    actIndex: 2,
    recipient: 'Bob',
    actor: 'Alice',
    route: 'mention',
  }, async () => { beforeSend = true; return true; }));
  assert.deepEqual(outcome, { outcome: 'accepted' });
  assert.equal(boundary, true);
  assert.equal(beforeSend, true);
  assert.equal(sent.agentId, 'exact-agent');
  assert.match(sent.prompt, /native adapter/);
  assert.match(sent.prompt, /catch --now/);
  assert.doesNotMatch(sent.prompt, /private payload/);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('PaseoAdapter classifies transport results without throwing across the port', async () => {
  const item = fixture();
  registerRoute(item);
  const route = { ownerId: 'bob-owner', sessionId: 'bob-agent', kind: 'paseo', address: { agentId: 'bob-agent' }, source: 'join-env', updatedAt: Date.now() };
  const request = { squarePath: item.squarePath, actIndex: 2, recipient: 'Bob', actor: 'Alice', route: 'mention' };
  const base = {
    discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'idle' }] }),
    waitForBoundary: async () => true,
  };
  const retryable = await withRegistry(item.env, () => new PaseoAdapter({
    ...base,
    sendWake: () => { throw new PaseoWakeSendError('refused', 'retryable'); },
  }).dispatch(route, request, async () => true));
  assert.equal(retryable.outcome, 'failed');
  assert.equal(retryable.retryable, true);
  const unknown = await withRegistry(item.env, () => new PaseoAdapter({
    ...base,
    sendWake: () => { throw new PaseoWakeSendError('timeout', 'unknown'); },
  }).dispatch(route, request, async () => true));
  assert.equal(unknown.outcome, 'unknown');
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('coordinator durably records accepted and never sends the same attention again', async () => {
  const item = fixture();
  registerRoute(item);
  let sends = 0;
  const adapters = [fakeAdapter(async (_route, _request, beforeSend) => {
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

test('an expired dispatching lease becomes terminal unknown without another send', async () => {
  const item = fixture();
  registerRoute(item);
  const runtime = loadSquare(item.squarePath).runtime;
  runtime.notifyLeases[JSON.stringify(['act_2', 'bob'])] = {
    leaseId: 'interrupted',
    expiresAt: 2,
    phase: 'dispatching',
    attemptN: 1,
    routeKind: 'paseo',
  };
  saveRuntimeSidecar(item.squarePath, runtime);
  let sends = 0;
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [fakeAdapter(async () => { sends += 1; return { outcome: 'accepted' }; })],
  }));
  assert.equal(sends, 0);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => [attempt.outcome, attempt.signature]), [
    ['unknown', 'worker_interrupted_during_dispatch'],
  ]);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('an accepted send with a failed ledger write is recovered as unknown without another send', async () => {
  const item = fixture();
  registerRoute(item);
  let sends = 0;
  const adapters = [fakeAdapter(async (_route, _request, beforeSend) => {
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

test('presented attention cancels after a boundary and leaves no wake attempt', async () => {
  const item = fixture();
  registerRoute(item, { sessionId: 'bob-session' });
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

test('active catch may deliver before Paseo sends', async () => {
  const item = fixture();
  registerRoute(item, { sessionId: 'bob-session' });
  const runtime = loadSquare(item.squarePath).runtime;
  runtime.leases.Bob = {
    leaseId: 'catch-active',
    ownerId: 'bob-owner',
    heartbeatAt: Date.now(),
    expiresAt: Date.now() + 10_000,
  };
  saveRuntimeSidecar(item.squarePath, runtime);
  let sends = 0;
  const adapter = new PaseoAdapter({
    discover: () => ({ agents: [{ id: 'bob-agent', name: 'Bob', status: 'idle' }] }),
    sendWake: () => { sends += 1; },
  });
  const processing = withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, { env: item.env, adapters: [adapter] }));
  await sleep(25);
  const delivered = loadSquare(item.squarePath).runtime;
  delivered.deliveryReceipts.Bob = { act_2: { status: 'delivered', at: Date.now() } };
  saveRuntimeSidecar(item.squarePath, delivered);
  await processing;
  assert.equal(sends, 0);
  fs.rmSync(item.root, { recursive: true, force: true });
});

test('detached worker uses durable routes and attempts', () => {
  const item = fixture();
  registerRoute(item, { agentId: 'exact-agent' });
  const bin = path.join(item.root, 'bin');
  const paseo = path.join(bin, 'paseo');
  const log = path.join(item.root, 'paseo.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(paseo, `#!/bin/sh\nif [ "$1" = "ls" ]; then\n  printf '%s\\n' '[{"id":"exact-agent","name":"Other","status":"idle"}]'\nelif [ "$1" = "send" ]; then\n  printf '%s\\n' "$@" > "$SQUARE_FAKE_PASEO_LOG"\nfi\n`);
  fs.chmodSync(paseo, 0o755);
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dist/cmd/notify-once.js'), '--square-path', item.squarePath, '--act-index', '2'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      ...item.env,
      SQUARE_NOTIFY_DELIVERY_WAIT_MS: '1',
      SQUARE_FAKE_PASEO_LOG: log,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(log, 'utf8'), /^send\nexact-agent\n/m);
  assert.deepEqual(readWakeAttempts({ env: item.env }).map((attempt) => attempt.outcome), ['accepted']);
  fs.rmSync(item.root, { recursive: true, force: true });
});
