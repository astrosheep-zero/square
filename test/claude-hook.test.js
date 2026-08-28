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
import { lookupParticipant, recordJoin } from '../dist/registry.js';

const CLI = path.resolve(import.meta.dirname, '../dist/square.js');

function spawnHook(sessionId, env) {
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
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: 'PostToolBatch' }));
  });
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-claude-hook-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registryPath = path.join(root, 'sessions.ndjsonl');
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registryPath;
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1, index: 0 },
    { kind: 'join', actor: 'Bob', at: 2, index: 1 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', index: 2 },
    { kind: 'say', actor: 'Alice', at: 4, body: 'attention', reach: 'bell', index: 3 },
    { kind: 'say', actor: 'Alice', at: 5, body: 'ambient', index: 4 },
  ];
  const runtime = { ...emptyRuntimeState(5), nextActIndex: 5 };
  const squareState = { hardCap: null, preamble: [], warmup: ['test'], acts, runtime };
  await writeSquareFile(squarePath, squareState);
  await recordJoin('claude-session', 'Bob', squarePath, { channel: 'claude-code' });
  return {
    squarePath,
    runtime,
    async persist() {
      await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts, runtime });
    },
    cleanup() {
      if (previous === undefined) delete process.env.SQUARE_REGISTRY;
      else process.env.SQUARE_REGISTRY = previous;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('session inbox returns only canonical pending directed notifications', async () => {
  const item = await fixture();
  try {
    let inbox = await sessionInbox('claude-session');
    assert.equal(inbox.length, 1);
    assert.deepEqual(
      inbox[0].notifications.map((notification) => [notification.actIndex, notification.route]),
      [[2, 'mention'], [3, 'bell']]
    );

    item.runtime.observations.Bob = {
      [formatActivityId(2)]: { state: 'seen', at: 6 },
    };
    await item.persist();
    inbox = await sessionInbox('claude-session');
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
  const previous = process.env.SQUARE_REGISTRY;
  process.env.SQUARE_REGISTRY = registryPath;
  try {
    const acts = [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'say', actor: 'Alice', at: 2, body: 'join us @Bob', index: 1 },
      { kind: 'join', actor: 'Bob', at: 3, index: 2 },
      { kind: 'say', actor: 'Alice', at: 4, body: 'welcome @Bob', index: 3 },
    ];
    const runtime = { ...emptyRuntimeState(4), nextActIndex: 4 };
    await writeSquareFile(squarePath, { hardCap: null, preamble: [], warmup: ['test'], acts, runtime });
    await recordJoin('prejoin-session', 'Bob', squarePath, { channel: 'claude-code' });

    const inbox = await sessionInbox('prejoin-session');
    assert.deepEqual(inbox[0].notifications.map((notification) => notification.actIndex), [3]);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude admits bounded context at an agent boundary and presents once', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-${Date.now()}.ndjsonl`);
  const previous = process.env.SQUARE_PRESENTED;
  process.env.SQUARE_PRESENTED = presented;
  try {
    const inbox = [{
      name: 'Bob',
      squarePath: item.squarePath,
      notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: 'hello @Bob' }],
    }];
    const response = await claudeHookResponse(
      { session_id: 'session', hook_event_name: 'PostToolBatch' },
      () => inbox
    );
    assert.equal(response.hookSpecificOutput.hookEventName, 'PostToolBatch');
    assert.match(response.hookSpecificOutput.additionalContext, /1 unread Square notification/);
    assert.match(response.hookSpecificOutput.additionalContext, new RegExp(`square:${item.squarePath.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}#act/2`));
    assert.match(response.hookSpecificOutput.additionalContext, /hello @Bob/);
    assert.match(response.hookSpecificOutput.additionalContext, /✓ shown in full/);
    assert.doesNotMatch(response.hookSpecificOutput.additionalContext, /catch --now/);
    assert.equal(await claudeHookResponse({ session_id: 'session', hook_event_name: 'PostToolBatch' }, () => inbox), undefined);
  } finally {
    if (previous === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previous;
    fs.rmSync(presented, { force: true });
    item.cleanup();
  }
});

test('concurrent native sessions produce one presentation for their shared owner', async () => {
  const item = await fixture();
  const presented = path.join(os.tmpdir(), `square-presented-concurrent-${Date.now()}.ndjsonl`);
  try {
    const env = { SQUARE_REGISTRY: process.env.SQUARE_REGISTRY, SQUARE_PRESENTED: presented };
    const results = await Promise.all([
      spawnHook('claude-session', env),
      spawnHook('claude-session', env),
    ]);
    assert.deepEqual(results.map((result) => result.status), [0, 0]);
    assert.equal(results.filter((result) => result.stdout.includes('PostToolBatch')).length, 1);
    assert.equal(results.filter((result) => result.stdout === '').length, 1);
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
    });

    const response = await claudeHookResponse(
      { session_id: 'nested-claude', hook_event_name: 'PostToolBatch' },
      sessionInbox,
      { SQUARE_PRESENTED: presented, PASEO_AGENT_ID: 'paseo-agent' }
    );
    // No membership for the nested session => nothing to present.
    assert.equal(response, undefined);
    const bindings = await lookupParticipant(item.squarePath, 'Bob');
    assert.deepEqual(bindings.map((binding) => binding.sessionId).sort(), ['claude-session', 'paseo-agent']);
    assert.equal(bindings.find((binding) => binding.sessionId === 'paseo-agent')?.channel, 'paseo');
  } finally {
    fs.rmSync(presented, { force: true });
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
        { SQUARE_PRESENTED: presented }
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
      { SQUARE_PRESENTED: presented }
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
