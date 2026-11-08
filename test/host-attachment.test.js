import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSquareFile } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-host-'));
  const location = path.join(root, 'world.square');
  process.env.SQUARE_DELIVERY = path.join(root, 'delivery.sqlite');
  await createSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  const square = await Square.at({ path: location });
  const ledger = await DeliveryLedger.open();
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  return { square, ledger, alice, bob };
}

test('ledger detach projects away while retaining audience and unread; attach resumes the same member', async t => {
  const { square, ledger, alice, bob } = await setup(t);
  const session = await ledger.session('test:bob');
  await bob.listen('Alice');
  assert.equal(await ledger.detach({ owner: 'test:bob', generation: session.generation }), true);
  const match = { fields: [{ path: ['job'], equals: 7 }] };
  assert.deepEqual(await bob.ack({ from: 'Worker', match, future: 'exact' }), { consumed: 0 });
  const sent = (await alice.express('while away', { force: true })).activity;
  const away = (await square.participants()).participants.find(p => p.name === 'Bob');
  assert.equal(away.presence, 'away');
  assert.equal(away.unreadActivityCount, 1);
  assert.deepEqual(await ledger.pending('test:bob', { generation: session.generation }), []);
  await assert.rejects(bob.express('cannot write', { force: true }));
  assert.ok(await ledger.attach({ owner: 'test:bob', expectedGeneration: session.generation, routes: [] }));
  assert.deepEqual((await bob.perceive()).activities.map(a => a.id), [sent.id]);
});

test('ledger deletion is overlaid on reads and lands done only on the next mutation', async t => {
  const { square, ledger, alice } = await setup(t);
  const session = await ledger.session('test:bob');
  assert.equal(await ledger.markDeleted({ owner: 'test:bob', generation: session.generation }), true);
  const before = await square.history({ limit: null });
  await square.status();
  assert.equal((await square.participants()).participants.find(p => p.name === 'Bob').presence, 'away');
  assert.deepEqual((await square.history({ limit: null })).activities, before.activities);
  await alice.express('reconcile', { force: true });
  const done = (await square.history({ limit: null })).activities.filter(a => a.kind === 'done' && a.actor === 'Bob');
  assert.equal(done.length, 1);
});
