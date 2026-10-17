import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import squarePiExtension from '../plugins/pi/square-pi.js';
import { readSquareSnapshot, writeSquareFile, createArtifactPort, observeSquareRevision, readSquareRevision } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { hostLedgerForEnv } from '../dist/registry.js';
import { sessionInbox, observeSessionPending } from '../dist/inbox.js';
import { formatActivityId } from '../dist/square-core.js';
import { hasPresentedForOwner } from './presentation-fixtures.js';

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('a Pi batch hydrates the recipient projection once and reuses it at the boundary', { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-cache-'));
  const previous = process.env.SQUARE_HOST_LEDGER_ROOT;
  process.env.SQUARE_HOST_LEDGER_ROOT = root;
  const squarePath = path.join(root, 'SQUARE.square');
  const sessionId = 'pi-pending-cache';
  t.after(() => {
    if (previous === undefined) delete process.env.SQUARE_HOST_LEDGER_ROOT;
    else process.env.SQUARE_HOST_LEDGER_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await writeSquareFile(squarePath, {
    hardCap: null, preamble: [], warmup: [],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'join', actor: 'Bob', at: 2, index: 1 },
      { kind: 'say', actor: 'Alice', at: 3, index: 2, body: 'cached pending', mentions: ['Bob'] },
    ],
    runtime: emptyRuntimeState(3),
  });
  const env = { ...process.env };
  await hostLedgerForEnv(env).ensurePresence({ location: squarePath, participant: 'Bob', session: sessionId, channel: 'pi' });

  // The recipient projection of one inbox read. A revision read only touches square_meta.
  const canonicalArtifact = fs.realpathSync.native(squarePath);
  const hydrations = [];
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (typeof sql === 'string' && sql.includes('act_index IN (SELECT value FROM json_each')
      && fs.realpathSync.native(this.location()) === canonicalArtifact) hydrations.push(sql);
    return prepare.call(this, sql, ...args);
  });

  const handlers = new Map();
  const sent = [];
  squarePiExtension({
    registerTool() {},
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
    await waitUntil(() => sent.length === 1, 'Pi never delivered the mentioned activity');
    // The observer scan hydrated the projection; the boundary scan and the deferred arm reused it.
    assert.equal(hydrations.length, 1, 'one pending batch must hydrate the recipient projection once');

    // The read the boundary no longer makes: a fresh complete inbox read hydrates it again.
    hydrations.length = 0;
    await sessionInbox(sessionId, env);
    assert.equal(hydrations.length, 1, 'a fresh boundary inbox read hydrates the projection again');

    await handlers.get('message_end')({ message: { role: 'custom', customType: 'square', content: sent[0] } });
    await waitUntil(
      async () => await hasPresentedForOwner(sessionId, squarePath, 'Bob', 2),
      'Pi did not present the cached pending activity',
    );
    assert.equal((await readSquareSnapshot(squarePath)).state.runtime.observations.Bob[formatActivityId(2)].state, 'seen');
  } finally {
    await handlers.get('session_shutdown')({}, ctx);
  }
});


test('an explicit inbox read honors a new catch lease before filesystem hints arrive', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Hold both filesystem hints and their periodic reconciliation. The cached version
  // remains deliberately stale, while the actual database accepts a new lease.
  t.mock.method(fs, 'watch', () => ({ on() { return this; }, close() {} }));
  t.mock.method(globalThis, 'setInterval', () => undefined);
  const squarePath = path.join(root, 'SQUARE.square');
  await writeSquareFile(squarePath, {
    hardCap: null, preamble: [], warmup: [],
    acts: [
      { kind: 'join', actor: 'Alice', at: 1, index: 0 },
      { kind: 'join', actor: 'Bob', at: 2, index: 1 },
      { kind: 'say', actor: 'Alice', at: 3, index: 2, body: 'catch owns this', mentions: ['Bob'] },
    ],
    runtime: emptyRuntimeState(3),
  });
  const env = { ...process.env, SQUARE_HOST_LEDGER_ROOT: path.join(root, 'ledger') };
  await hostLedgerForEnv(env).ensurePresence({ location: squarePath, participant: 'Bob', session: 'fresh', channel: 'pi' });
  const observer = await observeSessionPending('fresh', env);
  const versionObserver = await observeSquareRevision(squarePath);
  const artifact = createArtifactPort(squarePath);
  try {
    assert.equal((await observer.wait(0))[0].notifications[0].actIndex, 2);
    const oldRevision = await versionObserver.read();
    await artifact.transact((facts) => facts.putLease('Bob', {
      leaseId: 'fresh-catch', heartbeatAt: Date.now(), expiresAt: Date.now() + 60_000, filter: { mention: 'Bob' },
    }));
    assert.equal(await versionObserver.read(), oldRevision, 'the version hint cache must still be stale');
    assert.ok(await readSquareRevision(squarePath) > oldRevision, 'the lease committed despite the delayed hint');
    assert.deepEqual(await observer.read(), [], 'a current boundary must yield to the newly committed catch lease');
    await artifact.transact((facts) => facts.removeLease('Bob', 'fresh-catch'));
    assert.equal((await observer.read())[0].notifications[0].actIndex, 2, 'a later current read sees release without a hint');
  } finally {
    observer.close(); versionObserver.close(); await artifact.close();
  }
});
