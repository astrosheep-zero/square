import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { emptyRuntimeState, writeSquareFile } from '../dist/artifact.js';
import { claudeHookResponse, runClaudeHook } from '../dist/claude-hook.js';
import { formatActivityId } from '../dist/square-core.js';
import { sessionInbox } from '../dist/inbox.js';
import { lookupParticipant, recordJoin, recordSessionJoin } from '../dist/registry.js';
import { upsertWakeRoute } from '../dist/routes.js';
import { processActNotificationsOnce } from '../dist/notifications.js';
import { nodeCommandFixture } from './node-command-fixture.js';

const CLI = path.resolve(import.meta.dirname, '../dist/square.js');

function spawnHook(sessionId, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'claude-hook'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolBatch', ...(cwd === undefined ? {} : { cwd }) }));
  });
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-hook-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registryPath = path.join(root, 'sessions.ndjsonl');
  const env = {
    ...process.env,
    SQUARE_REGISTRY: registryPath,
    SQUARE_HOST_LEDGER_USER: path.join(root, 'host-ledger-user'),
    SQUARE_HOST_LEDGER_LOCAL: path.join(root, 'host-ledger-local'),
  };
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'], index: 2 },
    { kind: 'say', actor: 'Alice', at: 4, body: 'attention', reach: 'bell', index: 3 },
    { kind: 'say', actor: 'Alice', at: 5, body: 'ambient', index: 4 },
  ];
  const runtime = { ...emptyRuntimeState(5), nextActIndex: 5 };
  const squareState = { hardCap: null, preamble: [], warmup: ['test'], acts, runtime };
  await writeSquareFile(squarePath, squareState);
  await recordJoin('claude-session', 'Bob', squarePath, { channel: 'claude-code', env });
  return {
    squarePath,
    env,
    runtime,
    async persist() {
      await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts, runtime });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('session inbox returns only canonical pending directed notifications', async () => {
  const item = await fixture();
  try {
    let inbox = await sessionInbox('claude-session', item.env);
    assert.equal(inbox.length, 1);
    assert.deepEqual(
      inbox[0].notifications.map((notification) => [notification.actIndex, notification.route]),
      [[2, 'mention'], [3, 'bell']]
    );

    item.runtime.observations.Bob = {
      [formatActivityId(2)]: { state: 'seen', at: 6 },
    };
    await item.persist();
    inbox = await sessionInbox('claude-session', item.env);
    assert.deepEqual(
      inbox[0].notifications.map((notification) => notification.actIndex),
      [3]
    );
  } finally {
    item.cleanup();
  }
});

test('session inbox never resurrects a mention from before the recipient joined', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-prejoin-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registryPath = path.join(root, 'sessions.ndjsonl');
  const env = { ...process.env, SQUARE_REGISTRY: registryPath };
  try {
    const acts = [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'join us @Bob', mentions: ['Bob'], index: 1 },
      { kind: 'join', actor: 'Bob', at: 3, index: 2 },
      { kind: 'say', actor: 'Alice', at: 4, body: 'welcome @Bob', mentions: ['Bob'], index: 3 },
    ];
    const runtime = { ...emptyRuntimeState(4), nextActIndex: 4 };
    await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts, runtime });
    await recordJoin('prejoin-session', 'Bob', squarePath, { channel: 'claude-code', env });

    const inbox = await sessionInbox('prejoin-session', env);
    assert.deepEqual(inbox[0].notifications.map((notification) => notification.actIndex), [3]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude admits bounded context at an agent boundary and presents once', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-${Date.now()}.ndjsonl`);
  try {
    const inbox = [{
      name: 'Bob',
      squarePath: item.squarePath,
      notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'hello @Bob' }],
    }];
    const response = await claudeHookResponse(
      { session_id: 'session', hook_event_name: 'PostToolBatch' },
      () => inbox,
      { ...item.env, SQUARE_PRESENTED: presented }
    );
    assert.equal(response.hookSpecificOutput.hookEventName, 'PostToolBatch');
    assert.match(response.hookSpecificOutput.additionalContext, /1 unread Square notification/);
    assert.match(response.hookSpecificOutput.additionalContext, new RegExp(`square:${item.squarePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#act/2`));
    assert.match(response.hookSpecificOutput.additionalContext, /hello @Bob/);
    assert.match(response.hookSpecificOutput.additionalContext, /✓ shown in full/);
    assert.doesNotMatch(response.hookSpecificOutput.additionalContext, /catch --now/);
    assert.equal(await claudeHookResponse({ session_id: 'session', hook_event_name: 'PostToolBatch' }, () => inbox, { ...item.env, SQUARE_PRESENTED: presented }), undefined);
  } finally {
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('concurrent native sessions present each activity once for their shared owner', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-concurrent-${Date.now()}.ndjsonl`);
  try {
    const env = { ...item.env, SQUARE_PRESENTED: presented };
    const results = await Promise.all([
      spawnHook('claude-session', env),
      spawnHook('claude-session', env),
    ]);
    assert.deepEqual(results.map((result) => result.status), [0, 0]);
    const contexts = results.flatMap((result) => result.stdout === '' ? [] : [JSON.parse(result.stdout).hookSpecificOutput.additionalContext]);
    assert.equal(contexts.reduce((count, context) => count + (context.match(/#act\/2/g)?.length ?? 0), 0), 1);
    assert.equal(contexts.reduce((count, context) => count + (context.match(/#act\/3/g)?.length ?? 0), 0), 1);
  } finally {
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('failed presentation remains available to the next guarantee path', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-retry-${Date.now()}.ndjsonl`);
  const inbox = [{
    name: 'Bob',
    squarePath: item.squarePath,
    notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'hello @Bob' }],
  }];
  try {
    const ledger = new (await import('../dist/host-ledger-file-adapter.js')).FileHostLedgerPort({ userPath: path.dirname(presented), localPath: path.dirname(presented) });
    const artifact = (await import('../dist/square-file-adapter.js')).openSquare(item.squarePath, { hostLedger: ledger });
    const square = await artifact;
    await assert.rejects(() => import('../dist/presentation-operations.js').then(({ presentPending }) => presentPending({ artifact: square.artifact, location: item.squarePath, participant: 'Bob', activity: 2, hostLedger: ledger, session: 'session', sink: { present: () => { throw new Error('inject failed'); } } })), /inject failed/);
    assert.equal((await import('../dist/presentation-operations.js').then(({ presentPending }) => presentPending({ artifact: square.artifact, location: item.squarePath, participant: 'Bob', activity: 2, hostLedger: ledger, session: 'session', sink: { present: () => 'delivered' } }))).presented, true);
    await square.artifact.close();
  } finally {
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('Claude hook does not adopt a Paseo owner from inherited PASEO_AGENT_ID', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-nested-${Date.now()}.ndjsonl`);
  try {
    await recordJoin('paseo-agent', 'Bob', item.squarePath, {
      channel: 'paseo',
      paseoAgentId: 'paseo-agent',
      env: item.env,
    });

    const response = await claudeHookResponse(
      { session_id: 'nested-claude', hook_event_name: 'PostToolBatch' },
      sessionInbox,
      { ...item.env, SQUARE_PRESENTED: presented, PASEO_AGENT_ID: 'paseo-agent' }
    );
    // No membership for the nested session => nothing to present.
    assert.equal(response, undefined);
    const bindings = await lookupParticipant(item.squarePath, 'Bob', Date.now(), item.env);
    assert.deepEqual(bindings.map((binding) => binding.sessionId).sort(), ['claude-session', 'paseo-agent']);
    assert.equal(bindings.find((binding) => binding.sessionId === 'paseo-agent')?.channel, 'paseo');
  } finally {
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('privileged hook sweep wakes a different recipient after local failure', async () => {
  const item = await fixture();
  try {
    const env = { SQUARE_REGISTRY: process.env.SQUARE_REGISTRY, SQUARE_HOST_LEDGER_USER: path.join(path.dirname(item.squarePath), 'ledger'), SQUARE_HOST_LEDGER_LOCAL: path.join(path.dirname(item.squarePath), 'local'), SQUARE_PRESENTED: path.join(path.dirname(item.squarePath), 'presented.ndjsonl') };
    item.runtime.observations.Bob = { [formatActivityId(3)]: { state: 'seen', at: Date.now() } };
    await item.persist();
    await recordSessionJoin('bob-session', 'Bob', item.squarePath, 'claude-code', env);
    await upsertWakeRoute({ location: item.squarePath, participant: 'Bob', sessionId: 'bob-session', channel: 'claude-code', kind: 'claude-native', address: { sessionId: 'bob-session' } });
    const failed = { kind: 'claude-native', async dispatch() { return { outcome: 'failed', signature: 'temporary', message: 'offline' }; } };
    await processActNotificationsOnce(item.squarePath, 2, { env, adapters: [failed] });
    let calls = 0;
    const accepted = { kind: 'claude-native', async dispatch(_route, _payload, beforeSend) { if (!(await beforeSend())) return { outcome: 'cancelled' }; calls += 1; return { outcome: 'accepted' }; } };
    await claudeHookResponse({ session_id: 'alice-session', hook_event_name: 'PostToolBatch', cwd: path.dirname(path.dirname(item.squarePath)) }, () => [], env, [accepted]);
    assert.equal(calls, 1);
    await claudeHookResponse({ session_id: 'alice-session', hook_event_name: 'PostToolBatch', cwd: path.dirname(path.dirname(item.squarePath)) }, () => [], env, [accepted]);
    assert.equal(calls, 1);
  } finally { item.cleanup(); }
});

test('privileged hook exits before its native timeout when a wake transport hangs', async () => {
  const item = await fixture();
  const fake = nodeCommandFixture('square-slow-paseo', `
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  `);
  try {
    const env = {
      ...item.env,
      SQUARE_PASEO_BIN: fake.bin,
      SQUARE_PASEO_BIN_ARGS: JSON.stringify(fake.args),
    };
    await recordSessionJoin('slow-paseo', 'Bob', item.squarePath, 'paseo', env);
    await upsertWakeRoute({
      location: item.squarePath,
      participant: 'Bob',
      sessionId: 'slow-paseo',
      channel: 'paseo',
      kind: 'paseo',
      address: { agentId: 'slow-paseo' },
    }, { env });
    const startedAt = Date.now();
    const result = await spawnHook('unrelated-session', env, item.root);
    const elapsed = Date.now() - startedAt;
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(elapsed < 4500, `native hook took ${elapsed}ms`);
  } finally {
    fs.rmSync(fake.root, { recursive: true, force: true });
    item.cleanup();
  }
});

test('active catch owns matching attention at every adapter boundary', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-active-catch-${Date.now()}.ndjsonl`);
  try {
    const now = Date.now();
    item.runtime.leases.Bob = {
      leaseId: 'watch-active',
      heartbeatAt: now,
      expiresAt: now + 60_000,
    };
    await item.persist();

    assert.equal(
      await claudeHookResponse(
        { session_id: 'claude-session', hook_event_name: 'PostToolBatch' },
        sessionInbox,
        { ...item.env, SQUARE_PRESENTED: presented }
      ),
      undefined
    );

  } finally {
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('a boundary still admits notifications excluded by an active catch filter', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-filtered-catch-${Date.now()}.ndjsonl`);
  try {
    const now = Date.now();
    item.runtime.leases.Bob = {
      leaseId: 'watch-filtered',
      heartbeatAt: now,
      expiresAt: now + 60_000,
      filter: { participants: ['Cara'] },
    };
    await item.persist();

    const response = await claudeHookResponse(
      { session_id: 'claude-session', hook_event_name: 'PostToolBatch' },
      sessionInbox,
      { ...item.env, SQUARE_PRESENTED: presented }
    );
    assert.equal(response.hookSpecificOutput.hookEventName, 'PostToolBatch');
    assert.match(response.hookSpecificOutput.additionalContext, /hello @Bob/);
  } finally {
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('Claude hook is a bounded no-op for malformed, unsupported, or empty input', async () => {
  assert.equal(await runClaudeHook('not json'), '');
  assert.equal(
    await claudeHookResponse({ session_id: 'session', hook_event_name: 'SessionStart' }, () => []),
    undefined
  );
  assert.equal(
    await claudeHookResponse({ session_id: 'session', hook_event_name: 'Stop' }, () => []),
    undefined
  );
});
