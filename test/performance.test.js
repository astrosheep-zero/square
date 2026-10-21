import assert from 'node:assert/strict';
import test from 'node:test';

import { renderCatchOutcome } from '../dist/cli/catch-presentation.js';
import { Square } from '../dist/square-api.js';
import { catchUp } from '../dist/square-actions.js';
import { createArtifactPort } from '../dist/artifact.js';
import { catchPresence, toPublicActivity } from '../dist/views.js';

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
      read: (select, signal) => { counters.reads += 1; return cell.read((facts) => select(wrap(facts)), signal); },
      transact: (change, signal) => { counters.transacts += 1; return cell.transact((facts) => change(wrap(facts)), signal); },
      revision: (signal) => cell.revision(signal),
      changed: (since, timeout, signal) => cell.changed(since, timeout, signal),
      close: () => cell.close(),
    },
  };
}

function stateWithHistory(unrelatedSays, participants = 96) {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0 }];
  for (let index = 0; index < participants; index++) acts.push({ kind: 'join', actor: `P${index}`, at: index + 1 });
  for (let index = 0; index < unrelatedSays; index++) {
    acts.push({ kind: 'say', actor: 'Alice', at: index + 100, body: `dispatch ${index} @P0`, mentions: ['P0'] });
  }
  return {
    hardCap: null,
    preamble: [],
    warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { nextActIndex: acts.length, observations: {}, leases: {} },
  };
}

test('catch hydrates only its page while the remaining count is a bounded fact read', async () => {
  const cell = createArtifactPort(':memory:', stateWithHistory(900));
  const { counters, artifact } = instrumentCell(cell);
  const square = { artifact, clock: () => 2_000, location: 'memory' };
  try {
    const caught = await catchUp(square, 'P0');
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

test('recipient hot reads do not hydrate unrelated history as the square grows', async () => {
  const measurements = [];
  for (const unrelated of [900, 1_800]) {
    const cell = createArtifactPort(':memory:', stateWithHistory(unrelated));
    const { counters, artifact } = instrumentCell(cell);
    try {
      const caught = await catchUp({ artifact, clock: () => 2_000, location: 'memory' }, 'P0');
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

test('catch keeps transaction-selected records and presence enrichment/rendering never rehydrates them', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0 },
    { kind: 'join', actor: 'P0', at: 1 },
    ...Array.from({ length: 900 }, (_value, index) => ({ kind: 'say', actor: 'Alice', at: index + 2, body: `dispatch ${index} @P0`, mentions: ['P0'] })),
  ];
  const cell = createArtifactPort(':memory:', {
    hardCap: null, preamble: [], warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { nextActIndex: acts.length, observations: {}, leases: {} },
  });
  const { counters, artifact } = instrumentCell(cell);
  const square = { artifact, clock: () => 100_000, location: 'memory' };
  const measurements = () => structuredClone(counters);
  try {
    const caught = await catchUp(square, 'P0');
    const caughtIds = Array.from({ length: 10 }, (_value, index) => `act/${index + 2}`);
    assert.deepEqual(caught.activities.map((activity) => `act/${activity.index}`), caughtIds);
    assert.equal(caught.remaining, 890);
    assert.equal(caught.standingCount, 2);
    assert.deepEqual(caught.sayNumbers, Object.fromEntries(Array.from({ length: 10 }, (_value, index) => [index + 2, index + 1])));
    assert.deepEqual(counters.hydrated.flat(), caughtIds.map((id) => Number(id.slice(4))));

    const presence = await catchPresence(square);
    assert.deepEqual(counters.hydrated.flat(), caughtIds.map((id) => Number(id.slice(4))), 'nearby enrichment must not re-fetch the committed page');
    // Compose transaction selection and optional presence in the concrete catch result.
    const { activities, consumedThrough, remaining, terminalStatus, ...observation } = caught;
    const data = { activities: activities.map((activity) => ({ ...toPublicActivity(activity), perception: 'full' })), consumedThrough, remaining, idleExpired: false };
    const outcome = { ...data, observation: { ...observation, presence,
      location: 'memory', participant: 'P0',
      automaticDeliveryAvailable: false, waitStarted: false, replaced: false,
    } };
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
    const settled = await catchUp(square, 'P0', { from: ['P0'] });
    assert.deepEqual(settled.activities, []);
    assert.deepEqual(settled.sayNumbers, {});
    assert.equal(settled.standingCount, 2);
    assert.equal(counters.hydrated.length, hydrationCount, 'empty catch must not request body hydration');
    const { activities: emptyActivities, consumedThrough: emptyCursor, remaining: emptyRemaining, terminalStatus: emptyTerminal, ...emptyObservation } = settled;
    const emptyData = { activities: emptyActivities, consumedThrough: emptyCursor, remaining: emptyRemaining, idleExpired: false };
    const emptyOutcome = { ...emptyData, observation: { ...emptyObservation, presence,
      location: 'memory', participant: 'P0',
      automaticDeliveryAvailable: false, stop: 'empty-now', waitStarted: false, replaced: false,
    } };
    const beforeEmptyRender = measurements();
    const emptyOutput = renderCatchOutcome('memory', emptyOutcome, { from: ['P0'] });
    assert.equal(emptyOutput.exitCode, 0);
    assert.doesNotMatch(emptyOutput.stdout, /dispatch \d+ @P0/);
    assert.deepEqual(measurements(), beforeEmptyRender);
  } finally {
    await cell.close();
  }
});

test('catch fences selection and captures the page facts in its receipt transaction', async () => {
  const resource = Square.inMemory({ markdown: 'test', hardCap: 5, clock: () => 100 });
  try {
    const alice = (await resource.join('Alice')).participant;
    await resource.join('Bob');
    await alice.express('first for Bob', { force: true, mentions: ['Bob'] });
    await alice.express('second for Bob', { force: true, mentions: ['Bob'] });
    const square = resource.square;
    const cell = square.artifact;
    await cell.transact((facts) => facts.putLease('Bob', { leaseId: 'replacement', heartbeatAt: 100, expiresAt: 100_000 }));
    const revision = await cell.revision();
    assert.equal(await catchUp(square, 'Bob', {}, undefined, 'old'), null);
    assert.equal(await cell.revision(), revision, 'a replaced lease cannot insert a receipt');
    const artifact = {
      ...cell,
      read: () => { throw new Error('committed selection must not be looked up again'); },
      async transact(change, signal) {
        const result = await cell.transact(change, signal);
        await cell.transact((facts) => {
          facts.land({ kind: 'say', actor: 'Bob', body: 'later own activity', at: 200 });
          facts.land({ kind: 'say', actor: 'Alice', body: 'later for Bob', mentions: ['Bob'], at: 201 });
          facts.land({ kind: 'hold', actor: 'Alice', body: 'later hold', at: 202 });
        });
        return result;
      },
    };
    const caught = await catchUp({ ...square, artifact }, 'Bob', { limit: 1 }, undefined, 'replacement');
    assert.deepEqual(caught, {
      participant: 'Bob', activities: [{ kind: 'say', actor: 'Alice', body: 'first for Bob', mentions: ['Bob'], index: 2, at: 100 }],
      consumedThrough: 'act/2', remaining: 1, sayNumbers: { 2: 1 }, standingCount: 2,
      held: false, now: 100, ownActivityCount: 0, hardCap: 5, terminalStatus: undefined,
    });
    assert.deepEqual((await cell.read((facts) => ({
      receipt: facts.receipt('Bob', 2), remaining: facts.directedCount('Bob', { unseenOnly: true }),
      held: facts.hold().active, ownActivityCount: facts.participant('Bob').sayCount,
    }))).value, { receipt: { at: 100 }, remaining: 2, held: true, ownActivityCount: 1 });
  } finally {
    await resource.close();
  }
});

test('a capped idle catch through the shared SDK owner hydrates no bodies and writes no receipts', async () => {
  const resource = Square.inMemory({ markdown: 'test', hardCap: 1, clock: () => 100 });
  try {
    await resource.join('Alice');
    const participant = (await resource.join('P0')).participant;
    await participant.express('only say', { force: true });
    const cell = resource.square.artifact;
    const before = (await cell.read((facts) => facts.receiptAssignments())).value;
    const { counters, artifact } = instrumentCell(cell);
    resource.square.artifact = artifact;
    const caught = await participant.catch({ idle: 1 }, { signal: AbortSignal.timeout(2000) });
    assert.deepEqual(caught, { activities: [], consumedThrough: 'act/2', idleExpired: false, remaining: 0, status: 'capped' });
    assert.equal(counters.hydrated.flat().length, 0);
    assert.deepEqual((await cell.read((facts) => facts.receiptAssignments())).value, before);
  } finally {
    await resource.close();
  }
});
