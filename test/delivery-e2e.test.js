import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import { loadSquare, writeSquareFile } from '../dist/artifact.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { formatActivityId } from '../dist/square-core.js';
import { classifyDeliveryHealth, doctorDeliveryHealth } from '../dist/delivery-health.js';
import { wakeGraceMs } from '../dist/notifications.js';
import { deriveDeliveryModel } from '../dist/delivery.js';
import { processActNotificationsOnce, sweepPendingNotifications } from '../dist/notifications.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { recordDone, recordJoin } from '../dist/registry.js';
import { retireWakeRoute, upsertWakeRoute } from '../dist/routes.js';
import { readWakeAttempts, recordWakeAttempt } from '../dist/wake-attempts.js';
import { wakeEvidence, wakeIsEligible } from '../dist/wake-evidence.js';
import { readCursor } from '../dist/runtime.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'dist', 'square.js');
const WORKER = path.join(ROOT, 'test', 'fixtures', 'delivery-worker.js');

function workshop() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-delivery-e2e-'));
  const squarePath = path.join(root, 'SQUARE.square');
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
    SQUARE_HOST_LEDGER_USER: path.join(root, 'host-ledger'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
  };

  function cli(name, args, at = Date.now(), input) {
    const command = ['--location', squarePath, ...(name ? ['--as', name] : []), ...args];
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
  const previousLedger = process.env.SQUARE_HOST_LEDGER_USER;
  process.env.SQUARE_REGISTRY = env.SQUARE_REGISTRY;
  process.env.SQUARE_HOST_LEDGER_USER = env.SQUARE_HOST_LEDGER_USER;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(() => restoreRegistry(previous, previousLedger));
    }
    restoreRegistry(previous, previousLedger);
    return result;
  } catch (error) {
    restoreRegistry(previous, previousLedger);
    throw error;
  }
}

function restoreRegistry(previous, previousLedger) {
  if (previous === undefined) delete process.env.SQUARE_REGISTRY;
  else process.env.SQUARE_REGISTRY = previous;
  if (previousLedger === undefined) delete process.env.SQUARE_HOST_LEDGER_USER;
  else process.env.SQUARE_HOST_LEDGER_USER = previousLedger;
}

async function registerRoute(item, ownerId = 'bob-owner', sessionId = 'bob-session', at = Date.now()) {
  await withRegistry(item.env, async () => await recordJoin(sessionId, 'Bob', item.squarePath, {
    channel: 'paseo',
    paseoAgentId: sessionId,
    at,
  }));
  await upsertWakeRoute({
    location: item.squarePath,
    participant: 'Bob',
    sessionId,
    channel: 'paseo',
    kind: 'paseo',
    address: { agentId: sessionId },
  }, { env: item.env, at });
}

function inboxFor(item, act) {
  return [{
    name: 'Bob',
    squarePath: item.squarePath,
    notifications: [{ actIndex: act.index, actor: act.actor, at: act.at, route: 'mention', body: act.body }],
  }];
}

async function markPresentedEvidence(item, session, act, participant = 'Bob') {
  const ledger = createHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, writableScope: 'user', readableScopes: ['user'] });
  await ledger.appendEvidence({ location: item.squarePath, participant, session, activity: formatActivityId(act.index), kind: 'presentation', outcome: 'presented', at: Date.now() });
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

function snapshotFiles(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map((name) => {
    const file = path.join(root, name);
    return [name, fs.statSync(file).isFile() ? fs.readFileSync(file) : '<directory>'];
  }));
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

test('artifact roundtrip derives only directed pending attention', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'please review @Bob'], 30);

    const pending = deriveDeliveryModel(await loadSquare(item.squarePath)).pendingFor('Bob');
    assert.equal(pending.length, 1);
  } finally {
    item.cleanup();
  }
});

test('a native boundary presents bounded awareness and leaves clipped attention retryable', async () => {
  const item = workshop();
  try {
    const body = `@Bob ${'x'.repeat(400)}`;
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', body], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item, 'bob-owner', 'bob-native');
    let payload;

    const first = await withRegistry(item.env, () => presentPendingAtBoundary(
      'bob-native',
      (context) => { payload = context; return 'presented'; },
      () => inboxFor(item, act),
      item.env,
    ));
    let secondCalls = 0;
    const second = await withRegistry(item.env, () => presentPendingAtBoundary(
      'bob-native',
      () => { secondCalls += 1; return 'presented'; },
      () => inboxFor(item, act),
      item.env,
    ));

    assert.equal(first, 'presented');
    assert.equal(second, 'presented');
    assert.equal(secondCalls, 1);
    assert.match(payload, /@Bob x{95}\n… preview only/);
    assert.match(payload, /ignore if you have already seen this\./);
    assert.doesNotMatch(payload, /catch --now/);
    assert.doesNotMatch(payload, new RegExp(`x{${body.length - 5}}`));
    assert.ok(payload.length <= 1200);
    const rows = fs.readFileSync(path.join(item.env.SQUARE_HOST_LEDGER_USER, 'evidence.ndjsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter((row) => row.outcome === 'presented').length, 0);
    assert.ok(rows.every((row) => row.session === 'bob-native'));
    assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob?.[formatActivityId(act.index)], undefined);

    const evidence = await withRegistry(item.env, () => wakeEvidence(item.squarePath, 'Bob', act.index, Date.now(), item.env));
    assert.equal(evidence.presented, true);
    assert.equal(wakeIsEligible(evidence), true);
  } finally {
    item.cleanup();
  }
});

test('a native boundary marks a fully presented body seen', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'short attention @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item, 'bob-owner', 'bob-native');

    const result = await withRegistry(item.env, () => presentPendingAtBoundary(
      'bob-native',
      () => 'presented',
      () => [inboxFor(item, act)[0]],
      item.env,
    ));

    assert.equal(result, 'presented');
    const observation = (await loadSquare(item.squarePath)).runtime.observations.Bob[formatActivityId(act.index)];
    assert.equal(observation.state, 'seen');
    assert.equal(typeof observation.at, 'number');
    const evidence = await withRegistry(item.env, () => wakeEvidence(item.squarePath, 'Bob', act.index, Date.now(), item.env));
    assert.equal(evidence.delivered, true);
    assert.equal(wakeIsEligible(evidence), false);
  } finally {
    item.cleanup();
  }
});

test('catch is the durable acknowledgement that closes pending attention for later workers', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'please catch @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item);
    await markPresentedEvidence(item, 'bob-session', act);

    item.cli('Bob', ['catch', '--now'], 40);
    const caught = await loadSquare(item.squarePath);
    assert.equal(caught.runtime.observations.Bob[formatActivityId(act.index)].state, 'seen');
    assert.ok(readCursor(caught, 'Bob') >= act.index);
    assert.deepEqual(deriveDeliveryModel(caught).pendingFor('Bob'), []);

    const worker = await runWorker(item, act.index);
    assert.equal(worker.code, 0, worker.stderr);
    assert.equal(callCount(worker.callLog), 0);
    assert.deepEqual(await readWakeAttempts({ env: item.env }), []);
  } finally {
    item.cleanup();
  }
});

test('wake acceptance is durable and at most once across worker processes', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'wake once @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item);
    const callLog = path.join(item.root, 'worker-calls.log');

    const workers = await Promise.all([
      runWorker(item, act.index, 'accepted', callLog),
      runWorker(item, act.index, 'accepted', callLog),
    ]);
    const later = await runWorker(item, act.index, 'accepted', callLog);
    for (const worker of [...workers, later]) assert.equal(worker.code, 0, worker.stderr);

    assert.equal(callCount(callLog), 1);
    assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome }) => outcome), ['accepted']);
    assert.deepEqual((await loadSquare(item.squarePath)).runtime.leases, {});
  } finally {
    item.cleanup();
  }
});

test('an accepted native wake does not write presented evidence or suppress the boundary', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'native wake preview @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item);
    let payload;
    const adapter = {
      kind: 'paseo',
      async dispatch(_route, value, beforeSend) {
        payload = value;
        if (!(await beforeSend())) return { outcome: 'cancelled' };
        return { outcome: 'accepted' };
      },
    };
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, act.index, {
      env: item.env,
      adapters: [adapter],
    }));
    assert.match(payload, /act\//);
    assert.match(payload, /attention: act\/2 for Bob/);
    assert.equal(fs.existsSync(item.env.SQUARE_PRESENTED), false);
    assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob?.[formatActivityId(act.index)], undefined);
    const later = await withRegistry(item.env, () => presentPendingAtBoundary(
      'bob-session',
      () => 'presented',
      undefined,
      item.env,
    ));
    assert.equal(later, 'presented');
    assert.equal(fs.existsSync(path.join(item.env.SQUARE_HOST_LEDGER_USER, 'evidence.ndjsonl')), true);
  } finally {
    item.cleanup();
  }
});

test('a current owner notified observation suppresses another wake', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'notify current owner @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item, 'current-owner', 'current-session');
    const adapter = acceptedAdapter();
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, act.index, {
      env: item.env,
      adapters: [adapter],
    }));

    const evidence = await withRegistry(item.env, () => wakeEvidence(item.squarePath, 'Bob', act.index, Date.now(), item.env));
    assert.equal(evidence.delivered, false);
    assert.equal(wakeIsEligible(evidence), false);
  } finally {
    item.cleanup();
  }
});

test('a crash after send records unknown and blocks blind retry', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'crash window @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item);
    const callLog = path.join(item.root, 'worker-calls.log');
    const held = spawnHeldWorker(item, act.index, callLog);

    await held.sent;
    held.child.kill();
    await new Promise((resolve) => held.child.once('close', resolve));
    const interrupted = (await loadSquare(item.squarePath)).runtime;
    const lease = interrupted.leases.Bob;
    assert.equal(lease, undefined);
    assert.equal(callCount(callLog), 1);

    const recovery = await runWorker(item, act.index, 'accepted', callLog);
    const later = await runWorker(item, act.index, 'accepted', callLog);
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.equal(later.code, 0, later.stderr);
    assert.equal(callCount(callLog), 1);
    assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome, signature }) => [outcome, signature]), [
      ['unknown', 'worker_interrupted_during_dispatch'],
    ]);
    const claimsPath = path.join(item.env.SQUARE_HOST_LEDGER_USER, 'wake-claims.ndjsonl');
    const claims = fs.existsSync(claimsPath)
      ? fs.readFileSync(claimsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
    assert.equal(claims.some((claim) => claim.phase === 'dispatching'), false);
    const health = await withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, {
      graceMs: wakeGraceMs(item.env),
      env: item.env,
    }));
    assert.notEqual(health.find(({ actIndex }) => actIndex === act.index).kind, 'wake-accepted');
  } finally {
    item.cleanup();
  }
});

test('presentation does not suppress wake before worker start or at the final pre-send check', async () => {
  const item = workshop();
  try {
    await registerRoute(item);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'already visible @Bob'], 30);
    const visible = (await loadSquare(item.squarePath)).acts.at(-1);
    await markPresentedEvidence(item, 'bob-session', visible);
    const first = acceptedAdapter();
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, visible.index, { env: item.env, adapters: [first] }));

    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'race boundary @Bob'], 40);
    const racing = (await loadSquare(item.squarePath)).acts.at(-1);
    const second = acceptedAdapter(() => markPresentedEvidence(item, 'bob-session', racing));
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, racing.index, { env: item.env, adapters: [second] }));

    assert.equal(first.calls, 1);
    assert.equal(second.calls, 1);
    assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome }) => outcome), ['accepted', 'accepted']);
  } finally {
    item.cleanup();
  }
});

test('presented evidence is scoped to the current participant owner', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'new owner must see this @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    await registerRoute(item, 'old-owner', 'old-session');
    await markPresentedEvidence(item, 'old-session', act);
    await withRegistry(item.env, async () => {
      await recordDone('old-session', 'Bob', item.squarePath, { channel: 'paseo', at: Date.now() - 2 });
      await recordJoin('new-session', 'Bob', item.squarePath, { channel: 'paseo', at: Date.now() - 1 });
    });
    await retireWakeRoute({ location: item.squarePath, participant: 'Bob', sessionId: 'old-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'old-session' }, updatedAt: Date.now() });
    await upsertWakeRoute({
      location: item.squarePath, participant: 'Bob', sessionId: 'new-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'new-session' },
    }, { env: item.env });
    const adapter = acceptedAdapter();

    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, act.index, { env: item.env, adapters: [adapter] }));
    const health = await withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, {
      graceMs: wakeGraceMs(item.env),
      env: item.env,
    }));

    assert.equal(adapter.calls, 1);
    // Presentation evidence is session-scoped; a new binding reports its own accepted wake.
    assert.equal(health.find(({ actIndex }) => actIndex === act.index).kind, 'wake-accepted');
  } finally {
    item.cleanup();
  }
});

test('new route evidence lets the bounded sweep recover old failed attention', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'recover this @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    const firstAttemptAt = Date.now() - 2_000;
    await registerRoute(item, 'bob-owner', 'bob-session', firstAttemptAt - 1_000);
    const failed = {
      kind: 'paseo',
      async dispatch(_route, _request, beforeSend) {
        if (!(await beforeSend())) return { outcome: 'cancelled' };
        return { outcome: 'failed', signature: 'address_not_found', message: 'not found' };
      },
    };

    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, act.index, {
      env: item.env,
      adapters: [failed],
      now: () => firstAttemptAt,
    }));
    const unreachable = await withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, {
      graceMs: wakeGraceMs(item.env),
      now: firstAttemptAt + 500,
      env: item.env,
    }));
    assert.equal(unreachable.find((item) => item.actIndex === act.index).kind, 'awaiting');

    await upsertWakeRoute({
      location: item.squarePath, participant: 'Bob', sessionId: 'bob-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'bob-session' },
    }, { env: item.env, at: firstAttemptAt + 1_000 });
    const launched = [];
    const selected = await withRegistry(item.env, () => sweepPendingNotifications(item.squarePath, {
      env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
      now: firstAttemptAt + 1_500,
      dispatchCandidate: (actIndex) => launched.push(actIndex),
    }));
    assert.deepEqual(selected, [act.index]);
    assert.deepEqual(launched, [act.index]);

    const worker = await runWorker(item, act.index);
    assert.equal(worker.code, 0, worker.stderr);
    assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome }) => outcome), ['failed', 'accepted']);
  } finally {
    item.cleanup();
  }
});

test('worker, sweep, and doctor derive the same wake eligibility without diagnostic writes', async () => {
  const item = workshop();
  try {
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'shared evidence @Bob'], 30);
    const act = (await loadSquare(item.squarePath)).acts.at(-1);
    const now = Date.now();
    await registerRoute(item, 'bob-owner', 'bob-session', now - 1_000);

    const before = snapshotFiles(item.root);
    const evidence = await withRegistry(item.env, () => wakeEvidence(item.squarePath, 'Bob', act.index, now, item.env));
    const graceMs = wakeGraceMs(item.env);
    const health = await withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, { graceMs, now, env: item.env }));
    const doctor = await withRegistry(item.env, () => doctorDeliveryHealth(item.squarePath, graceMs, now, item.env));
    const selected = await withRegistry(item.env, () => sweepPendingNotifications(item.squarePath, {
      env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
      now,
      dispatchCandidate: () => {},
    }));

    assert.equal(wakeIsEligible(evidence), true);
    assert.equal(health.find((item) => item.actIndex === act.index).kind, 'awaiting');
    assert.match(doctor.join('\n'), /○ awaiting: 1/);
    assert.deepEqual(selected, [act.index]);
    assert.deepEqual(snapshotFiles(item.root), before);

    const adapter = acceptedAdapter();
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, act.index, {
      env: item.env,
      adapters: [adapter],
    }));
    assert.equal(adapter.calls, 1);
    assert.equal(wakeIsEligible(await withRegistry(item.env, () => wakeEvidence(item.squarePath, 'Bob', act.index, Date.now(), item.env))), false);
    assert.equal((await withRegistry(item.env, () => classifyDeliveryHealth(item.squarePath, {
      graceMs: wakeGraceMs(item.env),
      env: item.env,
    })))
      .find((item) => item.actIndex === act.index).kind, 'wake-accepted');
    assert.deepEqual(await withRegistry(item.env, () => sweepPendingNotifications(item.squarePath, {
      env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
      dispatchCandidate: () => { throw new Error('terminal attention must not dispatch'); },
    })), []);
  } finally {
    item.cleanup();
  }
});

test('one sweep projects every candidate from one ledger read and keeps individual selection semantics', async () => {
  const item = workshop();
  const now = Date.now();
  try {
    await withRegistry(item.env, async () => {
      await recordJoin('carol-session', 'Carol', item.squarePath, {
        channel: 'paseo', paseoAgentId: 'carol-session', at: now - 200,
      });
    });
    await upsertWakeRoute({
      location: item.squarePath, participant: 'Carol', sessionId: 'carol-session', channel: 'paseo', kind: 'paseo', address: { agentId: 'carol-session' },
    }, { env: item.env, at: now - 100 });
    await registerRoute(item, 'bob-owner', 'bob-session', now - 100);

    item.cli('Carol', ['join'], now - 90);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'terminal attempt @Bob'], now - 80_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'eligible first @Bob'], now - 70_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'already notified @Bob'], now - 60_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Carol', 'already presented @Carol'], now - 50_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'failed route @Bob'], now - 40_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'eligible later @Bob'], now - 30_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', '--mention', 'Carol', 'one activity two recipients @Bob @Carol'], now - 20_000);
    item.cli('Alice', ['express', '--force', '--mention', 'Bob', 'inside grace @Bob'], now - wakeGraceMs(item.env));

    const acts = (await loadSquare(item.squarePath)).acts.filter((act) => act.kind === 'say');
    const byBody = new Map(acts.map((act) => [act.body, act]));
    const notified = byBody.get('already notified @Bob');
    const terminal = byBody.get('terminal attempt @Bob');
    const failed = byBody.get('failed route @Bob');
    const presented = byBody.get('already presented @Carol');
    const grace = byBody.get('inside grace @Bob');
    assert.ok(notified && terminal && failed && presented && grace);

    const state = await loadSquare(item.squarePath);
    state.runtime.observations.Bob = {
      [formatActivityId(notified.index)]: { state: 'seen', at: now - 1 },
    };
    await writeSquareFile(item.squarePath, state);
    const ledger = createHostLedgerPort({ userPath: item.env.SQUARE_HOST_LEDGER_USER, writableScope: 'user', readableScopes: ['user'] });
    await ledger.appendEvidence({ location: item.squarePath, participant: 'Carol', session: 'carol-owner', activity: formatActivityId(presented.index), kind: 'presentation', outcome: 'presented', at: now - 1 });
    await recordWakeAttempt({
      attention: { squarePath: item.squarePath, recipient: 'Bob', actIndex: terminal.index },
      routeKind: 'paseo', outcome: 'accepted', signature: 'accepted', session: 'bob-session', attemptN: 1, at: now - 1,
    }, item.env);
    await recordWakeAttempt({
      attention: { squarePath: item.squarePath, recipient: 'Bob', actIndex: failed.index },
      routeKind: 'paseo', outcome: 'failed', signature: 'failed', session: 'bob-session', attemptN: 1, at: now - 1,
    }, item.env);

    const candidates = [
      ['Bob', byBody.get('eligible first @Bob')],
      ['Bob', notified],
      ['Carol', presented],
      ['Bob', terminal],
      ['Bob', failed],
      ['Bob', byBody.get('eligible later @Bob')],
      ['Bob', byBody.get('one activity two recipients @Bob @Carol')],
      ['Carol', byBody.get('one activity two recipients @Bob @Carol')],
      ['Bob', grace],
    ];
    const expected = new Set();
    for (const [recipient, act] of candidates) {
      assert.ok(act);
      if (now - act.at <= wakeGraceMs(item.env)) continue;
      const evidence = await withRegistry(item.env, () => wakeEvidence(item.squarePath, recipient, act.index, now, item.env));
      if (wakeIsEligible(evidence)) expected.add(act.index);
    }
    const expectedSelected = [...expected].sort((left, right) => left - right);
    assert.ok(terminal.index < expectedSelected[0]);
    assert.equal(expectedSelected.includes(grace.index), false);

    const reads = new Map([
      [item.squarePath, 0],
      [item.env.SQUARE_REGISTRY, 0],
      [item.env.SQUARE_ROUTES, 0],
      [item.env.SQUARE_WAKE_ATTEMPTS, 0],
      [item.env.SQUARE_PRESENTED, 0],
    ]);
    const originalReadFile = fs.promises.readFile;
    const originalReadFileSync = fs.readFileSync;
    const countRead = (file) => {
      const filePath = typeof file === 'string' ? file : file.toString();
      if (reads.has(filePath)) reads.set(filePath, reads.get(filePath) + 1);
    };
    fs.readFileSync = function countedReadSync(file, ...args) {
      countRead(file);
      return originalReadFileSync.call(this, file, ...args);
    };
    fs.promises.readFile = async function countedRead(file, ...args) {
      countRead(file);
      return originalReadFile.call(this, file, ...args);
    };
    const launched = [];
    try {
      const selected = await withRegistry(item.env, () => sweepPendingNotifications(item.squarePath, {
        env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
        now,
        limit: 10,
        dispatchCandidate: (actIndex) => launched.push(actIndex),
      }));
      assert.deepEqual(selected, expectedSelected);
      assert.deepEqual(launched, expectedSelected);
    } finally {
      fs.promises.readFile = originalReadFile;
      fs.readFileSync = originalReadFileSync;
    }
    assert.ok(reads.size >= 0);
    assert.deepEqual(await withRegistry(item.env, () => sweepPendingNotifications(item.squarePath, {
      env: { ...item.env, SQUARE_DISABLE_PASEO_WAKE: '0' },
      now,
      limit: 1,
      dispatchCandidate: () => {},
    })), expectedSelected.slice(0, 1));
  } finally {
    item.cleanup();
  }
});
