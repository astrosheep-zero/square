import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { readCodexBoundary, recordCodexBoundary } from '../dist/codex-boundary-state.js';
import { codexHookResponse, runCodexHook } from '../dist/codex-hook.js';
import { createArtifactPort } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
import { sessionInbox } from '../dist/inbox.js';
import { rememberSquarePath } from '../dist/square-index.js';

test('Codex hook budgets cancel boundary and end records while the lock stays held', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-hook-budget-'));
  const env = {
    ...process.env,
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'),
    SQUARE_CODEX_HOOK_BUDGET_MS: '60',
  };
  await recordCodexBoundary('thread', 'non-stop', env);
  const before = await readCodexBoundary('thread', env);
  const lock = new DatabaseSync(`${env.SQUARE_CODEX_BOUNDARIES}.lock`);
  lock.exec('BEGIN EXCLUSIVE');
  let held = true;
  const release = () => {
    if (held) lock.exec('ROLLBACK');
    held = false;
  };
  const watchdog = setTimeout(release, 1000);
  try {
    const startedAt = Date.now();
    await assert.rejects(codexHookResponse(
      { session_id: 'thread', hook_event_name: 'Stop', cwd: root },
      () => { throw new Error('Stop must not look up the inbox'); },
      env,
      [],
      () => {},
    ), { name: 'AbortError' });
    assert.ok(Date.now() - startedAt < 300, 'Stop must settle near its 60ms budget');
    assert.equal(held, true);

    await assert.rejects(runCodexHook(JSON.stringify({
      session_id: 'thread', hook_event_name: 'SessionEnd', cwd: root,
    }), env), { name: 'AbortError' });
    assert.equal(held, true);
    assert.deepEqual(await readCodexBoundary('thread', env), before);
  } finally {
    clearTimeout(watchdog);
    release();
    lock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extracted Codex hook pulls by exact Body and preserves artifact-owned presentation claims', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-hook-body-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl'),
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'), SQUARE_DISABLE_PASEO_WAKE: '1' };
  const location = path.join(root, 'test.square');
  const square = await Square.build({ path: location, markdown: 'Codex hook fixture', env });
  await square.close();
  const artifact = createArtifactPort(location);
  t.after(() => artifact.close());
  const body = "codex" + ":" + ('same-id');
  const otherBody = "pi" + ":" + ('same-id');
  const join = async (participant, coordinate) => (await artifact.transactAs({ kind: 'join', participant, owner: coordinate }, facts => {
    facts.land({ kind: 'join', actor: participant, at: 1 });
    return facts.seat(participant);
  })).value;
  const alice = await join('Alice', "test" + ":" + ('sender'));
  const bob = await join('Bob', body);
  const other = await join('Other', otherBody);
  const { value: act } = await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 2, body: 'Codex pending 字', mentions: ['Bob', 'Other'] }));
  await rememberSquarePath(location, body, env.SQUARE_INDEX);
  await rememberSquarePath(location, otherBody, env.SQUARE_INDEX);
  let lookups = 0;
  const lookup = (identity, receivedEnv, signal) => {
    lookups++;
    assert.deepEqual(identity, body);
    assert.equal(receivedEnv, env);
    assert.ok(signal instanceof AbortSignal);
    return sessionInbox(identity, receivedEnv, signal);
  };
  const input = { session_id: 'same-id', hook_event_name: 'PostToolUse', cwd: root };
  const response = await codexHookResponse(input, lookup, env, {}, () => {});
  assert.equal(response.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(response.hookSpecificOutput.additionalContext, /Codex pending 字/);
  const { value: facts } = await artifact.read(facts => ({
    bob: facts.deliveryEvidence('Bob', bob.generation), other: facts.deliveryEvidence('Other', other.generation),
    bobReceipt: facts.receipt('Bob', act.index), otherReceipt: facts.receipt('Other', act.index),
  }));
  assert.equal(facts.bob.filter(row => row.kind === 'presentation' && row.outcome === 'presented').length, 1);
  assert.ok(facts.bobReceipt);
  assert.deepEqual(facts.other, []);
  assert.equal(facts.otherReceipt, undefined);
  assert.equal(await codexHookResponse(input, lookup, env, {}, () => {}), undefined);
  assert.equal(lookups, 2);
});

test('Codex hook retains presented output while artifact settlement outlives the internal budget', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-codex-hook-settlement-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl'),
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'), SQUARE_DISABLE_PASEO_WAKE: '1',
    SQUARE_CODEX_HOOK_BUDGET_MS: '500' };
  const location = path.join(root, 'test.square');
  const square = await Square.build({ path: location, markdown: 'Codex settlement fixture', env });
  await square.close();
  const artifact = createArtifactPort(location);
  t.after(() => artifact.close());
  const body = "codex" + ":" + ('settlement-thread');
  const join = async (participant, coordinate) => (await artifact.transactAs({ kind: 'join', participant, owner: coordinate }, facts => {
    facts.land({ kind: 'join', actor: participant, at: 1 });
    return facts.seat(participant);
  })).value;
  const alice = await join('Alice', "test" + ":" + ('sender'));
  const bob = await join('Bob', body);
  const { value: act } = await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 2, body: 'settled Codex preview 字', mentions: ['Bob'] }));
  await rememberSquarePath(location, body, env.SQUARE_INDEX);

  const blocker = new DatabaseSync(location), exec = DatabaseSync.prototype.exec;
  const canonical = fs.realpathSync(location);
  const settlementStarted = Promise.withResolvers(), aborted = Promise.withResolvers(), committed = Promise.withResolvers();
  let writes = 0, held = false, settlingConnection, finished = false;
  const release = () => { if (held) exec.call(blocker, 'ROLLBACK'); held = false; };
  // The first artifact write claims presentation; hold the second, successful settlement.
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (sql === 'BEGIN IMMEDIATE' && this.location() === canonical && ++writes === 2) {
      exec.call(blocker, 'BEGIN IMMEDIATE');
      held = true;
      settlingConnection = this;
      settlementStarted.resolve();
    }
    const result = exec.call(this, sql, ...args);
    if (this === settlingConnection && sql === 'COMMIT') committed.resolve();
    return result;
  });
  const input = { session_id: 'settlement-thread', hook_event_name: 'PostToolUse', cwd: root };
  const hook = codexHookResponse(input, (identity, receivedEnv, signal) => {
    signal.addEventListener('abort', () => aborted.resolve(), { once: true });
    return sessionInbox(identity, receivedEnv, signal);
  }, env, {}, () => {}).then(value => { finished = true; return value; });
  try {
    await Promise.race([settlementStarted.promise, hook.then(() => assert.fail('hook never reached presentation settlement'))]);
    await aborted.promise;
    await new Promise(setImmediate);
    const abandonedSettlement = finished;
    release();
    await committed.promise;
    const response = await hook;
    assert.equal(abandonedSettlement, false, 'deadline cancellation must not abandon successful presentation custody');
    assert.match(response.hookSpecificOutput.additionalContext, /settled Codex preview 字/);
    const { value: evidence } = await artifact.read(facts => ({
      receipt: facts.receipt('Bob', act.index), delivery: facts.deliveryEvidence('Bob', bob.generation),
    }));
    assert.ok(evidence.receipt);
    assert.equal(evidence.delivery.filter(row => row.kind === 'presentation' && row.outcome === 'presented').length, 1);
    assert.equal(await codexHookResponse(input, sessionInbox, env, {}, () => {}), undefined, 'the returned presentation is not replayed');
  } finally {
    release();
    await hook.catch(() => {});
    t.mock.restoreAll();
    blocker.close();
  }
});
