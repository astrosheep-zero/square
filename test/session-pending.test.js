import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createArtifactPort, prepareSquareBuild, writeSquareFile, readSquareRevision } from '../dist/artifact.js';
import { observeSessionPending, projectSessionSeats, sessionInbox, pendingKey, projectBoundaryEligibility } from '../dist/inbox.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { inbox as publicInbox } from '../dist/square-api.js';
import { harnessOwner } from '../dist/owner.js';
import { rememberSquarePath } from '../dist/square-index.js';

async function fixture(t, leaseMs, hasPending = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-pending-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'SQUARE.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const state = await prepareSquareBuild({ force: true, hardCap: null }, 'pending');
  state.acts = [];
  state.runtime.nextActIndex = 0;
  await writeSquareFile(file, state);
  const artifact = createArtifactPort(file);
  const aliceBody = "pi" + ":" + ('author');
  const bobBody = "pi" + ":" + ('one');
  let aliceSeat, bobSeat;
  try {
    aliceSeat = (await artifact.transactAs({ kind: 'join', participant: 'Alice', owner: aliceBody }, facts => {
      facts.land({ kind: 'join', actor: 'Alice', at: 1 });
      return facts.seat('Alice');
    })).value;
    bobSeat = (await artifact.transactAs({ kind: 'join', participant: 'Bob', owner: bobBody }, facts => {
      facts.land({ kind: 'join', actor: 'Bob', at: 2 });
      return facts.seat('Bob');
    })).value;
    if (hasPending) await artifact.transactAs({ kind: 'participant', seat: aliceSeat }, facts =>
      facts.land({ kind: 'say', actor: 'Alice', at: 3, body: 'hello', mentions: ['Bob'] }));
    if (leaseMs !== undefined) await artifact.transactAs({ kind: 'participant', seat: bobSeat }, facts =>
      facts.putLease('Bob', { leaseId: 'catch', heartbeatAt: Date.now(), expiresAt: Date.now() + leaseMs, filter: { mention: 'Bob' } }, bobSeat.generation));
  } finally { await artifact.close(); }
  // Alice's join has published a different body. Bob's path becomes a candidate only when
  // the host later publishes Bob's body into the disposable index.
  await rememberSquarePath(file, aliceBody, env.SQUARE_INDEX);
  const observer = await observeSessionPending(bobBody, env);
  t.after(() => observer.close());
  const bind = (session = 'one') => rememberSquarePath(file, harnessOwner({ channel: 'pi', session }), env.SQUARE_INDEX);
  return { file, root, env, observer, bind };
}

async function markPresentation(item, activity, outcome) {
  const artifact = createArtifactPort(item.file);
  try {
    const { value: seat } = await artifact.read((facts) => facts.seat('Bob'));
    const claim = await artifact.claimDelivery({ seat: { participant: seat.participant, owner: seat.owner, generation: seat.generation },
      activity: `act/${activity}`, kind: 'presentation', at: Date.now(), leaseMs: 1000, claimToken: `presentation-${activity}` });
    assert.equal(claim.status, 'acquired');
    assert.equal(await artifact.completeDelivery({ seat: { participant: seat.participant, owner: seat.owner, generation: seat.generation },
      activity: `act/${activity}`, claimToken: claim.claimToken, outcome, at: Date.now() }), true);
  } finally { await artifact.close(); }
}

function armedWait(observer, options = {}, timeoutMs = 4_000) {
  let armed;
  const ready = new Promise((resolve) => { armed = resolve; });
  const pending = observer.wait(timeoutMs, { ...options, onChangeArmed: armed });
  return { ready, pending };
}

test('several names owned by one owner share one coherent projection transaction', async t => {
  const item = await fixture(t);
  await item.bind();
  const writer = createArtifactPort(item.file);
  try {
    for (const participant of ['Cara', 'Dana']) {
      await writer.transactAs({ kind: 'join', participant, owner: 'pi:one' }, facts => facts.land({ kind: 'join', actor: participant, at: 4 }));
    }
    const alice = (await writer.read(facts => facts.seat('Alice'))).value;
    await writer.transactAs({ kind: 'participant', seat: alice }, facts =>
      facts.land({ kind: 'say', actor: 'Alice', at: 5, body: 'all exact bodies', mentions: ['Bob', 'Cara', 'Dana'] }));
  } finally { await writer.close(); }
  const alias = path.join(item.root, 'alias.square');
  fs.symlinkSync(item.file, alias);
  fs.appendFileSync(item.env.SQUARE_INDEX, `${JSON.stringify({ location: alias, owner: 'pi:one' })}\n`);

  // Count connections AND transactions, not notification hydration alone: the old path
  // hydrated each recipient once while still reopening the same artifact in several stages.
  let connections = new Set(), transactions = 0, selecting = new Set(), sayHydrations = 0;
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (/^BEGIN\b/.test(sql)) { transactions++; connections.add(this); }
    return exec.call(this, sql, ...args);
  });
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/SELECT s\.\* FROM seats/.test(sql)) selecting.add(this);
    if (sql.includes('act_index IN (SELECT value FROM json_each')) sayHydrations++;
    return prepare.call(this, sql, ...args);
  });
  const reset = () => { connections = new Set(); selecting = new Set(); transactions = 0; sayHydrations = 0; };
  const owner = 'pi:one';
  const inbox = await sessionInbox(owner, item.env);
  assert.deepEqual(inbox.map(member => member.seat.participant), ['Bob', 'Cara', 'Dana']);
  assert.ok(inbox.every(member => member.seat.owner === owner));
  assert.ok(inbox.every(member => member.notifications.at(-1).body === 'all exact bodies'));
  assert.equal(connections.size, 1);
  assert.equal(transactions, 1);
  reset();
  assert.equal((await projectSessionSeats({ owner, env: item.env })).length, 3);
  assert.equal(transactions, 1, 'lifecycle consumers resolve all located seats in one transaction');
  assert.equal(sayHydrations, 0, 'lifecycle does not load pending say bodies');
  reset();
  const summary = await publicInbox({ env: item.env }, owner, { limit: 2 });
  assert.equal(transactions, 1, 'count-only public inbox does not reopen per seat');
  assert.equal(sayHydrations, 0, 'public counts do not load pending say bodies');
  assert.deepEqual(summary, { rows: [
    { name: 'Bob', squarePath: fs.realpathSync(item.file), pending: 2 },
    { name: 'Cara', squarePath: fs.realpathSync(item.file), pending: 1 },
  ], total: 3 });
  reset();
  const observer = await observeSessionPending(owner, item.env);
  t.after(() => observer.close());
  assert.equal((await observer.read()).length, 3);
  assert.equal(transactions, 1, 'explicit current reads combine binding, pending and eligibility');
  reset();
  assert.equal((await observer.wait(0)).length, 3);
  assert.equal(selecting.size, 1, 'revision capture precedes one authoritative selection connection');
  assert.equal(transactions, 3, 'two distinct revision captures plus one projection, independent of body count');
  reset();
  assert.equal((await observer.read()).length, 3);
  assert.equal(transactions, 1, 'cache currentness and seat generations are checked in one current transaction');
});

test('boundary batch rendering excludes cancelled and replaced seats before any member presents', async t => {
  const item = await fixture(t);
  await item.bind();
  const writer = createArtifactPort(item.file);
  t.after(() => writer.close());
  const body = "pi" + ":" + ('one');
  for (const participant of ['Cara', 'Dana']) await writer.transactAs({ kind: 'join', participant, owner: body }, facts =>
    facts.land({ kind: 'join', actor: participant, at: 4 }));
  const alice = (await writer.read(facts => facts.seat('Alice'))).value;
  const landed = await writer.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 5, body: 'shared batch', mentions: ['Bob', 'Cara', 'Dana'] }));
  const batch = await sessionInbox(body, item.env);
  assert.deepEqual(batch.map(member => member.seat.participant), ['Bob', 'Cara', 'Dana']);
  assert.ok(batch.every(member => member.joinedAt > 0 && member.seat.generation));
  const bob = batch[0];
  assert.deepEqual(await projectBoundaryEligibility([{ ...bob, seat: { ...bob.seat,
    owner: 'not-this-owner' } }]), [], 'same generation never substitutes for exact owner');
  await writer.cancelDeliveries(batch[1].seat);
  await writer.transactAs({ kind: 'takeover', participant: 'Dana', owner: body, expectedGeneration: batch[2].seat.generation }, facts => {
    facts.land({ kind: 'done', actor: 'Dana', at: 6 });
    facts.land({ kind: 'join', actor: 'Dana', at: 7 });
  });
  let renders = 0;
  const output = await presentPendingAtBoundary(body, context => { renders++; return context; }, () => batch, item.env);
  assert.equal(renders, 1);
  assert.match(output, /as="Bob"/);
  assert.doesNotMatch(output, /as="Cara"|as="Dana"/);
  const state = (await writer.read(facts => ({
    bob: facts.receipt('Bob', landed.value.index), cara: facts.receipt('Cara', landed.value.index),
    dana: facts.receipt('Dana', landed.value.index),
    oldDanaEvidence: facts.deliveryEvidence('Dana', batch[2].seat.generation),
  }))).value;
  assert.ok(state.bob);
  assert.equal(state.cara, undefined);
  assert.equal(state.dana, undefined);
  assert.deepEqual(state.oldDanaEvidence, []);
});

test('delivery-only cancellation invalidates cached eligibility without delayed filesystem hints', async t => {
  const item = await fixture(t);
  await item.bind();
  t.mock.method(fs, 'watch', () => ({ on() { return this; }, close() {} }));
  t.mock.method(globalThis, 'setInterval', () => undefined);
  assert.equal((await item.observer.read())[0].notifications[0].body, 'hello');
  const writer = createArtifactPort(item.file);
  try {
    const bob = (await writer.read(facts => facts.seat('Bob'))).value;
    const revision = await writer.revision();
    const deliveryRevision = await writer.deliveryRevision();
    await writer.cancelDeliveries(bob);
    assert.equal(await writer.revision(), revision, 'cancellation is not a conversation change');
    assert.ok(await writer.deliveryRevision() > deliveryRevision);
    assert.deepEqual(await item.observer.read(), []);
    const alice = (await writer.read(facts => facts.seat('Alice'))).value;
    await writer.transactAs({ kind: 'participant', seat: alice }, facts =>
      facts.land({ kind: 'say', actor: 'Alice', at: 4, body: 'after cancellation', mentions: ['Bob'] }));
    assert.deepEqual((await item.observer.read())[0].notifications.map(note => note.body), ['after cancellation']);
  } finally { await writer.close(); }
});

test('cached conversation payload keeps lease creation, renewal, removal and current reads live', async t => {
  const item = await fixture(t);
  await item.bind();
  const writer = createArtifactPort(item.file);
  t.after(() => writer.close());
  let now = 1000, leaseReads = 0, hydrations = 0;
  t.mock.method(Date, 'now', () => now);
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/SELECT \* FROM catch_leases/.test(sql)) leaseReads++;
    if (sql.includes('act_index IN (SELECT value FROM json_each')) hydrations++;
    return prepare.call(this, sql, ...args);
  });
  assert.equal((await item.observer.read())[0].notifications[0].body, 'hello');
  const bob = (await writer.read(facts => facts.seat('Bob'))).value;
  const put = expiresAt => writer.transactAs({ kind: 'participant', seat: bob }, facts =>
    facts.putLease('Bob', { leaseId: 'catch', heartbeatAt: now, expiresAt, filter: { mention: 'Bob' } }, bob.generation));
  await put(now + 100);
  assert.deepEqual(await item.observer.read(), []);
  await put(now + 1000);
  now += 150;
  assert.deepEqual(await item.observer.read(), [], 'a renewed lease outlives its cached earlier expiry');
  const reads = leaseReads, bodies = hydrations;
  await markPresentation(item, 2, 'failed');
  assert.deepEqual(await item.observer.read(), []);
  assert.ok(leaseReads > reads, 'even a conversation-cache hit reads the current lease facts');
  assert.equal(hydrations, bodies, 'delivery-only evidence leaves the cached conversation payload intact');
  await writer.transactAs({ kind: 'participant', seat: bob }, facts => facts.removeLease('Bob', 'catch', bob.generation));
  assert.equal((await item.observer.read())[0].notifications[0].body, 'hello', 'removal releases the formerly owned pending item');
});

test('an initially undiscovered body notices index publication without an artifact write', async (t) => {
  const item = await fixture(t);
  const baseline = await readSquareRevision(item.file);
  const waiting = armedWait(item.observer);
  await waiting.ready;
  await item.bind();
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);
  assert.equal(await readSquareRevision(item.file), baseline);
});

test('catch lease expiry wakes notification eligibility without an artifact write', async (t) => {
  const item = await fixture(t, 250);
  await item.bind();
  const baseline = await readSquareRevision(item.file);
  const pending = await item.observer.wait(2_000);
  assert.equal(pending[0].notifications[0].actIndex, 2);
  assert.equal(await readSquareRevision(item.file), baseline);
});

test('an unrelated index entry leaves projections cold while activity in a candidate wakes delivery', async (t) => {
  const item = await fixture(t, undefined, false);
  const cell = createArtifactPort(item.file);
  t.after(() => cell.close());
  await item.bind();
  const waiting = armedWait(item.observer, {}, 2_500);
  await waiting.ready;
  let activitySnapshots = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (/SELECT \* FROM activities WHERE act_index=\?$/i.test(sql)) {
      const get = statement.get;
      t.mock.method(statement, 'get', function (index, ...values) {
        // Binding reconciliation reads Bob's establishing join time, not activity content.
        if (index !== 1) activitySnapshots++;
        return get.call(this, index, ...values);
      });
    } else if (/SELECT \* FROM activities/i.test(sql)) activitySnapshots++;
    return statement;
  });
  const otherFile = path.join(item.root, 'unrelated.square');
  fs.copyFileSync(item.file, otherFile);
  await rememberSquarePath(otherFile, "pi" + ":" + ('unrelated'), item.env.SQUARE_INDEX);
  assert.deepEqual(await waiting.pending, []);
  assert.equal(activitySnapshots, 0, 'an unrelated body must not hydrate activity history');

  const changed = armedWait(item.observer);
  await changed.ready;
  const alice = (await cell.read(facts => facts.seat('Alice'))).value;
  await cell.transactAs({ kind: 'participant', seat: alice }, facts => facts.land({ kind: 'say', actor: 'Alice', at: 4, body: 'new activity', mentions: ['Bob'] }));
  assert.equal((await changed.pending)[0].notifications[0].body, 'new activity');
  assert.ok(activitySnapshots > 0, 'the changed artifact revision must hydrate its recipient projection');
});

test('an unreadable artifact cannot reuse stale pending and repair restores delivery', async (t) => {
  const item = await fixture(t);
  await item.bind();
  assert.equal((await item.observer.read())[0].notifications[0].body, 'hello', 'prime the current projection cache');
  const saved = fs.readFileSync(item.file);
  fs.writeFileSync(item.file, 'not a SQLite database');
  await sleep(30);
  const waiting = armedWait(item.observer);
  await waiting.ready;
  fs.writeFileSync(item.file, saved);
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);
});

test('artifact presentation evidence suppresses a clipped activity but fresh conversation remains eligible', async (t) => {
  const item = await fixture(t);
  await item.bind();
  assert.equal((await item.observer.read())[0].notifications[0].actIndex, 2);
  await markPresentation(item, 2, 'clipped');
  assert.deepEqual(await item.observer.read(), []);
  const cell = createArtifactPort(item.file);
  t.after(() => cell.close());
  const alice = (await cell.read(facts => facts.seat('Alice'))).value;
  await cell.transactAs({ kind: 'participant', seat: alice }, facts => facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'fresh after clipped presentation', mentions: ['Bob'] }));
  assert.equal((await item.observer.read())[0].notifications[0].body, 'fresh after clipped presentation');
});

test('failed delivery evidence cannot spin deferred retries; conversation change wakes them', async (t) => {
  const item = await fixture(t);
  await item.bind();
  const cell = createArtifactPort(item.file);
  t.after(() => cell.close());
  const alice = (await cell.read(facts => facts.seat('Alice'))).value;
  const waiting = armedWait(item.observer, { skipImmediate: true }, 2_000);
  await waiting.ready;
  let resolved = false;
  waiting.pending.then(() => { resolved = true; });
  let transactions = 0;
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, 'exec', function (sql, ...args) {
    if (/^BEGIN\b/.test(sql)) transactions++;
    return exec.call(this, sql, ...args);
  });
  let hydrations = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (sql.includes('act_index IN (SELECT value FROM json_each')) hydrations++;
    return prepare.call(this, sql, ...args);
  });
  await markPresentation(item, 2, 'failed');
  await sleep(100);
  assert.equal(resolved, false);
  assert.equal(hydrations, 0, 'delivery-only evidence must not rehydrate cached conversation bodies');
  const settled = transactions;
  await sleep(100);
  assert.equal(transactions, settled, 'unchanged delivery evidence must settle, not repeatedly reproject');
  await cell.transactAs({ kind: 'participant', seat: alice }, facts => facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'new activity after failed delivery', mentions: ['Bob'] }));
  const pending = await waiting.pending;
  assert.deepEqual(pending[0].notifications.map((notification) => notification.body), ['hello', 'new activity after failed delivery']);
});

test('stale index candidates are not reread on missing-artifact reconciliation', async (t) => {
  const item = await fixture(t);
  await item.bind();
  const saved = fs.readFileSync(item.file);
  fs.unlinkSync(item.file);
  let indexReads = 0;
  const readFile = fs.promises.readFile.bind(fs.promises);
  t.mock.method(fs.promises, 'readFile', (...args) => {
    if (String(args[0]) === item.env.SQUARE_INDEX) indexReads++;
    return readFile(...args);
  });
  const waiting = armedWait(item.observer);
  await waiting.ready;
  const baseline = indexReads;
  await sleep(2_200);
  assert.equal(indexReads, baseline);
  fs.writeFileSync(item.file, saved);
  assert.equal((await waiting.pending)[0].notifications[0].actIndex, 2);
});

test('an unreadable candidate stays quiet across reconciliation and repair restores delivery', async (t) => {
  const item = await fixture(t);
  const saved = fs.readFileSync(item.file);
  const cell = createArtifactPort(item.file);
  const bob = (await cell.read(facts => facts.seat('Bob'))).value;
  try { await cell.transactAs({ kind: 'participant', seat: bob }, facts => facts.markSeen('Bob', [2], Date.now())); }
  finally { await cell.close(); }
  const corruptFile = path.join(item.root, 'CORRUPT.square');
  fs.writeFileSync(corruptFile, 'not a SQLite artifact');
  await item.bind();
  await rememberSquarePath(corruptFile, "pi" + ":" + ('one'), item.env.SQUARE_INDEX);
  await assert.rejects(readSquareRevision(corruptFile), { code: 'invalid_args' });
  let snapshotReads = 0;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/SELECT \* FROM activities/i.test(sql)) snapshotReads++;
    return prepare.call(this, sql, ...args);
  });
  const waiting = armedWait(item.observer, {}, 8_000);
  await waiting.ready;
  snapshotReads = 0;
  await sleep(4_200);
  assert.equal(snapshotReads, 0);
  fs.writeFileSync(corruptFile, saved);
  const repaired = (await waiting.pending)[0];
  assert.equal(path.basename(repaired.location), 'CORRUPT.square');
  assert.equal(repaired.notifications[0].actIndex, 2);
  assert.ok(snapshotReads > 0, 'the repaired artifact must supply current recipient activity');
});

test('complete recipient discovery crosses 100 withheld candidates and expiry alone reconsiders the earlier batch', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const item = await fixture(t, undefined, false);
  const cell = createArtifactPort(item.file);
  t.after(() => cell.close());
  const caraBody = "test" + ":" + ('cara');
  const cara = (await cell.transactAs({ kind: 'join', participant: 'Cara', owner: caraBody }, facts => {
    facts.land({ kind: 'join', actor: 'Cara', at: now });
    return facts.seat('Cara');
  })).value;
  const alice = (await cell.read(facts => facts.seat('Alice'))).value;
  await cell.transactAs({ kind: 'participant', seat: alice }, facts => {
    for (let index = 0; index < 105; index++) facts.land({ kind: 'say', actor: 'Alice', at: now, body: `earlier ${index}`, mentions: ['Bob'] });
  });
  await cell.transactAs({ kind: 'participant', seat: cara }, facts => facts.land({ kind: 'say', actor: 'Cara', at: now, body: 'later eligible', mentions: ['Bob'] }));
  const bob = (await cell.read(facts => facts.seat('Bob'))).value;
  await cell.transactAs({ kind: 'participant', seat: bob }, facts => facts.putLease('Bob', { leaseId: 'alice-catch', heartbeatAt: now, expiresAt: now + 400, filter: { participants: ['Alice'] } }, bob.generation));
  await item.bind();
  const complete = await sessionInbox("pi" + ":" + ('one'), item.env);
  assert.equal(complete[0].notifications.length, 106, 'storage pages must not shrink the initial boundary key set');
  const eligible = await item.observer.wait(1000);
  assert.deepEqual(eligible[0].notifications.map((note) => note.body), ['later eligible']);
  const revision = await readSquareRevision(item.file);
  const later = eligible[0].notifications[0].actIndex;
  const excluded = new Set([pendingKey(eligible[0], later)]);
  const waiting = armedWait(item.observer, { excludeKeys: excluded, skipImmediate: true });
  await waiting.ready;
  now += 401;
  const earlier = await waiting.pending;
  assert.equal(earlier[0].notifications.length, 105);
  assert.equal(earlier[0].notifications[0].body, 'earlier 0');
  assert.equal(await readSquareRevision(item.file), revision, 'expiry reconsideration is not a receipt or artifact write');
});

test('an unrepaired candidate respects timeout and cancellation', async (t) => {
  const item = await fixture(t);
  await item.bind();
  fs.writeFileSync(item.file, 'not a SQLite artifact');
  assert.deepEqual(await item.observer.wait(80), []);
  const controller = new AbortController();
  const waiting = armedWait(item.observer, { signal: controller.signal });
  await waiting.ready;
  controller.abort();
  assert.deepEqual(await waiting.pending, []);
});

test('a takeover between revision capture and projection uses the new exact-body seat', async t => {
  const item = await fixture(t, undefined, false);
  const body = "pi" + ":" + ('two') + ":agent:new-child";
  await rememberSquarePath(item.file, body, item.env.SQUARE_INDEX);
  const observer = await observeSessionPending(body, item.env);
  const writer = createArtifactPort(item.file);
  t.after(async () => { observer.close(); await writer.close(); });
  const { value: seats } = await writer.read(facts => ({ bob: facts.seat('Bob'), alice: facts.seat('Alice') }));
  let captured = 0, selections = 0, transition;
  const close = DatabaseSync.prototype.close, prepare = DatabaseSync.prototype.prepare, realpath = fs.promises.realpath;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    if (/SELECT s\.\* FROM seats/.test(sql)) selections++;
    return prepare.call(this, sql, ...args);
  });
  t.mock.method(DatabaseSync.prototype, 'close', function (...args) {
    const result = close.apply(this, args);
    if (++captured === 2) {
      assert.equal(selections, 0, 'both revision baselines must be captured before authoritative selection');
      transition = (async () => {
        await writer.transactAs({ kind: 'takeover', participant: 'Bob', owner: body, expectedGeneration: seats.bob.generation }, facts => {
          facts.land({ kind: 'done', actor: 'Bob', at: 4 });
          facts.land({ kind: 'join', actor: 'Bob', at: 5 });
        });
        await writer.transactAs({ kind: 'participant', seat: seats.alice }, facts =>
          facts.land({ kind: 'say', actor: 'Alice', at: 6, body: 'new generation pending', mentions: ['Bob'] }));
      })();
    }
    return result;
  });
  t.mock.method(fs.promises, 'realpath', async (...args) => {
    if (transition !== undefined && String(args[0]) === item.file) await transition;
    return realpath.apply(fs.promises, args);
  });
  const pending = await observer.wait(4_000);
  assert.ok(transition);
  await transition;
  assert.equal(pending[0].seat.generation, 'act/3');
  assert.deepEqual(pending[0].seat.owner, body);
  assert.deepEqual(pending[0].notifications.map(note => note.body), ['new generation pending']);
});

test('a takeover after empty binding selection cannot be hidden behind a newer revision baseline', async t => {
  const item = await fixture(t, undefined, false);
  const body = "pi" + ":" + ('two');
  await item.bind('two');
  const observer = await observeSessionPending(body, item.env);
  const writer = createArtifactPort(item.file);
  t.after(async () => { observer.close(); await writer.close(); });
  const { value: seats } = await writer.read(facts => ({ bob: facts.seat('Bob'), alice: facts.seat('Alice') }));
  const transfer = async () => {
    await writer.transactAs({ kind: 'takeover', participant: 'Bob', owner: body, expectedGeneration: seats.bob.generation }, facts => {
      facts.land({ kind: 'done', actor: 'Bob', at: 4 });
      facts.land({ kind: 'join', actor: 'Bob', at: 5 });
    });
    await writer.transactAs({ kind: 'participant', seat: seats.alice }, facts =>
      facts.land({ kind: 'say', actor: 'Alice', at: 6, body: 'arrived after empty binding', mentions: ['Bob'] }));
  };
  let transition;
  const prepare = DatabaseSync.prototype.prepare, realpath = fs.promises.realpath;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (/SELECT s\.\* FROM seats/.test(sql)) {
      const all = statement.all;
      t.mock.method(statement, 'all', function (...values) {
        const rows = all.apply(this, values);
        if (transition === undefined && values.includes(JSON.stringify(body)) && rows.length === 0)
          transition = transfer();
        return rows;
      });
    }
    return statement;
  });
  t.mock.method(fs.promises, 'realpath', async (...args) => {
    // Force the next artifact monitor/open to start after the concurrent commit.
    if (transition !== undefined && String(args[0]) === item.file) await transition;
    return realpath.apply(fs.promises, args);
  });
  const pending = await observer.wait(4_000);
  assert.ok(transition, 'the empty authoritative binding read must have triggered the takeover');
  await transition;
  assert.deepEqual(pending.flatMap(member => member.notifications.map(note => note.body)), ['arrived after empty binding']);
});

test('cancellation leaves another observer alive and an index candidate cannot transfer custody', async (t) => {
  const item = await fixture(t);
  const otherBody = "pi" + ":" + ('two');
  const other = await observeSessionPending(otherBody, item.env);
  t.after(() => other.close());
  const cancelled = new AbortController();
  const first = armedWait(item.observer, { signal: cancelled.signal });
  const second = armedWait(other);
  await Promise.all([first.ready, second.ready]);
  cancelled.abort();
  assert.deepEqual(await first.pending, []);
  item.observer.close();

  // A HOME candidate row only identifies a path; the artifact seat still belongs to session one.
  await item.bind('two');
  assert.deepEqual(await other.read(), []);

  const artifact = createArtifactPort(item.file);
  try {
    const prior = (await artifact.read((facts) => facts.seat('Bob'))).value;
    await artifact.transactAs({ kind: 'takeover', participant: 'Bob', owner: otherBody, expectedGeneration: prior.generation }, facts => {
      facts.land({ kind: 'done', actor: 'Bob', at: Date.now() });
      facts.land({ kind: 'join', actor: 'Bob', at: Date.now() });
    });
    const alice = (await artifact.read(facts => facts.seat('Alice'))).value;
    await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
      facts.land({ kind: 'say', actor: 'Alice', at: Date.now(), body: 'new activity after explicit takeover', mentions: ['Bob'] }));
  } finally { await artifact.close(); }
  assert.equal((await second.pending)[0].notifications[0].body, 'new activity after explicit takeover');
});
