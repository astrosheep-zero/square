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
import { codexBoundaryStore } from '../dist/codex-address.js';

const cli = fileURLToPath(new URL('../dist/square.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(15); }
  assert.fail(`timed out: ${description}`);
}

// The watcher never contacts a native app-server: queue admission writes the
// shared native queue store through the CLI, and the hosting Codex process
// starts queued input only when the thread is idle. Native coverage is opt-in.
// Bound every wait so a stall fails with its name instead of hanging until the test timeout.
const within = (promise, description, ms = 20_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${description}`)), ms); })])
    .finally(() => clearTimeout(timer));
};

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
  const stop = async () => (await codexBoundaryStore(env).read('thread'))?.stop;
  t.after(async () => {
    for (const { controller } of running) controller.abort();
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.all(running.map(item => item.promise));
    await Promise.all(children.map(item => item.exited));
    await ledger.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { env, ledger, owner, session, watch, command, calls, stop };
}

test('each Stop queues once without any native contact and exits; the next Stop starts a fresh watcher', async t => {
  const f = await fixture(t);
  assert.ok((await createDefaultDeliveryTransports()).every(transport => transport.kind !== 'codex-queue'));
  let producerCalls = 0;
  const first = f.command();
  const stop = await until(f.stop, 'first Stop watcher');
  const duplicate = f.command();
  assert.deepEqual(await within(duplicate.exited, 'duplicate Stop exit'), [0, null]);
  assert.deepEqual(await f.stop(), stop);
  await postAndDispatch(f.ledger, { owner: f.owner, key: ["first"], text: 'receiver-owned text' }, {
    transports: [{ kind: 'codex-queue', send: async () => { producerCalls++; return 'accepted'; } }] });
  assert.equal(producerCalls, 0);
  assert.deepEqual(await within(first.exited, 'first Stop exit'), [0, null]);
  assert.equal(first.output().stdout, '');
  assert.match((await f.calls())[0].at(-1), /Square wake:/);
  assert.doesNotMatch((await f.calls())[0].at(-1), /receiver-owned text/);
  assert.deepEqual((await f.ledger.pending(f.owner, { generation: f.session.generation })).map(card => card.text), ['receiver-owned text']);
  assert.deepEqual(await f.ledger.receipts(f.owner), []); // queue admission is not presentation
  assert.equal((await f.calls()).length, 1);

  await f.ledger.post({ owner: f.owner, key: ["second"], text: 'later Stop' });
  const second = f.command('two');
  assert.deepEqual(await within(second.exited, 'second Stop exit'), [0, null]);
  assert.equal((await f.calls()).length, 2);
  assert.equal((await f.calls())[1].at(-1), (await f.calls())[0].at(-1));
});

test('queued wake fetches current context only after an intervening perceive suppresses the original card', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: ["original"], text: 'STALE_ORIGINAL_BODY' });
  await within(f.watch().promise, 'wake admission');
  assert.doesNotMatch((await f.calls())[0].at(-1), /STALE_ORIGINAL_BODY/);
  await f.ledger.suppress({ owner: f.owner, key: ["original"], scope: 'exact' });
  await f.ledger.post({ owner: f.owner, key: ["fresh"], text: 'FRESH_BODY_AT_DEQUEUE' });
  let context;
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' }, text => { context = text; }, f.env, () => {});
  assert.match(context, /FRESH_BODY_AT_DEQUEUE/);
  assert.doesNotMatch(context, /STALE_ORIGINAL_BODY/);
  assert.deepEqual((await f.ledger.receipts(f.owner)).map(row => row.key), [["fresh"]]);
});

test('a newer Stop retires the older watcher and owns the next queue', async t => {
  const f = await fixture(t);
  const old = f.watch();
  await until(f.stop, 'old watcher armed');
  const next = f.watch('two');
  await within(old.promise, 'older watcher retirement'); // the newer Stop epoch retires the older watcher
  await f.ledger.post({ owner: f.owner, key: ["new"], text: 'new Stop owns delivery' });
  await within(next.promise, 'newer watcher end');
  assert.equal((await f.calls()).length, 1);
  assert.doesNotMatch((await f.calls())[0].at(-1), /new Stop owns delivery/);
  assert.deepEqual(await f.ledger.handoffs(f.owner, { generation: f.session.generation }), []);
});

test('active native events retire the watcher and leave cards to synchronous hooks', async t => {
  const f = await fixture(t);
  const waiting = f.watch();
  await until(f.stop, 'idle watcher');
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' }, undefined, f.env, () => {});
  await within(waiting.promise, 'watcher end');
  await f.ledger.post({ owner: f.owner, key: ["active"], text: 'active hook fallback' });
  await pause(100);
  assert.deepEqual(await f.calls(), []);
  let output;
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'PostToolUse' }, text => { output = JSON.parse(text); }, f.env, () => {});
  assert.match(output.hookSpecificOutput.additionalContext, /active hook fallback/);
  assert.equal((await f.ledger.receipts(f.owner)).length, 1);
});

test('final launch checks prevent stale queueing', async t => {
  for (const change of ['route', 'generation', 'detach', 'cancel', 'suppress', 'mute']) await t.test(change, async t => {
    const f = await fixture(t);
    // Mutate after the first eligibility read, before the queue's launch fence.
    const original = LedgerStore.prototype.pendingCards;
    let changed = false;
    t.mock.method(LedgerStore.prototype, 'pendingCards', async function (...args) {
      const cards = await original.apply(this, args);
      if (changed || !cards.length) return cards;
      changed = true;
      if (change === 'route') await f.ledger.updateRoutes({ owner: f.owner, generation: f.session.generation,
        routes: [{ kind: 'codex-queue', address: { ...f.session.routes[0].address, endpoint: 'ws://127.0.0.1:1' } }] });
      if (change === 'detach') await f.ledger.detach({ owner: f.owner, generation: f.session.generation });
      if (change === 'generation') await f.ledger.attach({ owner: f.owner, expectedGeneration: f.session.generation, routes: f.session.routes });
      if (change === 'cancel') await f.ledger.cancel({ owner: f.owner, generation: f.session.generation });
      if (change === 'suppress') await f.ledger.suppress({ owner: f.owner, key: ["pending"], scope: 'exact' });
      if (change === 'mute') await f.ledger.mute({ durationMs: 60_000 });
      return cards;
    });
    await f.ledger.post({ owner: f.owner, key: ["pending"], text: 'must remain unsent' });
    await within(f.watch().promise, 'watcher end');
    assert.deepEqual(await f.ledger.handoffs(f.owner, { generation: f.session.generation }), []);
    assert.deepEqual(await f.calls(), []);
  });
});

test('Interrupt cancels its pending batch; a later Stop admits future cards', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: ["cancelled"], text: 'old batch' });
  const interrupt = spawn(process.execPath, [cli, 'codex-interrupt'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(interrupt, 'exit');
  interrupt.stdin.end(JSON.stringify({ session_id: 'thread', hook_event_name: 'Interrupt', turn_id: 'one' }));
  assert.deepEqual(await within(exited, 'interrupt exit'), [0, null]);
  const waiting = f.watch();
  await until(f.stop, 'watcher after interrupt');
  await f.ledger.post({ owner: f.owner, key: ["future"], text: 'future batch' });
  await within(waiting.promise, 'watcher end');
  assert.equal((await f.calls()).length, 1);
  assert.doesNotMatch((await f.calls())[0].at(-1), /future batch/);
  let context;
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'UserPromptSubmit' }, text => { context = text; }, f.env, () => {});
  assert.match(context, /future batch/);
  assert.doesNotMatch(context, /old batch/);
  assert.doesNotMatch((await f.calls())[0].at(-1), /old batch/);
});

test('refused and ambiguous queue attempts both end the watcher without retry or false receipts', async t => {
  for (const flag of ['QUEUE_REFUSED', 'QUEUE_UNKNOWN']) await t.test(flag, async t => {
    const f = await fixture(t); f.env[flag] = '1';
    await f.ledger.post({ owner: f.owner, key: ["attempt"], text: 'one attempt only' });
    await within(f.watch().promise, 'watcher end');
    assert.equal((await f.calls()).length, 1);
    const attempts = await f.ledger.handoffs(f.owner, { generation: f.session.generation });
    assert.deepEqual(attempts, []);
    assert.deepEqual((await f.ledger.pending(f.owner, { generation: f.session.generation })).map(card => card.key), [["attempt"]]);
    assert.deepEqual(await f.ledger.receipts(f.owner), []);
  });
});
