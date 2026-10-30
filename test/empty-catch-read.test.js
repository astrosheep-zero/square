import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactPort } from '../dist/artifact.js';
import { resourceWithArtifact } from './fixtures/resource-with-artifact.js';

const bodyFor = name => ("test" + ":" + (name.toLowerCase()));
async function fixture(t, extra = [], hardCap = null) {
  const cell = createArtifactPort(':memory:', {
    hardCap, preamble: [], warmup: ['test'], acts: [],
    runtime: { nextActIndex: 0, observations: {}, leases: {} },
  });
  t.after(() => cell.close());
  const seats = new Map();
  for (const activity of [{ kind: 'join', actor: 'Alice', at: 0 }, { kind: 'join', actor: 'Bob', at: 1 }, ...extra]) {
    if (activity.kind === 'join') {
      await cell.transactAs({ kind: 'join', participant: activity.actor, owner: bodyFor(activity.actor) }, facts => facts.land(activity));
      seats.set(activity.actor, (await cell.read(facts => facts.seat(activity.actor))).value);
    } else await cell.transactAs({ kind: 'participant', seat: seats.get(activity.actor) }, facts => facts.land(activity));
  }
  const bobSeat = seats.get('Bob'), artifact = { ...cell };
  const square = await resourceWithArtifact(t, artifact);
  return { cell, artifact, square, bob: await square.participant('bOB', { owner: bobSeat.owner }), seats, bobSeat };
}
function withoutBodies(facts) {
  return { ...facts, activity() { assert.fail('catch probe must not hydrate a body'); }, activities() { assert.fail('catch probe must not hydrate bodies'); } };
}
function noWriter() { assert.fail('empty catch must not acquire the artifact writer'); }

test('an empty filtered catch returns its snapshot without bodies, a writer, or receipts', async t => {
  const { cell, artifact, bob } = await fixture(t, [
    { kind: 'join', actor: 'Cara', at: 2 },
    { kind: 'say', actor: 'Cara', at: 3, body: 'still pending', mentions: ['Bob'] },
    { kind: 'say', actor: 'Bob', at: 4, body: 'own activity' },
  ], 1);
  const revision = await cell.revision();
  let reads = 0;
  artifact.read = (select, signal) => { reads++; return cell.read(facts => select(withoutBodies(facts)), signal); };
  artifact.transactAs = noWriter;
  const result = await bob.catch({ from: ['Alice'], mention: true, limit: 1, observe: true });
  assert.deepEqual({ ...result, observation: undefined }, { activities: [], remaining: 0, reason: 'capped', observation: undefined });
  const { observation } = result;
  assert.deepEqual([observation.participant, observation.standingCount, observation.now, observation.ownActivityCount, observation.hardCap], ['Bob', 3, 100, 1, 1]);
  assert.equal(reads, 2, 'one selection and one explicitly requested presence read');
  assert.equal(await cell.revision(), revision);
  assert.equal((await cell.read(facts => facts.receipt('Bob', 3))).value, undefined);
});

test('a nonempty probe records nothing; the writer reselects, hydrates once, and observes its snapshot', async t => {
  const { cell, artifact, bob, seats, bobSeat } = await fixture(t, [
    { kind: 'say', actor: 'Alice', at: 2, body: 'claimed elsewhere', mentions: ['Bob'] },
  ]);
  const hydrated = [];
  let writes = 0, probed = false;
  artifact.read = async (select, signal) => {
    const result = await cell.read(facts => select(withoutBodies(facts)), signal);
    if (!probed) {
      probed = true;
      assert.equal((await cell.read(facts => facts.receipt('Bob', 2))).value, undefined);
      await cell.transactAs({ kind: 'participant', seat: bobSeat }, facts => facts.markSeen('Bob', [2], 50));
      await cell.transactAs({ kind: 'participant', seat: seats.get('Alice') }, facts => {
        facts.land({ kind: 'say', actor: 'Alice', at: 51, body: 'selected by writer', mentions: ['Bob'] });
        facts.land({ kind: 'say', actor: 'Alice', at: 52, body: 'remaining', mentions: ['Bob'] });
      });
    }
    return result;
  };
  artifact.transactAs = (authority, change, signal) => {
    writes++;
    return cell.transactAs(authority, facts => change({ ...facts, activities(indexes) { hydrated.push([...indexes]); return facts.activities(indexes); } }), signal);
  };
  const caught = await bob.catch({ from: ['alice'], mention: true, limit: 1, observe: true });
  assert.deepEqual(caught.activities.map(({ id, body }) => ({ id, body })), [{ id: 'act/3', body: 'selected by writer' }]);
  assert.equal(caught.remaining, 1);
  assert.equal(caught.reason, 'drained');
  assert.equal(caught.activities[0].via, 'mention');
  assert.equal(writes, 1);
  assert.deepEqual(hydrated, [[3]]);
  assert.deepEqual((await cell.read(facts => [facts.receipt('Bob', 2), facts.receipt('Bob', 3), facts.receipt('Bob', 4)])).value, [{ at: 50 }, { at: 100 }, undefined]);
});

test('exact-ID catches retain their repeatable receipt transaction and never use the empty probe', async t => {
  const { cell, artifact, bob } = await fixture(t, [{ kind: 'say', actor: 'Alice', at: 2, body: 'exact', mentions: ['Bob'] }]);
  const marked = [];
  artifact.read = (select, signal) => cell.read(facts => select({ ...facts, directed() { assert.fail('ID catch must not probe a directed page'); } }), signal);
  artifact.transactAs = (authority, change, signal) => cell.transactAs(authority, facts => change({
    ...facts, markSeen(name, indexes, at) { marked.push([...indexes]); return facts.markSeen(name, indexes, at); },
  }), signal);
  const first = await bob.catch({ id: 'act/2' });
  assert.deepEqual(await bob.catch({ id: 'act/2' }), first);
  assert.deepEqual(marked, [[2], [2]]);
});

test('empty catch validates caller, filters, limits, and semantic time without a writer', async t => {
  const { cell, artifact, square } = await fixture(t);
  await assert.rejects(square.participant('Missing', { owner: bodyFor('Bob') }), { code: 'already_joined' });
  artifact.transactAs = noWriter;
  const bob = await square.participant('Bob', { owner: bodyFor('Bob') });
  await assert.rejects(bob.catch({ from: ['Missing'] }), error => error.code === 'invalid_args' && error.facts.reason === 'never_joined');
  for (const limit of [0, 101, 1.5]) await assert.rejects(bob.catch({ limit }), { code: 'invalid_args' });
  for (const at of [NaN, Infinity, '100', -0.5]) {
    const resource = await resourceWithArtifact(t, artifact, () => at);
    const participant = await resource.participant('Bob', { owner: bodyFor('Bob') });
    if (at === -0.5) assert.equal((await participant.catch({ observe: true })).observation.now, at);
    else await assert.rejects(participant.catch(), { code: 'invalid_args' });
  }
  assert.equal((await cell.read(facts => facts.receipt('Bob', 2))).value, undefined);
});

test('catch propagates cancellation through probe and writer but keeps a committed receipt result', async t => {
  const { cell, artifact, bob } = await fixture(t, [{ kind: 'say', actor: 'Alice', at: 2, body: 'pending', mentions: ['Bob'] }]);
  const controller = new AbortController(), reason = new Error('cancelled after probe');
  artifact.read = async (select, signal) => {
    assert.equal(signal, controller.signal);
    const result = await cell.read(facts => select(withoutBodies(facts)), signal);
    controller.abort(reason);
    return result;
  };
  artifact.transactAs = (authority, change, signal) => { assert.equal(signal, controller.signal); return cell.transactAs(authority, change, signal); };
  await assert.rejects(bob.catch({}, { signal: controller.signal }), error => error === reason);
  assert.equal((await cell.read(facts => facts.receipt('Bob', 2))).value, undefined);
  await assert.rejects(bob.catch({}, { signal: controller.signal }), error => error === reason);
  artifact.read = cell.read;
  const late = new AbortController();
  artifact.transactAs = async (authority, change, signal) => {
    const result = await cell.transactAs(authority, change, signal);
    late.abort(new Error('response cancelled after commit'));
    return result;
  };
  const committed = await bob.catch({}, { signal: late.signal });
  assert.equal(committed.activities[0].body, 'pending');
  assert.deepEqual((await cell.read(facts => facts.receipt('Bob', 2))).value, { at: 100 });
});

test('empty catch keeps its completed snapshot after late read cancellation', async t => {
  const { cell, artifact, bob } = await fixture(t);
  const controller = new AbortController(), order = [];
  artifact.read = async (select, signal) => {
    order.push('read');
    assert.equal(signal, controller.signal);
    const result = await cell.read(facts => select(withoutBodies(facts)), signal);
    controller.abort(new Error('late snapshot cancellation'));
    return result;
  };
  artifact.transactAs = noWriter;
  assert.deepEqual((await bob.catch({}, { signal: controller.signal })).activities, []);
  assert.deepEqual(order, ['read']);
  assert.equal(controller.signal.aborted, true);
});
