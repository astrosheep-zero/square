import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import plugin from '../dist/plugins/opencode/index.js';
import { Square } from '../dist/square-api.js';
import { readSquareSnapshot } from '../dist/artifact.js';
import { claimSessionTakeover, hostLedgerForEnv } from '../dist/registry.js';
import { interceptLedgerSql, ledgerDatabasePath } from './host-ledger-fixtures.js';
import { renderPendingAtBoundary } from '../dist/boundary-presentation.js';
import { sessionInbox } from '../dist/inbox.js';

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('OpenCode receiver did not settle the expected boundary');
}
async function fixture(t, beforeSetup) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-opencode-v2-'));
  const original = process.env.SQUARE_HOST_LEDGER_ROOT;
  process.env.SQUARE_HOST_LEDGER_ROOT = path.join(root, 'ledger');
  const env = { ...process.env, OPENCODE_SESSION_ID: 'opencode-fixture', PI_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' };
  const squarePath = path.join(root, 'S.square');
  const square = await Square.build({ path: squarePath, env, markdown: 'fixture', hardCap: null });
  await square.join('Bob');
  const aliceSquare = await Square.at({ path: squarePath, env: { ...env, OPENCODE_SESSION_ID: '' } });
  const alice = (await aliceSquare.join('Alice')).participant;
  const ledger = hostLedgerForEnv(env);
  const hooks = new Map();
  const events = new EventEmitter();
  // A real OpenCode event stream buffers; the plugin awaits each event's handler before pulling the
  // next one, so events emitted in that window must be retained instead of dropped by an unlistening
  // emitter. Emit-time queueing keeps delivery ordered and lossless under load.
  const queue = [];
  let wake = null;
  events.on('event', (event) => {
    queue.push(event);
    wake?.();
    wake = null;
  });
  const sent = [];
  let failure = false;
  let nativeDirectory = root;
  const ctx = {
    app: { version: '2.0.20' }, location: { directory: root, project: { id: 'project-fixture' } },
    session: {
      async hook(name, callback) { hooks.set(name, callback); },
      async get({ sessionID }) { return { id: sessionID, projectID: 'project-fixture', location: { directory: nativeDirectory } }; },
      async prompt(input) {
        sent.push(input);
        if (failure) throw new Error('ordinary native provider failure');
        return { id: input.id, sessionID: input.sessionID, type: 'user', delivery: input.delivery, payload: { text: input.text }, time: { created: Date.now() } };
      },
    },
    event: {
      async *subscribe({ signal }) {
        while (!signal.aborted) {
          if (queue.length) { yield queue.shift(); continue; }
          await new Promise((resolve) => {
            const ready = () => { signal.removeEventListener('abort', ready); resolve(); };
            wake = ready;
            signal.addEventListener('abort', ready, { once: true });
          });
        }
      },
    },
  };
  await beforeSetup?.();
  let cleanup = await plugin.setup(ctx);
  t.after(async () => {
    await cleanup();
    await square.close();
    await aliceSquare.close();
    if (original === undefined) delete process.env.SQUARE_HOST_LEDGER_ROOT;
    else process.env.SQUARE_HOST_LEDGER_ROOT = original;
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    squarePath, env, ledger, hooks, sent, events, square,
    express: async (body) => Number((await alice.express(body, { mentions: ['Bob'] })).activity.id.slice(4)),
    evidence: () => ledger.listEvidence({ session: 'opencode-fixture' }),
    seen: async (index) => (await readSquareSnapshot(squarePath)).state.runtime.observations.Bob?.[`act/${index}`]?.state,
    context: async (input, overrides = {}) => hooks.get('context')({ sessionID: input.sessionID, messages: [{ id: input.id, role: 'user', content: [{ type: 'text', text: input.text }], ...overrides }] }),
    reload: async () => { await cleanup(); cleanup = await plugin.setup(ctx); await hooks.get('prompt')({ sessionID: 'opencode-fixture' }); },
    fail: () => { failure = true; },
    moveAway: async () => {
      nativeDirectory = path.join(root, 'other-location');
      events.emit('event', { type: 'session.moved', data: { sessionID: 'opencode-fixture' } });
      await hooks.get('prompt')({ sessionID: 'opencode-fixture' });
    },
  };
}

test('v2 native body admission is not presentation; exact prepared primary context is full/clipped and idempotent', async (t) => {
  const f = await fixture(t);
  const index = await f.express('BODY for Bob');
  await waitFor(() => f.sent.length === 1);
  assert.deepEqual([...f.hooks.keys()].sort(), ['context', 'prompt']);
  assert.equal(f.sent[0].sessionID, 'opencode-fixture');
  assert.equal(f.sent[0].delivery, 'steer');
  assert.equal(f.sent[0].resume, true);
  assert.match(f.sent[0].text, /BODY for Bob/);
  assert.equal(f.sent[0].text, renderPendingAtBoundary(await sessionInbox('opencode-fixture', f.env)));
  await waitFor(async () => (await f.evidence()).some((row) => row.activity === `act/${index}` && row.outcome === 'accepted'));
  assert.equal(await f.seen(index), undefined);
  await f.context(f.sent[0], { id: 'msg_wrong' });
  await f.context(f.sent[0], { role: 'assistant' });
  await f.context(f.sent[0], { content: [{ type: 'text', text: `${f.sent[0].text} changed` }] });
  assert.equal(await f.seen(index), undefined);
  await f.context(f.sent[0]);
  await f.context(f.sent[0]);
  assert.equal(await f.seen(index), 'seen');
  assert.equal((await f.evidence()).filter((row) => row.activity === `act/${index}` && row.kind === 'presentation').length, 1);
  const clipped = await f.express('x'.repeat(300));
  await waitFor(() => f.sent.length === 2);
  assert.equal(f.sent[1].text, renderPendingAtBoundary(await sessionInbox('opencode-fixture', f.env)));
  await f.context(f.sent[1]);
  assert.equal(await f.seen(clipped), undefined);
  assert.equal((await f.evidence()).filter((row) => row.activity === `act/${clipped}` && row.outcome === 'clipped').length, 1);
  await f.reload();
  assert.equal(f.sent.length, 2);
});

test('a transient receiver ledger failure recovers on reconciliation without plugin reload', async (t) => {
  let failures = 0;
  const f = await fixture(t, async () => {
    interceptLedgerSql(t, process.env.SQUARE_HOST_LEDGER_ROOT, () => {
      if (failures === 0) {
        failures += 1;
        throw Object.assign(new Error('one-shot evidence read failure'), { code: 'EIO' });
      }
      return undefined;
    });
  });
  await waitFor(() => failures === 1);
  assert.equal(f.sent.length, 0);
  await f.hooks.get('prompt')({ sessionID: 'opencode-fixture' });
  const index = await f.express('fresh BODY after receiver failure');
  await waitFor(async () => (await f.evidence()).some((row) => row.activity === `act/${index}` && row.outcome === 'accepted'));
  await f.hooks.get('prompt')({ sessionID: 'opencode-fixture' });
  assert.equal(failures, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /fresh BODY after receiver failure/);
});

test('queued cancellation survives receiver settlement and binding replacement fences late native context', async (t) => {
  const f = await fixture(t);
  const old = await f.express('cancel this BODY');
  await waitFor(async () => (await f.evidence()).some((row) => row.activity === `act/${old}` && row.outcome === 'accepted'));
  // A real SQLite write lock stalls reconciliation inside its own busy retry; a
  // synchronous SQL mock cannot block, only fail. Observe the retry reaching
  // storage instead of guessing with sleeps.
  const lock = new DatabaseSync(ledgerDatabasePath(process.env.SQUARE_HOST_LEDGER_ROOT));
  t.after(() => { try { lock.close(); } catch { /* already closed by normal cleanup */ } });
  lock.exec('PRAGMA busy_timeout=0');
  for (let attempt = 0; ; attempt += 1) {
    try { lock.exec('BEGIN EXCLUSIVE'); break; }
    catch (error) { if (attempt >= 100) throw error; await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  let reachedStorage = false;
  let refusedRead = false;
  interceptLedgerSql(t, process.env.SQUARE_HOST_LEDGER_ROOT, (method, sql) => {
    const text = sql ?? '';
    if (method === 'exec' && /PRAGMA synchronous=FULL/.test(text)) reachedStorage = true;
    if (!refusedRead && /SELECT seq,row_json FROM host_presence/.test(text)) {
      refusedRead = true;
      throw Object.assign(new Error('one-shot presence read failure'), { code: 'EIO' });
    }
    return undefined;
  });
  let preparation;
  try {
    preparation = f.hooks.get('prompt')({ sessionID: 'opencode-fixture' });
    preparation.catch(() => {});
    await waitFor(() => reachedStorage);
    f.events.emit('event', { type: 'session.execution.interrupted', data: { sessionID: 'opencode-fixture', reason: 'user' } });
    // Let the aborted receiver settle while cancellation is queued behind the blocked reconciliation.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
  }
  await preparation;
  assert.equal(refusedRead, true, 'the queued reconciliation must meet the injected read failure');
  await waitFor(async () => (await f.ledger.listPresence({ session: 'opencode-fixture' })).some((owner) => owner.cancelledThrough >= old));
  await f.reload();
  await f.context(f.sent[0]);
  assert.equal(await f.seen(old), undefined);
  const fresh = await f.express('fresh BODY');
  await waitFor(() => f.sent.length === 2);
  await claimSessionTakeover(f.squarePath, 'Bob', f.ledger, f.env, {}, async () => undefined);
  await f.context(f.sent[1]);
  assert.equal(await f.seen(fresh), undefined);
  assert.equal(f.sent.length, 2);
});

test('uncertain native call is not replayed after reload and deletion retires all current memberships', async (t) => {
  const f = await fixture(t);
  f.fail();
  const index = await f.express('ordinary failure BODY');
  await waitFor(async () => (await f.evidence()).some((row) => row.activity === `act/${index}` && row.outcome === 'unknown'));
  assert.equal(await f.seen(index), undefined);
  await f.reload();
  assert.equal(f.sent.length, 1);
  f.events.emit('event', { type: 'session.deleted', data: { sessionID: 'opencode-fixture' } });
  await waitFor(async () => (await f.ledger.listPresence({ session: 'opencode-fixture' })).length === 0);
  assert.equal((await readSquareSnapshot(f.squarePath)).state.acts.at(-1).kind, 'done');
});

test('moving out stops native delivery without ending membership; deletion retires even without a receiver', async (t) => {
  const f = await fixture(t);
  await f.hooks.get('prompt')({ sessionID: 'opencode-fixture' });
  await f.moveAway();
  assert.equal((await f.ledger.listPresence({ session: 'opencode-fixture' })).length, 1);
  assert.notEqual((await readSquareSnapshot(f.squarePath)).state.acts.at(-1).kind, 'done');
  f.events.emit('event', { type: 'session.deleted', data: { sessionID: 'opencode-fixture' } });
  await waitFor(async () => (await f.ledger.listPresence({ session: 'opencode-fixture' })).length === 0);
  assert.equal((await readSquareSnapshot(f.squarePath)).state.acts.at(-1).kind, 'done');
});
