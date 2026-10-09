import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import squarePiExtension from '../extensions/square-pi.js';
import { emptyRuntimeState, loadSquare, writeSquareFile } from '../dist/artifact.js';
import { recordJoin } from '../dist/registry.js';
import { hasPresentedForOwner } from './presentation-fixtures.js';
import { formatActivityId } from '../dist/square-core.js';

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

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
  await recordJoin(sessionId, 'Bob', squarePath, { channel: 'pi', ownerId: 'pi-owner' });

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
