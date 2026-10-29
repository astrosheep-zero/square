import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Square, selectOwnSeat } from '../dist/index.js';

const body = session => `test:${session}`;
const wakeAddress = session => ({ kind: 'paseo', address: { agentId: session } });

async function rejectsWithoutSeat(promise) {
  await assert.rejects(promise, error => error.code === 'already_joined'
    && error.facts?.reason === 'needs_seat' && typeof error.facts.join === 'string');
}

test('one identity-free memory resource carries explicit current seats for multiple Bodies', async t => {
  const square = Square.inMemory({ markdown: 'shared memory' });
  t.after(() => square.close());
  const aliceBody = body('alice'), bobBody = body('bob');
  assert.equal(Object.hasOwn(square, 'body'), false);

  const alice = await square.join('Alice', { owner: aliceBody, observe: true });
  const bob = await square.join('Bob', { owner: bobBody, wakeAddress: wakeAddress('bob'), observe: true });
  assert.equal(alice.observation.deliveryAvailable, false);
  assert.equal(bob.observation.deliveryAvailable, true);
  const aliceSeat = (await square.seatsOf(aliceBody))[0];
  assert.deepEqual(aliceSeat, { name: 'Alice', generation: 'act/0', attachment: 'attached' });
  assert.deepEqual((await square.seatsOf(bobBody)).map(seat => seat.name), ['Bob']);
  assert.equal((await square.participant('Alice', { owner: aliceBody })).name, 'Alice');
  assert.equal((await square.participant('Bob', { owner: bobBody })).name, 'Bob');
  await rejectsWithoutSeat(square.participant('Nobody', { owner: aliceBody }));
  await rejectsWithoutSeat(square.participant('Bob', { owner: aliceBody }));

  const status = await square.status();
  assert.equal(status.listening, undefined, 'core status does not infer a viewer');
  assert.deepEqual(status.participants.map(person => [person.name, person.deliveryAvailable]).sort(), [['Alice', false], ['Bob', true]]);
  assert.equal((await square.status({ viewer: 'Alice' })).listening.length, 0);
  await square.join('Alice', { owner: aliceBody, wakeAddress: wakeAddress('alice') });
  assert.equal((await alice.participant.catch({ observe: true })).observation.deliveryAvailable, true,
    'existing handles observe the current seat wake readiness, not their acquisition snapshot');

  const stale = alice.participant;
  assert.equal(await square.detach('Alice', { owner: aliceBody, generation: aliceSeat.generation }), true);
  await rejectsWithoutSeat(square.participant('Alice', { owner: aliceBody }));
  await assert.rejects(stale.express('detached', { force: true }), error => error.code === 'already_joined');
  const attached = await square.reattach('Alice', { owner: aliceBody });
  assert.equal(attached.name, 'Alice');
  await attached.done();
  await rejectsWithoutSeat(square.participant('Alice', { owner: aliceBody }));
});

test('adapter selection uses only an explicit own name or one attached own seat', async t => {
  const square = Square.inMemory({ markdown: 'selection' });
  t.after(() => square.close());
  const a = body('a'), b = body('b');
  assert.equal(await selectOwnSeat(square, a, undefined, { optional: true }), undefined);
  await assert.rejects(selectOwnSeat(square, a), { code: 'invalid_args' });
  await square.join('Alice', { owner: a });
  await square.join('Foreign', { owner: b });
  assert.equal((await selectOwnSeat(square, a)).name, 'Alice');
  await square.join('Bob', { owner: a });
  assert.equal(await selectOwnSeat(square, a, undefined, { optional: true }), undefined);
  await assert.rejects(selectOwnSeat(square, a), /multiple names/);
  assert.equal((await selectOwnSeat(square, a, 'alice')).name, 'Alice');
  await assert.rejects(selectOwnSeat(square, a, 'Foreign', { optional: true }), { code: 'already_joined' });
  const aliceSeat = (await square.seatsOf(a)).find(seat => seat.name === 'Alice');
  await square.detach('Alice', { owner: a, generation: aliceSeat.generation });
  assert.equal((await selectOwnSeat(square, a)).name, 'Bob');
  await assert.rejects(selectOwnSeat(square, a, 'Alice', { optional: true }), { code: 'already_joined' });
});

test('a file-backed identity-free resource joins separate Bodies and publishes only acquired seats', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'square-identity-free-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'shared.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const square = await Square.build({ path: location, markdown: 'shared file', env });
  await assert.rejects(fs.stat(env.SQUARE_INDEX), { code: 'ENOENT' });
  const a = body('file-alice'), b = body('file-bob');
  await square.join('Alice', { owner: a });
  await square.join('Bob', { owner: b });
  await square.close();
  await fs.unlink(env.SQUARE_INDEX);

  const reopened = await Square.at({ path: location, env });
  try {
    await assert.rejects(fs.stat(env.SQUARE_INDEX), { code: 'ENOENT' });
    assert.equal((await reopened.participant('Alice', { owner: a })).name, 'Alice');
    assert.equal((await reopened.participant('Bob', { owner: b })).name, 'Bob');
    assert.deepEqual((await reopened.seatsOf(a)).map(seat => seat.name), ['Alice']);
    assert.deepEqual((await reopened.seatsOf(b)).map(seat => seat.name), ['Bob']);
    await (await reopened.participant('Alice', { owner: a })).express('no discovery side effect', { force: true });
    await assert.rejects(fs.stat(env.SQUARE_INDEX), { code: 'ENOENT' });
    await reopened.reattach('Alice', { owner: a });
    assert.ok((await fs.stat(env.SQUARE_INDEX)).isFile());
  } finally {
    await reopened.close();
  }
});
