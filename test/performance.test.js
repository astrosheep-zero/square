import assert from 'node:assert/strict';
import test from 'node:test';

import { renderWatchOutput } from '../dist/presentation.js';
import { catchUp } from '../dist/square-actions.js';
import { createMemoryCell } from '../dist/square-storage.js';
import { watchPresentation } from '../dist/views.js';

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
  const cell = createMemoryCell(stateWithHistory(900));
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
    const cell = createMemoryCell(stateWithHistory(unrelated));
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

test('watch hydrates only the caught page and settled rendering asks the artifact for nothing', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0 },
    { kind: 'join', actor: 'P0', at: 1 },
    ...Array.from({ length: 900 }, (_value, index) => ({ kind: 'say', actor: 'Alice', at: index + 2, body: `dispatch ${index} @P0`, mentions: ['P0'] })),
  ];
  const cell = createMemoryCell({
    hardCap: null, preamble: [], warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { nextActIndex: acts.length, observations: {}, leases: {} },
  });
  const { counters, artifact } = instrumentCell(cell);
  const square = { artifact, clock: () => 100_000, location: 'memory' };
  try {
    const caughtIds = Array.from({ length: 10 }, (_value, index) => `act/${index + 2}`);
    const watch = await watchPresentation(square, 'P0', caughtIds);
    assert.equal(watch.activities.length, 10);
    assert.equal(Object.keys(watch.sayNumbers).length, 10);
    assert.deepEqual(counters.hydrated.flat(), caughtIds.map((id) => Number(id.slice(4))));

    const settled = await watchPresentation(square, 'P0');
    assert.deepEqual(settled.activities, []);
    assert.deepEqual(counters.hydrated.at(-1), [], 'a settled watch without a caught page hydrates no bodies');

    const beforeRender = structuredClone({ reads: counters.reads, transacts: counters.transacts, hydrated: counters.hydrated, counts: counters.counts });
    const perceptions = new Map(watch.activities.map((activity) => [activity.index, 'full']));
    const output = renderWatchOutput(watch.activities, watch.sayNumbers, { viewer: 'P0', perceptions });
    assert.match(output, /dispatch 0 @P0/);
    assert.doesNotMatch(output, /dispatch 899 @P0/);
    assert.deepEqual({ reads: counters.reads, transacts: counters.transacts, hydrated: counters.hydrated, counts: counters.counts }, beforeRender);
  } finally {
    await cell.close();
  }
});

test('a terminal watch hydrates no bodies at all', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0 },
    { kind: 'join', actor: 'P0', at: 1 },
    { kind: 'say', actor: 'P0', at: 2, body: 'only say' },
  ];
  const cell = createMemoryCell({
    hardCap: 1, preamble: [], warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { nextActIndex: acts.length, observations: {}, leases: {} },
  });
  const { counters, artifact } = instrumentCell(cell);
  try {
    const watch = await watchPresentation({ artifact, clock: () => 100, location: 'memory' }, 'P0');
    assert.equal(watch.terminalStatus, 'capped');
    assert.deepEqual(watch.activities, []);
    assert.equal(counters.hydrated.flat().length, 0);
  } finally {
    await cell.close();
  }
});
