import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Square } from '../dist/square-api.js';
import { createArtifactPort } from '../dist/artifact.js';
import { deliverPending, sweepPending } from '../dist/delivery-operations.js';
import { preparePendingPresentation, presentPending } from '../dist/presentation-operations.js';
import { presentPendingAtBoundary } from '../dist/boundary-presentation.js';
import { nativePendingPreview, observeSessionPending, sessionInbox, sessionInboxCounts } from '../dist/inbox.js';
import { restoreSessionSeats } from '../dist/session-lifecycle.js';
import { rememberSquarePath } from '../dist/square-index.js';
import { endOpenCodeSession, publishOpenCodeAddress } from '../dist/plugins/opencode/delivery.js';
import openCodePlugin from '../dist/plugins/opencode/index.js';

async function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'square-attachment-'));
  const location = path.join(root, 'TEST.square');
  const env = { ...process.env, SQUARE_INDEX: path.join(root, 'index.ndjsonl') };
  const body = { channel: 'pi', session: 'receiver' };
  const wakeAddress = { kind: 'paseo', address: { agentId: body.session } };
  const square = await Square.build({ path: location, env, body, wakeAddress, markdown: 'attachment', ...extra });
  const bob = (await square.join('Bob')).participant;
  const author = square.forBody({ body: { channel: 'test', session: 'author' } });
  const alice = (await author.join('Alice')).participant;
  const artifact = createArtifactPort(location);
  const read = select => artifact.read(select).then(result => result.value);
  const ref = await read(facts => facts.seat('Bob'));
  const detach = () => square.detachOwnedSession('Bob', body.session, ref.generation, body);
  t.after(async () => { await artifact.close(); await square.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, location, env, body, wakeAddress, square, bob, alice, artifact, read, ref, detach };
}
const match = { fields: [{ path: ['kind'], equals: 'notice' }] };
const needsSeat = error => error.code === 'already_joined' && error.facts?.reason === 'needs_seat';

test('host detach preserves membership, listens, horizon and evidence, but revokes every participant mutation', async t => {
  const f = await fixture(t);
  await f.bob.listen('Alice');
  const lease = await f.bob.deferDelivery({ match, durationMs: 60_000 });
  const sent = await f.alice.express('pending before shutdown @Bob', { force: true });
  const claim = await f.artifact.claimDelivery({ seat: f.ref, activity: sent.activity.id, kind: 'wake', at: Date.now(), leaseMs: 5000, claimToken: 'before-detach' });
  assert.equal(claim.status, 'acquired');
  await f.artifact.transactAs({ kind: 'participant', seat: f.ref }, facts =>
    facts.putLease('Bob', { leaseId: 'catching', heartbeatAt: Date.now(), expiresAt: Date.now() + 60_000 }, f.ref.generation));
  const before = await f.read(facts => ({ header: facts.header(), member: facts.participant('Bob'), listening: facts.attention('Bob'), evidence: facts.deliveryEvidence('Bob', f.ref.generation) }));
  assert.equal(await f.detach(), true);
  const after = await f.read(facts => ({ header: facts.header(), member: facts.participant('Bob'), listening: facts.attention('Bob'), evidence: facts.deliveryEvidence('Bob', f.ref.generation),
    seat: facts.seat('Bob'), catchLease: facts.lease('Bob'), deferrals: facts.deliveryDeferrals('Bob', f.ref.generation) }));
  assert.deepEqual(after.member, before.member);
  assert.deepEqual(after.listening, before.listening);
  assert.deepEqual(after.evidence, before.evidence);
  assert.equal(after.header.revision, before.header.revision);
  assert.ok(after.header.deliveryRevision > before.header.deliveryRevision);
  assert.deepEqual(after.seat, { participant: 'Bob', body: f.body, generation: f.ref.generation, attachment: 'detached' });
  assert.equal(after.catchLease, undefined);
  assert.deepEqual(after.deferrals, []);
  assert.deepEqual(await f.square.recognize(), []);
  assert.deepEqual(await f.square.bodySeats(), [{ participant: 'Bob', generation: f.ref.generation, attachment: 'detached' }]);
  // Both a previously captured handle and one selected while detached must fail.
  const detached = await f.square.participant('Bob');
  for (const participant of [f.bob, detached]) for (const mutate of [
    p => p.express('no effect', { force: true }), p => p.catch(), p => p.catch({ id: sent.activity.id }),
    p => p.listen('Alice'), p => p.unlisten('Alice'), p => p.ignore('Alice'), p => p.hold(), p => p.resume(), p => p.done(),
    p => p.deferDelivery({ match, durationMs: 1000 }), p => p.renewDeliveryDeferral(lease.id, 1000), p => p.releaseDeliveryDeferral(lease.id),
  ]) await assert.rejects(mutate(participant), needsSeat);
  const unchanged = await f.read(facts => facts.header());
  assert.equal(await f.detach(), null);
  assert.deepEqual(await f.read(facts => facts.header()), unchanged);
});

test('even an empty catch probe and raw artifact writes require an attached captured seat', async t => {
  const f = await fixture(t);
  await f.detach();
  await assert.rejects(f.bob.catch(), needsSeat);
  for (const mutate of [
    facts => facts.markSeen('Bob', [], 1), facts => facts.putLease('Bob', { leaseId: 'no', heartbeatAt: 1, expiresAt: 2 }),
    facts => facts.removeLease('Bob', 'no'), facts => facts.updateWakeAddress(f.ref, f.wakeAddress), facts => facts.cancelThrough(f.ref, 0),
    facts => facts.claimDelivery({ seat: f.ref, activity: 'act/0', kind: 'wake', at: 1, leaseMs: 10, claimToken: 'no' }),
    facts => facts.prepareDelivery({ seat: f.ref, claimToken: 'no', correlation: { harness: 'pi' } }),
    facts => facts.completeDelivery({ seat: f.ref, activity: 'act/0', claimToken: 'no', outcome: 'accepted', at: 1 }),
    facts => facts.observeNativeDelivery({ seat: f.ref, claimToken: 'no', observation: { eventId: 'no', messageId: 'no', state: 'held', observedAt: 1 } }),
  ]) await assert.rejects(f.artifact.transactAs({ kind: 'participant', seat: f.ref }, mutate), needsSeat);
  await assert.rejects(f.artifact.transactAs({ kind: 'host-cleanup', seat: f.ref }, facts => facts.land({ kind: 'say', actor: 'Bob', at: 1, body: 'not host authority' })), /only end membership/);
  await assert.rejects(f.artifact.transactAs({ kind: 'host-cleanup', seat: f.ref }, facts => facts.markSeen('Bob', [], 1)), /current participant seat/);
});

test('away is projected without history; bells, mentions and listening accumulate and survive exact-Body join or implicitJoin', async t => {
  const f = await fixture(t);
  await f.bob.listen('Alice');
  const before = await f.read(facts => facts.participant('Bob'));
  await f.detach();
  for (const body of [{ ...f.body, session: 'new-session' }, { ...f.body, agent: 'child' }, { ...f.body, channel: 'codex' }]) {
    const foreign = f.square.forBody({ body });
    assert.deepEqual(await foreign.bodySeats(), []);
    await assert.rejects(foreign.join('Bob'), error => error.code === 'already_joined');
    await assert.rejects(foreign.implicitJoin('Bob'), error => error.code === 'already_joined');
  }
  const activities = [];
  activities.push((await f.alice.express('a mention @Bob', { force: true })).activity.id);
  activities.push((await f.alice.express('a bell', { reach: 'bell', force: true })).activity.id);
  activities.push((await f.alice.express('listened words', { force: true })).activity.id);
  assert.deepEqual(await f.read(facts => activities.map(id => facts.directedAt('Bob', Number(id.slice(4))).route)), ['mention', 'bell', 'attention']);
  for (const result of [await f.square.participants({ observe: true }), await f.square.status({ observe: true })]) {
    const away = result.participants.find(p => p.name === 'Bob');
    assert.equal(away.presence, 'away');
    assert.equal(away.unreadActivityCount, 3);
    assert.deepEqual(away.listening, ['Alice']);
    assert.equal(result.observation.standingCount, 2);
    assert.equal(result.observation.classificationByName.Bob, 'away');
  }
  assert.equal((await f.square.snapshot()).participants.find(p => p.name === 'Bob').presence, 'away');
  const suspended = await f.square.participant('Bob');
  const reconnected = await f.square.join('Bob');
  assert.equal(reconnected.kind, 'reconnected');
  assert.equal(reconnected.activity, null);
  assert.deepEqual((await suspended.catch()).activities.map(item => item.id), activities);
  await f.detach();
  const last = (await f.alice.express('after a second detach @Bob', { force: true })).activity.id;
  const implicit = await f.square.implicitJoin('Bob');
  assert.equal(implicit.state, 'active');
  assert.deepEqual((await implicit.participant.catch()).activities.map(item => item.id), [last]);
  const restored = await f.read(facts => ({ member: facts.participant('Bob'), seat: facts.seat('Bob'), kinds: facts.activityHeads({ actors: ['Bob'] }, { edge: 'oldest', limit: 100 }).items.map(a => a.kind) }));
  assert.equal(restored.member.lastJoinIndex, before.lastJoinIndex);
  assert.equal(restored.seat.generation, f.ref.generation);
  assert.equal(restored.seat.attachment, 'attached');
  assert.deepEqual(restored.seat.wakeAddress, f.wakeAddress);
  assert.deepEqual(restored.kinds, ['join', 'listen']);
  assert.deepEqual((await f.square.recognize()).map(p => p.name), ['Bob']);
});

test('detach invalidates cached inboxes, claims and final proactive presentation without success or consumption', async t => {
  const f = await fixture(t);
  const sent = await f.alice.express('proactive @Bob', { force: true });
  const inbox = await sessionInbox(f.body, f.env);
  const observer = await observeSessionPending(f.body, f.env);
  t.after(() => observer.close());
  assert.equal((await observer.read()).length, 1);
  const prepared = await preparePendingPresentation({ artifact: f.artifact, location: f.location, participant: 'Bob', seat: f.ref, activity: sent.activity.id });
  assert.ok(prepared);
  await f.detach();
  assert.equal(await prepared.eligible(), false);
  assert.deepEqual(await observer.read(), []);
  assert.deepEqual(await sessionInboxCounts({ body: f.body, env: f.env }), []);
  let effects = 0;
  assert.equal(await presentPendingAtBoundary(f.body, () => { effects++; }, () => inbox, f.env), undefined);
  assert.deepEqual(await presentPending({ artifact: f.artifact, location: f.location, participant: 'Bob', seat: f.ref, activity: sent.activity.id, sink: { present() { effects++; } } }), { presented: false });
  await deliverPending({ artifact: f.artifact, location: f.location, activity: sent.activity.id, transport: { async attempt() { effects++; return { outcome: 'accepted' }; } } });
  assert.deepEqual(await sweepPending({ artifact: f.artifact, location: f.location, now: Date.now(), graceMs: 0, limit: 20 }), []);
  assert.equal(effects, 0);
  assert.equal(await f.read(facts => facts.receipt('Bob', Number(sent.activity.id.slice(4)))), undefined);
  assert.equal(await f.read(facts => nativePendingPreview(facts, { location: f.location, sessionId: f.body.session, participant: 'Bob', actIndex: Number(sent.activity.id.slice(4)), now: Date.now(), routeKind: 'opencode-server', address: { sessionId: f.body.session } })), undefined);
  await prepared.release();
});

test('a detach during transport readiness fails the final send gate', async t => {
  const f = await fixture(t);
  const sent = await f.alice.express('race @Bob', { force: true });
  let attempts = 0, sends = 0;
  await deliverPending({ artifact: f.artifact, location: f.location, activity: sent.activity.id, transport: {
    async probe() { return true; },
    async attempt(_request, _timeout, beforeSend) {
      attempts++;
      await f.detach();
      if (await beforeSend()) { sends++; return { outcome: 'accepted' }; }
      return { outcome: 'not-capable' };
    },
  } });
  assert.equal(attempts, 1);
  assert.equal(sends, 0);
  assert.equal(await f.read(facts => facts.deliveryEvidence('Bob', f.ref.generation).some(row => row.outcome === 'accepted' || row.outcome === 'presented')), false);
});

test('voluntary done and takeover cannot be undone by host discovery or late cleanup', async t => {
  const f = await fixture(t, { hardCap: 1 });
  await f.bob.express('uses the cap', { force: true });
  await f.detach();
  await restoreSessionSeats(f.body, f.env);
  await assert.rejects((await f.square.participant('Bob')).express('cap survives', { force: true, noWait: true }), error => error.code === 'capped');
  await (await f.square.participant('Bob')).done();
  await restoreSessionSeats(f.body, f.env);
  assert.equal((await f.square.implicitJoin('Bob')).state, 'done');
  assert.equal(await f.detach(), null);
  assert.deepEqual(await f.square.bodySeats(), []);
  // Explicit participant join remains the only way back after a voluntary leave.
  await f.square.join('Bob');
  const captured = await f.read(facts => facts.seat('Bob'));
  await f.square.detachOwnedSession('Bob', f.body.session, captured.generation, f.body);
  const replacement = f.square.forBody({ body: { channel: 'pi', session: 'replacement' } });
  await replacement.join('Bob', { takeover: true });
  assert.equal(await f.square.detachOwnedSession('Bob', f.body.session, captured.generation, f.body), null);
  assert.equal(await f.square.endOwnedSession('Bob', f.body.session, captured.generation, f.body), null);
  assert.equal((await f.artifact.transactAs({ kind: 'host-cleanup', seat: captured }, facts => facts.detachSeat(captured))).value, false);
  await restoreSessionSeats(f.body, f.env);
  assert.deepEqual(await f.square.bodySeats(), []);
  await assert.rejects(f.square.implicitJoin('Bob'), error => error.code === 'already_joined');
  assert.equal(await f.read(facts => facts.seat('Bob').body.session), 'replacement');
});

test('host restore tolerates failed locations/seats and an intervening voluntary done', async t => {
  const f = await fixture(t);
  await f.square.join('Peer');
  await f.square.join('Broken');
  await f.detach();
  await f.square.detachOwnedSession('Peer', f.body.session, undefined, f.body);
  await f.square.detachOwnedSession('Broken', f.body.session, undefined, f.body);
  await rememberSquarePath(path.join(f.root, 'missing.square'), f.body, f.env.SQUARE_INDEX);
  const implicitJoin = Object.getPrototypeOf(f.square).implicitJoin;
  let failed = false;
  t.mock.method(Object.getPrototypeOf(f.square), 'implicitJoin', async function(name, control) {
    if (name === 'Bob' && !failed) {
      failed = true;
      // A participant voluntarily leaves between discovery and the restoring transaction.
      await (await f.square.join('Bob')).participant.done();
    }
    if (name === 'Broken') throw new Error('one failed seat');
    return implicitJoin.call(this, name, control);
  });
  await restoreSessionSeats(f.body, f.env);
  assert.equal(await f.read(facts => facts.participant('Bob').done), true);
  assert.equal(await f.read(facts => facts.seat('Peer').attachment), 'attached');
  assert.equal(await f.read(facts => facts.seat('Broken').attachment), 'detached');
});

test('OpenCode permanent deletion ends attached or detached membership, while normal startup only restores standing exact-Body seats', async t => {
  const f = await fixture(t);
  const body = { channel: 'opencode', session: 'native' };
  const native = f.square.forBody({ body });
  await native.join('Attached');
  await native.join('Detached');
  await native.join('Replaced');
  const captured = (await native.bodySeats()).find(seat => seat.participant === 'Detached');
  await native.detachOwnedSession('Detached', body.session, captured.generation, body);
  await f.square.join('Replaced', { takeover: true });
  await endOpenCodeSession(body.session, f.env, new AbortController().signal);
  const state = await f.read(facts => ({ attached: facts.participant('Attached'), detached: facts.participant('Detached'), replaced: facts.seat('Replaced') }));
  assert.equal(state.attached.done, true);
  assert.equal(state.detached.done, true);
  assert.deepEqual(state.replaced.body, f.body);
  assert.equal(await publishOpenCodeAddress(body.session, f.env, new AbortController().signal), false);
  assert.deepEqual(await native.bodySeats(), []);
  await native.join('Resumable');
  const generation = (await native.bodySeats())[0].generation;
  await native.detachOwnedSession('Resumable', body.session, generation, body);
  assert.equal(await publishOpenCodeAddress(body.session, f.env, new AbortController().signal), true);
  assert.deepEqual(await native.bodySeats(), [{ participant: 'Resumable', generation, attachment: 'attached' }]);
});

test('the OpenCode session.deleted event uses permanent membership cleanup, not host detach', async t => {
  const f = await fixture(t);
  const body = { channel: 'opencode', session: 'deleted-session' };
  const native = f.square.forBody({ body });
  await native.join('Deleted');
  const previous = process.env.SQUARE_INDEX;
  process.env.SQUARE_INDEX = f.env.SQUARE_INDEX;
  let unload;
  try {
    unload = await openCodePlugin.setup({ app: { version: '2.0.20' }, location: { directory: f.root, project: { id: 'fixture' } },
      session: { async hook() {}, async get() { throw new Error('permanently unavailable'); }, async prompt() { assert.fail('no send'); } },
      event: { async *subscribe({ signal }) {
        yield { type: 'session.deleted', data: { sessionID: body.session } };
        if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      } },
    });
    const deadline = Date.now() + 1000;
    while (!(await f.read(facts => facts.participant('Deleted').done))) {
      assert.ok(Date.now() < deadline, 'session.deleted did not end membership');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(await f.read(facts => facts.seat('Deleted')), undefined);
    assert.equal(await f.read(facts => facts.activityCount({ actors: ['Deleted'], kinds: ['done'] })), 1);
  } finally {
    await unload?.();
    if (previous === undefined) delete process.env.SQUARE_INDEX; else process.env.SQUARE_INDEX = previous;
  }
});

test('CLI rosters show away and detached writes end with a plain rejoin', async t => {
  const f = await fixture(t);
  await f.detach();
  const cli = (...args) => spawnSync(process.execPath, [path.resolve('dist/square.js'), '--location', f.location, '--as', 'Bob', ...args], {
    env: { ...f.env, PI_SESSION_ID: f.body.session, NO_COLOR: '1' }, encoding: 'utf8', timeout: 10_000,
  });
  for (const command of ['participants', 'status']) {
    const result = cli(command);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Bob[^\n]*away/);
  }
  for (const args of [['catch'], ['done'], ['express', '--force', '--no-wait', 'not sent']]) {
    const result = cli(...args);
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /away/);
    assert.match(output.trim().split('\n').at(-1), /^square .* join(?:\s|$)/);
  }
});
