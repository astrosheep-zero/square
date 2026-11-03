import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { harnessOwner } from '../dist/owner.js';
import { observeOpenCodeContext, receiveOpenCodePending } from '../dist/plugins/opencode-shared/delivery.js';
import plugin, { createOpenCodeWakeTransport } from '../dist/plugins/opencode/index.js';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-ledger-'));
  const env = { SQUARE_DELIVERY: path.join(root, 'delivery.sqlite') };
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(async () => { await ledger.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = harnessOwner({ channel: 'opencode', session: 'ses_test' });
  const session = await ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'opencode-server', address: { sessionId: 'ses_test' } }] });
  return { ledger, owner, generation: session.generation, env };
}
const hash = text => createHash('sha256').update(text).digest('hex');
const context = text => [{ id: 'native-message', role: 'user', content: [{ type: 'text', text }] }];
const transport = send => ({ kind: 'opencode-server', send });

test('v2 records the native input identity before confirmed native acceptance', async () => {
  let sent, correlation;
  const target = { sessionId: 'ses_test', session: { prompt: async input => {
    sent = input;
    return { id: input.id, sessionID: input.sessionID, type: 'user', delivery: input.delivery, payload: { text: input.text }, time: { created: Date.now() } };
  } } };
  const adapter = createOpenCodeWakeTransport(target, new AbortController().signal);
  const outcome = await adapter.send({ text: 'hello' }, { sessionId: 'ses_test' }, {
    token: 'handoff', deadline: Date.now() + 1000, signal: new AbortController().signal,
    prepare: async value => { correlation = value; return true; }, beforeSend: async () => true,
  });
  assert.equal(outcome, 'accepted');
  assert.equal(correlation.token, 'handoff');
  assert.equal(correlation.messageId, sent.id);
  assert.equal(correlation.payloadHash, hash(sent.text));
});

test('exact context hash confirms the current handoff, never a changed message or canceled card', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: 'first', text: 'hello' });
  const result = await f.ledger.dispatchHandoff(f.owner, 'first', transport(async (card, _address, c) => {
    assert.ok(await c.prepare({ token: c.token, messageId: 'native-message', payloadHash: hash(card.text) }));
    return 'accepted';
  }), { generation: f.generation, timeoutMs: 1000 });
  assert.equal(result.outcome, 'accepted');
  const signal = new AbortController().signal;
  await observeOpenCodeContext('ses_test', f.generation, context('tampered'), f.env, signal);
  assert.deepEqual(await f.ledger.receipts(f.owner), []);
  await observeOpenCodeContext('ses_test', f.generation, context('hello'), f.env, signal);
  assert.equal((await f.ledger.receipts(f.owner)).length, 1);

  await f.ledger.post({ owner: f.owner, key: 'second', text: 'later' });
  await f.ledger.dispatchHandoff(f.owner, 'second', transport(async (card, _address, c) => {
    await c.prepare({ token: c.token, messageId: 'native-message', payloadHash: hash(card.text) });
    return 'accepted';
  }), { generation: f.generation, timeoutMs: 1000 });
  await f.ledger.cancel({ owner: f.owner, generation: f.generation });
  await observeOpenCodeContext('ses_test', f.generation, context('later'), f.env, signal);
  assert.equal((await f.ledger.receipts(f.owner)).length, 1);

  await f.ledger.post({ owner: f.owner, key: 'third', text: 'stale' });
  await f.ledger.dispatchHandoff(f.owner, 'third', transport(async (card, _address, c) => {
    await c.prepare({ token: c.token, messageId: 'native-message', payloadHash: hash(card.text) });
    return 'accepted';
  }), { generation: f.generation, timeoutMs: 1000 });
  await f.ledger.attach({ owner: f.owner, expectedGeneration: f.generation, routes: [{ kind: 'opencode-server', address: { sessionId: 'ses_test' } }] });
  await observeOpenCodeContext('ses_test', f.generation, context('stale'), f.env, signal);
  assert.equal((await f.ledger.receipts(f.owner)).length, 1);
});

test('interrupt cancels the captured generation without suppressing later cards', async t => {
  const f = await fixture(t);
  const previous = process.env.SQUARE_DELIVERY;
  process.env.SQUARE_DELIVERY = f.env.SQUARE_DELIVERY;
  const hooks = {}, queue = [];
  let wake;
  const calls = [];
  const events = { push(event) { queue.push(event); wake?.(); } };
  const stop = await plugin.setup({ app: { version: '2.0.0' }, location: { directory: os.tmpdir(), project: { id: 'project' } },
    session: {
      hook: async (name, callback) => { hooks[name] = callback; },
      get: async ({ sessionID }) => ({ id: sessionID, projectID: 'project', location: { directory: os.tmpdir() } }),
      prompt: async input => { calls.push(input); return { id: input.id, sessionID: input.sessionID, type: 'user', delivery: input.delivery, payload: { text: input.text }, time: { created: Date.now() } }; },
    }, event: { async *subscribe({ signal }) {
      while (!signal.aborted) {
        if (!queue.length) await new Promise(resolve => { wake = resolve; signal.addEventListener('abort', resolve, { once: true }); });
        wake = undefined;
        while (queue.length) yield queue.shift();
      }
    } },
  });
  try {
  const until = async predicate => {
    const deadline = Date.now() + 5000;
    while (!await predicate()) { if (Date.now() >= deadline) throw Error(`timed out waiting for receiver; calls=${calls.length}; session=${JSON.stringify(await f.ledger.session(f.owner))}`); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  await hooks.prompt({ sessionID: 'ses_test' });
  const before = (await f.ledger.session(f.owner)).generation;
  await f.ledger.post({ owner: f.owner, key: 'first', text: 'first' });
  await until(() => calls.length === 1);
  events.push({ type: 'session.execution.interrupted', data: { sessionID: 'ses_test', reason: 'user' } });
  await until(async () => (await f.ledger.session(f.owner)).generation !== before);
  const after = (await f.ledger.session(f.owner)).generation;
  assert.deepEqual(await f.ledger.pending(f.owner, { generation: after }), []);
  await f.ledger.post({ owner: f.owner, key: 'second', text: 'second' });
  await until(() => calls.length === 2);
  await f.ledger.attach({ owner: f.owner, expectedGeneration: after, routes: [{ kind: 'opencode-server', address: { sessionId: 'ses_test' } }] });
  events.push({ type: 'session.execution.interrupted', data: { sessionID: 'ses_test', reason: 'user' } });
  await new Promise(resolve => setTimeout(resolve, 100));
  await hooks.prompt({ sessionID: 'ses_test' });
  await f.ledger.post({ owner: f.owner, key: 'third', text: 'third' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.length, 2, 'a lost cancellation fence must not restart the watcher');
  } finally {
    await stop();
    if (previous === undefined) delete process.env.SQUARE_DELIVERY; else process.env.SQUARE_DELIVERY = previous;
  }
});

test('watcher pulls ledger cards and competing presentation custody prevents duplicate handoff', async t => {
  const f = await fixture(t);
  await f.ledger.post({ owner: f.owner, key: 'held', text: 'held' });
  const claim = await f.ledger.claimPresentation(f.owner, { generation: f.generation, budgetChars: 1000 });
  await f.ledger.post({ owner: f.owner, key: 'free', text: 'free' });
  const abort = new AbortController();
  const sent = [];
  let resolve;
  const landed = new Promise(done => { resolve = done; });
  const running = receiveOpenCodePending('ses_test', f.generation, transport(async card => {
    sent.push(card.key); resolve(); return 'accepted';
  }), f.env, abort.signal);
  let timer;
  try { await Promise.race([landed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('watcher timed out')), 5000); })]); }
  finally { clearTimeout(timer); abort.abort(); await running; }
  assert.deepEqual(sent, ['free']);
  await claim.settle('released');
});
