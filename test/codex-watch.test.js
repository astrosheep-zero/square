import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { postAndDispatch, createDefaultDeliveryTransports } from '../dist/notifications.js';
import { codexHookResponse } from '../dist/codex-hook.js';
import { runCodexWatch } from '../dist/codex-watch.js';
import { withFileLock } from '../dist/file-lock.js';

const cli = fileURLToPath(new URL('../dist/square.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(15); }
  assert.fail(`timed out: ${description}`);
}

// Protocol fixture only; native evidence lives in codex-watch-native.mjs.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-codex-watch-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const state = { reads: 0, version: 'agent-delivery/0.166.0', status: 'idle', turns: [{ id: 'one', status: 'completed' }], beforeRead: undefined };
  server.on('connection', socket => socket.on('message', async raw => {
    const request = JSON.parse(raw);
    if (request.method === 'initialized') return;
    let result;
    if (request.method === 'initialize') result = { userAgent: state.version, codexHome: root, platformFamily: 'unix', platformOs: 'darwin' };
    else {
      assert.equal(request.method, 'thread/read');
      assert.equal(request.params.includeTurns, true);
      state.reads++;
      await state.beforeRead?.(state.reads, socket);
      result = { thread: { id: 'thread', status: { type: state.status }, turns: state.turns } };
    }
    if (socket.readyState === 1) socket.send(JSON.stringify({ id: request.id, result }));
  }));
  const bin = path.join(root, 'queue.mjs'), callsFile = path.join(root, 'calls');
  await fs.writeFile(bin, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.appendFileSync(process.env.QUEUE_CALLS,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.QUEUE_UNKNOWN)process.exit(1);if(process.env.QUEUE_REFUSED){console.error('Error: unknown thread');process.exit(1);}`, { mode: 0o700 });
  const env = { ...process.env, HOME: root, CODEX_HOME: path.join(root, 'codex'),
    SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'),
    SQUARE_CODEX_ENDPOINT: `ws://127.0.0.1:${server.address().port}`, SQUARE_CODEX_BIN: bin, QUEUE_CALLS: callsFile,
    SQUARE_DISABLE_PASEO_WAKE: '1' };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  const owner = 'codex:thread';
  const hook = (event, turn_id = 'one') => codexHookResponse({ session_id: 'thread', hook_event_name: event, turn_id }, undefined, env, () => {});
  await hook('SessionStart');
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
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await ledger.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, state, env, ledger, owner, session, hook, watch, command, calls, locked };
}

test('each async Stop queues once and exits; the next Stop starts a fresh watcher', async t => {
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

  f.state.status = 'active'; f.state.turns.push({ id: 'two', status: 'inProgress' });
  const stale = f.command();
  assert.deepEqual(await stale.exited, [0, null]); // even without pending work
  await f.ledger.post({ owner: f.owner, key: 'second', text: 'later Stop' });
  f.state.status = 'idle'; f.state.turns.at(-1).status = 'completed';
  const second = f.command('two');
  assert.deepEqual(await second.exited, [0, null]);
  assert.equal((await f.calls()).length, 2);
  assert.match((await f.calls())[1].at(-1), /later Stop/);
});

test('waiting Stop settles before delivery, while a new active turn retires an empty watcher', async t => {
  const f = await fixture(t);
  f.state.status = 'active'; f.state.turns[0].status = 'inProgress';
  await f.ledger.post({ owner: f.owner, key: 'waiting', text: 'wait until Stop settles' });
  const waiting = f.watch();
  await until(() => f.state.reads > 0, 'native Stop still settling');
  assert.deepEqual(await f.ledger.handoffs(f.owner, { generation: f.session.generation }), []);
  f.state.status = 'idle'; f.state.turns[0].status = 'completed';
  await waiting.promise;
  assert.equal((await f.calls()).length, 1);

  const empty = f.watch();
  await until(f.locked, 'empty wait');
  f.state.status = 'active'; f.state.turns.push({ id: 'two', status: 'inProgress' });
  await empty.promise;
  assert.equal((await f.calls()).length, 1);
});

test('final native, route, attachment and cancellation checks prevent stale queueing', async t => {
  for (const change of ['route', 'generation', 'detach', 'cancel', 'suppress', 'native-active', 'native-interrupted', 'native-mismatch', 'native-malformed', 'native-unavailable']) await t.test(change, async t => {
    const f = await fixture(t);
    f.state.beforeRead = async (count, socket) => {
      if (count !== 2) return; // final native read after ledger claim
      if (change === 'route') await f.ledger.updateRoutes({ owner: f.owner, generation: f.session.generation,
        routes: [{ kind: 'codex-queue', address: { ...f.session.routes[0].address, endpoint: 'ws://127.0.0.1:1' } }] });
      if (change === 'detach') await f.ledger.detach({ owner: f.owner, generation: f.session.generation });
      if (change === 'generation') await f.ledger.attach({ owner: f.owner, expectedGeneration: f.session.generation, routes: f.session.routes });
      if (change === 'cancel') await f.ledger.cancel({ owner: f.owner, generation: f.session.generation });
      if (change === 'suppress') await f.ledger.suppress({ owner: f.owner, key: 'pending', scope: 'exact' });
      if (change === 'native-active') f.state.status = 'active';
      if (change === 'native-interrupted') f.state.turns.at(-1).status = 'interrupted';
      if (change === 'native-mismatch') f.state.turns.push({ id: 'newer', status: 'completed' });
      if (change === 'native-malformed') f.state.turns = [{ id: 'one' }];
      if (change === 'native-unavailable') { f.state.status = 'notLoaded'; socket.terminate(); }
    };
    await f.ledger.post({ owner: f.owner, key: 'pending', text: 'must remain unsent' });
    await f.watch().promise;
    if (change === 'generation' || change === 'detach') assert.ok((await f.ledger.health(f.owner)).unknownAttempts.length);
    else assert.ok((await f.ledger.handoffs(f.owner, { generation: f.session.generation })).every(attempt => attempt.outcome !== 'dispatching'));
    assert.deepEqual(await f.calls(), []);
  });
});

test('different Stop does not lose its wait behind an older turn lock', async t => {
  const f = await fixture(t);
  const old = f.watch();
  await until(f.locked, 'old turn lock');
  f.state.turns.push({ id: 'two', status: 'completed' });
  await f.ledger.post({ owner: f.owner, key: 'new', text: 'new Stop owns delivery' });
  const next = f.watch('two');
  await next.promise;
  await old.promise;
  assert.equal((await f.calls()).length, 1);
});

test('Interrupt cancels its pending batch; a later Stop admits future cards', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: 'cancelled', text: 'old batch' });
  const interrupt = spawn(process.execPath, [cli, 'codex-interrupt'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(interrupt, 'exit');
  interrupt.stdin.end(JSON.stringify({ session_id: 'thread', hook_event_name: 'Interrupt', turn_id: 'one' }));
  assert.deepEqual(await exited, [0, null]);
  f.state.turns[0].status = 'interrupted';
  await f.ledger.post({ owner: f.owner, key: 'future', text: 'future batch' });
  await f.watch().promise;
  assert.deepEqual(await f.calls(), []);
  f.state.turns.push({ id: 'two', status: 'completed' });
  await f.watch('two').promise;
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

test('without a hosting endpoint idle delivery exits and leaves cards for PostToolUse', async t => {
  const f = await fixture(t);
  delete f.env.SQUARE_CODEX_ENDPOINT;
  await f.ledger.updateRoutes({ owner: f.owner, generation: f.session.generation,
    routes: [{ kind: 'codex-queue', address: { threadId: 'thread', codexHome: f.env.CODEX_HOME } }] });
  await f.ledger.post({ owner: f.owner, key: 'stdio', text: 'active hook fallback' });
  const command = f.command();
  assert.deepEqual(await command.exited, [0, null]);
  assert.match(command.output().stderr, /requires a reachable hosting app-server endpoint/);
  assert.deepEqual(await f.calls(), []);
  let output;
  await codexHookResponse({ session_id: 'thread', hook_event_name: 'PostToolUse' }, text => { output = JSON.parse(text); }, f.env, () => {});
  assert.match(output.hookSpecificOutput.additionalContext, /active hook fallback/);
  assert.equal((await f.ledger.receipts(f.owner)).length, 1);
});
