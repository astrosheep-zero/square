import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSquareFile } from '../dist/artifact.js';
import { createTestArtifactPort as createArtifactPort } from './fixtures/test-artifact-port.js';
import { Square } from '../dist/square-api.js';
import { resolveKnownName } from '../dist/decisions.js';
import { catchPresence, entryPresentation, selectHistory, NON_READ, queryParticipants, recoveryObservation, snapshot, queryStatus, streamProjection } from '../dist/views.js';
import { renderLifecycleResult, renderStatusResult } from '../dist/operation-presentation.js';

const queryContext = { location: 'memory', now: 100_000, automaticDeliveryAvailable: false };

function fixture(acts, observations = {}) {
  return { hardCap: null, preamble: ['context', '---'], warmup: ['scene'], acts,
    runtime: { nextActIndex: (acts.at(-1)?.index ?? -1) + 1, observations, leases: {} } };
}
async function archiveSquare(t, state) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const squarePath = path.join(root, 'archive.square');
  await createSquareFile(squarePath, state);
  const square = await Square.at({ cwd: root, path: squarePath, clock: () => 100_000,
    env: { ...process.env, SQUARE_REGISTRY: path.join(root, 'registry') } });
  t.after(() => square.close());
  return square;
}
function measuredSquare(state) {
  const cell = createArtifactPort(':memory:', state);
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
  for (let index = 3; index <= 10; index++) acts.push({ kind: 'say', actor: 'Alice', at: index === 3 ? 40 : index, index, body: String(index), mentions: ['Bob'] });
  acts.push({ kind: 'hold', actor: 'Bob', at: 11, index: 11, body: 'pause' });
  const state = fixture(acts);
  state.hardCap = 5;
  const { square, reads, cell } = measuredSquare(state);
  try {
    const before = (await cell.read((facts) => facts.receiptAssignments())).value;
    assert.equal((await square.artifact.read(facts => resolveKnownName(facts, 'BOB'))).value, 'Bob');
    const recovered = (await square.artifact.read(facts => recoveryObservation(facts, 'BOB', square.clock()))).value;
    assert.deepEqual(recovered, {
      participant: 'Bob', standingCount: 2,
      held: true, ownActivityCount: 1, hardCap: 5,
      activitySummaries: [{ name: 'Alice', count: 8, latestActivityAgeMs: 99_960, preview: acts[10] }],
    });
    assert.deepEqual(reads.batches, [[10]], 'preview follows greatest index, age follows greatest timestamp');
    assert.deepEqual(reads.ordinals, []);
    assert.deepEqual((await cell.read((facts) => facts.receiptAssignments())).value, before);
  } finally { await cell.close(); }
});

test('unread summaries retain sender spelling, seen rows beyond a hole, and the last index across pages', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0, index: 0 },
    { kind: 'join', actor: 'Bob', at: 1, index: 1 },
    { kind: 'join', actor: 'Cara', at: 2, index: 2 },
  ];
  for (let index = 3; index <= 102; index++)
    acts.push({ kind: 'say', actor: 'Alice', at: index === 3 ? 900 : 4, index, body: `Alice ${index}`, mentions: ['Bob'] });
  acts.push({ kind: 'say', actor: 'Cara', at: 1000, index: 103, body: 'already seen after a gap', mentions: ['Bob'] });
  acts.push({ kind: 'say', actor: 'alice', at: 5, index: 104, body: 'different spelling', mentions: ['Bob'] });
  const { square, reads, cell } = measuredSquare(fixture(acts, { Bob: { 'act/103': { state: 'seen', at: 2000 } } }));
  try {
    const recovered = (await square.artifact.read(facts => recoveryObservation(facts, 'Bob', 100_000))).value;
    assert.deepEqual(recovered.activitySummaries.map(({ name, count, latestActivityAgeMs, preview }) =>
      [name, count, latestActivityAgeMs, preview.index]), [
      ['Cara', 1, 99_000, 103], ['Alice', 100, 99_100, 102], ['alice', 1, 99_995, 104],
    ]);
    assert.deepEqual(reads.batches, [[102, 103, 104]]);
    assert.ok(reads.directed >= 3, 'the directed suffix spans pages after the cursor query');
  } finally { await cell.close(); }
});

test('entry hydrates only its newest public page and settles viewer perception without ordinals', async () => {
  const acts = [{ kind: 'join', actor: 'Alice', at: 0, index: 0 }, { kind: 'join', actor: 'Bob', at: 1, index: 1 }];
  for (let index = 2; index < 242; index++) acts.push({ kind: 'say', actor: 'Alice', at: index, index, body: String(index), mentions: ['Bob'] });
  acts.push({ kind: 'listen', actor: 'Bob', target: 'Alice', at: 242, index: 242 });
  const { square, reads, cell } = measuredSquare(fixture(acts));
  try {
    const entry = (await square.artifact.read(facts => entryPresentation(facts, 'BOB', 3))).value;
    assert.deepEqual(entry.recentActivities.map((a) => a.id), ['act/239', 'act/240', 'act/241']);
    assert.deepEqual(entry.recentActivities.map((a) => a.perception), ['full', 'full', 'full']);
    assert.deepEqual(reads.batches, [[239, 240, 241]]);
    assert.deepEqual(reads.ordinals, []);
    assert.equal(entry.joinContext, 'context');
    assert.equal(entry.joinedBefore, false);
    const ambient = (await square.artifact.read(facts => entryPresentation(facts, '', 1))).value;
    assert.equal(ambient.recentActivities[0].perception, 'presence');
  } finally { await cell.close(); }
});

test('history keeps traversing audience pages through empty intersections and limits after search', async (t) => {
  const acts = ['Alice', 'Bob', 'Cara'].map((actor, index) => ({ kind: 'join', actor, at: index, index }));
  for (let index = 3; index < 208; index++) acts.push({ kind: 'say', actor: 'Alice', at: index, index, body: 'unrelated', mentions: ['Bob'] });
  acts.push({ kind: 'say', actor: 'Cara', at: 208, index: 208, body: 'first needle', mentions: ['Bob'] });
  acts.push({ kind: 'say', actor: 'Cara', at: 209, index: 209, body: 'second needle', mentions: ['Bob'] });
  const { square, reads, cell } = measuredSquare(fixture(acts));
  try {
    const query = { from: ['CARA'], mention: 'bob', grep: 'needle', limit: 1, order: 'desc' };
    const selected = (await square.artifact.read((facts) => selectHistory(facts, query, query.limit, NON_READ))).value;
    assert.deepEqual(selected.activities.map((a) => a.index), [209]);
    assert.equal(selected.totalMatches, 2);
    assert.deepEqual(selected.visibleActivities.map((activity) => activity.index), [209]);
    assert.deepEqual(selected.continuation, { direction: 'before', cursor: 'act/209', limit: 1 });
    const app = await archiveSquare(t, fixture(acts));
    const outcome = await app.history({ ...query, observe: true });
    assert.equal(outcome.observation.sayNumbers[209], 2);
    assert.deepEqual(outcome.observation.continuation, selected.continuation);
    assert.deepEqual(outcome.activities.map((activity) => activity.id), ['act/209']);
    assert.equal(reads.directed, 3);
    assert.deepEqual(reads.batches.filter((ids) => ids.length > 0), [[208, 209], [209]]);
    const byId = (await app.history({ mention: 'Bob', grep: '^act/208$', limit: 1 })).activities;
    assert.deepEqual(byId.map((a) => a.id), ['act/208']);
    const first = (await app.history({ after: 'act/207', mention: 'Bob', limit: 1, order: 'desc' })).activities;
    assert.deepEqual(first.map((a) => a.id), ['act/208']);
  } finally { await cell.close(); }
});

test('context uses existing activity positions while facade omits read and CLI raw windows retain it', async (t) => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0, index: 0 },
    { kind: 'say', actor: 'Alice', at: 1, index: 7, body: 'before' },
    { kind: 'read', actor: 'Alice', at: 2, index: 50, through: 7 },
    { kind: 'hold', at: 3, index: 80 },
    { kind: 'say', actor: 'Alice', at: 4, index: 101, body: 'after' },
  ];
  const { square, cell } = measuredSquare(fixture(acts));
  try {
    const app = await archiveSquare(t, fixture(acts));
    const application = await app.history({ observe: true, at: ['act/50'], contextBefore: 1, contextAfter: 1 });
    assert.deepEqual(application.observation.visibleActivities.map((a) => a.index), [7, 80]);
    assert.deepEqual(application.observation.activities.map((activity) => activity.index), [7, 50, 80]);
    assert.deepEqual(application.activities.map((activity) => activity.id), ['act/7']);
    assert.equal(application.observation.continuation, undefined);
    const ordinary = await app.history({ observe: true, limit: 3 });
    assert.deepEqual(ordinary.observation.activities.map((a) => a.index), [7, 80, 101]);
    const facade = (await app.history({ before: 'act/80', limit: 3 })).activities;
    assert.deepEqual(facade.map((a) => a.id), ['act/0', 'act/7']);
    const after = (await app.history({ after: 'act/0', before: undefined, limit: 1, order: 'desc' })).activities;
    assert.deepEqual(after.map((a) => a.id), ['act/7']);
    const all = (await app.history({ limit: null })).activities;
    const stream = app.stream({ start: { kind: 'tail', last: 10 } }, { signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    const records = [];
    for (const _activity of all) records.push((await stream.next()).value);
    await stream.return();
    assert.deepEqual(records, all, 'read and actorless historical records never escape as stream activities');
    const later = app.stream({ start: { kind: 'after', after: 'act/50' } }, { signal: AbortSignal.timeout(2000) })[Symbol.asyncIterator]();
    assert.equal((await later.next()).value.id, 'act/101');
    await later.return();
  } finally { await cell.close(); }
});

test('hidden listener events occupy history positions without becoming terminal continuation anchors', async (t) => {
  const state = fixture([
    { kind: 'join', actor: 'Alice', at: 0, index: 0 },
    { kind: 'join', actor: 'Bob', at: 1, index: 2 },
    { kind: 'say', actor: 'Alice', at: 2, index: 7, body: 'earlier', mentions: ['Bob'] },
    { kind: 'listen', actor: 'Bob', target: 'Alice', at: 3, index: 50 },
    { kind: 'ignore', actor: 'Bob', target: 'Alice', at: 4, index: 80 },
    { kind: 'read', actor: 'Bob', at: 5, index: 100, through: 7 },
    { kind: 'say', actor: 'Alice', at: 6, index: 101, body: 'latest', mentions: ['Bob'] },
  ]);
  const app = await archiveSquare(t, state);
  const recent = await app.history({ observe: true, limit: 3, order: 'desc' });
  assert.deepEqual(recent.observation.activities.map((activity) => activity.index), [101, 80, 50]);
  assert.deepEqual(recent.activities.map((activity) => activity.id), ['act/101', 'act/80', 'act/50']);
  assert.deepEqual(recent.observation.visibleActivities.map((activity) => activity.index), [101]);
  assert.deepEqual(recent.observation.continuation, { direction: 'before', cursor: 'act/101', limit: 3 });
  assert.deepEqual(recent.observation.sayNumbers, { 101: 2 });
  assert.deepEqual(recent.observation.presenceAnchors, { 101: ['Alice'] });
  assert.equal(recent.observation.standingCount, 2);
  const forward = await app.history({ observe: true, after: 'act/0', limit: 3, order: 'desc' });
  assert.deepEqual(forward.observation.activities.map((activity) => activity.index), [50, 7, 2]);
  assert.deepEqual(forward.observation.continuation, { direction: 'after', cursor: 'act/7', limit: 3 });
  const hidden = await app.history({ observe: true, before: 'act/101', limit: 2 });
  assert.deepEqual(hidden.activities.map((activity) => activity.kind), ['listen', 'ignore']);
  assert.deepEqual(hidden.observation.visibleActivities, []);
  assert.equal(hidden.observation.continuation, undefined);
});

test('history bounds contextual windows and uses the same validation for SDK and adapters', async (t) => {
  const state = fixture([{ kind: 'join', actor: 'Alice', at: 0, index: 0 },
    ...Array.from({ length: 101 }, (_, index) => ({ kind: 'say', actor: 'Alice', at: index + 1, index: index + 1, body: `message ${index}` })),
  ]);
  const app = await archiveSquare(t, state);
  await assert.rejects(app.history({ observe: true, at: ['act/50'], contextBefore: 100, contextAfter: 100 }), (error) => {
    assert.equal(error.code, 'invalid_args');
    assert.deepEqual(error.operation, { operation: 'history', historyBounds: { maxLimit: 100, totalMatches: 102 } });
    return true;
  });
  assert.equal((await app.history({ observe: true, at: ['act/50'], contextBefore: 100, contextAfter: 100, limit: 100 })).activities.length, 100);
  for (const query of [{ limit: 101 }, { grep: 'message', fixed: 'other' }, { fixed: '' }, { since: Infinity }, { contextBefore: -1 }, { before: 'act/5', after: 'act/2' }, { at: ['bad'] }]) {
    await assert.rejects(app.history(query), (error) => error.code === 'invalid_args');
  }
  assert.equal((await app.history({ limit: null, grep: 'message' })).activities.length, 101);
  assert.equal((await app.history({ limit: null })).activities.length, 102);
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
    const { observation: projection } = (await square.artifact.read((facts) => queryStatus(facts, queryContext, '', true))).value;
    assert.equal(projection.latestPerception, 'presence');
    assert.equal(projection.joinCount, 4);
    assert.deepEqual(projection.joins.map(({ activity, rejoined }) => [activity.id, rejoined]), [['act/5', false], ['act/6', true], ['act/7', false]]);
    assert.deepEqual(projection.joins[0].activity, { id: 'act/5', at: 5, kind: 'join', actor: 'bob', mentions: [] });
    assert.deepEqual(reads.batches, [[5, 6, 7]]);
    assert.deepEqual(reads.singles, [3]);
    assert.deepEqual(reads.ordinals, []);
    const { observation: own } = (await square.artifact.read((facts) => queryStatus(facts, queryContext, 'ALICE', true))).value;
    assert.equal(own.latestPerception, 'full');
    assert.equal(own.viewer, 'Alice');
    assert.deepEqual(own.attentionNames, ['Alice']);
  } finally { await cell.close(); }
});

test('status keeps one filtered roster and ignores read and actorless hold when selecting latest words', async (t) => {
  const state = fixture([
    { kind: 'read', actor: 'Reserved', at: 0, index: 0, through: 0 },
    { kind: 'join', actor: 'Alice', at: 1, index: 1 },
    { kind: 'join', actor: 'Gone', at: 2, index: 2 },
    { kind: 'done', actor: 'Gone', at: 3, index: 3 },
    { kind: 'hold', actor: 'Alice', at: 4, index: 4, body: 'pause' },
    { kind: 'hold', at: 5, index: 5, body: 'historical pause' },
    { kind: 'read', actor: 'Alice', at: 6, index: 6, through: 5 },
  ]);
  state.hardCap = 7;
  state.throttlePerMinute = 3;
  const { square, cell } = measuredSquare(state);
  try {
    const before = (await cell.read((facts) => ({ header: facts.header(), roster: facts.roster(), receipts: facts.receiptAssignments() }))).value;
    const { observation: projection, ...data } = (await square.artifact.read((facts) => queryStatus(facts, queryContext, 'alice', true))).value;
    assert.deepEqual(data, {
      hardCap: 7, throttlePerMinute: 3, held: { reason: 'historical pause', at: 5 }, now: 100_000, listening: [],
      latestActivity: { id: 'act/3', at: 3, kind: 'done', actor: 'Gone', mentions: [] },
      participants: [
        { name: 'Alice', listening: [], activityCount: 0, lastActiveAt: 6, presence: 'active', unreadActivityCount: 0, pendingMentionCount: 0 },
        { name: 'Gone', listening: [], activityCount: 0, lastActiveAt: 3, presence: 'done', unreadActivityCount: 0, pendingMentionCount: 0 },
      ],
    });
    assert.equal(projection.knownParticipantCount, 3);
    const app = await archiveSquare(t, state);
    const status = await app.status({ viewer: 'alice' });
    assert.deepEqual(status.held, { reason: 'historical pause', at: 5 });
    const observed = await app.status({ viewer: 'alice', observe: true });
    assert.deepEqual(observed.held, status.held);
    assert.match(renderStatusResult(app.location, observed), /· someone raised a hand — historical pause · 1m ago/);
    assert.deepEqual(projection.orderedHereNames, ['Alice']);
    assert.equal(projection.classificationByName.Reserved, 'not-joined');
    assert.equal(Object.hasOwn(projection, 'latestAct'), false);
    assert.equal(Object.hasOwn(projection, 'status'), false);
    assert.equal(Object.hasOwn(projection, 'participants'), false);
    assert.equal(Object.hasOwn(projection, 'now'), false);
    assert.equal(Object.hasOwn(projection, 'held'), false);
    const snap = (await square.artifact.read(facts => snapshot(facts, queryContext.now))).value;
    assert.deepEqual(snap.participants, [
      { name: 'Alice', presence: 'active', listening: [] },
      { name: 'Gone', presence: 'done', listening: [] },
    ]);
    const roster = (await square.artifact.read((facts) => queryParticipants(facts, queryContext, true))).value;
    assert.deepEqual(roster.participants.map((p) => p.name), ['Alice', 'Gone', 'Reserved']);
    assert.equal(Object.hasOwn(roster.observation, 'participants'), false);
    assert.deepEqual((await cell.read((facts) => ({ header: facts.header(), roster: facts.roster(), receipts: facts.receiptAssignments() }))).value, before);
  } finally { await cell.close(); }
});

test('observed lifecycle renders its committed public activity and listener keeps only its target', async t => {
  const square = Square.inMemory({ markdown: 'context', body: { channel: 'test', session: 'one' }, clock: () => 100 });
  t.after(() => square.close());
  const alice = (await square.join('Alice')).participant;
  const listened = await alice.listen('Bob', { observe: true });
  assert.equal(listened.observation.target, 'Bob');
  assert.equal(Object.hasOwn(listened.observation, 'requestedTarget'), false);
  const held = await alice.hold('pause', { observe: true });
  assert.equal(Object.hasOwn(held.observation, 'activity'), false);
  assert.deepEqual(held.activity, { id: 'act/2', at: 100, kind: 'hold', actor: 'Alice', body: 'pause', mentions: [] });
  assert.match(renderLifecycleResult(square.location, 'hold', held), /@Alice raised a hand — pause · act\/2 · just now/);
  const resumed = await alice.resume({ observe: true });
  assert.equal(Object.hasOwn(resumed.observation, 'activity'), false);
  assert.match(renderLifecycleResult(square.location, 'resume', resumed), /@Alice lowered the hand · act\/3 · just now/);
});

test('SDK delivered closure detaches exact raw assignments including orphan coordinates', async () => {
  const acts = [{ kind: 'join', actor: 'Bob', at: 0, index: 0 }, { kind: 'say', actor: 'Bob', at: 1, index: 5, body: 'own' }];
  const { square, cell } = measuredSquare(fixture(acts, {
    Bob: { 'act/3': { state: 'seen', at: 10 } },
    bob: { 'act/4': { state: 'seen', at: 11 } },
    Unknown: { 'act/2': { state: 'seen', at: 12 } },
  }));
  const detached = (await square.artifact.read(facts => snapshot(facts, square.clock()))).value;
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
    const empty = (await square.artifact.read(facts => streamProjection(facts, -1, 'bob'))).value;
    assert.deepEqual(empty.activities, []);
    assert.equal(empty.cursor, 99);
    assert.equal(empty.hasMore, true);
    assert.deepEqual(reads.batches, [[]]);
    const historical = (await square.artifact.read(facts => streamProjection(facts, empty.cursor, 'BOB'))).value;
    assert.deepEqual(historical.activities.map(({ id, perception, via }) => [id, perception, via]), [['act/102', 'full', 'mention']]);
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
    const { observation: participants } = (await square.artifact.read((facts) => queryParticipants(facts, queryContext, true))).value;
    const { observation: status } = (await square.artifact.read((facts) => queryStatus(facts, queryContext, 'Recent', true))).value;
    assert.deepEqual(participants.classificationByName, { Old: 'lingering', Watcher: 'here', Lingering: 'lingering', Recent: 'here', Done: 'done' });
    assert.deepEqual(participants.orderedHereNames, ['Watcher', 'Recent']);
    assert.equal(participants.lingeringCount, 2);
    assert.deepEqual(status.classificationByName, participants.classificationByName);
    assert.deepEqual(status.orderedHereNames, participants.orderedHereNames);
    const bodyReads = { batches: reads.batches.length, singles: reads.singles.length, ordinals: reads.ordinals.length };
    const presence = (await square.artifact.read(facts => catchPresence(facts, square.clock()))).value;
    assert.deepEqual(new Set(presence.participants.map((participant) => participant.name)), new Set(['Watcher', 'Lingering', 'Recent', 'Done']));
    assert.equal(presence.now, now);
    assert.deepEqual({ batches: reads.batches.length, singles: reads.singles.length, ordinals: reads.ordinals.length }, bodyReads);
    assert.deepEqual((await cell.read((facts) => ({ receipts: facts.receiptAssignments(), lease: facts.lease('Watcher'), header: facts.header() }))).value, before);
  } finally { await cell.close(); }
});
