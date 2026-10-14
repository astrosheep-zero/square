import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import squarePiExtension from '../plugins/pi/square-pi.js';
import { emptyRuntimeState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { hostLedgerForEnv } from '../dist/registry.js';
import { hasPresentedForOwner } from './presentation-fixtures.js';
import { formatActivityId } from '../dist/square-core.js';

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('Pi lifecycle awaits watcher retirement after cancellation and replacement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-retire-'));
  const previous = process.env.SQUARE_HOST_LEDGER_ROOT;
  process.env.SQUARE_HOST_LEDGER_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.SQUARE_HOST_LEDGER_ROOT;
    else process.env.SQUARE_HOST_LEDGER_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  let opened = 0;
  let closed = 0;
  t.mock.method(fs, 'watch', () => {
    opened++;
    const watcher = new EventEmitter();
    watcher.close = () => { closed++; };
    return watcher;
  });
  const handlers = new Map();
  squarePiExtension({
    registerFlag() {}, getFlag() {}, sendMessage() {},
    on(event, handler) {
      const prior = handlers.get(event);
      handlers.set(event, async (...args) => { await prior?.(...args); await handler(...args); });
    },
  });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'retirement-test' } };
  t.after(() => handlers.get('session_shutdown')({}, ctx));
  await handlers.get('session_start')({}, ctx);
  await waitUntil(() => opened > 0, 'watcher not created');
  const first = opened;
  const run = new AbortController();
  await handlers.get('agent_start')({}, { ...ctx, mode: 'tui', signal: run.signal });
  run.abort();
  await handlers.get('agent_settled')();
  assert.equal(closed, first);
  await waitUntil(() => opened > first, 'watcher not restarted');
  const restarted = opened;
  await handlers.get('session_start')({}, ctx);
  assert.equal(closed, restarted);
  await waitUntil(() => opened > restarted, 'replacement watcher not created');
  await handlers.get('session_shutdown')({}, ctx);
  assert.equal(closed, opened, 'shutdown returned with owned watchers still open');

  let releaseStartup;
  const startup = new Promise((resolve) => { releaseStartup = resolve; });
  const access = fs.promises.access.bind(fs.promises);
  t.mock.method(fs.promises, 'access', async (...args) => {
    await startup;
    return access(...args);
  });
  await handlers.get('session_start')({}, ctx);
  let ended = false;
  const shutdown = handlers.get('session_shutdown')({}, ctx).then(() => { ended = true; });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ended, false, 'shutdown overtook in-flight automatic session startup');
  } finally {
    releaseStartup();
    await shutdown;
  }
  assert.equal(closed, opened);
});

test('a retiring watcher cannot suppress an unsent notification in its replacement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-replace-'));
  const previous = process.env.SQUARE_HOST_LEDGER_ROOT;
  process.env.SQUARE_HOST_LEDGER_ROOT = root;
  const squarePath = path.join(root, 'SQUARE.square');
  const sessionId = 'pi-replacement-race';
  await writeSquareFile(squarePath, {
    hardCap: null, preamble: [], warmup: [],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'join', actor: 'Bob', at: 2, index: 1 },
      { kind: 'say', actor: 'Alice', at: 3, index: 2, body: 'original pending', mentions: ['Bob'] },
    ],
    runtime: emptyRuntimeState(3),
  });
  await hostLedgerForEnv().ensurePresence({ location: squarePath, participant: 'Bob', session: sessionId, channel: 'pi' });
  let enter;
  let release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let presenting = false;
  let blocked = false;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (...args) {
    const result = exec.apply(this, args);
    if (path.basename(this.location()).startsWith('presentation-boundary-')) presenting = true;
    return result;
  });
  const readFile = fs.promises.readFile.bind(fs.promises);
  t.mock.method(fs.promises, 'readFile', async (...args) => {
    if (presenting && !blocked && path.basename(String(args[0])) === 'presence.ndjsonl') {
      blocked = true;
      enter();
      await gate;
    }
    return readFile(...args);
  });
  const handlers = new Map();
  const sent = [];
  squarePiExtension({
    registerFlag() {}, getFlag() {},
    on(event, handler) {
      const prior = handlers.get(event);
      handlers.set(event, async (...args) => { await prior?.(...args); await handler(...args); });
    },
    sendMessage(message) { sent.push(message.content); },
  });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => sessionId } };
  try {
    await handlers.get('session_start')({}, ctx);
    await entered;
    const replacement = handlers.get('session_start')({}, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 0);
    release();
    await replacement;
    await waitUntil(() => sent.length > 0, 'replacement suppressed an unsent original notification');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /original pending/);
  } finally {
    release();
    await handlers.get('session_shutdown')({}, ctx);
    if (previous === undefined) delete process.env.SQUARE_HOST_LEDGER_ROOT;
    else process.env.SQUARE_HOST_LEDGER_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Pi watcher survives an unreadable bound artifact without changing it', { timeout: 5_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-failure-'));
  const squarePath = path.join(root, 'SQUARE.square');
  const registry = path.join(root, 'sessions.ndjsonl');
  const presented = path.join(root, 'presented.ndjsonl');
  const sessionId = 'pi-unreadable-session';
  const previous = {
    registry: process.env.SQUARE_REGISTRY,
    presented: process.env.SQUARE_PRESENTED,
    piSession: process.env.PI_SESSION_ID,
  };
  const runtime = { ...emptyRuntimeState(3), nextActIndex: 3 };
  await writeSquareFile(squarePath, {
    hardCap: null,
    preamble: [],
    warmup: ['test'],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'join', actor: 'Bob', at: 2, index: 1 },
      { kind: 'say', actor: 'Alice', at: 3, body: 'recover after unreadable @Bob', mentions: ['Bob'], index: 2 },
    ],
    runtime,
  });
  process.env.SQUARE_REGISTRY = registry;
  process.env.SQUARE_PRESENTED = presented;
  delete process.env.PI_SESSION_ID;
  await hostLedgerForEnv().ensurePresence({ location: squarePath, participant: 'Bob', session: sessionId, channel: 'pi' });

  const original = fs.readFileSync(squarePath);
  const before = (await loadSquare(squarePath)).runtime.observations;
  const handlers = new Map();
  const sent = [];
  const pi = {
    registerFlag() {},
    getFlag() { return undefined; },
    on(event, handler) {
      const previous = handlers.get(event);
      handlers.set(event, async (...args) => { await previous?.(...args); await handler(...args); });
    },
    sendMessage(message, options) { sent.push({ message, options }); },
  };
  squarePiExtension(pi);
  const context = { sessionManager: { getSessionId: () => sessionId }, cwd: '/tmp/no-public-square' };

  // chmod cannot deny reads on Windows (or when tests run as root). Inject the
  // actual failed read instead, then explicitly signal the repaired artifact.
  const canonicalArtifact = fs.realpathSync.native(squarePath);
  const canonicalRoot = fs.realpathSync.native(root);
  let repairHint;
  const watch = fs.watch;
  t.mock.method(fs, 'watch', (directory, listener) => {
    if (fs.realpathSync.native(directory) === canonicalRoot) repairHint = listener;
    return watch(directory, listener);
  });
  let observedUnreadable;
  const unreadable = new Promise((resolve) => { observedUnreadable = resolve; });
  const prepare = DatabaseSync.prototype.prepare;
  const readFault = t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
    if (fs.realpathSync.native(this.location()) === canonicalArtifact) {
      observedUnreadable();
      throw Object.assign(new Error('artifact read denied'), { code: 'EACCES' });
    }
    return prepare.apply(this, args);
  });

  try {
    await handlers.get('session_start')({}, context);
    await unreadable;
    assert.equal(sent.length, 0);

    readFault.mock.restore();
    assert.deepEqual(fs.readFileSync(squarePath), original);
    assert.deepEqual((await loadSquare(squarePath)).runtime.observations, before);
    assert.equal(fs.existsSync(presented), false);

    assert.equal(typeof repairHint, 'function');
    repairHint('change', path.basename(squarePath));

    await waitUntil(() => sent.length === 1, 'Pi did not recover after the artifact became readable');
    await handlers.get('message_end')({
      message: { role: 'custom', customType: 'square', content: sent[0].message.content },
    });
    await waitUntil(
      async () => await hasPresentedForOwner(sessionId, squarePath, 'Bob', 2),
      'Pi did not present after recovering from the unreadable artifact',
    );
    assert.equal((await loadSquare(squarePath)).runtime.observations.Bob[formatActivityId(2)].state, 'seen');
  } finally {
    readFault.mock.restore();
    await handlers.get('session_shutdown')({}, context);
    if (previous.registry === undefined) delete process.env.SQUARE_REGISTRY;
    else process.env.SQUARE_REGISTRY = previous.registry;
    if (previous.presented === undefined) delete process.env.SQUARE_PRESENTED;
    else process.env.SQUARE_PRESENTED = previous.presented;
    if (previous.piSession === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previous.piSession;
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
});
