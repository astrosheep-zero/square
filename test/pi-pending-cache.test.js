import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import squarePiExtension from '../plugins/pi/square-pi.js';
import { createArtifactPort, observeSquareRevision, readSquareRevision } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
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

async function pendingFixture(root, sessionId) {
  const squarePath = path.join(root, 'SQUARE.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const authorBody = { channel: 'pi', session: `${sessionId}-author` };
  const recipientBody = { channel: 'pi', session: sessionId };
  const author = await Square.build({ path: squarePath, markdown: 'pending-cache', env, body: authorBody, participant: 'Alice' });
  try { await author.join('Alice'); }
  finally { await author.close(); }
  const recipient = await Square.at({ path: squarePath, env, body: recipientBody, participant: 'Bob' });
  try { await recipient.join('Bob'); }
  finally { await recipient.close(); }
  const speaker = await Square.at({ path: squarePath, env, body: authorBody, participant: 'Alice' });
  try { await (await speaker.participant()).express('cached pending', { force: true, mentions: ['Bob'] }); }
  finally { await speaker.close(); }
  return { squarePath, env, authorBody, recipientBody, sessionId };
}

function isolatePiIndex(t, indexPath) {
  const previous = process.env.SQUARE_INDEX;
  process.env.SQUARE_INDEX = indexPath;
  t.after(() => {
    if (previous === undefined) delete process.env.SQUARE_INDEX;
    else process.env.SQUARE_INDEX = previous;
  });
}

test('a Pi batch hydrates the recipient projection once and reuses it at the boundary', { timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = 'pi-pending-cache';
  const fixture = await pendingFixture(root, sessionId);
  isolatePiIndex(t, fixture.env.SQUARE_INDEX);

  // Count the artifact's bounded notification projection, not any host-side authority read.
  const canonicalArtifact = fs.realpathSync.native(fixture.squarePath);
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
    assert.equal(hydrations.length, 1, 'one pending batch must hydrate the recipient projection once');

    // A fresh public inbox read hydrates again; the boundary itself reuses the observed batch.
    hydrations.length = 0;
    await sessionInbox(fixture.recipientBody, fixture.env);
    assert.equal(hydrations.length, 1, 'a fresh inbox read hydrates the projection again');

    await handlers.get('message_end')({ message: { role: 'custom', customType: 'square', content: sent[0] } });
    await waitUntil(
      async () => await hasPresentedForOwner(sessionId, fixture.squarePath, 'Bob', 2),
      'Pi did not present the cached pending activity',
    );
    const artifact = createArtifactPort(fixture.squarePath);
    try {
      assert.deepEqual((await artifact.read(facts => facts.deliveryEvidence('Bob', 'act/1', formatActivityId(2)))).value
        .filter(row => row.kind === 'presentation').map(row => row.outcome), ['presented']);
    } finally { await artifact.close(); }
  } finally {
    await handlers.get('session_shutdown')({}, ctx);
  }
});


test('an explicit inbox read honors a new catch lease before filesystem hints arrive', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Hold filesystem hints and periodic reconciliation; the artifact seat and lease remain authoritative.
  t.mock.method(fs, 'watch', () => ({ on() { return this; }, close() {} }));
  t.mock.method(globalThis, 'setInterval', () => undefined);
  const fixture = await pendingFixture(root, 'fresh');
  const observer = await observeSessionPending(fixture.recipientBody, fixture.env);
  const versionObserver = await observeSquareRevision(fixture.squarePath);
  const artifact = createArtifactPort(fixture.squarePath);
  try {
    assert.equal((await observer.wait(0))[0].notifications[0].actIndex, 2);
    const oldRevision = await versionObserver.read();
    const seat = (await artifact.read(facts => facts.seat('Bob'))).value;
    const ref = { participant: seat.participant, body: seat.body, generation: seat.generation };
    await artifact.transactAs({ kind: 'participant', seat: ref }, facts => facts.putLease('Bob', {
      leaseId: 'fresh-catch', heartbeatAt: Date.now(), expiresAt: Date.now() + 60_000, filter: { mention: 'Bob' },
    }, seat.generation));
    assert.equal(await versionObserver.read(), oldRevision, 'the filesystem revision hint must remain stale');
    assert.ok(await readSquareRevision(fixture.squarePath) > oldRevision, 'the lease committed despite the delayed hint');
    assert.deepEqual(await observer.read(), [], 'a current boundary must yield to the newly committed catch lease');
    await artifact.transactAs({ kind: 'participant', seat: ref }, facts => facts.removeLease('Bob', 'fresh-catch', seat.generation));
    assert.equal((await observer.read())[0].notifications[0].actIndex, 2, 'a later current read sees release without a hint');
  } finally {
    observer.close(); versionObserver.close(); await artifact.close();
  }
});
