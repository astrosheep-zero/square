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
import { codexBoundaryStore } from '../dist/codex-boundary-state.js';
import { runCodexWatch } from '../dist/codex-watch.js';
import { withFileLock } from '../dist/file-lock.js';

const cli = fileURLToPath(new URL('../dist/square.js', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await pause(15); }
  assert.fail(`timed out: ${description}`);
}

// Native protocol fixture, not native-success evidence. The separate opt-in
// codex watcher smoke uses the installed binary and the shipped hooks.
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
    SQUARE_DELIVERY: path.join(root, 'delivery.sqlite'), SQUARE_CODEX_BOUNDARIES: path.join(root, 'boundaries.json'),
    SQUARE_CODEX_ENDPOINT: `ws://127.0.0.1:${server.address().port}`, SQUARE_CODEX_BIN: bin, QUEUE_CALLS: callsFile,
    SQUARE_DISABLE_PASEO_WAKE: '1' };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  const owner = 'codex:thread', boundaries = codexBoundaryStore(env);
  const hook = (event, turn_id = 'one') => codexHookResponse({ session_id: 'thread', hook_event_name: event, turn_id }, undefined, env, () => {});
  await hook('SessionStart');
  const session = await ledger.session(owner);
  await hook('Stop');
  const running = [], children = [];
  const watch = () => {
    const controller = new AbortController();
    const promise = runCodexWatch(JSON.stringify({ session_id: 'thread', hook_event_name: 'Stop', turn_id: 'one' }), env, controller.signal);
    running.push({ controller, promise });
    return { controller, promise };
  };
  const command = () => {
    const child = spawn(process.execPath, [cli, 'codex-watch'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ session_id: 'thread', hook_event_name: 'Stop', turn_id: 'one' }));
    children.push({ child, exited });
    return { child, exited, output: () => ({ stdout, stderr }) };
  };
  const calls = async () => (await fs.readFile(callsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const locked = async () => {
    const files = await fs.readdir(path.join(root, 'codex-watchers')).catch(() => []);
    if (!files.length) return false;
    return await withFileLock(path.join(root, 'codex-watchers', files[0]), { retryMs: 1, skipIfBusy: true }, () => false) === undefined;
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
  return { root, state, env, ledger, owner, session, boundaries, hook, watch, command, calls, locked };
}

test('public producers never dispatch Codex; one actual command owns observation and follows later Stops', async t => {
  const f = await fixture(t);
  assert.ok((await createDefaultDeliveryTransports(f.env)).every(transport => transport.kind !== 'codex-queue'));
  let producerCalls = 0;
  await postAndDispatch(f.ledger, { owner: f.owner, key: 'first', text: 'receiver-owned text' }, { env: f.env,
    transports: [{ kind: 'codex-queue', send: async () => { producerCalls++; return 'accepted'; } }] });
  assert.equal(producerCalls, 0);
  const first = f.command();
  await until(f.locked, 'resident watcher');
  const duplicate = f.command();
  assert.deepEqual(await duplicate.exited, [0, null]);
  assert.equal(duplicate.output().stdout, '');
  await until(async () => (await f.calls()).length === 1, 'receiver queue');
  await until(async () => (await f.ledger.handoffs(f.owner, { generation: f.session.generation })).some(attempt => attempt.outcome === 'accepted'), 'queue admission settled');
  assert.equal(first.child.exitCode, null);
  assert.match((await f.calls())[0].at(-1), /receiver-owned text/);
  assert.deepEqual(await f.ledger.receipts(f.owner), []); // admission is not presentation
  assert.equal((await f.ledger.post({ owner: f.owner, key: 'first', text: 'different after admission' })).status, 'duplicate');

  await f.hook('UserPromptSubmit', 'two');
  f.state.status = 'active'; f.state.turns.push({ id: 'two', status: 'inProgress' });
  await postAndDispatch(f.ledger, { owner: f.owner, key: 'second', text: 'later epoch' }, { env: f.env });
  // A delayed old Stop cannot authorize deliberate queue while the native turn is active.
  const before = f.state.reads;
  await f.hook('Stop', 'one');
  await until(() => f.state.reads > before, 'stale Stop native check');
  assert.equal((await f.calls()).length, 1);
  f.state.status = 'idle'; f.state.turns.at(-1).status = 'completed';
  await f.hook('Stop', 'two');
  await until(async () => (await f.calls()).length === 2, 'existing watcher follows next Stop');
  await f.hook('SessionEnd');
  assert.deepEqual(await first.exited, [0, null]);
  assert.equal(first.output().stdout, '');
});

test('receiver final checks prevent queue across native, epoch, route, attachment and suppression changes', async t => {
  for (const change of ['epoch', 'route', 'generation', 'detach', 'cancel', 'suppress', 'native-active', 'native-interrupted', 'native-mismatch', 'native-malformed', 'native-unavailable']) await t.test(change, async t => {
    const f = await fixture(t);
    const changed = Promise.withResolvers();
    f.state.beforeRead = async (count, socket) => {
      if (count !== 2) return; // after the real ledger claim, at final native read
      if (change === 'epoch') await f.hook('UserPromptSubmit', 'two');
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
      changed.resolve();
    };
    await f.ledger.post({ owner: f.owner, key: 'pending', text: 'must remain unsent' });
    const watcher = f.watch();
    await changed.promise;
    if (change === 'generation' || change === 'detach') {
      await watcher.promise;
      assert.ok((await f.ledger.health(f.owner)).unknownAttempts.length);
    } else {
      await until(async () => (await f.ledger.handoffs(f.owner, { generation: f.session.generation })).every(attempt => attempt.outcome !== 'dispatching'), 'known-unsent settlement');
    }
    assert.deepEqual(await f.calls(), []);
  });
});

test('Interrupt command cancels only its pending batch; a later verified Stop admits future cards', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: 'cancelled', text: 'old batch' });
  const interrupt = spawn(process.execPath, [cli, 'codex-interrupt'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; interrupt.stdout.on('data', data => { stdout += data; });
  const exited = once(interrupt, 'exit');
  interrupt.stdin.end(JSON.stringify({ session_id: 'thread', hook_event_name: 'Interrupt', turn_id: 'one' }));
  assert.deepEqual(await exited, [0, null]);
  assert.equal(stdout, '');
  assert.equal(await f.boundaries.queueEligible('thread'), false);
  await f.ledger.post({ owner: f.owner, key: 'future', text: 'future batch' });
  assert.deepEqual((await f.ledger.pending(f.owner, { generation: f.session.generation })).map(card => card.key), ['future']);
  f.watch();
  await f.hook('Stop');
  await until(async () => (await f.calls()).length === 1, 'future card queued');
  assert.match((await f.calls())[0].at(-1), /future batch/);
  assert.doesNotMatch((await f.calls())[0].at(-1), /old batch/);
});

test('known-unsent retry waits for reconciliation instead of following its own claim edges', async t => {
  const f = await fixture(t); f.env.QUEUE_REFUSED = '1';
  await f.ledger.post({ owner: f.owner, key: 'retry', text: 'known unsent' });
  const watcher = f.watch();
  await until(async () => (await f.ledger.handoffs(f.owner, { generation: f.session.generation })).some(attempt => attempt.outcome === 'released'), 'known-unsent release');
  await pause(300);
  assert.equal((await f.calls()).length, 1, 'own claim/settlement writes must not drive a hot retry');
  await until(async () => (await f.calls()).length === 2, 'bounded retry rescan');
  watcher.controller.abort();
  await watcher.promise;
});

test('invoked unknown queue is held without replay or a false presentation receipt', async t => {
  const f = await fixture(t); f.env.QUEUE_UNKNOWN = '1';
  await f.ledger.post({ owner: f.owner, key: 'unknown', text: 'uncertain native effect' });
  f.watch();
  await until(async () => (await f.ledger.health(f.owner)).unknownAttempts.length, 'unknown settlement');
  await f.hook('Stop');
  assert.deepEqual((await f.ledger.pending(f.owner, { generation: f.session.generation })).map(card => card.text), ['']);
  assert.equal((await f.ledger.post({ owner: f.owner, key: 'unknown', text: 'replacement' })).status, 'duplicate');
  assert.deepEqual(await f.ledger.receipts(f.owner), []);
  assert.equal((await f.calls()).length, 1);
});
