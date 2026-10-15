import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { catchUp } from '../dist/square-actions.js';

function fixture(t, extra = [], hardCap = null) {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 0 },
    { kind: 'join', actor: 'Bob', at: 1 },
    ...extra,
  ].map((activity, index) => ({ ...activity, index }));
  const cell = createArtifactPort(':memory:', {
    hardCap, preamble: [], warmup: ['test'], acts,
    runtime: { nextActIndex: acts.length, observations: {}, leases: {} },
  });
  t.after(() => cell.close());
  return { cell, square: { artifact: cell, clock: () => 100, location: 'memory' } };
}

function withoutBodies(facts) {
  return {
    ...facts,
    activity() { assert.fail('catch probe must not hydrate a body'); },
    activities() { assert.fail('catch probe must not hydrate bodies'); },
  };
}

function noWriter() { assert.fail('empty catch must not acquire the artifact writer'); }

test('an empty filtered catch returns its full snapshot without bodies, a writer, or receipts', async (t) => {
  const { cell, square } = fixture(t, [
    { kind: 'join', actor: 'Cara', at: 2 },
    { kind: 'say', actor: 'Cara', at: 3, body: 'still pending', mentions: ['Bob'] },
    { kind: 'say', actor: 'Bob', at: 4, body: 'own activity' },
    { kind: 'hold', actor: 'Alice', at: 5, body: 'pause' },
  ], 1);
  const before = (await cell.read((facts) => facts.receiptAssignments())).value;
  const revision = await cell.revision();
  let reads = 0;
  const artifact = {
    ...cell,
    read: (select, signal) => { reads++; return cell.read((facts) => select(withoutBodies(facts)), signal); },
    transact: noWriter,
  };
  assert.deepEqual(await catchUp({ ...square, artifact }, 'bOB', { from: ['Alice'], mention: true, limit: 1 }), {
    participant: 'Bob', activities: [], consumedThrough: 'act/2', remaining: 0,
    sayNumbers: {}, standingCount: 3, held: true, now: 100,
    ownActivityCount: 1, hardCap: 1, terminalStatus: 'capped',
  });
  assert.equal(reads, 1);
  assert.equal(await cell.revision(), revision);
  assert.deepEqual((await cell.read((facts) => facts.receiptAssignments())).value, before);
  assert.equal((await cell.read((facts) => facts.receipt('Bob', 3))).value, undefined);
});

test('a nonempty probe records nothing and the writer reselects, hydrates once, and observes its own snapshot', async (t) => {
  const { cell, square } = fixture(t, [
    { kind: 'say', actor: 'Alice', at: 2, body: 'claimed elsewhere', mentions: ['Bob'] },
  ]);
  const hydrated = [];
  let writes = 0;
  const artifact = {
    ...cell,
    async read(select, signal) {
      const result = await cell.read((facts) => select(withoutBodies(facts)), signal);
      assert.equal((await cell.read((facts) => facts.receipt('Bob', 2))).value, undefined, 'probe cannot consume its candidate');
      await cell.transact((facts) => {
        facts.markSeen('Bob', [2], 50);
        facts.land({ kind: 'say', actor: 'Alice', at: 51, body: 'selected by writer', mentions: ['Bob'] });
        facts.land({ kind: 'say', actor: 'Alice', at: 52, body: 'remaining', mentions: ['Bob'] });
        facts.land({ kind: 'hold', actor: 'Alice', at: 53, body: 'later hold' });
      });
      return result;
    },
    transact(change, signal) {
      writes++;
      return cell.transact((facts) => change({
        ...facts,
        activities(indexes) { hydrated.push([...indexes]); return facts.activities(indexes); },
      }), signal);
    },
  };
  const caught = await catchUp({ ...square, artifact }, 'Bob', { from: ['alice'], mention: true, limit: 1 });
  assert.deepEqual(caught.activities.map(({ index, body }) => ({ index, body })), [{ index: 3, body: 'selected by writer' }]);
  assert.equal(caught.remaining, 1);
  assert.equal(caught.consumedThrough, 'act/3');
  assert.equal(caught.held, true);
  assert.deepEqual(caught.sayNumbers, { 3: 2 });
  assert.equal(writes, 1);
  assert.deepEqual(hydrated, [[3]]);
  assert.deepEqual((await cell.read((facts) => [facts.receipt('Bob', 2), facts.receipt('Bob', 3), facts.receipt('Bob', 4)])).value,
    [{ at: 50 }, { at: 100 }, undefined]);
});

test('exact-ID and leased catches retain their receipt transaction and never use the empty probe', async (t) => {
  const { cell, square } = fixture(t, [
    { kind: 'say', actor: 'Alice', at: 2, body: 'exact', mentions: ['Bob'] },
  ]);
  const marked = [];
  const artifact = {
    ...cell,
    read() { assert.fail('ID and leased catches must not probe'); },
    transact: (change, signal) => cell.transact((facts) => change({
      ...facts,
      markSeen(name, indexes, at) { marked.push([...indexes]); return facts.markSeen(name, indexes, at); },
    }), signal),
  };
  const context = { ...square, artifact };
  const first = await catchUp(context, 'Bob', { id: 'act/2' });
  assert.deepEqual(await catchUp(context, 'Bob', { id: 'act/2' }), first);
  await cell.transact((facts) => facts.putLease('Bob', { leaseId: 'current', heartbeatAt: 100, expiresAt: 1000 }));
  assert.equal(await catchUp(context, 'Bob', {}, undefined, 'replaced'), null);
  assert.deepEqual((await catchUp(context, 'Bob', {}, undefined, 'current')).activities, []);
  assert.deepEqual(marked, [[2], [2], []]);
});

test('empty catch still validates names, page limits, and finite time without acquiring a writer', async (t) => {
  const { cell, square } = fixture(t);
  const context = { ...square, artifact: { ...cell, transact: noWriter } };
  await assert.rejects(catchUp(context, 'bad name'), { code: 'invalid_name' });
  await assert.rejects(catchUp(context, 'Missing'), (error) => error.code === 'invalid_args' && error.facts.reason === 'never_joined');
  for (const limit of [0, 101, 1.5]) await assert.rejects(catchUp(context, 'Bob', { limit }), { code: 'invalid_args' });
  for (const at of [NaN, Infinity, '100']) {
    await assert.rejects(catchUp({ ...context, clock: () => at }, 'Bob'), { code: 'invalid_args' });
  }
  assert.equal((await catchUp({ ...context, clock: () => -0.5 }, 'Bob')).now, -0.5);
});

test('catch propagates cancellation through probe and writer but keeps a committed receipt result', async (t) => {
  const { cell, square } = fixture(t, [
    { kind: 'say', actor: 'Alice', at: 2, body: 'pending', mentions: ['Bob'] },
  ]);
  const controller = new AbortController();
  const reason = new Error('cancelled after probe');
  const artifact = {
    ...cell,
    async read(select, signal) {
      assert.equal(signal, controller.signal);
      const result = await cell.read((facts) => select(withoutBodies(facts)), signal);
      controller.abort(reason);
      return result;
    },
    transact(change, signal) {
      assert.equal(signal, controller.signal);
      return cell.transact(change, signal);
    },
  };
  await assert.rejects(catchUp({ ...square, artifact }, 'Bob', {}, { signal: controller.signal }), (error) => error === reason);
  assert.equal((await cell.read((facts) => facts.receipt('Bob', 2))).value, undefined);
  await assert.rejects(catchUp({ ...square, artifact: { ...cell, read: noWriter, transact: noWriter } }, 'Bob', {}, { signal: controller.signal }), (error) => error === reason);

  const late = new AbortController();
  const committed = await catchUp({ ...square, artifact: {
    ...cell,
    async transact(change, signal) {
      const result = await cell.transact(change, signal);
      late.abort(new Error('response cancelled after commit'));
      return result;
    },
  } }, 'Bob', {}, { signal: late.signal });
  assert.equal(committed.activities[0].body, 'pending');
  assert.deepEqual((await cell.read((facts) => facts.receipt('Bob', 2))).value, { at: 100 });
});

test('empty catch checks ownership first and still publishes identity after its snapshot completes', async (t) => {
  const { cell, square } = fixture(t);
  const controller = new AbortController();
  const order = [];
  let ownerSession = 'other';
  const context = {
    ...square, location: '/tmp/square-empty-catch-read.square', env: { PI_SESSION_ID: 'empty-catch' },
    hostLedger: {
      async listPresence() {
        order.push('presence');
        return [{ location: context.location, participant: 'Bob', session: ownerSession, channel: 'pi', updatedAt: 0, epoch: 1 }];
      },
      async ensurePresence(record) {
        order.push('published');
        assert.equal(record.participant, 'Bob');
        assert.equal(record.session, 'empty-catch');
        return { status: 'ensured' };
      },
    },
    artifact: {
      ...cell,
      async read(select, signal) {
        order.push('read');
        assert.equal(signal, controller.signal);
        const result = await cell.read((facts) => select(withoutBodies(facts)), signal);
        controller.abort(new Error('late snapshot cancellation'));
        return result;
      },
      transact: noWriter,
    },
  };
  await assert.rejects(catchUp(context, 'Bob'), { code: 'already_joined' });
  assert.deepEqual(order, ['presence']);
  ownerSession = 'empty-catch';
  order.length = 0;
  assert.deepEqual((await catchUp(context, 'bOB', {}, { signal: controller.signal })).activities, []);
  assert.deepEqual(order, ['presence', 'read', 'presence', 'published']);
  assert.equal(controller.signal.aborted, true);
});
