import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import plugin from '../dist/opencode.js';
import { Square } from '../dist/square-wiring.js';
import { loadSquare } from '../dist/artifact.js';
import { claimSessionTakeover, hostLedgerForEnv } from '../dist/registry.js';

async function waitFor(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('OpenCode receiver did not settle the expected boundary');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-opencode-v2-'));
  const original = process.env.SQUARE_HOST_LEDGER_ROOT;
  process.env.SQUARE_HOST_LEDGER_ROOT = path.join(root, 'ledger');
  const env = { ...process.env, OPENCODE_SESSION_ID: 'opencode-fixture', PI_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' };
  const squarePath = path.join(root, 'S.square');
  const square = await Square.build({ path: squarePath, env, markdown: 'fixture', hardCap: null });
  await square.join('Bob');
  const aliceSquare = await Square.at({ path: squarePath, env: { ...env, OPENCODE_SESSION_ID: '' } });
  const alice = await aliceSquare.join('Alice');
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
    seen: async (index) => (await loadSquare(squarePath)).runtime.observations.Bob?.[`act/${index}`]?.state,
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
  await f.context(f.sent[1]);
  assert.equal(await f.seen(clipped), undefined);
  assert.equal((await f.evidence()).filter((row) => row.activity === `act/${clipped}` && row.outcome === 'clipped').length, 1);
  await f.reload();
  assert.equal(f.sent.length, 2);
});

test('local cancellation and binding replacement fence late native context, while new activity survives', async (t) => {
  const f = await fixture(t);
  const old = await f.express('cancel this BODY');
  await waitFor(() => f.sent.length === 1);
  f.events.emit('event', { type: 'session.execution.interrupted', data: { sessionID: 'opencode-fixture', reason: 'user' } });
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
  assert.equal((await loadSquare(f.squarePath)).acts.at(-1).kind, 'done');
});

test('moving out stops native delivery without ending membership; deletion retires even without a receiver', async (t) => {
  const f = await fixture(t);
  await f.hooks.get('prompt')({ sessionID: 'opencode-fixture' });
  await f.moveAway();
  assert.equal((await f.ledger.listPresence({ session: 'opencode-fixture' })).length, 1);
  assert.notEqual((await loadSquare(f.squarePath)).acts.at(-1).kind, 'done');
  f.events.emit('event', { type: 'session.deleted', data: { sessionID: 'opencode-fixture' } });
  await waitFor(async () => (await f.ledger.listPresence({ session: 'opencode-fixture' })).length === 0);
  assert.equal((await loadSquare(f.squarePath)).acts.at(-1).kind, 'done');
});
