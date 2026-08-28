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
import { lookupSessionBindings } from '../dist/registry.js';
import { createHostLedgerPort } from '../dist/host-ledger-file-adapter.js';

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
  const ledger = createHostLedgerPort({ userPath: path.dirname(item.env.SQUARE_REGISTRY), localPath: path.dirname(item.env.SQUARE_REGISTRY) });
  const rows = await ledger.listPresence({ location: item.publicPath, participant: automaticParticipant('claude', 'claude-session', item.env), scopes: ['user'] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'claude-code');
  assert.deepEqual(rows[0].route, { kind: 'paseo', address: { agentId: 'paseo-agent' } });
});

test('automatic implicit join does not re-enter a participant that has done', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv(item.env, async (env) => {
    await automaticSessionStart('pi', 'pi-session', item.cwd, env);
    await automaticSessionEnd('pi', 'pi-session', item.cwd, env);
    assert.equal(await automaticSessionStart('pi', 'pi-session', item.cwd, env), undefined);
  });
  assert.deepEqual((await loadSquare(item.publicPath)).acts.map((act) => act.kind), ['join', 'done']);
});

test('automatic implicit join rebinds an active participant without another join', { concurrency: false }, async () => {
  const item = await fixture();
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'shared' }, async (env) => {
    await automaticSessionStart('pi', 'first-session', item.cwd, env);
    const resumed = await automaticSessionStart('pi', 'second-session', item.cwd, env);
    assert.equal(resumed, undefined);
    assert.equal((await lookupSessionBindings('second-session')).some((binding) => binding.name === 'shared'), true);
  });
  assert.deepEqual((await loadSquare(item.publicPath)).acts.map((act) => act.kind), ['join']);
});

test('missing PUBLIC.square is a no-op', { concurrency: false }, async () => {
  const item = await fixture();
  fs.unlinkSync(item.publicPath);
  assert.equal(await automaticSessionStart('claude', 'session', item.cwd, item.env), undefined);
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
