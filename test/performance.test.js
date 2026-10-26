import assert from 'node:assert/strict';
import test from 'node:test';

import { renderCatchOutcome } from '../dist/cli/catch-presentation.js';
import { resourceWithArtifact } from './fixtures/resource-with-artifact.js';
import { createArtifactPort as createRealArtifactPort } from '../dist/artifact.js';
import { createTestArtifactPort as createArtifactPort } from './fixtures/test-artifact-port.js';
import { catchPresence } from '../dist/views.js';

/** Counts artifact callbacks and the activity rows/selectors each read actually asks for. */
function instrumentCell(cell) {
  const counters = { reads: 0, transacts: 0, hydrated: [], counts: [], directedPages: [] };
  const wrap = (facts) => Object.assign({}, facts, {
    activities: (indexes) => { counters.hydrated.push([...indexes]); return facts.activities(indexes); },
    activityCount: (filter) => { counters.counts.push({ method: 'activityCount', filter }); return facts.activityCount(filter); },
    directedCount: (recipient, filter) => { counters.counts.push({ method: 'directedCount', recipient, filter }); return facts.directedCount(recipient, filter); },
    directed: (recipient, filter, page) => { counters.directedPages.push({ recipient, filter, page }); return facts.directed(recipient, filter, page); },
  });
  return {
    counters,
    artifact: {
      ...cell,
      read: (select, signal) => { counters.reads += 1; return cell.read((facts) => select(wrap(facts)), signal); },
      transact: (change, signal) => { counters.transacts += 1; return cell.transact((facts) => change(wrap(facts)), signal); },
      transactAs: (authority, change, signal) => { counters.transacts += 1; return cell.transactAs(authority, (facts) => change(wrap(facts)), signal); },
    },
  };
}

function bodyFor(name) { return { channel: 'test', session: name.toLowerCase() }; }

async function establishSeat(cell, participant, at) {
  const body = bodyFor(participant);
  return (await cell.transactAs({ kind: 'join', participant, body }, (facts) => {
    const joined = facts.land({ kind: 'join', actor: participant, at });
    const seat = { participant, body, generation: `act/${joined.index}` };
    facts.storeSeat(seat);
    return seat;
  })).value;
}

/** The caller's seat comes from its own join authority; the rest of the history is seeded raw. */
async function stateWithHistory(unrelatedSays, participants = 96) {
  const cell = createArtifactPort(':memory:', {
    hardCap: null, preamble: [], warmup: ['test'], acts: [],
    runtime: { nextActIndex: 0, observations: {}, leases: {} },
  });
  await cell.transact((facts) => facts.land({ kind: 'join', actor: 'Alice', at: 0 }));
  const p0 = await establishSeat(cell, 'P0', 1);
  await cell.transact((facts) => {
    for (let index = 1; index < participants; index++) facts.land({ kind: 'join', actor: `P${index}`, at: index + 1 });
    for (let index = 0; index < unrelatedSays; index++) {
      facts.land({ kind: 'say', actor: 'Alice', at: index + 100, body: `dispatch ${index} @P0`, mentions: ['P0'] });
    }
  });
  return { cell, p0 };
}

test('catch hydrates only its page while the remaining count is a bounded fact read', async t => {
  const { cell, p0 } = await stateWithHistory(900);
  const { counters, artifact } = instrumentCell(cell);
  const square = await resourceWithArtifact(t, artifact, p0.body, () => 2_000);
  try {
    const caught = await (await square.participant('P0')).catch();
    assert.equal(caught.activities.length, 10);
    assert.equal(caught.remaining, 890);
    assert.deepEqual(counters.hydrated.flat(), Array.from({ length: 10 }, (_value, index) => index + 97));
    const remainingFact = counters.counts.find((entry) => entry.method === 'directedCount' && entry.filter.unseenOnly === true);
    assert.ok(remainingFact, 'remaining must come from an explicit unseen count, never from hydrated bodies');
    assert.equal(remainingFact.recipient, 'P0');
    assert.ok(counters.directedPages.every((page) => page.page.limit <= 100), 'directed pages stay bounded');
    assert.ok(counters.directedPages.some((page) => page.page.edge === 'oldest' && page.page.limit === 10));
  } finally {
    await cell.close();
  }
});

test('recipient hot reads do not hydrate unrelated history as the square grows', async t => {
  const measurements = [];
  for (const unrelated of [900, 1_800]) {
    const { cell, p0 } = await stateWithHistory(unrelated);
    const { counters, artifact } = instrumentCell(cell);
    try {
      const square = await resourceWithArtifact(t, artifact, p0.body, () => 2_000);
      const caught = await (await square.participant('P0')).catch();
      measurements.push({
        delivered: caught.activities.length,
        remaining: caught.remaining,
        hydrated: counters.hydrated.flat().length,
        largestBatch: Math.max(0, ...counters.hydrated.map((batch) => batch.length)),
        headReads: counters.counts.filter((entry) => entry.method === 'activityCount').length,
      });
    } finally {
      await cell.close();
    }
  }
  assert.deepEqual(measurements.map(({ delivered, remaining, hydrated, largestBatch }) => ({ delivered, remaining, hydrated, largestBatch })), [
    { delivered: 10, remaining: 890, hydrated: 10, largestBatch: 10 },
    { delivered: 10, remaining: 1_790, hydrated: 10, largestBatch: 10 },
  ]);
  assert.equal(measurements[0].headReads, measurements[1].headReads, 'selector cost must not scale with unrelated history');
});

test('catch keeps transaction-selected records and presence enrichment/rendering never rehydrates them', async t => {
  const { cell, p0 } = await stateWithHistory(900, 1);
  const { counters, artifact } = instrumentCell(cell);
  const square = await resourceWithArtifact(t, artifact, p0.body, () => 100_000);
  const measurements = () => structuredClone(counters);
  try {
    const participant = await square.participant('P0');
    const outcome = await participant.catch({ observe: true });
    const caught = outcome.observation;
    const caughtIds = Array.from({ length: 10 }, (_value, index) => `act/${index + 2}`);
    assert.deepEqual(outcome.activities.map(activity => activity.id), caughtIds);
    assert.equal(outcome.remaining, 890);
    assert.equal(caught.standingCount, 2);
    assert.deepEqual(caught.sayNumbers, Object.fromEntries(Array.from({ length: 10 }, (_value, index) => [index + 2, index + 1])));
    assert.deepEqual(counters.hydrated.flat(), caughtIds.map((id) => Number(id.slice(4))));

    const presence = (await artifact.read(facts => catchPresence(facts, 100_000))).value;
    assert.deepEqual(counters.hydrated.flat(), caughtIds.map((id) => Number(id.slice(4))), 'nearby enrichment must not re-fetch the committed page');
    const beforeRender = measurements();
    const output = renderCatchOutcome('memory', outcome);
    assert.equal(output.exitCode, 0);
    assert.match(output.stdout, /dispatch 0 @P0/);
    assert.doesNotMatch(output.stdout, /dispatch 899 @P0/);
    assert.match(output.stdout, /890 matching activities remain/);
    assert.deepEqual(measurements(), beforeRender);

    // A valid sender filter with no matching pending activity settles empty;
    // unrelated remaining activity cannot force body hydration for that result.
    const hydrationCount = counters.hydrated.length;
    const emptyOutcome = await participant.catch({ from: ['P0'], observe: true });
    assert.deepEqual(emptyOutcome.activities, []);
    assert.deepEqual(emptyOutcome.observation.sayNumbers, {});
    assert.equal(emptyOutcome.observation.standingCount, 2);
    assert.equal(counters.hydrated.length, hydrationCount, 'empty catch must not request body hydration');
    const beforeEmptyRender = measurements();
    const emptyOutput = renderCatchOutcome('memory', emptyOutcome, { from: ['P0'] });
    assert.equal(emptyOutput.exitCode, 0);
    assert.doesNotMatch(emptyOutput.stdout, /dispatch \d+ @P0/);
    assert.deepEqual(measurements(), beforeEmptyRender);
  } finally {
    await cell.close();
  }
});

test('catch fences selection and captures the page facts in its receipt transaction', async t => {
  const cell = createRealArtifactPort(':memory:', { hardCap: 5, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  t.after(() => cell.close());
  const artifact = { ...cell };
  const resource = await resourceWithArtifact(t, artifact, bodyFor('owner'));
  const alice = (await resource.join('Alice')).participant;
  const bob = (await resource.join('Bob')).participant;
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
  const interrupted = await bob.catch({ idle: 1 }, { signal: AbortSignal.timeout(2000) });
  assert.equal(interrupted.status, 'replaced');
  assert.equal(replaced, true);
  assert.deepEqual((await cell.read(facts => facts.receiptAssignments())).value, [], 'a replaced lease cannot insert a receipt');

  artifact.transactAs = async (authority, change, signal) => {
    const result = await cell.transactAs(authority, change, signal);
    if (result.value?.activities?.length) {
      await cell.transactAs({ kind: 'participant', seat: bobSeat }, facts => facts.land({ kind: 'say', actor: 'Bob', body: 'later own activity', at: 200 }));
      await cell.transactAs({ kind: 'participant', seat: aliceSeat }, facts => {
        facts.land({ kind: 'say', actor: 'Alice', body: 'later for Bob', mentions: ['Bob'], at: 201 });
        facts.land({ kind: 'hold', actor: 'Alice', body: 'later hold', at: 202 });
      });
      artifact.read = () => { throw new Error('committed selection must not be looked up again'); };
    }
    return result;
  };
  const caught = await bob.catch({ limit: 1, observe: true });
  assert.equal(typeof caught.hint, 'string', 'the first catch carries a hint');
  assert.deepEqual(caught.activities, [{ id: 'act/2', kind: 'say', actor: 'Alice', body: 'first for Bob', mentions: ['Bob'], at: 100, perception: 'full' }]);
  assert.equal(caught.consumedThrough, 'act/2');
  assert.equal(caught.remaining, 1);
  assert.deepEqual(caught.observation.sayNumbers, { 2: 1 });
  assert.equal(caught.observation.standingCount, 2);
  assert.equal(caught.observation.held, false);
  assert.equal(caught.observation.now, 100);
  assert.equal(caught.observation.ownActivityCount, 0);
  assert.equal(caught.observation.hardCap, 5);
  assert.equal(caught.observation.enrichmentUnavailable, true);
  assert.deepEqual((await cell.read(facts => ({
    receipt: facts.receipt('Bob', 2), remaining: facts.directedCount('Bob', { unseenOnly: true }),
    held: facts.hold().active, ownActivityCount: facts.participant('Bob').sayCount,
  }))).value, { receipt: { at: 100 }, remaining: 2, held: true, ownActivityCount: 1 });
});

test('a capped idle catch through the shared SDK owner hydrates no bodies and writes no receipts', async t => {
  const cell = createRealArtifactPort(':memory:', { hardCap: 1, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  t.after(() => cell.close());
  const { counters, artifact } = instrumentCell(cell);
  const resource = await resourceWithArtifact(t, artifact, bodyFor('p0'));
  await resource.join('Alice');
  const participant = (await resource.join('P0')).participant;
  await participant.express('only say', { force: true });
  const before = (await cell.read(facts => facts.receiptAssignments())).value;
  counters.hydrated = [];
  const caught = await participant.catch({ idle: 1 }, { signal: AbortSignal.timeout(2000) });
  assert.deepEqual(caught, { activities: [], consumedThrough: 'act/2', idleExpired: false, remaining: 0, status: 'capped' });
  assert.equal(counters.hydrated.flat().length, 0);
  assert.deepEqual((await cell.read(facts => facts.receiptAssignments())).value, before);
});
