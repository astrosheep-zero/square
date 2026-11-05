import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { LedgerStore } from '../dist/delivery-ledger-sqlite.js';
import { postAndDispatch, createDefaultDeliveryTransports } from '../dist/notifications.js';
import { runCodexWatch } from '../dist/codex-watch.js';
import { codexHookResponse } from '../dist/codex-hook.js';
import { withFileLock } from '../dist/file-lock.js';

const cli = fileURLToPath(new URL('../dist/square.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(15); }
  assert.fail(`timed out: ${description}`);
}

// The watcher never contacts a native app-server: queue admission writes the
// shared native queue store through the CLI, and the hosting Codex process
// starts queued input only when the thread is idle. No native fixture exists.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-codex-watch-'));
  const bin = path.join(root, 'queue.mjs'), callsFile = path.join(root, 'calls');
  await fs.writeFile(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(process.env.QUEUE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.QUEUE_UNKNOWN)process.exit(1);if(process.env.QUEUE_REFUSED){console.error('Error: unknown thread');process.exit(1);}`, { mode: 0o700 });
  const env = { ...process.env, HOME: root, CODEX_HOME: path.join(root, 'codex'),
    SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'),
    SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'),
    SQUARE_CODEX_BIN: bin, QUEUE_CALLS: callsFile,
    SQUARE_DISABLE_PASEO_WAKE: '1' };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  const owner = 'codex:thread';
  await ledger.attach({ owner, expectedGeneration: null,
    routes: [{ kind: 'codex-queue', address: { threadId: 'thread', codexHome: env.CODEX_HOME } }] });
  const session = await ledger.session(owner);
  const running = [], children = [];
  const watch = (turn_id = 'one') => {
    const controller = new AbortController();
    const promise = runCodexWatch(JSON.stringify({ session_id: 'thread', hook_event_name: 'Stop', turn_id }), env, controller.signal);
    running.push({ controller, promise });
    return { controller, promise };
  };
  const command = (turn_id = 'one') => {
    const child = spawn(process.execPath, [cli, 'codex-watch'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ session_id: 'thread', hook_event_name: 'Stop', turn_id }));
    children.push({ child, exited });
    return { child, exited, output: () => ({ stdout, stderr }) };
  };
  const calls = async () => (await fs.readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const locked = async () => {
    const files = await fs.readdir(path.join(root, 'codex-watchers')).catch(() => []);
    for (const file of files) if (await withFileLock(path.join(root, 'codex-watchers', file), { retryMs: 1, skipIfBusy: true }, () => false) === undefined) return true;
    return false;
  };
  t.after(async () => {
    for (const { controller } of running) controller.abort();
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(running.map(item => item.promise));
    await Promise.all(children.map(item => item.exited));
    await ledger.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, env, ledger, owner, session, watch, command, calls, locked };
}

test('each Stop queues once without any native contact and exits; the next Stop starts a fresh watcher', async t => {
  const f = await fixture(t);
  assert.ok((await createDefaultDeliveryTransports(f.env)).every(transport => transport.kind !== 'codex-queue'));
  let producerCalls = 0;
  const first = f.command();
  await until(f.locked, 'first Stop watcher');
  const duplicate = f.command();
  assert.deepEqual(await duplicate.exited, [0, null]);
  await postAndDispatch(f.ledger, { owner: f.owner, key: 'first', text: 'receiver-owned text' }, { env: f.env,
    transports: [{ kind: 'codex-queue', send: async () => { producerCalls++; return 'accepted'; } }] });
  assert.equal(producerCalls, 0);
  assert.deepEqual(await first.exited, [0, null]);
  assert.equal(first.output().stdout, '');
  assert.match((await f.calls())[0].at(-1), /receiver-owned text/);
  assert.deepEqual(await f.ledger.receipts(f.owner), []); // queue admission is not presentation
  assert.equal((await f.calls()).length, 1);

  await f.ledger.post({ owner: f.owner, key: 'second', text: 'later Stop' });
  const second = f.command('two');
  assert.deepEqual(await second.exited, [0, null]);
  assert.equal((await f.calls()).length, 2);
  assert.match((await f.calls())[1].at(-1), /later Stop/);
});

test('a newer Stop retires the older watcher and owns the next queue', async t => {
  const f = await fixture(t);
  const old = f.watch();
  await until(f.locked, 'old watcher lock');
  const next = f.watch('two');
  await old.promise; // the newer Stop epoch retires the older watcher
  await f.ledger.post({ owner: f.owner, key: 'new', text: 'new Stop owns delivery' });
  await next.promise;
  assert.equal((await f.calls()).length, 1);
  assert.match((await f.calls())[0].at(-1), /new Stop owns delivery/);
});

test('active native events retire the watcher and leave cards to synchronous hooks', async t => {
  const f = await fixture(t);
  const waiting = f.watch();
  await until(f.locked, 'idle watcher');
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' }, undefined, f.env, () => {});
  await waiting.promise;
  await f.ledger.post({ owner: f.owner, key: 'active', text: 'active hook fallback' });
  await pause(100);
  assert.deepEqual(await f.calls(), []);
  let output;
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'PostToolUse' }, text => { output = JSON.parse(text); }, f.env, () => {});
  assert.match(output.hookSpecificOutput.additionalContext, /active hook fallback/);
  assert.equal((await f.ledger.receipts(f.owner)).length, 1);
});

test('final route, attachment and cancellation checks prevent stale queueing', async t => {
  for (const change of ['route', 'generation', 'detach', 'cancel', 'suppress']) await t.test(change, async t => {
    const f = await fixture(t);
    // Mutate after the ledger handoff claim, before the transport's final fences.
    const original = LedgerStore.prototype.claimHandoff;
    t.mock.method(LedgerStore.prototype, 'claimHandoff', async function (...args) {
      const claim = await original.apply(this, args);
      if (!claim) return claim;
      if (change === 'route') await f.ledger.updateRoutes({ owner: f.owner, generation: f.session.generation,
        routes: [{ kind: 'codex-queue', address: { ...f.session.routes[0].address, endpoint: 'ws://127.0.0.1:1' } }] });
      if (change === 'detach') await f.ledger.detach({ owner: f.owner, generation: f.session.generation });
      if (change === 'generation') await f.ledger.attach({ owner: f.owner, expectedGeneration: f.session.generation, routes: f.session.routes });
      if (change === 'cancel') await f.ledger.cancel({ owner: f.owner, generation: f.session.generation });
      if (change === 'suppress') await f.ledger.suppress({ owner: f.owner, key: 'pending', scope: 'exact' });
      return claim;
    });
    await f.ledger.post({ owner: f.owner, key: 'pending', text: 'must remain unsent' });
    await f.watch().promise;
    if (change === 'generation' || change === 'detach') assert.ok((await f.ledger.health(f.owner)).unknownAttempts.length);
    else assert.ok((await f.ledger.handoffs(f.owner, { generation: f.session.generation })).every(attempt => attempt.outcome !== 'dispatching'));
    assert.deepEqual(await f.calls(), []);
  });
});

test('Interrupt cancels its pending batch; a later Stop admits future cards', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: 'cancelled', text: 'old batch' });
  const interrupt = spawn(process.execPath, [cli, 'codex-interrupt'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(interrupt, 'exit');
  interrupt.stdin.end(JSON.stringify({ session_id: 'thread', hook_event_name: 'Interrupt', turn_id: 'one' }));
  assert.deepEqual(await exited, [0, null]);
  const waiting = f.watch();
  await until(f.locked, 'watcher after interrupt');
  await f.ledger.post({ owner: f.owner, key: 'future', text: 'future batch' });
  await waiting.promise;
  assert.equal((await f.calls()).length, 1);
  assert.match((await f.calls())[0].at(-1), /future batch/);
  assert.doesNotMatch((await f.calls())[0].at(-1), /old batch/);
});

test('refused and ambiguous queue attempts both end the watcher without retry or false receipts', async t => {
  for (const flag of ['QUEUE_REFUSED', 'QUEUE_UNKNOWN']) await t.test(flag, async t => {
    const f = await fixture(t); f.env[flag] = '1';
    await f.ledger.post({ owner: f.owner, key: 'attempt', text: 'one attempt only' });
    await f.watch().promise;
    assert.equal((await f.calls()).length, 1);
    const attempts = await f.ledger.handoffs(f.owner, { generation: f.session.generation });
    assert.equal(attempts[0].outcome, flag === 'QUEUE_REFUSED' ? 'released' : 'unknown');
    assert.deepEqual(await f.ledger.receipts(f.owner), []);
  });
});
