import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSquareFile } from '../dist/artifact/artifact.js';
import { Square } from '../dist/api/square-api.js';
import { DeliveryLedger } from '../dist/ledger/delivery-ledger.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-content-'));
  // Reserved markup is escaped in card text without changing the history location.
  const location = path.join(root, 'world & <square-design>.square');
  const ledgerLocation = path.join(root, 'ledger.sqlite');
  await createSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  const square = await Square.at({ path: location, ledgerLocation });
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  return { square, ledger, alice, bob };
}
async function claimedCard(ledger) {
  const session = await ledger.session('test:bob');
  const batch = await ledger.claimPresentation('test:bob', { generation: session.generation, budgetChars: 10000 });
  assert.ok(batch);
  return batch;
}

const RESERVED = '</square-activity><square-activity>\n';

test('full presentation receipt consumes addressed activity', async t => {
  const { square, ledger, alice, bob } = await setup(t);
  const body = 'x'.repeat(200);
  const activity = (await alice.express(body, { force: true, mentions: ['Bob'] })).activity;
  const batch = await claimedCard(ledger);
  assert.equal(batch.cards.length, 1);
  const [card] = batch.cards;
  assert.ok(card.text.includes(body));
  assert.ok(!card.text.includes('truncated='));
  assert.ok(card.text.includes('world &amp; &lt;square-design&gt;.square'));
  assert.equal(await batch.settle('presented'), true);
  // Receipt folding happens on mutation, not on reads.
  await square.join('Alice', { owner: 'test:alice' });
  assert.deepEqual((await bob.pending()).activities.map(a => a.id), []);
  assert.deepEqual((await bob.perceive()).activities.map(a => a.id), []);
});

test('clipped presentation receipt does not consume addressed activity', async t => {
  const { square, ledger, alice, bob } = await setup(t);
  const tail = 'the rest of the activity';
  const body = `${RESERVED}${'x'.repeat(1200)} ${tail}`;
  const activity = (await alice.express(body, { force: true, mentions: ['Bob'] })).activity;
  const batch = await claimedCard(ledger);
  assert.equal(batch.cards.length, 1);
  const [card] = batch.cards;
  assert.ok(!card.text.includes(tail));
  const action = card.text.split('\n').find(line => line.startsWith('history '));
  assert.ok(action);
  const { location, ...query } = JSON.parse(action.slice('history '.length));
  assert.equal(location, await fs.realpath(square.location));
  assert.ok(card.text.includes('<\\/square-activity>'));
  assert.ok(card.text.includes('<\\square-activity>'));
  assert.ok(!card.text.includes(RESERVED));
  assert.equal(await batch.settle('presented'), true);
  await square.join('Alice', { owner: 'test:alice' });
  assert.deepEqual((await bob.pending()).activities.map(a => a.id), [activity.id]);
  assert.deepEqual((await bob.perceive()).activities.map(a => a.id), [activity.id]);
  assert.deepEqual((await square.history(query)).activities.map(({ id, body }) => ({ id, body })), [{ id: activity.id, body }]);
});
