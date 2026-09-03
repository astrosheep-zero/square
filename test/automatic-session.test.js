import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSquareState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { automaticParticipant, automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';
import { codexHookResponse, runCodexHookAsync } from '../dist/codex-hook.js';
import { codexQueueEligible } from '../dist/codex-boundary-state.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';
import { lookupSessionBindings, readParticipantOwner } from '../dist/registry.js';
import { readWakeRoutes, retireWakeRoute } from '../dist/routes.js';
import { Square } from '../dist/square-wiring.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-auto-'));
  const cwd = path.join(root, 'workspace');
  const publicPath = path.join(cwd, '.square', 'PUBLIC.square');
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  await writeSquareFile(publicPath, await createSquareState({ force: true, hardCap: null }, 'Host context'));
  const env = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'), SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake.ndjsonl'), SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'), SQUARE_CODEX_BOUNDARIES: path.join(root, 'codex-boundaries.json'), SQUARE_LOCATION: path.join(root, 'other.square') };
  return { root, cwd, publicPath, env };
}

async function withEnv(env, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try { return await fn(process.env); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('automatic sessions target PUBLIC.square only and join idempotently across resume', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const first = await automaticSessionStart('codex', 'thread-1', item.cwd, env);
    assert.equal(first, undefined);
    assert.equal((await readParticipantOwner(item.publicPath, automaticParticipant('codex', 'thread-1', env), env))?.epoch, 1);
    const second = await automaticSessionStart('codex', 'thread-1', item.cwd, env);
    assert.equal(second, undefined);
  });
  const squareState = await loadSquare(item.publicPath);
  assert.equal(squareState.acts.filter((act) => act.kind === 'join').length, 1);
  assert.equal(squareState.acts.some((act) => JSON.stringify(act).includes('thread-1')), false);
  assert.equal(automaticParticipant('codex', 'thread-1', item.env), `codex-${crypto.createHash('sha256').update('thread-1').digest('hex').slice(0, 12)}`);
});

test('automatic session end writes ordinary done for its bound owner', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    await automaticSessionStart('pi', 'pi-session', item.cwd, env);
    await automaticSessionEnd('pi', 'pi-session', item.cwd, env);
  });
  const squareState = await loadSquare(item.publicPath);
  assert.deepEqual(squareState.acts.map((act) => act.kind), ['join', 'done']);
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'changed' }, (env) => automaticSessionEnd('pi', 'pi-session', item.cwd, env));
  assert.equal((await loadSquare(item.publicPath)).acts.length, 2);
});

test('Paseo is the preferred wake route when a native session runs under Paseo', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, PASEO_AGENT_ID: 'paseo-agent' }, async (env) => {
    await automaticSessionStart('claude', 'claude-session', item.cwd, env);
  });
  const routes = (await loadSquare(item.publicPath)).routes;
  assert.equal(routes.length, 1);
  assert.equal(routes[0].channel, 'claude-code');
  assert.deepEqual({ kind: routes[0].kind, address: routes[0].address }, { kind: 'paseo', address: { agentId: 'paseo-agent' } });
});

test('automatic implicit join does not re-enter a participant that has done', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, PASEO_AGENT_ID: 'agent-1' }, async (env) => {
    await automaticSessionStart('pi', 'pi-session', item.cwd, env);
    await automaticSessionEnd('pi', 'pi-session', item.cwd, env);
    assert.equal(await automaticSessionStart('pi', 'pi-session', item.cwd, env), undefined);
  });
  assert.deepEqual((await loadSquare(item.publicPath)).acts.map((act) => act.kind), ['join', 'done']);
  assert.equal((await loadSquare(item.publicPath)).routes?.some((route) => route.sessionId === 'pi-session'), false);
});

test('automatic implicit join rejects an active participant bound to another session', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await automaticSessionStart('pi', 'first-session', item.cwd, env);
    await assert.rejects(
      () => automaticSessionStart('pi', 'second-session', item.cwd, env),
      (error) => error?.code === 'already_joined',
    );
    assert.equal((await lookupSessionBindings('second-session')).some((binding) => binding.name === 'shared'), false);
  });
  assert.deepEqual((await loadSquare(item.publicPath)).acts.map((act) => act.kind), ['join']);
});

test('missing PUBLIC.square is a no-op', { concurrency: false }, async () => {
  const item = await fixture();
  fs.unlinkSync(item.publicPath);
  assert.equal(await automaticSessionStart('claude', 'session', item.cwd, item.env), undefined);
});

test('old shutdown paused across a replacement cannot mark the new owner done', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await automaticSessionStart('pi', 'owner-a', item.cwd, env);
    const { createHostLedgerPort } = await import('../dist/host-ledger-file-adapter.js');
    const { projectSessionBindings } = await import('../dist/square-projections.js');
    const { readParticipantOwner } = await import('../dist/registry.js');
    const { done } = await import('../dist/square-actions.js');
    const { openSquare } = await import('../dist/square-file-adapter.js');
    const { closeOpenSquare } = await import('../dist/open-square.js');
    const { Square } = await import('../dist/square-wiring.js');

    const hostLedger = createHostLedgerPort({
      userPath: env.SQUARE_HOST_LEDGER_USER ?? path.dirname(env.SQUARE_REGISTRY),
      localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? path.dirname(env.SQUARE_REGISTRY),
    });
    const pausedBinding = (await projectSessionBindings({
      hostLedger,
      sessionId: 'owner-a',
      location: item.publicPath,
      scopes: ['user', 'local'],
    }))[0];
    assert.ok(pausedBinding);
    const expectedEpoch = (await readParticipantOwner(item.publicPath, pausedBinding.participant, env))?.epoch ?? 0;
    assert.equal(expectedEpoch, 1);

    // Mirror operationEnv: only the pi session claims ownership; ambient runner identities must not leak in.
    const replacementEnv = {
      ...env,
      CLAUDE_CODE_SESSION_ID: '',
      CLAUDE_CODE_CHILD_SESSION: '',
      CODEX_THREAD_ID: '',
      OPENCODE_SESSION_ID: '',
      SQUARE_PI_SESSION_ID: 'owner-b',
    };
    const square = await Square.at({ path: item.publicPath, hostLedger, env: replacementEnv });
    try {
      await square.takeover('shared');
    } finally {
      await square.close();
    }

    const oldSession = await openSquare(item.publicPath, {
      hostLedger,
      env: { ...env, CLAUDE_CODE_SESSION_ID: '', CLAUDE_CODE_CHILD_SESSION: '', CODEX_THREAD_ID: '', OPENCODE_SESSION_ID: '', SQUARE_PI_SESSION_ID: 'owner-a' },
    });
    try {
      await assert.rejects(
        () => done(oldSession, pausedBinding.participant, '', { expectedEpoch }),
        (error) => error?.code === 'already_done',
      );
    } finally {
      await closeOpenSquare(oldSession);
    }
  });
  const acts = (await loadSquare(item.publicPath)).acts.map((act) => act.kind);
  assert.deepEqual(acts, ['join', 'done', 'join']);
  assert.equal((await lookupSessionBindings('owner-a', Date.now(), item.env)).some((binding) => binding.name === 'shared'), false);
  assert.equal((await lookupSessionBindings('owner-b', Date.now(), item.env)).some((binding) => binding.name === 'shared'), true);
});

test('automatic resume republishes the current epoch and stale retirement leaves it in place', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared', PASEO_AGENT_ID: 'paseo-agent' }, async (env) => {
    await automaticSessionStart('pi', 'owner-a', item.cwd, env);
    const participant = 'shared';
    assert.equal((await readParticipantOwner(item.publicPath, participant, env))?.epoch, 1);
    assert.equal((await readWakeRoutes({ location: item.publicPath, participant, sessionId: 'owner-a', now: Date.now() }))[0]?.epoch, 1);

    const replacement = await Square.at({
      path: item.publicPath,
      hostLedger: createHostLedgerPort({
        userPath: env.SQUARE_HOST_LEDGER_USER ?? path.dirname(env.SQUARE_REGISTRY),
        localPath: env.SQUARE_HOST_LEDGER_LOCAL ?? path.dirname(env.SQUARE_REGISTRY),
      }),
      env: { ...env, CODEX_THREAD_ID: '', SQUARE_PI_SESSION_ID: 'owner-a' },
    });
    try {
      await replacement.takeover(participant);
    } finally {
      await replacement.close();
    }
    assert.equal((await readParticipantOwner(item.publicPath, participant, env))?.epoch, 2);

    await automaticSessionStart('pi', 'owner-a', item.cwd, env);
    const currentRoute = (await readWakeRoutes({ location: item.publicPath, participant, sessionId: 'owner-a', now: Date.now() }))[0];
    assert.equal(currentRoute?.epoch, 2);
    assert.ok(currentRoute);
    await retireWakeRoute(currentRoute, { expectedEpoch: 1, env });
    const routes = await readWakeRoutes({ location: item.publicPath, participant, sessionId: 'owner-a', now: Date.now() });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].epoch, 2);
  });
});

test('Codex hook command joins and ends through the real CLI boundary', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const start = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: item.cwd, hook_event_name: 'SessionStart', source: 'startup' }), env);
    assert.equal(start, '');
    const end = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: item.cwd, hook_event_name: 'SessionEnd' }), env);
    assert.equal(end, '');
  });
  assert.deepEqual((await loadSquare(item.publicPath)).acts.map((act) => act.kind), ['join', 'done']);
});

test('Codex SessionResume uses the hook process cwd when the payload omits cwd', { concurrency: false }, async () => {
  const item = await fixture();
  const previousCwd = process.cwd();
  process.chdir(item.cwd);
  try {
    await withEnv(item.env, async (env) => {
      const resume = await runCodexHookAsync(JSON.stringify({ session_id: 'resume-without-cwd', hook_event_name: 'SessionResume', source: 'resume' }), env);
      assert.equal(resume, '');
    });
  } finally {
    process.chdir(previousCwd);
  }
  assert.deepEqual((await loadSquare(item.publicPath)).acts.map((act) => act.kind), ['join']);
});

test('Codex Stop presents pending attention through the stop wire', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const result = await codexHookResponse(
      { session_id: 'stop-session', hook_event_name: 'Stop' },
      () => [{
        name: 'Bob',
        squarePath: item.publicPath,
        ownerId: 'stop-owner',
        notifications: [{ actIndex: 2, actor: 'Alice', at: 3, route: 'mention', body: `stop answer ${'x'.repeat(121)}` }],
      }],
      env,
    );
    assert.ok(result);
    assert.equal(result.hookSpecificOutput, undefined);
    assert.match(result.systemMessage, /stop answer/);
  });
});
test('Codex hook boundary state follows Stop, non-Stop, and SessionEnd', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    const thread = 'boundary-thread';
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'SessionStart', cwd: item.cwd }), env);
    assert.equal(await codexQueueEligible(thread, env), false);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'Stop' }), env);
    assert.equal(await codexQueueEligible(thread, env), true);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'PostToolUse' }), env);
    assert.equal(await codexQueueEligible(thread, env), false);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'Stop' }), env);
    assert.equal(await codexQueueEligible(thread, env), true);
    await runCodexHookAsync(JSON.stringify({ session_id: thread, hook_event_name: 'SessionEnd' }), env);
    assert.equal(await codexQueueEligible(thread, env), false);
  });
});
