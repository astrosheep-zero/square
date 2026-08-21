import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSquareState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { automaticParticipant, automaticSessionEnd, automaticSessionStart } from '../dist/automatic-session.js';
import { runCodexHookAsync } from '../dist/codex-hook.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-auto-'));
  const cwd = path.join(root, 'workspace');
  const publicPath = path.join(cwd, '.square', 'PUBLIC.square');
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  writeSquareFile(publicPath, createSquareState({ force: true, hardCap: null }, 'Host context'));
  const env = { ...process.env, SQUARE_REGISTRY: path.join(root, 'sessions.ndjsonl'), SQUARE_PRESENTED: path.join(root, 'presented.ndjsonl'), SQUARE_WAKE_ATTEMPTS: path.join(root, 'wake.ndjsonl'), SQUARE_ROUTES: path.join(root, 'routes.ndjsonl'), SQUARE_LOCATION: path.join(root, 'other.square') };
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
  const item = fixture();
  await withEnv(item.env, async (env) => {
    const first = await automaticSessionStart('codex', 'thread-1', item.cwd, env);
    assert.match(first, /codex-/);
    const second = await automaticSessionStart('codex', 'thread-1', item.cwd, env);
    assert.equal(second, undefined);
  });
  const squareState = loadSquare(item.publicPath);
  assert.equal(squareState.acts.filter((act) => act.kind === 'join').length, 1);
  assert.equal(squareState.acts.some((act) => JSON.stringify(act).includes('thread-1')), false);
  assert.equal(automaticParticipant('codex', 'thread-1', item.env), `codex-${crypto.createHash('sha256').update('thread-1').digest('hex').slice(0, 12)}`);
});

test('automatic session end writes ordinary done for its bound owner', { concurrency: false }, async () => {
  const item = fixture();
  await withEnv(item.env, async (env) => {
    await automaticSessionStart('pi', 'pi-session', item.cwd, env);
    await automaticSessionEnd('pi', 'pi-session', item.cwd, env);
  });
  const squareState = loadSquare(item.publicPath);
  assert.deepEqual(squareState.acts.map((act) => act.kind), ['join', 'done']);
  await withEnv({ ...item.env, SQUARE_PARTICIPANT_NAME: 'changed' }, (env) => automaticSessionEnd('pi', 'pi-session', item.cwd, env));
  assert.equal(loadSquare(item.publicPath).acts.length, 2);
});

test('missing PUBLIC.square is a no-op', { concurrency: false }, async () => {
  const item = fixture();
  fs.unlinkSync(item.publicPath);
  assert.equal(await automaticSessionStart('claude', 'session', item.cwd, item.env), undefined);
});

test('Codex hook command joins and ends through the real CLI boundary', { concurrency: false }, async () => {
  const item = fixture();
  await withEnv(item.env, async (env) => {
    const start = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: item.cwd, hook_event_name: 'SessionStart', source: 'startup' }), env);
    assert.match(start, /You joined the public square/);
    const end = await runCodexHookAsync(JSON.stringify({ session_id: 'hook-session', cwd: item.cwd, hook_event_name: 'SessionEnd' }), env);
    assert.equal(end, '');
  });
  assert.deepEqual(loadSquare(item.publicPath).acts.map((act) => act.kind), ['join', 'done']);
});
