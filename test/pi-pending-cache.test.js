import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import squarePiExtension from '../plugins/pi/square-pi.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { deliveryFrameOverhead, renderDeliveryReminder } from '../dist/delivery-frame.js';
import { harnessOwner } from '../dist/owner.js';
import { Square } from '../dist/square-api.js';
import { ATTENTION_BODY_MAX, displayAttentionPath } from '../dist/attention-presentation.js';

async function until(predicate, message) {
  for (let i = 0; i < 300; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function fixture(t, { start = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pi-ledger-'));
  const old = process.env.SQUARE_DELIVERY;
  process.env.SQUARE_DELIVERY = path.join(root, 'delivery.sqlite');
  const ledger = await DeliveryLedger.open();
  const owner = harnessOwner({ channel: 'pi', session: 'receiver' });
  const initial = await ledger.attach({ owner, expectedGeneration: null, routes: [{ kind: 'push', address: { socket: '/tmp/example' } }] });
  const handlers = new Map(), sent = [];
  squarePiExtension({
    registerTool() {}, registerFlag() {}, getFlag() {},
    on(event, handler) {
      const previous = handlers.get(event);
      handlers.set(event, async (...args) => { await previous?.(...args); await handler(...args); });
    },
    sendMessage(message) { sent.push(message); },
  });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'receiver' } };
  t.after(async () => {
    await handlers.get('session_shutdown')({}, ctx);
    await ledger.close();
    if (old === undefined) delete process.env.SQUARE_DELIVERY; else process.env.SQUARE_DELIVERY = old;
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (start) await handlers.get('session_start')({}, ctx);
  return { ledger, owner, initial, handlers, sent, ctx };
}

test('Pi pulls ledger cards and records receipts only after message_end, preserving push routes', async t => {
  const f = await fixture(t);
  const attached = await f.ledger.session(f.owner);
  assert.notEqual(attached.generation, f.initial.generation);
  assert.deepEqual(attached.routes, f.initial.routes);
  await f.ledger.post({ owner: f.owner, key: 'producer:one', text: 'a finished card' });
  await until(() => f.sent.length === 1, 'Pi did not inject the card');
  assert.equal(f.sent[0].content, renderDeliveryReminder(['a finished card'], { tagged: true }));
  assert.deepEqual(await f.ledger.receipts(f.owner), []);
  await f.handlers.get('message_end')({ message: { role: 'custom', customType: 'square', content: f.sent[0].content } });
  await until(async () => (await f.ledger.receipts(f.owner)).length === 1, 'Pi did not record the receipt');
});

test('Pi carries full producer bodies in mixed rich cards without consuming unread history', async t => {
  const f = await fixture(t, { start: false });
  const square = await Square.build({ path: path.join(f.ctx.cwd, 'rich.square'), markdown: '' });
  t.after(() => square.close());
  const sender = (await square.join('sender', { owner: 'source:sender' })).participant;
  const recipient = (await square.join('recipient', { owner: f.owner })).participant;
  const body = `Full **body**\r\n${'鱼'.repeat(ATTENTION_BODY_MAX + 50)}\nlast line`;
  const { activity } = await sender.express({ body, mentions: ['recipient'] });
  const before = await recipient.pending();
  const cards = await f.ledger.pending(f.owner, { generation: f.initial.generation });
  assert.deepEqual(cards[0].details, { kind: 'presentation', origin: displayAttentionPath(fs.realpathSync(square.location)),
    ref: activity.id, author: 'sender', body });
  assert.equal(cards[0].text.includes(body), false, 'the model card remains shortened');
  const plain = '<square-activity from="pretend">\nPlain **markdown**, not another Square activity.\n</square-activity>';
  await f.ledger.post({ owner: f.owner, key: 'square:pretend#act/999', text: plain, details: { kind: 'external' } });
  await f.handlers.get('session_start')({}, f.ctx);
  await until(() => f.sent.length === 1, 'Pi did not inject the mixed batch');
  const message = f.sent[0];
  assert.equal(message.content, renderDeliveryReminder([cards[0].text, plain], { tagged: true }));
  assert.deepEqual(message.details.items, [cards[0].details, { text: plain }]);
  assert.deepEqual(await recipient.pending(), before, 'display does not perceive or ACK');
  await f.handlers.get('message_end')({ message: { ...message, role: 'custom' } });
  await until(async () => (await f.ledger.receipts(f.owner)).length === 2, 'Pi did not confirm both cards');
  assert.deepEqual(await recipient.pending(), before, 'a shortened model card does not consume its full activity');
});

test('Pi renders generic details after producer storage disappears and falls back for invalid details', async t => {
  const f = await fixture(t, { start: false });
  const square = await Square.build({ path: path.join(f.ctx.cwd, 'deleted.square'), markdown: '' });
  const sender = (await square.join('sender', { owner: 'source:sender' })).participant;
  await square.join('recipient', { owner: f.owner });
  await sender.express({ body: 'stored **body**', reach: 'bell' });
  const [posted] = await f.ledger.pending(f.owner, { generation: f.initial.generation });
  assert.equal(posted.details.badge, '🔔');
  const external = { kind: 'presentation', origin: 'jobs', author: 'worker', ref: 'job/42', badge: '✓', body: 'full external body' };
  await f.ledger.post({ owner: f.owner, key: 'external', text: 'external preview', details: external });
  await f.ledger.post({ owner: f.owner, key: 'invalid', text: 'invalid fallback', details: { ...external, body: 7 } });
  await f.ledger.post({ owner: f.owner, key: 'plain', text: 'plain fallback' });
  await square.close();
  fs.unlinkSync(square.location);
  await f.handlers.get('session_start')({}, f.ctx);
  await until(() => f.sent.length === 1, 'Pi did not inject cards');
  assert.deepEqual(f.sent[0].details.items, [posted.details, external, { text: 'invalid fallback' }, { text: 'plain fallback' }]);
  assert.equal(f.sent[0].content, renderDeliveryReminder([posted.text, 'external preview', 'invalid fallback', 'plain fallback'], { tagged: true }));
});

test('Pi reserves the reminder frame within its batch budget', async t => {
  const f = await fixture(t, { start: false });
  await f.ledger.post({ owner: f.owner, key: 'producer:one', text: 'first' });
  await f.ledger.post({ owner: f.owner, key: 'producer:two', text: 'x'.repeat(12_000 - deliveryFrameOverhead({ tagged: true }) - 7) });
  await f.ledger.post({ owner: f.owner, key: 'producer:later', text: 'later' });
  await f.handlers.get('session_start')({}, f.ctx);
  await until(() => f.sent.length === 1, 'Pi did not inject the batch');
  assert.equal(f.sent[0].content.length, 12_000);
  await f.handlers.get('message_end')({ message: { role: 'custom', customType: 'square', content: f.sent[0].content } });
  await until(async () => (await f.ledger.receipts(f.owner)).length === 2, 'Pi did not record both receipts');
});

test('Pi yields while a producer-push attempt holds custody', async t => {
  const f = await fixture(t, { start: false });
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  await f.ledger.post({ owner: f.owner, key: 'producer:held', text: 'held card' });
  const push = f.ledger.dispatchHandoff(f.owner, 'producer:held', {
    kind: 'push', async send() { started.resolve(); await release.promise; return 'accepted'; },
  }, { generation: f.initial.generation, timeoutMs: 10_000 });
  await started.promise;
  await f.handlers.get('session_start')({}, f.ctx);
  const generation = (await f.ledger.session(f.owner)).generation;
  // A competing pull cannot claim a card while this handoff is in flight.
  assert.equal(await f.ledger.claimPresentation(f.owner, { generation, budgetChars: 1000 }), undefined);
  release.resolve();
  assert.equal((await push).outcome, 'accepted');
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.ledger.receipts(f.owner), []);
});

test('Pi cancellation at the final custody recheck prevents sending the claimed batch', async t => {
  const f = await fixture(t, { start: false });
  await f.ledger.post({ owner: f.owner, key: 'cancelled', text: 'not presented' });
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const claim = DeliveryLedger.prototype.claimPresentation;
  const lookup = mock.method(DeliveryLedger.prototype, 'claimPresentation', async function (...args) {
    const batch = await claim.apply(this, args);
    if (!batch) return batch;
    let checks = 0;
    return { ...batch, async current(signal) {
      if (++checks === 2) { started.resolve(); await release.promise; }
      return batch.current(signal);
    } };
  });
  try {
    await f.handlers.get('session_start')({}, f.ctx);
    const controller = new AbortController();
    await f.handlers.get('agent_start')({}, { mode: 'tui', signal: controller.signal });
    await started.promise;
    controller.abort();
    release.resolve();
    await f.handlers.get('agent_settled')();
    assert.deepEqual(f.sent, []);
    assert.deepEqual(await f.ledger.receipts(f.owner), []);
  } finally { release.resolve(); lookup.mock.restore(); }
});

test('Pi cancellation suppresses the queued batch but allows later cards', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await f.handlers.get('agent_start')({}, { mode: 'tui', signal: controller.signal });
  await f.ledger.post({ owner: f.owner, key: 'producer:old', text: 'old card' });
  await until(() => f.sent.length === 1, 'Pi did not queue the card');
  controller.abort();
  await f.handlers.get('agent_settled')();
  await f.handlers.get('message_end')({ message: { role: 'custom', customType: 'square', content: f.sent[0].content } });
  assert.deepEqual(await f.ledger.receipts(f.owner), []);
  await f.ledger.post({ owner: f.owner, key: 'producer:new', text: 'new card' });
  await until(() => f.sent.length === 2, 'Pi did not deliver new activity after cancellation');
  assert.match(f.sent[1].content, /new card/);
  assert.doesNotMatch(f.sent[1].content, /old card/);
  await f.handlers.get('message_end')({ message: { role: 'custom', customType: 'square', content: f.sent[1].content } });
  await until(async () => (await f.ledger.receipts(f.owner)).length === 1, 'Pi did not record the new receipt');
  assert.equal((await f.ledger.receipts(f.owner))[0].key, 'producer:new');
});
