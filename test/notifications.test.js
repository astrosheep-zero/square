import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { emptyRuntimeState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { processActNotificationsOnce, sweepPrivilegedPending } from '../dist/notifications.js';
import { PaseoAdapter } from '../dist/paseo-delivery.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { recordJoin, recordSessionJoin } from '../dist/registry.js';
import { upsertWakeRoute } from '../dist/routes.js';
import { PaseoWakeSendError } from '../dist/wake-sink.js';
import { readWakeReleaseDiagnostics } from '../dist/wake-attempts.js';
import { readWakeAttempts } from './wake-attempt-fixtures.js';
import { doctorDeliveryHealth } from '../dist/delivery-health.js';
import { codexHookResponse } from '../dist/codex-hook.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { sessionInbox } from '../dist/inbox.js';
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-notify-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const env = {
    SQUARE_HOST_LEDGER_ROOT: path.join(root, 'host-ledger'),
    SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'),
    SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'),
    SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake-attempts.ndjsonl'),
    SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'),
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'codex-boundaries.json'),
  };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'private payload @Bob', mentions: ['Bob'], index: 2 },
  ];
  const squareState = {
    hardCap: null,
    preamble: [],
    warmup: ['warmup'],
    acts,
    runtime: { ...emptyRuntimeState(3), nextActIndex: 3 },
  };
  await writeSquareFile(squarePath, squareState);
  return { root, squarePath, env };
}
function withRegistry(env, fn) {
  const previous = process.env.SQUARE_REGISTRY;
  const previousLedger = process.env.SQUARE_HOST_LEDGER_ROOT;
  process.env.SQUARE_REGISTRY = env.SQUARE_REGISTRY;
  process.env.SQUARE_HOST_LEDGER_ROOT = env.SQUARE_HOST_LEDGER_ROOT;
  const restore = () => {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
    if (previousLedger === undefined) delete process.env.SQUARE_HOST_LEDGER_ROOT;
    else process.env.SQUARE_HOST_LEDGER_ROOT = previousLedger;
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
async function route(item, options = {}) {
  const agentId = options.agentId ?? 'bob-agent';
  const sessionId = options.sessionId ?? agentId;
  await withRegistry(item.env, async () => await recordJoin(sessionId, 'Bob', item.squarePath, {
    channel: 'paseo',
    paseoAgentId: agentId,
  }));
  await upsertWakeRoute({
    location: item.squarePath,
    participant: 'Bob',
    sessionId,
    channel: 'paseo',
    kind: 'paseo',
    address: { agentId },
  }, { env: item.env, at: options.at });
  const ledger = createHostLedgerPort({ rootPath: item.env.SQUARE_HOST_LEDGER_ROOT });
  await ledger.ensurePresence({ location: item.squarePath, participant: 'Bob', session: sessionId, channel: 'paseo', route: { kind: 'paseo', address: { agentId } }, updatedAt: options.at ?? Date.now() });
}
function fakeAdapter(kind, dispatch) {
  return { kind, dispatch };
}
test('default notifications honor disabled Paseo while explicit injection remains usable', async () => {
  const item = await fixture();
  const dispatch = PaseoAdapter.prototype.dispatch;
  let calls = 0;
  PaseoAdapter.prototype.dispatch = async () => { calls += 1; return { outcome: 'accepted' }; };
  try {
    item.env.SQUARE_DISABLE_PASEO_WAKE = '1';
    await route(item);
    const blocked = await processActNotificationsOnce(item.squarePath, 2, { env: item.env });
    assert.equal(calls, 0);
    assert.equal(blocked.attempted, 0);
    assert.equal(blocked.notCapable, 1);
    assert.deepEqual(await readWakeAttempts({ env: item.env }), []);
    const injected = await processActNotificationsOnce(item.squarePath, 2, {
      env: item.env,
      adapters: [new PaseoAdapter()],
    });
    assert.equal(calls, 1);
    assert.equal(injected.accepted, 1);
  } finally {
    PaseoAdapter.prototype.dispatch = dispatch;
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('PaseoAdapter wakes an idle agent and sends supplied awareness only', async () => {
  const item = await fixture();
  await route(item, { agentId: 'exact-agent' });
  const registered = { location: item.squarePath, participant: 'Bob', sessionId: 'exact-agent', channel: 'paseo', kind: 'paseo', address: { agentId: 'exact-agent' }, updatedAt: Date.now() };
  let boundary = false;
  let sent;
  const timeouts = [];
  const adapter = new PaseoAdapter({
    discover: (timeoutMs) => { timeouts.push(['discover', timeoutMs]); return { agents: [
      { id: 'decoy', name: 'Bob', status: 'idle' },
      { id: 'exact-agent', name: 'Other', status: 'idle' },
    ] }; },
    waitForBoundary: async (_agent, timeoutMs) => { timeouts.push(['boundary', timeoutMs]); boundary = true; return true; },
    sendWake: (request, options) => { timeouts.push(['send', options.timeoutMs]); sent = request; },
  });
  const payload = '<system-reminder source="square">awareness</system-reminder>';
  const outcome = await adapter.dispatch(registered.address, payload, async () => true, 321);
  assert.deepEqual(outcome, { outcome: 'accepted' });
  assert.equal(boundary, true);
  assert.equal(sent.agentId, 'exact-agent');
  assert.equal(sent.prompt, payload);
  assert.deepEqual(timeouts.map(([phase]) => phase), ['discover', 'boundary', 'send']);
  assert.ok(timeouts.every(([, timeoutMs]) => timeoutMs > 0 && timeoutMs <= 321));
  assert.ok(timeouts.every(([, timeoutMs], index) => index === 0 || timeoutMs <= timeouts[index - 1][1]));
  assert.doesNotMatch(sent.prompt, /private payload/);
  assert.deepEqual((await loadSquare(item.squarePath)).runtime.observations, {});
  assert.equal(fs.existsSync(item.env.SQUARE_PRESENTED), false);
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('privileged sweep stops at its native hook deadline', async () => {
  const item = await fixture();
  try {
    await recordSessionJoin('deadline-session', 'Bob', item.squarePath, 'claude-code', item.env);
    await upsertWakeRoute({
      location: item.squarePath,
      participant: 'Bob',
      sessionId: 'deadline-session',
      channel: 'claude-code',
      kind: 'paseo',
      address: { agentId: 'deadline-agent' },
    }, { env: item.env });
    const ledger = createHostLedgerPort({ rootPath: item.env.SQUARE_HOST_LEDGER_ROOT });
    await ledger.ensurePresence({ location: item.squarePath, participant: 'Bob', session: 'deadline-session', channel: 'claude-code', route: { kind: 'paseo', address: { agentId: 'deadline-agent' } } });
    let timeoutMs;
    const hanging = {
      kind: 'paseo',
      dispatch(_address, _payload, _beforeSend, timeout) {
        timeoutMs = timeout;
        return new Promise(() => {});
      },
    };
    const startedAt = Date.now();
    await sweepPrivilegedPending(item.root, item.env, [hanging], startedAt + 150);
    const elapsed = Date.now() - startedAt;
    assert.ok(timeoutMs > 0 && timeoutMs <= 150, `transport timeout ${timeoutMs}`);
    assert.ok(elapsed < 750, `privileged sweep took ${elapsed}ms`);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
test('Codex privileged hook sweep still delivers attention from an indexed live square', async () => {
  const item = await fixture();
  try {
    await route(item, { agentId: 'live-agent' });
    let calls = 0;
    const accepted = fakeAdapter('paseo', async (_address, _payload, beforeSend) => {
      assert.equal(await beforeSend(), true);
      calls += 1;
      return { outcome: 'accepted' };
    });
    await codexHookResponse(
      { session_id: 'observing-session', hook_event_name: 'PostToolUse', cwd: path.join(item.root, 'workspace') },
      () => [],
      item.env,
      [accepted],
    );
    await codexHookResponse(
      { session_id: 'observing-session', hook_event_name: 'PostToolUse', cwd: path.join(item.root, 'workspace') },
      () => [],
      item.env,
      [accepted],
    );
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
test('PaseoAdapter does not wake a running agent', async () => {
  const item = await fixture();
  await route(item, { agentId: 'running-agent' });
  let boundary = false;
  let sent = false;
  const outcome = await new PaseoAdapter({
    discover: () => ({ agents: [{ id: 'running-agent', name: 'Bob', status: 'running' }] }),
    waitForBoundary: async () => { boundary = true; return true; },
    sendWake: () => { sent = true; },
  }).dispatch({ agentId: 'running-agent' }, '<system-reminder source="square">awareness</system-reminder>', async () => true);
  assert.equal(outcome.outcome, 'unavailable');
  assert.equal(outcome.signature, 'agent_not_idle');
  assert.equal(boundary, false);
  assert.equal(sent, false);
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('unavailable Paseo dispatch records its release reason for delivery diagnostics', async () => {
  const item = await fixture();
  try {
    await route(item, { agentId: 'busy-agent' });
    const result = await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
      env: item.env,
      adapters: [new PaseoAdapter({
        discover: () => ({ agents: [{ id: 'busy-agent', name: 'Bob', status: 'running' }] }),
      })],
    }));
    assert.deepEqual(result, { attempted: 1, accepted: 0, failed: 1, unknown: 0, notCapable: 0 });
    const releases = await readWakeReleaseDiagnostics({
      attention: { squarePath: item.squarePath, actIndex: 2, recipient: 'Bob' },
      env: item.env,
    });
    assert.equal(releases.length, 1);
    assert.equal(releases[0].routeKind, 'paseo');
    assert.equal(releases[0].attemptN, 1);
    assert.equal(releases[0].signature, 'agent_not_idle');
    assert.equal(releases[0].diagnostic.phase, 'selection');
    assert.equal(releases[0].diagnostic.code, 'not_idle');
    const doctor = await doctorDeliveryHealth(item.squarePath, 5000, Date.now(), item.env);
    assert.match(doctor.join('\n'), /recent wake releases/);
    assert.match(doctor.join('\n'), /agent_not_idle/);
    assert.match(doctor.join('\n'), /The registered Paseo agent is not idle/);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
test('the notification worker records an accepted wake through the real Paseo adapter', async () => {
  const item = await fixture();
  await route(item, { agentId: 'integrated-agent' });
  let sent;
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({
      discover: () => ({ agents: [{ id: 'integrated-agent', name: 'Bob', status: 'idle' }] }),
      sendWake: (request) => { sent = request; },
    })],
  }));
  assert.equal(sent.agentId, 'integrated-agent');
  assert.match(sent.prompt, /<system-reminder source="square" wake="paseo">/);
  assert.doesNotMatch(sent.prompt, /native adapter presented/);
  assert.match(sent.prompt, new RegExp(`square: ${item.squarePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(sent.prompt, /<square>[^<]+<\/square>/);
  assert.doesNotMatch(sent.prompt, /catch --now/);
  assert.match(sent.prompt, /attention: act\/2 for Bob from Alice/);
  assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome }) => outcome), ['accepted']);
  assert.deepEqual((await loadSquare(item.squarePath)).runtime.leases, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('the notification worker uses an artifact Paseo route with a local binding', async () => {
  const item = await fixture();
  try {
    await upsertWakeRoute({
      location: item.squarePath,
      participant: 'Bob',
      sessionId: 'local-paseo-session',
      channel: 'paseo',
      kind: 'paseo',
      address: { agentId: 'local-paseo-agent' },
    }, { env: item.env, at: 3 });
    const localLedger = createHostLedgerPort({
      rootPath: item.env.SQUARE_HOST_LEDGER_ROOT,
    });
    await localLedger.ensurePresence({
      location: item.squarePath,
      participant: 'Bob',
      session: 'local-paseo-session',
      channel: 'claude-code',
      route: { kind: 'paseo', address: { agentId: 'local-paseo-agent' } },
      updatedAt: Date.now(),
    }, 'local');
    let calls = 0;
    await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
      env: item.env,
      adapters: [fakeAdapter('paseo', async (_address, _payload, beforeSend) => {
        assert.equal(await beforeSend(), true);
        calls += 1;
        return { outcome: 'accepted' };
      })],
    }));
    assert.equal(calls, 1);
    assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome }) => outcome), ['accepted']);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});
test('PaseoAdapter records transport certainty without leaking retry policy', async () => {
  const item = await fixture();
  await route(item);
  const registered = { location: item.squarePath, participant: 'Bob', sessionId: 'bob-agent', channel: 'paseo', kind: 'paseo', address: { agentId: 'bob-agent' }, updatedAt: Date.now() };
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
  const item = await fixture();
  await route(item, { agentId: 'closed-agent' });
  const registered = { location: item.squarePath, participant: 'Bob', sessionId: 'closed-agent', channel: 'paseo', kind: 'paseo', address: { agentId: 'closed-agent' }, updatedAt: Date.now() };
  const outcome = await new PaseoAdapter({
    discover: () => ({ agents: [] }),
  }).dispatch(registered.address, '<system-reminder source="square">awareness</system-reminder>', async () => true);
  assert.equal(outcome.outcome, 'unavailable');
  assert.equal(outcome.signature, 'address_not_found');
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('a closed Paseo route is retired without consuming pending attention', async () => {
  const item = await fixture();
  await route(item, { agentId: 'gone-agent' });
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({ discover: () => ({ agents: [] }) })],
  }));
  assert.deepEqual(await readWakeAttempts({ env: item.env }), []);
  const { readWakeRoutes } = await import('../dist/routes.js');
  assert.deepEqual(await readWakeRoutes({ env: item.env, now: Date.now() }), []);
  assert.deepEqual((await loadSquare(item.squarePath)).runtime.observations, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('a refreshed Paseo route wakes the old pending notification', async () => {
  const item = await fixture();
  await route(item, { agentId: 'gone-agent' });
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [new PaseoAdapter({ discover: () => ({ agents: [] }) })],
  }));
  const refreshedAt = Date.now();
  await upsertWakeRoute({
    location: item.squarePath,
    participant: 'Bob',
    sessionId: 'gone-agent',
    channel: 'paseo',
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
  assert.deepEqual((await readWakeAttempts({ env: item.env })).map(({ outcome }) => outcome), ['accepted']);
  assert.equal((await loadSquare(item.squarePath)).runtime.observations.Bob?.['act/2'], undefined);
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('a worker with no route writes no synthetic attempt', async () => {
  const item = await fixture();
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [fakeAdapter('paseo', async () => { throw new Error('no route must not dispatch'); })],
  }));
  assert.deepEqual(await readWakeAttempts({ env: item.env }), []);
  assert.deepEqual((await loadSquare(item.squarePath)).runtime.leases, {});
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('wake transport rechecks pending and route ownership before send', async () => {
  const item = await fixture();
  await route(item, { agentId: 'race-agent' });
  let calls = 0;
  await withRegistry(item.env, () => processActNotificationsOnce(item.squarePath, 2, {
    env: item.env,
    adapters: [{
      kind: 'paseo',
      dispatch: async (_address, _payload, beforeSend) => {
        const current = await loadSquare(item.squarePath);
        await writeSquareFile(item.squarePath, { ...current, routes: [] });
        if (!(await beforeSend())) return { outcome: 'cancelled' };
        calls += 1;
        return { outcome: 'accepted' };
      },
    }],
  }));
  assert.equal(calls, 0);
  const releases = await readWakeReleaseDiagnostics({
    attention: { squarePath: item.squarePath, actIndex: 2, recipient: 'Bob' },
    env: item.env,
  });
  assert.equal(releases[0].signature, 'pre_send_revalidation_failed');
  assert.equal(releases[0].diagnostic.routePublished, false);
  fs.rmSync(item.root, { recursive: true, force: true });
});
test('Codex PostToolUse hook aborts a contended presentation boundary within its budget and traces stages', async () => {
  const item = await fixture();
  const traces = [];
  try {
    const env = { ...item.env, SQUARE_CODEX_HOOK_BUDGET_MS: '300' };
    // Hold the per-session presentation boundary lock with a lookup that blocks until released.
    let releaseLookup;
    const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
    const holder = presentPendingAtBoundary('contended-session', () => ({ held: true }), () => lookupGate, env);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const startedAt = Date.now();
    const response = await codexHookResponse(
      { session_id: 'contended-session', hook_event_name: 'PostToolUse', cwd: item.root },
      sessionInbox,
      env,
      undefined,
      (line) => traces.push(line),
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(response, undefined);
    assert.ok(elapsed < 2000, `hook should exit near its 300ms budget, took ${elapsed}ms`);
    const stages = traces.join('\n');
    assert.match(stages, /stage=boundary-record/);
    assert.match(stages, /stage=presentation .*(aborted=true|error=)/);
    assert.match(stages, /stage=sweep/);
    releaseLookup([]);
    assert.deepEqual(await holder, undefined);
  } finally {
    fs.rmSync(item.root, { recursive: true, force: true });
  }
});