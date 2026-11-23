import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPerceiveOutcome } from '../dist/surfaces/perceive-presentation.js';
import { resourceWithArtifact } from './fixtures/resource-with-artifact.js';
import { createArtifactPort } from '../dist/artifact/artifact.js';

/** Counts artifact callbacks and the activity rows/selectors each read actually asks for. */
function instrumentCell(cell) {
  const counters = { reads: 0, transacts: 0, hydrated: [], counts: [], directedPages: [], ordinals: [] };
  const wrap = (facts) => Object.assign({}, facts, {
    activities: (indexes) => { counters.hydrated.push([...indexes]); return facts.activities(indexes); },
    sayOrdinals: (indexes) => { counters.ordinals.push([...indexes]); return facts.sayOrdinals(indexes); },
    activityCount: (filter) => { counters.counts.push({ method: 'activityCount', filter }); return facts.activityCount(filter); },
    directedCount: (recipient, filter) => { counters.counts.push({ method: 'directedCount', recipient, filter }); return facts.directedCount(recipient, filter); },
    directed: (recipient, filter, page) => { counters.directedPages.push({ recipient, filter, page }); return facts.directed(recipient, filter, page); },
  });
  return {
    counters,
    artifact: {
      ...cell,
      read: (select, signal) => { counters.reads += 1; return cell.read((facts) => select(wrap(facts)), signal); },
      transactAs: (authority, change, signal) => { counters.transacts += 1; return cell.transactAs(authority, (facts) => change(wrap(facts)), signal); },
    },
  };
}

function bodyFor(name) { return "test" + ":" + (name.toLowerCase()); }

async function establishSeat(cell, participant, at) {
  const body = bodyFor(participant);
  return (await cell.transactAs({ kind: 'join', participant, owner: body }, (facts) => {
    facts.land({ kind: 'join', actor: participant, at });
    return facts.seat(participant);
  })).value;
}

/** Seed each participant and sender through their own authority. */
async function stateWithHistory(unrelatedSays, participants = 96) {
  const cell = createArtifactPort(':memory:', {
    hardCap: null, preamble: [], warmup: ['test'], acts: [],
    runtime: { nextActIndex: 0, observations: {}, leases: {} },
  });
  const alice = await establishSeat(cell, 'Alice', 0);
  const p0 = await establishSeat(cell, 'P0', 1);
  for (let index = 1; index < participants; index++) await establishSeat(cell, `P${index}`, index + 1);
  await cell.transactAs({ kind: 'participant', seat: alice }, (facts) => {
    for (let index = 0; index < unrelatedSays; index++) {
      facts.land({ kind: 'say', actor: 'Alice', at: index + 100, body: `dispatch ${index} @P0`, mentions: ['P0'] });
    }
  });
  return { cell, p0 };
}

test('perceive hydrates one bounded page while unseen count and selector cost stay flat', async t => {
  const measurements = [];
  for (const size of [30, 180]) {
    const { cell, p0 } = await stateWithHistory(size);
    const { counters, artifact } = instrumentCell(cell);
    try {
      const square = await resourceWithArtifact(t, artifact, () => 2_000);
      const perceived = await (await square.participant('P0', { owner: p0.owner })).perceive();
      measurements.push({
        delivered: perceived.activities.length,
        remaining: perceived.remaining,
        hydrated: counters.hydrated.flat(),
        largestBatch: Math.max(0, ...counters.hydrated.map(batch => batch.length)),
        unseenCounts: counters.counts.filter(entry => entry.method === 'directedCount' && entry.filter.unseenOnly === true),
        headReads: counters.counts.filter(entry => entry.method === 'activityCount').length,
      });
    } finally {
      await cell.close();
    }
  }
  assert.deepEqual(measurements.map(({ delivered, remaining }) => ({ delivered, remaining })), [
    { delivered: 10, remaining: 20 },
    { delivered: 10, remaining: 170 },
  ]);
  const page = Array.from({ length: 10 }, (_value, index) => index + 97);
  assert.deepEqual(measurements.map(({ hydrated }) => hydrated), [page, page], 'the page requests only the ten selected IDs');
  assert.deepEqual(measurements.map(({ largestBatch }) => largestBatch), [10, 10], 'directed pages stay bounded');
  const unseenCalls = measurements[0].unseenCounts.length;
  assert.ok(unseenCalls > 0, 'remaining comes from a typed unseen count');
  assert.ok(measurements.every(({ unseenCounts }) => unseenCounts.length === unseenCalls && unseenCounts.every((entry) => entry.recipient === 'P0')));
  assert.equal(measurements[0].headReads, measurements[1].headReads, 'selector cost must not scale with unrelated history');
});

test('perceive renders its transaction-selected records without rehydrating them', async t => {
  const { cell, p0 } = await stateWithHistory(25, 1);
  const { counters, artifact } = instrumentCell(cell);
  const square = await resourceWithArtifact(t, artifact, () => 100_000);
  const measurements = () => structuredClone(counters);
  try {
    const participant = await square.participant('P0', { owner: p0.owner });
    const outcome = await participant.perceive();
    const perceivedIds = Array.from({ length: 10 }, (_value, index) => `act/${index + 2}`);
    assert.deepEqual(outcome.activities.map(activity => activity.id), perceivedIds);
    assert.equal(outcome.remaining, 15);
    assert.equal(outcome.standingCount, 2);
    assert.deepEqual(counters.ordinals, [], 'perceive does not query history ordinals');
    assert.deepEqual(counters.hydrated.flat(), perceivedIds.map((id) => Number(id.slice(4))));

    const beforeRender = measurements();
    const output = renderPerceiveOutcome(outcome);
    assert.match(output, /dispatch 0 @P0/);
    assert.doesNotMatch(output, /dispatch 24 @P0/);
    assert.deepEqual(measurements(), beforeRender);

    // A valid sender filter with no matching pending activity settles empty;
    // unrelated remaining activity cannot force body hydration for that result.
    const hydrationCount = counters.hydrated.length;
    const emptyOutcome = await participant.perceive({ from: ['P0'] });
    assert.deepEqual(emptyOutcome.activities, []);
    assert.equal(emptyOutcome.standingCount, 2);
    assert.equal(counters.hydrated.length, hydrationCount, 'empty perceive must not request body hydration');
    const beforeEmptyRender = measurements();
    const emptyOutput = renderPerceiveOutcome(emptyOutcome, { from: ['P0'] });
    assert.doesNotMatch(emptyOutput, /dispatch \d+ @P0/);
    assert.deepEqual(measurements(), beforeEmptyRender);
  } finally {
    await cell.close();
  }
});

test('perceive fences selection and captures the page facts in its receipt transaction', async t => {
  const cell = createArtifactPort(':memory:', { hardCap: 5, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  t.after(() => cell.close());
  const artifact = { ...cell };
  const body = bodyFor('owner');
  const resource = await resourceWithArtifact(t, artifact);
  const alice = (await resource.join('Alice', { owner: body })).participant;
  const bob = (await resource.join('Bob', { owner: body })).participant;
  await alice.express('first for Bob', { force: true, mentions: ['Bob'] });
  await alice.express('second for Bob', { force: true, mentions: ['Bob'] });
  const bobSeat = (await cell.read(facts => facts.seat('Bob'))).value;
  const aliceSeat = (await cell.read(facts => facts.seat('Alice'))).value;
  let replaced = false;
  artifact.transactAs = async (authority, change, signal) => {
    const result = await cell.transactAs(authority, change, signal);
    // Replace the lease after its heartbeat but before receipt selection.
    if (!replaced && result.value?.type === 'sleep') {
      replaced = true;
      await cell.transactAs({ kind: 'participant', seat: bobSeat }, facts => facts.putLease('Bob', { leaseId: 'replacement', heartbeatAt: 100, expiresAt: 100_000 }, bobSeat.generation));
    }
    return result;
  };
  const interrupted = await bob.perceive({ wait: '1ms' }, { signal: AbortSignal.timeout(2000) });
  assert.equal(interrupted.reason, 'replaced');
  assert.equal(replaced, true);
  assert.equal((await cell.read(facts => facts.receipt('Bob', 2))).value, undefined, 'a replaced lease cannot insert a receipt');

  artifact.transactAs = async (authority, change, signal) => {
    const result = await cell.transactAs(authority, change, signal);
    if (result.value?.activities?.length) {
      await cell.transactAs({ kind: 'participant', seat: bobSeat }, facts => facts.land({ kind: 'say', actor: 'Bob', body: 'later own activity', at: 200 }));
      await cell.transactAs({ kind: 'participant', seat: aliceSeat }, facts => {
        facts.land({ kind: 'say', actor: 'Alice', body: 'later for Bob', mentions: ['Bob'], at: 201 });
      });
      artifact.read = () => { throw new Error('committed selection must not be looked up again'); };
    }
    return result;
  };
  const perceived = await bob.perceive({ limit: 1 });
  assert.equal(typeof perceived.hint, 'string', 'the first perceive carries a hint');
  assert.deepEqual(perceived.activities, [{ id: 'act/2', kind: 'say', actor: 'Alice', body: 'first for Bob', mentions: ['Bob'], at: 100, perception: 'full', via: 'mention' }]);
  assert.equal(perceived.reason, 'drained');
  assert.equal(perceived.remaining, 1);
  assert.equal(perceived.standingCount, 2);
  assert.equal(perceived.now, 100);
  assert.equal(perceived.ownActivityCount, 0);
  assert.equal(perceived.hardCap, 5);
  assert.deepEqual((await cell.read(facts => ({
    receipt: facts.receipt('Bob', 2), remaining: facts.directedCount('Bob', { unseenOnly: true }),
    ownActivityCount: facts.participant('Bob').sayCount,
  }))).value, { receipt: { at: 100 }, remaining: 2, ownActivityCount: 1 });
});

test('a capped idle perceive through the shared SDK owner hydrates no bodies and writes no receipts', async t => {
  const cell = createArtifactPort(':memory:', { hardCap: 1, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  t.after(() => cell.close());
  const { counters, artifact } = instrumentCell(cell);
  const body = bodyFor('p0');
  const resource = await resourceWithArtifact(t, artifact);
  const alice = (await resource.join('Alice', { owner: body })).participant;
  const participant = (await resource.join('P0', { owner: body })).participant;
  await alice.express('pending for P0', { force: true, mentions: ['P0'] });
  await participant.express('only say', { force: true });
  const before = (await cell.read(facts => facts.receipt('P0', 2))).value;
  assert.equal(before, undefined);
  counters.hydrated = [];
  const perceived = await participant.perceive({ wait: '1ms' }, { signal: AbortSignal.timeout(2000) });
  assert.equal(perceived.reason, 'capped');
  assert.equal(perceived.remaining, 1);
  assert.deepEqual(perceived.activities, []);
  assert.equal(counters.hydrated.flat().length, 0);
  assert.equal((await cell.read(facts => facts.receipt('P0', 2))).value, before);
});
