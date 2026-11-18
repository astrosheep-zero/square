import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSquareFile } from '../dist/artifact.js';
import { Square } from '../dist/square-api.js';
import { DeliveryLedger } from '../dist/delivery-ledger.js';
import { renderExpression } from '../dist/operation-presentation.js';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-host-'));
  const location = path.join(root, 'world.square');
  const ledgerLocation = path.join(root, 'delivery.sqlite');
  await createSquareFile(location, { hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  const square = await Square.at({ path: location, ledgerLocation });
  const ledger = await DeliveryLedger.open({ location: ledgerLocation });
  t.after(async () => { await square.close(); await ledger.close(); await fs.rm(root, { recursive: true, force: true }); });
  const alice = (await square.join('Alice', { owner: 'test:alice' })).participant;
  const bob = (await square.join('Bob', { owner: 'test:bob' })).participant;
  return { square, ledger, alice, bob, root, location };
}

test('ledger detach projects away while retaining audience and unread; attach resumes the same member', async t => {
  const { square, ledger, alice, bob } = await setup(t);
  const session = await ledger.session('test:bob');
  const question = await bob.express('question', { force: true });
  await bob.listen('Alice');
  assert.equal(await ledger.detach({ owner: 'test:bob', generation: session.generation }), true);
  const match = { fields: [{ path: ['job'], equals: 7 }] };
  assert.deepEqual(await bob.ack({ from: 'Worker', match, future: 'exact' }), { consumed: 0 });
  const result = await alice.express('while away @bob @BOB @Alice @Missing', {
    force: true, mentions: ['BOB', 'Alice'], reply: question.activity.id,
  });
  const sent = result.activity;
  assert.deepEqual(result.awayRecipients, ['Bob']);
  assert.equal(result.observation, undefined, 'away facts do not require observe');
  assert.deepEqual(result.unmatchedMentions, ['Missing']);
  assert.equal(sent.awayRecipients, undefined);
  assert.equal((await square.history({ at: [sent.id] })).activities[0].awayRecipients, undefined);
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

test('away observations do not override ignore and a reply still reaches its away author', async t => {
  const { square, ledger, alice, bob } = await setup(t);
  const question = await bob.express('question', { force: true });
  await bob.ignore('Alice');
  const session = await ledger.session('test:bob');
  await ledger.detach({ owner: 'test:bob', generation: session.generation });
  const direct = await alice.express('@bob', { force: true });
  assert.deepEqual(direct.awayRecipients, ['Bob']);
  assert.equal((await square.participants({ local: true })).participants.find(p => p.name === 'Bob').unreadActivityCount, 0, 'ignore still excludes directed audience');
  const carol = (await square.join('Carol', { owner: 'test:carol' })).participant;
  const reply = await carol.express('answer', { reply: question.activity.id, force: true });
  assert.deepEqual(reply.awayRecipients, ['Bob']);
  await ledger.attach({ owner: 'test:bob', expectedGeneration: session.generation, routes: [] });
  assert.deepEqual((await bob.perceive()).activities.map(a => a.id), [reply.activity.id]);
});

test('a missing session remains unknown even with a stale detached seat and never creates a session', async t => {
  const { square, ledger, alice, bob, root, location } = await setup(t);
  const session = await ledger.session('test:bob');
  await ledger.detach({ owner: 'test:bob', generation: session.generation });
  await alice.express('observe detach', { force: true });
  assert.equal((await square.artifact.read(facts => facts.seat('Bob'))).value.attachment, 'detached');
  const unknownLocation = path.join(root, 'missing-sessions.sqlite');
  const unknown = await DeliveryLedger.open({ location: unknownLocation });
  const peer = await Square.at({ path: location, ledgerLocation: unknownLocation });
  t.after(async () => { await peer.close(); await unknown.close(); });
  const sender = await peer.participant('Alice', { owner: 'test:alice' });
  const result = await sender.express('@bob', { force: true, observe: true });
  assert.equal(result.awayRecipients, undefined);
  assert.equal((await peer.participants({ local: true })).participants.find(p => p.name === 'Bob').unreadActivityCount, 1);
  assert.equal(await unknown.session('test:bob'), undefined);
  assert.equal(await unknown.session('test:alice'), undefined);
  assert.deepEqual(renderExpression(location, result).split('\n').filter(line => line.startsWith('⚠')), []);
});

test('captured away observations cannot pass to a replaced owner or a new join generation', async t => {
  for (const replacementOwner of ['test:bob', 'test:replacement']) {
    await t.test(replacementOwner, async t => {
      const { square, ledger, alice, bob } = await setup(t);
      const session = await ledger.session('test:bob');
      await ledger.detach({ owner: 'test:bob', generation: session.generation });
      const transact = square.artifact.transactAs.bind(square.artifact);
      let replacement;
      const intercept = t.mock.method(square.artifact, 'transactAs', async (authority, change, signal) => {
        if (authority.kind === 'participant' && authority.seat.participant === 'Alice') {
          intercept.mock.restore();
          // Real lifecycle changes after reconciliation and before the landing transaction.
          await ledger.attach({ owner: 'test:bob', expectedGeneration: session.generation, routes: [] });
          if (replacementOwner === 'test:bob') await bob.done();
          replacement = (await square.join('Bob', { owner: replacementOwner, takeover: replacementOwner !== 'test:bob' })).participant;
        }
        return transact(authority, change, signal);
      });
      const result = await alice.express('@bob', { force: true });
      assert.ok(replacement);
      assert.notEqual(replacement.generation, bob.generation);
      assert.equal(result.awayRecipients, undefined);
      assert.deepEqual((await replacement.pending()).activities.map(a => a.id), [result.activity.id]);
    });
  }
});

test('away is a captured observation even if the recipient resumes and consumes before export', async t => {
  const { square, ledger, alice, bob, location } = await setup(t);
  const session = await ledger.session('test:bob');
  await ledger.detach({ owner: 'test:bob', generation: session.generation });
  const flush = square.flush.bind(square);
  t.mock.method(square, 'flush', async signal => {
    await ledger.attach({ owner: 'test:bob', expectedGeneration: session.generation, routes: [] });
    await square.reconcile();
    const id = (await square.history()).activities.at(-1).id;
    assert.deepEqual(await bob.ack([id]), { consumed: 1 });
    await flush(signal);
  });
  const result = await alice.express('@bob', { force: true, observe: true });
  assert.deepEqual(result.awayRecipients, ['Bob']);
  assert.deepEqual((await bob.pending()).activities, []);
  assert.deepEqual(renderExpression(location, result).split('\n').filter(line => line.startsWith('⚠')), ['⚠ @Bob is away.']);
  assert.equal((await alice.express('@bob', { force: true })).awayRecipients, undefined, 'the next operation checks anew');
});
