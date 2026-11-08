import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Square, selectOwnSeat } from '../dist/square-api.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';

const match = (turn = 'turn/7') => ({ fields: [
  { path: ['keiyaku', 'kind'], equals: 'akuma.turn-outcome' },
  { path: ['keiyaku', 'akumaId'], equals: 'aku/intern/12345678' },
  { path: ['keiyaku', 'historyId'], equals: turn },
] });
const notice = (turn = 'turn/7', to = ['observer']) => ({ from: 'keiyaku-notice', to,
  body: `result ${turn}`, metadata: { keiyaku: { kind: 'akuma.turn-outcome', akumaId: 'aku/intern/12345678', historyId: turn }, extra: 'allowed' } });
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-producer-'));
  process.env.SQUARE_DELIVERY = path.join(root, 'delivery.sqlite');
  let now = 1000;
  const input = { path: path.join(root, 'world.square'), clock: () => now };
  const square = await Square.build({ ...input, markdown: '' });
  const observer = (await square.join('observer', { owner: `observer:${root}` })).participant;
  const other = (await square.join('other', { owner: `other:${root}` })).participant;
  const reopened = await Square.at(input);
  const ledger = await DeliveryLedger.open();
  t.after(async () => { await reopened.close(); await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const owner = `observer:${root}`;
  async function cards(forOwner = owner) {
    const session = await ledger.session(forOwner);
    return ledger.pending(forOwner, { generation: session.generation });
  }
  return { square, reopened, observer, other, ledger, cards, owner, input, advance: value => { now += value; } };
}

test('explicit exact ACK consumes existing and future notices only for its captured recipient and outcome', async t => {
  const c = await setup(t);
  const sent = await c.square.send(notice('turn/7', ['observer', 'other']));
  assert.match(sent.id, /^notice\//);
  assert.equal((await c.square.history({ limit: null })).activities.some(activity => activity.actor === 'keiyaku-notice'), false);
  assert.deepEqual(await c.observer.ack({ from: 'keiyaku-notice', match: match(), future: 'exact' }), { consumed: 1 });
  await c.square.send(notice());
  await c.square.send(notice('turn/8'));
  assert.deepEqual((await c.cards()).map(card => card.text), ['result turn/8']);
  assert.deepEqual(await c.observer.ack({ from: 'KEIYAKU-NOTICE', match: match('turn/9'), future: 'exact' }), { consumed: 0 });
  await c.square.send(notice('turn/9'));
  assert.deepEqual((await c.cards()).map(card => card.text), ['result turn/8']);
  const otherCards = await c.cards(`other:${path.dirname(c.input.path)}`);
  assert.deepEqual(otherCards.map(card => card.text), ['result turn/7']);
});

test('zero-count future ACK is durable without a TTL or ledger access and matches nested scalar equalities', async t => {
  const c = await setup(t);
  const deniedLedger = path.join(path.dirname(c.input.path), 'denied-ledger');
  await fs.mkdir(deniedLedger);
  const previousDelivery = process.env.SQUARE_DELIVERY;
  let sandbox;
  try {
    process.env.SQUARE_DELIVERY = deniedLedger;
    sandbox = await Square.at(c.input);
    const seat = await selectOwnSeat(sandbox, c.owner, 'observer');
    assert.deepEqual(await seat.ack({ from: 'keiyaku-notice', match: match(), future: 'exact' }), { consumed: 0 });
  } finally { await sandbox?.close(); process.env.SQUARE_DELIVERY = previousDelivery; }
  c.advance(1000 * 60 * 60 * 24 * 500);
  const again = await c.reopened.participant('observer', { owner: c.owner });
  assert.deepEqual(await again.ack({ from: 'keiyaku-notice', match: { fields: [...match().fields].reverse() }, future: 'exact' }), { consumed: 0 });
  await c.square.send(notice());
  await c.square.send(notice('turn/8'));
  assert.deepEqual((await c.cards()).map(card => card.text), ['result turn/8']);
  await assert.rejects(() => again.ack({ from: 'keiyaku-notice', match: match() }), error => error.code === 'invalid_args');
});

test('ACK after committed export ownership does not recall the captured post or hold a World writer', async t => {
  const c = await setup(t);
  const original = DeliveryLedger.prototype.post;
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { resume = resolve; });
  DeliveryLedger.prototype.post = async function(input) {
    if (input.text === 'result turn/7') { enter(); await resumed; }
    return original.call(this, input);
  };
  try {
    const sending = c.square.send(notice());
    await entered;
    // A separately opened producer handle can commit while the external post is paused.
    const seat = await c.reopened.participant('observer', { owner: c.owner });
    assert.deepEqual(await seat.ack({ from: 'keiyaku-notice', match: match(), future: 'exact' }), { consumed: 1 });
    resume();
    await sending;
    // Perceive/retraction may remove an unclaimed card, but no pre-export suppression is claimed.
    const session = await c.ledger.session(c.owner);
    assert.equal(session.state, 'attached');
    await c.square.send(notice());
    assert.equal((await c.cards()).length, 0);
  } finally { resume(); DeliveryLedger.prototype.post = original; }
});

test('World-local discovery preserves known identities without probing host delivery', async t => {
  const c = await setup(t);
  const departed = (await c.square.join('departed', { owner: 'departed:owner' })).participant;
  await departed.done();
  await c.square.join('foreign', { owner: 'foreign:owner' });
  const session = await c.ledger.session(c.owner);
  await c.ledger.updateRoutes({ owner: c.owner, generation: session.generation, routes: [{ kind: 'test', address: {} }] });
  assert.equal((await c.square.participants()).participants.find(person => person.name === 'observer').deliveryAvailable, true);
  await c.ledger.detach({ owner: c.owner, generation: session.generation });
  assert.equal((await c.square.participants()).participants.find(person => person.name === 'observer').presence, 'away');
  const deniedLedger = path.join(path.dirname(c.input.path), 'denied-discovery-ledger');
  await fs.mkdir(deniedLedger);
  const previousDelivery = process.env.SQUARE_DELIVERY;
  let sandbox;
  try {
    process.env.SQUARE_DELIVERY = deniedLedger;
    sandbox = await Square.at(c.input);
    const local = await sandbox.participants({ local: true, observe: true });
    assert.equal(local.participants.find(person => person.name === 'observer').presence, 'active', 'local attachment has not reconciled host detach');
    assert.equal(local.participants.find(person => person.name === 'departed').presence, 'done');
    assert.equal(local.participants.find(person => person.name === 'foreign').presence, 'active');
    assert.ok(local.observation);
    assert.ok(local.participants.every(person => person.deliveryAvailable === false));
    await assert.rejects(() => sandbox.participants());
    await assert.rejects(() => sandbox.participant('foreign', { owner: c.owner }));
    process.env.SQUARE_DELIVERY = previousDelivery;
    await c.square.join('other', { owner: `other:${path.dirname(c.input.path)}` });
    process.env.SQUARE_DELIVERY = deniedLedger;
    assert.equal((await sandbox.participants({ local: true })).participants.find(person => person.name === 'observer').presence, 'away');
    await assert.rejects(() => sandbox.participant('observer', { owner: c.owner }));
  } finally { await sandbox?.close(); process.env.SQUARE_DELIVERY = previousDelivery; }
});

test('local World custody refuses known departure or replacement without probing the ledger', async t => {
  const c = await setup(t);
  await c.square.join('observer', { owner: 'replacement', takeover: true });
  await assert.rejects(() => c.observer.ack({ from: 'keiyaku-notice', match: match(), future: 'exact' }), /replaced/);
});
