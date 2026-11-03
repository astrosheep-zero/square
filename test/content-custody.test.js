import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSquareFile } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-content-'));
  const location = path.join(root, 'world.square');
  const env = { ...process.env, SQUARE_DELIVERY: path.join(root, 'ledger.sqlite') };
  await createSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  const square = await Square.at({ path: location, env });
  const ledger = await DeliveryLedger.open({ location: env.SQUARE_DELIVERY });
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  return { square, ledger, alice, bob };
}

for (const [label, body, full] of [['full', 'short body', true], ['clipped', 'x'.repeat(300), false]]) {
  test(`${label} presentation receipt ${full ? 'consumes' : 'does not consume'} addressed activity`, async t => {
    const { square, ledger, alice, bob } = await setup(t);
    const activity = (await alice.express(body, { force: true, mentions: ['Bob'] })).activity;
    const session = await ledger.session('test:bob');
    const claim = await ledger.claimPresentation('test:bob', { generation: session.generation, budgetChars: 10000 });
    assert.ok(claim);
    assert.equal(claim.cards.length, 1);
    assert.equal(claim.cards[0].text.includes(body), full);
    assert.equal(await claim.settle('presented'), true);
    // Receipt folding happens on mutation, not on reads.
    await square.join('Alice', { owner: 'test:alice' });
    assert.deepEqual((await bob.pending()).activities.map(a => a.id), full ? [] : [activity.id]);
    assert.deepEqual((await bob.catch()).activities.map(a => a.id), full ? [] : [activity.id]);
  });
}
