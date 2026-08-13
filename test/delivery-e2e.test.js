import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { loadSquare, parseSquare, renderSquareDoc, saveRuntimeSidecar } from '../dist/artifact.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { classifyDeliveryHealth } from '../dist/delivery-health.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { processActNotificationsOnce } from '../dist/notifications.js';
import { presentOnce } from '../dist/presented.js';
import { recordDone, recordJoin } from '../dist/registry.js';
import { upsertWakeRoute } from '../dist/routes.js';
import { readWakeAttempts } from '../dist/wake-attempts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'square.js');
const WORKER = path.join(ROOT, 'test', 'fixtures', 'delivery-worker.js');

function workshop() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-delivery-e2e-'));
  const squarePath = path.join(root, 'SQUARE.md');
  const env = {
    ...process.env,
    HOME: root,
    CLAUDE_CODE_SESSION_ID: '',
    CLAUDE_CODE_CHILD_SESSION: '',
    CODEX_THREAD_ID: '',
    OPENCODE_SESSION_ID: '',
    SQUARE_PI_SESSION_ID: '',
    PASEO_AGENT_ID: '',
    SQUARE_DISABLE_PASEO_WAKE: '1',
    SQUARE_REGISTRY: path.join(root, 'registry.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_HEARTBEATS: path.join(root, 'heartbeats.ndjsonl'),
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
  };

  function cli(name, args, at = Date.now(), input) {
    const command = ['--square-path', squarePath, ...(name ? ['--as', name] : []), ...args];
    const result = spawnSync(process.execPath, [CLI, ...command], {
      cwd: ROOT,
      encoding: 'utf8',
      input,
      env: { ...env, SQUARE_NOW_MS: String(at) },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result;
  }

  cli(undefined, ['build', '--cap', 'unlimited', '--force'], 1, 'delivery acceptance\n');
  cli('Alice', ['join'], 10);
  cli('Bob', ['join'], 20);

  return {
    root,
    squarePath,
    env,
    cli,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function withRegistry(env, fn) {
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = env.SQUARE_REGISTRY;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(() => restoreRegistry(previous));
    }
    restoreRegistry(previous);
    return result;
  } catch (error) {
    restoreRegistry(previous);
    throw error;
  }
}

function restoreRegistry(previous) {
  if (previous === undefined) delete process.env.SQUARE_REGISTRY;
  else process.env.SQUARE_REGISTRY = previous;
}

function registerRoute(item, ownerId = 'bob-owner', sessionId = 'bob-session', at = Date.now()) {
  withRegistry(item.env, () => recordJoin(sessionId, 'Bob', item.squarePath, {
    channel: 'paseo',
    paseoAgentId: sessionId,
    ownerId,
    at,
  }));
  upsertWakeRoute({
    ownerId,
    sessionId,
    kind: 'paseo',
    address: { agentId: sessionId },
    source: 'join-env',
  }, { env: item.env, at });
}

function inboxFor(item, act) {
  return [{
    name: 'Bob',
    squarePath: item.squarePath,
    notifications: [{ actIndex: act.index, actor: act.actor, at: act.at, route: 'mention', body: act.body }],
  }];
}

function acceptedAdapter(onBeforeSend) {
  return {
    kind: 'paseo',
    calls: 0,
    async dispatch(_route, _request, beforeSend) {
      if (onBeforeSend) await onBeforeSend();
      if (!(await beforeSend())) return { outcome: 'cancelled' };
      this.calls += 1;
      return { outcome: 'accepted' };
    },
  };
}

function runWorker(item, actIndex, mode = 'accepted', callLog = path.join(item.root, 'worker-calls.log')) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, item.squarePath, String(actIndex), mode, callLog], {
      cwd: ROOT,
      env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ child, code, signal, stdout, stderr, callLog }));
  });
}

function spawnHeldWorker(item, actIndex, callLog) {
  const child = spawn(process.execPath, [WORKER, item.squarePath, String(actIndex), 'hold-after-send', callLog], {
    cwd: ROOT,
    env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sent = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('sent\n')) resolve();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => reject(new Error(`worker closed before send: ${code}/${signal}: ${stderr}`)));
  });
  return { child, sent };
}

function callCount(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
}

test('artifact roundtrip derives only directed pending attention', () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', 'please review @Bob'], 30);
    item.cli('Alice', ['express', '--force', 'broadcast'], 40);

    const parsed = parseSquare(renderSquareDoc(loadSquare(item.squarePath)));
    const pending = deriveDeliveryModel(parsed).pendingFor('Bob');
    assert.equal(pending.length, 1);
    assert.equal(deriveDeliveryModel(parsed).plan(parsed.acts.at(-1))[0].route, 'broadcast');
  } finally {
    item.cleanup();
  }
});

test('a native boundary presents bounded awareness once and records the current owner', () => {
  const item = workshop();
  try {
    const body = `@Bob ${'x'.repeat(400)}`;
    item.cli('Alice', ['express', '--force', body], 30);
    const act = loadSquare(item.squarePath).acts.at(-1);
    registerRoute(item, 'bob-owner', 'bob-native');
    let payload;

    const first = withRegistry(item.env, () => presentPendingAtBoundary(
      'bob-native',
      (context) => { payload = context; return 'presented'; },
      () => inboxFor(item, act),
      item.env,
    ));
    const second = withRegistry(item.env, () => presentPendingAtBoundary(
      'bob-native',
      () => { throw new Error('duplicate presentation'); },
      () => inboxFor(item, act),
      item.env,
    ));

    assert.equal(first, 'presented');
    assert.equal(second, undefined);
    assert.match(payload, /@Bob x{195}\n… \[truncated; run catch --now\]/);
    assert.match(payload, /square --square-path .* --as 'Bob' catch --now/);
    assert.doesNotMatch(payload, new RegExp(`x{${body.length - 5}}`));
    assert.ok(payload.length <= 1200);
    const rows = fs.readFileSync(item.env.SQUARE_PRESENTED, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].owner_id, 'bob-owner');
  } finally {
    item.cleanup();
  }
});

test('catch is the durable acknowledgement that closes pending attention for later workers', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', 'please catch @Bob'], 30);
    const act = loadSquare(item.squarePath).acts.at(-1);
    registerRoute(item);
    withRegistry(item.env, () => presentOnce('bob-session', () => inboxFor(item, act), () => true, item.env));

    item.cli('Bob', ['catch', '--now'], 40);
    const caught = loadSquare(item.squarePath);
    assert.equal(caught.runtime.deliveryReceipts.Bob[`act_${act.index}`].status, 'delivered');
    assert.ok(caught.runtime.cursors.Bob.consumedThroughIndex >= act.index);
    assert.deepEqual(deriveDeliveryModel(caught).pendingFor('Bob'), []);

    const worker = await runWorker(item, act.index);
    assert.equal(worker.code, 0, worker.stderr);
    assert.equal(callCount(worker.callLog), 0);
    assert.deepEqual(readWakeAttempts({ env: item.env }), []);
  } finally {
    item.cleanup();
  }
});

test('wake acceptance is durable and at most once across worker processes', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', 'wake once @Bob'], 30);
    const act = loadSquare(item.squarePath).acts.at(-1);
    registerRoute(item);
    const callLog = path.join(item.root, 'worker-calls.log');

    const workers = await Promise.all([
      runWorker(item, act.index, 'accepted', callLog),
      runWorker(item, act.index, 'accepted', callLog),
    ]);
    const later = await runWorker(item, act.index, 'accepted', callLog);
    for (const worker of [...workers, later]) assert.equal(worker.code, 0, worker.stderr);

    assert.equal(callCount(callLog), 1);
    assert.deepEqual(readWakeAttempts({ env: item.env }).map(({ outcome }) => outcome), ['accepted']);
    assert.deepEqual(loadSquare(item.squarePath).runtime.notifyLeases, {});
  } finally {
    item.cleanup();
  }
});

test('a crash after send recovers unknown and permanently prevents a second send', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', 'crash window @Bob'], 30);
    const act = loadSquare(item.squarePath).acts.at(-1);
    registerRoute(item);
    const callLog = path.join(item.root, 'worker-calls.log');
    const held = spawnHeldWorker(item, act.index, callLog);

    await held.sent;
    held.child.kill('SIGKILL');
    await new Promise((resolve) => held.child.once('close', resolve));
    const interrupted = loadSquare(item.squarePath).runtime;
    const lease = interrupted.notifyLeases[JSON.stringify([`act_${act.index}`, 'bob'])];
    assert.equal(lease.phase, 'dispatching');
    assert.equal(callCount(callLog), 1);

    lease.expiresAt = 1;
    saveRuntimeSidecar(item.squarePath, interrupted);
    const recovery = await runWorker(item, act.index, 'accepted', callLog);
    const later = await runWorker(item, act.index, 'accepted', callLog);
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.equal(later.code, 0, later.stderr);
    assert.equal(callCount(callLog), 1);
    assert.deepEqual(readWakeAttempts({ env: item.env }).map(({ outcome, signature }) => [outcome, signature]), [
      ['unknown', 'worker_interrupted_during_dispatch'],
    ]);
    const health = withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, { env: item.env }));
    assert.equal(health.find(({ actIndex }) => actIndex === act.index).kind, 'wake-unknown');
  } finally {
    item.cleanup();
  }
});

test('presentation suppresses wake before worker start and at the final pre-send check', async () => {
  const item = workshop();
  try {
    registerRoute(item);
    item.cli('Alice', ['express', '--force', 'already visible @Bob'], 30);
    const visible = loadSquare(item.squarePath).acts.at(-1);
    withRegistry(item.env, () => presentOnce('bob-session', () => inboxFor(item, visible), () => true, item.env));
    const first = acceptedAdapter();
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, visible.index, { env: item.env, adapters: [first] }));

    item.cli('Alice', ['express', '--force', 'race boundary @Bob'], 40);
    const racing = loadSquare(item.squarePath).acts.at(-1);
    const second = acceptedAdapter(() => withRegistry(item.env, () => presentOnce(
      'bob-session',
      () => inboxFor(item, racing),
      () => true,
      item.env,
    )));
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, racing.index, { env: item.env, adapters: [second] }));

    assert.equal(first.calls, 0);
    assert.equal(second.calls, 0);
    assert.deepEqual(readWakeAttempts({ env: item.env }), []);
  } finally {
    item.cleanup();
  }
});

test('presented evidence is scoped to the current participant owner', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', 'new owner must see this @Bob'], 30);
    const act = loadSquare(item.squarePath).acts.at(-1);
    registerRoute(item, 'old-owner', 'old-session');
    withRegistry(item.env, () => presentOnce('old-session', () => inboxFor(item, act), () => true, item.env));
    withRegistry(item.env, () => {
      recordDone('old-session', 'Bob', item.squarePath, { channel: 'paseo', at: Date.now() - 2 });
      recordJoin('new-session', 'Bob', item.squarePath, { channel: 'paseo', ownerId: 'new-owner', at: Date.now() - 1 });
    });
    upsertWakeRoute({
      ownerId: 'new-owner', sessionId: 'new-session', kind: 'paseo', address: { agentId: 'new-session' }, source: 'join-env',
    }, { env: item.env });
    const adapter = acceptedAdapter();

    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, act.index, { env: item.env, adapters: [adapter] }));
    const health = withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, { env: item.env }));

    assert.equal(adapter.calls, 1);
    assert.equal(health.find(({ actIndex }) => actIndex === act.index).kind, 'wake-accepted');
  } finally {
    item.cleanup();
  }
});
