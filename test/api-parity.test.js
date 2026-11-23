import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact/artifact.js';
import { Square, selectOwnSeat } from '../dist/api/square-api.js';
import { renderJoinResult } from '../dist/surfaces/operation-presentation.js';
import { resourceWithArtifact } from './fixtures/resource-with-artifact.js';

const owner = `test:${'api-parity'}`;

async function memory(t) {
  const square = Square.inMemory({ markdown: 'archive' });
  t.after(() => square.close());
  return square;
}

test('history defaults to ten, accepts a larger page, and leaves pending untouched', async (t) => {
  const square = await memory(t);
  const alice = (await square.join('Alice', { owner })).participant;
  const bob = (await square.join('Bob', { owner })).participant;
  for (let index = 0; index < 12; index++) await alice.express(`message ${index}`, { force: true });
  await bob.express('for Alice', { force: true, mentions: ['Alice'] });
  const pending = await alice.pending();
  assert.equal(pending.activities.length, 1);

  const recent = await square.history();
  assert.deepEqual(recent.activities.map((activity) => activity.id),
    Array.from({ length: 10 }, (_value, index) => `act/${index + 5}`));
  const observed = await square.history({ observe: true });
  assert.deepEqual(observed.observation.continuation, { direction: 'before', cursor: 'act/5', limit: 10 });
  assert.equal((await square.history({ limit: 20 })).activities.length, 15);
  assert.deepEqual(await alice.pending(), pending);
});

test('a stale participant handle cannot speak after done or rejoin', async (t) => {
  const square = await memory(t);
  const alice = (await square.join('Alice', { owner })).participant;
  await alice.done();
  await assert.rejects(alice.express('stale handle'), { code: 'already_joined' });
  const rejoined = (await square.join('Alice', { owner })).participant;
  await assert.rejects(alice.express('old generation after rejoin'), { code: 'already_joined' });
  assert.equal((await rejoined.express('back', { force: true })).activity.id, 'act/3');
});

test('join refuses an omitted or blank name without adding history', async (t) => {
  const square = Square.inMemory({ markdown: 'explicit-name' });
  t.after(() => square.close());
  const before = (await square.history()).activities.length;
  await assert.rejects(square.join(undefined, { owner }), { code: 'invalid_args' });
  await assert.rejects(square.join('', { owner }), { code: 'invalid_name' });
  await assert.rejects(square.join('   ', { owner }), { code: 'invalid_name' });
  assert.equal((await square.history()).activities.length, before);
  assert.equal((await square.join('Defaulted', { owner })).kind, 'joined');
  assert.equal((await selectOwnSeat(square, owner)).name, 'Defaulted');
  await assert.rejects(square.join(undefined, { owner }), { code: 'invalid_args' });
  assert.equal((await square.history()).activities.filter((activity) => activity.kind === 'join').length, 1);
});

test('perceive resolves caller and filters in one typed failure', async (t) => {
  const square = await memory(t);
  const alice = (await square.join('Alice', { owner })).participant;
  await assert.rejects(alice.perceive({ from: ['Unknown'] }), (error) => {
    assert.equal(error.code, 'invalid_args');
    assert.equal(error.facts.reason, 'never_joined');
    assert.equal(error.facts.activityId, undefined);
    assert.deepEqual(error.operation, { operation: 'perceive', subject: 'filter', participant: 'Alice' });
    return true;
  });
});

async function seededArtifact() {
  const cell = createArtifactPort(':memory:', {
    hardCap: null, preamble: [], warmup: ['fixture warmup'], acts: [],
    runtime: { nextActIndex: 0, observations: {}, leases: {} },
  });
  const seats = new Map();
  for (const activity of [
    { kind: 'join', actor: 'Alice', at: 0 },
    { kind: 'join', actor: 'Bob', at: 1 },
    { kind: 'say', actor: 'Bob', at: 2, body: 'for Alice', mentions: ['Alice'] },
  ]) {
    if (activity.kind === 'join') {
      await cell.transactAs({ kind: 'join', participant: activity.actor, owner: `test:${activity.actor.toLowerCase()}` },
        (facts) => facts.land(activity));
      seats.set(activity.actor, (await cell.read((facts) => facts.seat(activity.actor))).value);
    } else {
      await cell.transactAs({ kind: 'participant', seat: seats.get(activity.actor) }, (facts) => facts.land(activity));
    }
  }
  return cell;
}

test('optional observations hydrate only what they present', async (t) => {
  const cell = await seededArtifact();
  t.after(() => cell.close());
  let hydrated = [];
  const read = cell.read.bind(cell);
  cell.read = (select, signal) => read((facts) => select({ ...facts, activities(ids) {
    if (ids.includes(2)) hydrated.push([...ids]);
    return facts.activities(ids);
  } }), signal);
  const square = await resourceWithArtifact(t, cell);
  const alice = await square.participant('Alice', { owner: 'test:alice' });

  hydrated = [];
  const plain = await alice.express('plain', { force: true });
  assert.equal(plain.observation, undefined);
  assert.deepEqual(hydrated, []);

  hydrated = [];
  const observed = await alice.express('seen', { force: true, observe: true });
  assert.deepEqual(observed.observation.context.activities.map((activity) => activity.preview), ['for Alice']);
  assert.equal(hydrated.length, 1);
  assert.ok(hydrated[0].includes(2));

  hydrated = [];
  const plainJoin = await square.join('Cara', { owner: 'test:cara' });
  assert.equal(plainJoin.observation, undefined);
  assert.deepEqual(hydrated, []);

  const first = await square.join('Dana', { owner: 'test:dana', observe: true });
  assert.match(renderJoinResult(first), /fixture warmup/);
  const again = await square.join('Dana', { owner: 'test:dana', observe: true });
  assert.equal(again.kind, 'reconnected');
  assert.equal(again.activity, null);
  assert.doesNotMatch(renderJoinResult(again), /fixture warmup/);
});
