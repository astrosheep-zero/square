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

test('Pi restores full producer bodies in mixed rich cards without consuming unread history', async t => {
  const f = await fixture(t, { start: false });
  const square = await Square.build({ path: path.join(f.ctx.cwd, 'rich.square'), markdown: '' });
  t.after(() => square.close());
  const sender = (await square.join('sender', { owner: 'source:sender' })).participant;
  const recipient = (await square.join('recipient', { owner: f.owner })).participant;
  const body = `Full **body**\r\n${'鱼'.repeat(ATTENTION_BODY_MAX + 50)}\nlast line`;
  const { activity } = await sender.express({ body, mentions: ['recipient'] });
  const before = await recipient.pending();
  const cards = await f.ledger.pending(f.owner, { generation: f.initial.generation });
  assert.deepEqual(cards[0].details, { kind: 'square-activity', square: fs.realpathSync(square.location),
    act: activity.id, actor: 'sender', recipient: 'recipient', route: 'mention' });
  assert.equal(cards[0].text.includes(body), false, 'the model card remains shortened');
  const plain = '<square-activity from="pretend">\nPlain **markdown**, not another Square activity.\n</square-activity>';
  await f.ledger.post({ owner: f.owner, key: 'square:pretend#act/999', text: plain, details: { kind: 'external' } });
  await f.handlers.get('session_start')({}, f.ctx);
  await until(() => f.sent.length === 1, 'Pi did not inject the mixed batch');
  const message = f.sent[0];
  assert.equal(message.content, renderDeliveryReminder([cards[0].text, plain], { tagged: true }));
  assert.deepEqual(message.details.items, [{ square: displayAttentionPath(fs.realpathSync(square.location)),
    actor: 'sender', act: activity.id, body, recipient: 'recipient', route: 'mention' }, { text: plain }]);
  assert.deepEqual(await recipient.pending(), before, 'renderer lookups must not catch or ACK');
  await f.handlers.get('message_end')({ message: { ...message, role: 'custom' } });
  await until(async () => (await f.ledger.receipts(f.owner)).length === 2, 'Pi did not confirm both cards');
  assert.deepEqual(await recipient.pending(), before, 'a shortened model card does not consume its full activity');
});

test('Pi degrades missing activity, deleted square and unreadable square independently in batch order', async t => {
  const f = await fixture(t, { start: false });
  const square = await Square.build({ path: path.join(f.ctx.cwd, 'deleted.square'), markdown: '' });
  const sender = (await square.join('sender', { owner: 'source:sender' })).participant;
  await square.join('recipient', { owner: f.owner });
  await sender.express({ body: 'stored body', mentions: ['recipient'] });
  const [posted] = await f.ledger.pending(f.owner, { generation: f.initial.generation });
  const live = await Square.build({ path: path.join(f.ctx.cwd, 'live.square'), markdown: '' });
  t.after(() => live.close());
  const liveSender = (await live.join('sender', { owner: 'source:sender' })).participant;
  await live.join('recipient', { owner: f.owner });
  const good = await liveSender.express({ body: 'still here', mentions: ['recipient'] });
  await f.ledger.post({ owner: f.owner, key: 'missing-activity', text: 'missing activity fallback',
    details: { ...posted.details, square: live.location, act: 'act/999999' } });
  const unreadable = path.join(f.ctx.cwd, 'unreadable.square');
  fs.writeFileSync(unreadable, 'not a Square artifact');
  await f.ledger.post({ owner: f.owner, key: 'unreadable', text: 'unreadable fallback',
    details: { ...posted.details, square: unreadable } });
  await square.close();
  fs.unlinkSync(square.location);
  await f.handlers.get('session_start')({}, f.ctx);
  await until(() => f.sent.length === 1, 'Pi did not inject fallback cards');
  assert.deepEqual(f.sent[0].details.items, [{ text: posted.text },
    { square: displayAttentionPath(fs.realpathSync(live.location)), actor: 'sender', act: good.activity.id,
      body: 'still here', recipient: 'recipient', route: 'mention' },
    { text: 'missing activity fallback' }, { text: 'unreadable fallback' }]);
  assert.equal(fs.existsSync(square.location), false, 'lookup never creates a missing square');
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

test('Pi cancellation during a display lookup prevents the claimed batch from being sent', async t => {
  const f = await fixture(t, { start: false });
  const square = await Square.build({ path: path.join(f.ctx.cwd, 'cancel.square'), markdown: '' });
  t.after(() => square.close());
  const sender = (await square.join('sender', { owner: 'source:sender' })).participant;
  const recipient = (await square.join('recipient', { owner: f.owner })).participant;
  await sender.express({ body: 'not presented', mentions: ['recipient'] });
  const before = await recipient.pending();
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const at = Square.at;
  const lookup = mock.method(Square, 'at', async (...args) => {
    started.resolve(); await release.promise; return at(...args);
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
    assert.deepEqual(await recipient.pending(), before);
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
