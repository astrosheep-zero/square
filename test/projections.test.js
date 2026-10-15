import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryCell } from '../dist/square-storage.js';
import { applicationHistory, catchPresence, entryPresentation, history, historyPresentation, participantsPresentation, recoveryObservation, resolveParticipant, snapshot, statusPresentation, streamProjection } from '../dist/views.js';

function fixture(acts, observations = {}) {
  return { hardCap: null, preamble: ['context', '---'], warmup: ['scene'], acts,
    runtime: { nextActIndex: (acts.at(-1)?.index ?? -1) + 1, observations, leases: {} } };
}
function measuredSquare(state) {
  const cell = createMemoryCell(state);
  const reads = { batches: [], singles: [], directed: 0, ordinals: [] };
  const artifact = { ...cell, read(select, signal) {
    return cell.read((facts) => select(new Proxy(facts, { get(target, key) {
      const method = target[key];
      return (...args) => {
        if (key === 'activities') reads.batches.push([...args[0]]);
        if (key === 'activity') reads.singles.push(args[0]);
        if (key === 'directed') reads.directed++;
        if (key === 'sayOrdinals') reads.ordinals.push([...args[0]]);
        return method.apply(target, args);
      };
    } })), signal);
  } };
  return { square: { artifact, location: 'memory', clock: () => 100_000 }, reads, cell };
}

test('recovery observes caller gates and bounded unread previews without selecting an expression feed', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0, index: 0 },
    { kind: 'join', actor: 'Bob', at: 1, index: 1 },
    { kind: 'say', actor: 'Bob', at: 2, index: 2, body: 'own', mentions: [] },
  ];
  for (let index = 3; index <= 10; index++) acts.push({ kind: 'say', actor: 'Alice', at: index, index, body: String(index), mentions: ['Bob'] });
  acts.push({ kind: 'hold', actor: 'Bob', at: 11, index: 11, body: 'pause' });
  const state = fixture(acts);
  state.hardCap = 5;
  const { square, reads, cell } = measuredSquare(state);
  try {
    const before = (await cell.read((facts) => facts.receiptAssignments())).value;
    assert.deepEqual(await resolveParticipant(square, 'BOB'), { name: 'Bob' });
    const recovered = await recoveryObservation(square, 'BOB');
    assert.deepEqual(recovered, {
      name: 'Bob', roster: ['Alice', 'Bob'], participantCount: 2,
      held: true, holdReason: 'pause', ownActivityCount: 1, hardCap: 5,
      activitySummaries: [{ name: 'Alice', count: 8, latestActivityAgeMs: 99_990,
        previews: [8, 9, 10].map((index) => ({ number: index - 2, act: acts[index], perception: 'full' })),
      }],
    });
    assert.deepEqual(reads.batches, [[8, 9, 10]]);
    assert.deepEqual(reads.ordinals, []);
    assert.deepEqual((await cell.read((facts) => facts.receiptAssignments())).value, before);
  } finally { await cell.close(); }
});

test('entry hydrates only its newest public page and numbers lifetime says', async () => {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0, index: 0 }, { kind: 'join', actor: 'Bob', at: 1, index: 1 }];
  for (let index = 2; index < 242; index++) acts.push({ kind: 'say', actor: 'Alice', at: index, index, body: String(index), mentions: ['Bob'] });
  acts.push({ kind: 'listen', actor: 'Bob', target: 'Alice', at: 242, index: 242 });
  const { square, reads, cell } = measuredSquare(fixture(acts));
  try {
    const entry = await entryPresentation(square, 'BOB', 3);
    assert.deepEqual(entry.recentActivities.map((a) => a.index), [239, 240, 241]);
    assert.deepEqual(entry.sayNumbers, { 239: 238, 240: 239, 241: 240 });
    assert.deepEqual(Object.values(entry.perceptions), ['full', 'full', 'full']);
    assert.deepEqual(reads.batches, [[239, 240, 241]]);
    assert.deepEqual(reads.ordinals, [[239, 240, 241]]);
    assert.equal(entry.joinContext, 'context');
    assert.equal(entry.joinedBefore, false);
    const ambient = await entryPresentation(square, '', 1);
    assert.equal(ambient.perceptions[241], 'presence');
  } finally { await cell.close(); }
});

test('history keeps traversing audience pages through empty intersections and limits after search', async () => {
  const acts = ['Alice', 'Bob', 'Cara'].map((actor, index) => ({ kind: 'join', actor, at: index, index }));
  for (let index = 3; index < 208; index++) acts.push({ kind: 'say', actor: 'Alice', at: index, index, body: 'unrelated', mentions: ['Bob'] });
  acts.push({ kind: 'say', actor: 'Cara', at: 208, index: 208, body: 'first needle', mentions: ['Bob'] });
  acts.push({ kind: 'say', actor: 'Cara', at: 209, index: 209, body: 'second needle', mentions: ['Bob'] });
  const { square, reads, cell } = measuredSquare(fixture(acts));
  try {
    const selected = await historyPresentation(square, { participants: ['CARA'], mention: 'bob', grep: 'needle', lastN: 1, order: 'desc' });
    assert.deepEqual(selected.activities.map((a) => a.index), [209]);
    assert.equal(selected.totalMatches, 2);
    assert.equal(selected.publicBefore, true);
    assert.equal(selected.publicAfter, false);
    assert.equal(selected.sayNumbers[209], 2);
    assert.deepEqual(selected.visibleActivities.map((activity) => activity.index), [209]);
    assert.deepEqual(selected.continuation, { direction: 'before', cursor: 'act/209', limit: 1 });
    assert.deepEqual(selected.bounds, { limit: 1, maxLimit: 100, contextWindow: false });
    assert.equal(reads.directed, 3);
    assert.deepEqual(reads.batches.filter((ids) => ids.length > 0), [[208, 209], [209]]);
    const byId = await history(square, { mention: 'Bob', grep: '^act/208$', limit: 1 });
    assert.deepEqual(byId.map((a) => a.id), ['act/208']);
    const first = await history(square, { after: 'act/207', mention: 'Bob', limit: 1, order: 'desc' });
    assert.deepEqual(first.map((a) => a.id), ['act/208']);
  } finally { await cell.close(); }
});

test('context uses existing activity positions while facade omits read and CLI raw windows retain it', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0, index: 0 },
    { kind: 'say', actor: 'Alice', at: 1, index: 7, body: 'before' },
    { kind: 'read', actor: 'Alice', at: 2, index: 50, through: 7 },
    { kind: 'hold', at: 3, index: 80 },
    { kind: 'say', actor: 'Alice', at: 4, index: 101, body: 'after' },
  ];
  const { square, cell } = measuredSquare(fixture(acts));
  try {
    const raw = await historyPresentation(square, { atIndexes: [50], beforeContext: 1, afterContext: 1, lastN: null });
    assert.deepEqual(raw.activities.map((a) => a.index), [7, 50, 80]);
    assert.deepEqual(raw.visibleActivities.map((a) => a.index), [7, 80]);
    assert.deepEqual(raw.bounds, { limit: null, maxLimit: 100, contextWindow: true });
    const application = await applicationHistory(square, { at: ['act/50'], contextBefore: 1, contextAfter: 1 });
    assert.deepEqual(application.projection.activities.map((activity) => activity.index), [7, 50, 80]);
    assert.deepEqual(application.data.activities.map((activity) => activity.id), ['act/7']);
    assert.equal(application.projection.continuation, undefined);
    const ordinary = await historyPresentation(square, { lastN: 3 });
    assert.deepEqual(ordinary.activities.map((a) => a.index), [7, 80, 101]);
    const facade = await history(square, { before: 'act/80', limit: 3 });
    assert.deepEqual(facade.map((a) => a.id), ['act/0', 'act/7']);
    const after = await history(square, { after: 'act/0', before: undefined, limit: 1, order: 'desc' });
    assert.deepEqual(after.map((a) => a.id), ['act/7']);
  } finally { await cell.close(); }
});

test('status settles viewer perception and retains exact-spelling rejoin annotations', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0, index: 0 },
    { kind: 'join', actor: 'Bob', at: 1, index: 1 },
    { kind: 'done', actor: 'Bob', at: 2, index: 2 },
    { kind: 'say', actor: 'Alice', at: 3, index: 3, body: 'private', mentions: [] },
    { kind: 'join', actor: 'Cara', at: 4, index: 4 },
    { kind: 'join', actor: 'bob', at: 5, index: 5 },
    { kind: 'join', actor: 'Bob', at: 6, index: 6 },
    { kind: 'join', actor: 'Dan', at: 7, index: 7 },
  ];
  const { square, reads, cell } = measuredSquare(fixture(acts));
  try {
    const projection = await statusPresentation(square, '');
    assert.equal(projection.latestPerception, 'presence');
    assert.equal(projection.latestActNumber, 1);
    assert.equal(projection.joinCount, 4);
    assert.deepEqual(projection.joins.map(({ activity, rejoined }) => [activity.index, rejoined]), [[5, false], [6, true], [7, false]]);
    assert.deepEqual(reads.batches, [[5, 6, 7]]);
    assert.deepEqual(reads.singles, [3]);
    const own = await statusPresentation(square, 'ALICE');
    assert.equal(own.latestPerception, 'full');
    assert.equal(own.viewer, 'Alice');
    assert.deepEqual(own.attentionNames, ['Alice']);
  } finally { await cell.close(); }
});

test('SDK delivered closure detaches exact raw assignments including orphan coordinates', async () => {
  const acts = [{ kind: 'join', actor: 'Bob', at: 0, index: 0 }, { kind: 'say', actor: 'Bob', at: 1, index: 5, body: 'own' }];
  const { square, cell } = measuredSquare(fixture(acts, {
    Bob: { 'act/3': { state: 'seen', at: 10 } },
    bob: { 'act/4': { state: 'seen', at: 11 } },
    Unknown: { 'act/2': { state: 'seen', at: 12 } },
  }));
  const detached = await snapshot(square);
  await cell.transact((facts) => facts.markSeen('Bob', [5], 20));
  await cell.close();
  assert.equal(detached.delivered('BOB', 'act/3'), true);
  assert.equal(detached.delivered('bob', 'act/4'), false);
  assert.equal(detached.delivered('Unknown', 'act/2'), true);
  assert.equal(detached.delivered('unknown', 'act/2'), false);
  assert.equal(detached.delivered('Bob', 'act/5'), false);
  assert.throws(() => detached.delivered('Bob', 'bad'), /Invalid activity id/);
});

test('recipient stream advances a raw page without bodies and retains seen pre-rejoin history', async () => {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0, index: 0 }, { kind: 'join', actor: 'Bob', at: 1, index: 1 }];
  for (let index = 2; index < 102; index++) acts.push({ kind: 'say', actor: 'Alice', at: index, index, body: 'not for Bob' });
  acts.push({ kind: 'say', actor: 'Alice', at: 102, index: 102, body: 'historical', mentions: ['Bob'] });
  acts.push({ kind: 'done', actor: 'Bob', at: 103, index: 103 });
  acts.push({ kind: 'join', actor: 'bob', at: 104, index: 104 });
  const { square, reads, cell } = measuredSquare(fixture(acts, { Bob: { 'act/102': { state: 'seen', at: 200 } } }));
  try {
    const empty = await streamProjection(square, -1, 'bob');
    assert.deepEqual(empty.activities, []);
    assert.equal(empty.cursor, 99);
    assert.equal(empty.hasMore, true);
    assert.deepEqual(reads.batches, [[]]);
    const historical = await streamProjection(square, empty.cursor, 'BOB');
    assert.deepEqual(historical.activities.map(({ activity, route }) => [activity.index, route]), [[102, 'mention']]);
    assert.equal(historical.cursor, 104);
    assert.equal(historical.hasMore, false);
    assert.deepEqual(reads.batches, [[], [102]]);
  } finally { await cell.close(); }
});

test('presence classifications and nearby watch participants are settled by projections without writes', async () => {
  const now = 100_000;
  const state = fixture([
    { kind: 'join', actor: 'Old', at: now - 9 * 60 * 60_000, index: 0 },
    { kind: 'join', actor: 'Watcher', at: now - 9 * 60 * 60_000, index: 1 },
    { kind: 'join', actor: 'Lingering', at: now - 60 * 60_000, index: 2 },
    { kind: 'join', actor: 'Recent', at: now - 1000, index: 3 },
    { kind: 'join', actor: 'Done', at: now - 9 * 60 * 60_000, index: 4 },
    { kind: 'done', actor: 'Done', at: now - 9 * 60 * 60_000, index: 5 },
  ]);
  state.runtime.leases.Watcher = { leaseId: 'watching', heartbeatAt: now, expiresAt: now + 60_000 };
  const { square, reads, cell } = measuredSquare(state);
  try {
    const before = (await cell.read((facts) => ({ receipts: facts.receiptAssignments(), lease: facts.lease('Watcher'), header: facts.header() }))).value;
    const participants = await participantsPresentation(square);
    const status = await statusPresentation(square, 'Recent');
    assert.deepEqual(participants.classificationByName, { Old: 'lingering', Watcher: 'here', Lingering: 'lingering', Recent: 'here', Done: 'done' });
    assert.deepEqual(participants.orderedHere.map((participant) => participant.name), ['Watcher', 'Recent']);
    assert.equal(participants.lingeringCount, 2);
    assert.deepEqual(status.classificationByName, participants.classificationByName);
    assert.deepEqual(status.orderedHere, participants.orderedHere);
    const bodyReads = { batches: reads.batches.length, singles: reads.singles.length, ordinals: reads.ordinals.length };
    const presence = await catchPresence(square);
    assert.deepEqual(new Set(presence.participants.map((participant) => participant.name)), new Set(['Watcher', 'Lingering', 'Recent', 'Done']));
    assert.equal(presence.now, now);
    assert.deepEqual({ batches: reads.batches.length, singles: reads.singles.length, ordinals: reads.ordinals.length }, bodyReads);
    assert.deepEqual((await cell.read((facts) => ({ receipts: facts.receiptAssignments(), lease: facts.lease('Watcher'), header: facts.header() }))).value, before);
  } finally { await cell.close(); }
});
