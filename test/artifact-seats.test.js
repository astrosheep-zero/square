import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArtifactPort } from '../dist/artifact.js';

const empty = () => ({ hardCap: null, preamble: [], warmup: [], acts: [], runtime: { nextActIndex: 0, observations: {}, leases: {} } });

async function join(artifact, participant, body, at) {
  await artifact.transactAs({ kind: 'join', participant, body }, facts => facts.land({ kind: 'join', actor: participant, at }));
  return (await artifact.read(facts => facts.seat(participant))).value;
}

test('every SeatRef mutation checks the complete input against captured authority', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const alice = await join(artifact, 'Alice', { channel: 'test', session: 'alice' }, 1);
  const bob = await join(artifact, 'Bob', { channel: 'test', session: 'bob', agent: 'worker' }, 2);
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 3, body: 'notice', mentions: ['Bob'] }));
  const claim = { seat: bob, activity: 'act/2', kind: 'wake', at: 4, leaseMs: 100, claimToken: 'body-claim' };
  assert.equal((await artifact.claimDelivery(claim)).status, 'acquired');
  const correlation = { harness: 'pi', token: 'native' };
  const observation = { eventId: 'event', messageId: 'message', state: 'held', observedAt: 5 };
  const mutations = [
    ['claim', { session: 'other' }, (facts, seat) => facts.claimDelivery({ ...claim, seat, claimToken: 'forged' })],
    ['prepare', { agent: 'other' }, (facts, seat) => facts.prepareDelivery({ seat, claimToken: claim.claimToken, correlation })],
    ['complete', { channel: 'pi' }, (facts, seat) => facts.completeDelivery({ ...claim, seat, outcome: 'accepted' })],
    ['observe', { agent: undefined }, (facts, seat) => facts.observeNativeDelivery({ seat, claimToken: claim.claimToken, observation })],
    ['wake address', { channel: 'pi' }, (facts, seat) => facts.updateWakeAddress(seat, { kind: 'paseo', address: { agentId: 'wrong' } })],
    ['cancel', { agent: 'other' }, (facts, seat) => facts.cancelThrough(seat, 2)],
  ];
  const before = (await artifact.read(facts => facts.header())).value;
  for (const [name, changedBody, mutate] of mutations) {
    const forged = { ...bob, body: { ...bob.body, ...changedBody } };
    await assert.rejects(artifact.transactAs({ kind: 'participant', seat: bob }, facts => mutate(facts, forged)),
      error => error.code === 'already_joined', name);
  }
  for (const forged of [{ ...bob, participant: 'Alice' }, { ...bob, generation: alice.generation }])
    await assert.rejects(artifact.transactAs({ kind: 'participant', seat: bob }, facts =>
      facts.claimDelivery({ ...claim, seat: forged })), error => error.code === 'already_joined');
  await assert.rejects(artifact.transactAs({ kind: 'join', participant: 'Bob', body: bob.body }, facts =>
    facts.updateWakeAddress({ ...bob, body: { ...bob.body, agent: 'other' } })), error => error.code === 'already_joined');
  assert.deepEqual((await artifact.read(facts => facts.header())).value, before);
  assert.equal((await artifact.read(facts => facts.deliveryByToken('forged'))).value, undefined);
  const unchanged = (await artifact.read(facts => facts.deliveryByToken(claim.claimToken))).value;
  assert.equal(unchanged.outcome, 'dispatching');
  assert.equal(unchanged.correlation, undefined);
  assert.equal(unchanged.nativeObservations, undefined);
  assert.equal((await artifact.read(facts => facts.cancelledThrough('Bob', bob.generation))).value, undefined);
  assert.equal((await artifact.read(facts => facts.seat('Bob'))).value.wakeAddress, undefined);
  assert.equal(await artifact.prepareDelivery({ seat: bob, claimToken: claim.claimToken, correlation }), true);
  assert.equal(await artifact.completeDelivery({ ...claim, outcome: 'accepted' }), true);
});

test('mutations revalidate after done in the same transaction and rejected writes roll back retirement', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const bob = await join(artifact, 'Bob', { channel: 'test', session: 'bob', agent: 'worker' }, 1);
  const claim = { seat: bob, activity: 'act/0', kind: 'wake', at: 3, leaseMs: 100, claimToken: 'after-done' };
  const mutations = [
    facts => facts.claimDelivery(claim),
    facts => facts.prepareDelivery({ seat: bob, claimToken: claim.claimToken, correlation: { harness: 'pi', token: 'native' } }),
    facts => facts.completeDelivery({ ...claim, outcome: 'accepted' }),
    facts => facts.observeNativeDelivery({ seat: bob, claimToken: claim.claimToken, observation: { eventId: 'event', messageId: 'message', state: 'held', observedAt: 3 } }),
    facts => facts.updateWakeAddress(bob, { kind: 'paseo', address: { agentId: 'bob' } }),
    facts => facts.cancelThrough(bob, 0),
    facts => facts.markSeen('Bob', [0], 3),
    facts => facts.putLease('Bob', { leaseId: 'lease', heartbeatAt: 3, expiresAt: 100 }, bob.generation),
    facts => facts.removeLease('Bob', 'lease', bob.generation),
    facts => facts.land({ kind: 'say', actor: 'Bob', at: 3, body: 'after done' }),
  ];
  const before = (await artifact.read(facts => facts.header())).value;
  for (const mutate of mutations) {
    await assert.rejects(artifact.transactAs({ kind: 'participant', seat: bob }, facts => {
      facts.land({ kind: 'done', actor: 'Bob', at: 2 });
      mutate(facts);
    }), error => error.code === 'already_joined');
    assert.deepEqual((await artifact.read(facts => facts.header())).value, before);
    assert.deepEqual((await artifact.read(facts => facts.seat('Bob'))).value, bob);
  }
});

test('artifact gate owns lifecycle seats, fences writes, and keeps delivery evidence off conversation revisions', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const aliceBody = { channel: 'test', session: 'alice' };
  const bobBody = { channel: 'test', session: 'bob', agent: 'worker' };
  const alice = await join(artifact, 'Alice', aliceBody, 1);
  const bob = await join(artifact, 'Bob', bobBody, 2);
  assert.equal('transact' in artifact, false);
  assert.equal((await artifact.transactAs({ kind: 'participant', seat: alice }, facts => ({
    publicStoreSeat: 'storeSeat' in facts,
    publicRemoveSeat: 'removeSeat' in facts,
  }))).value.publicStoreSeat, false);
  assert.equal((await artifact.read(facts => facts.seat('Bob'))).value.generation, bob.generation);

  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 3, body: 'hello @Bob', mentions: ['Bob'] }));
  const beforeDelivery = await artifact.read(facts => ({ conversation: facts.header().revision, delivery: facts.header().deliveryRevision }));
  const claim = await artifact.claimDelivery({ seat: bob, activity: 'act/2', kind: 'wake',
    route: { kind: 'claude-native', address: { sessionId: 'bob' } }, at: 4, leaseMs: 100, claimToken: 'claim-1' });
  assert.deepEqual(claim, { status: 'acquired', claimToken: 'claim-1', attemptN: 0 });
  assert.equal((await artifact.read(facts => facts.deliveryByToken('claim-1'))).value?.participant, 'Bob');
  assert.equal((await artifact.read(facts => facts.header().revision)).value, beforeDelivery.value.conversation);

  const observation = { eventId: 'event-1', messageId: 'message-1', state: 'held', observedAt: 5 };
  assert.equal((await artifact.transactAs({ kind: 'participant', seat: bob }, facts =>
    facts.observeNativeDelivery({ seat: bob, claimToken: 'claim-1', observation }))).value, true);
  assert.equal(await artifact.completeDelivery({ seat: bob, activity: 'act/2', claimToken: 'claim-1', outcome: 'accepted', at: 6,
    correlation: { harness: 'claude', messageId: 'message-1' } }), true);
  const evidence = (await artifact.read(facts => facts.deliveryByToken('claim-1'))).value;
  assert.equal(evidence?.outcome, 'accepted');
  assert.deepEqual(evidence?.nativeObservations, [observation]);
  assert.equal((await artifact.read(facts => facts.header().revision)).value, beforeDelivery.value.conversation);
  assert.ok((await artifact.read(facts => facts.header().deliveryRevision)).value > beforeDelivery.value.delivery);

  await artifact.transactAs({ kind: 'participant', seat: bob }, facts =>
    facts.updateWakeAddress(bob, { kind: 'paseo', address: { agentId: 'bob' } }));
  assert.deepEqual((await artifact.read(facts => facts.seat('Bob'))).value?.wakeAddress,
    { kind: 'paseo', address: { agentId: 'bob' } });
  assert.equal(await artifact.cancelDeliveries(bob), true);
  assert.equal((await artifact.read(facts => facts.cancelledThrough('Bob', bob.generation))).value, 2);
  const revisionAtCancellation = await artifact.revision();
  await assert.rejects(artifact.cancelDeliveries(bob, 999), /existing activity|current head/i);
  assert.equal(await artifact.revision(), revisionAtCancellation, 'a future cancellation boundary rolls back');
  assert.equal((await artifact.read(facts => facts.cancelledThrough('Bob', bob.generation))).value, 2);
  assert.deepEqual(await artifact.claimDelivery({ seat: bob, activity: 'act/2', kind: 'wake', at: 7, leaseMs: 100, claimToken: 'claim-2' }),
    { status: 'stale' });

  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 8, body: 'after cancellation', mentions: ['Bob'] }));
  assert.equal((await artifact.claimDelivery({ seat: bob, activity: 'act/3', kind: 'wake', at: 9, leaseMs: 100, claimToken: 'claim-3' })).status, 'acquired');

  const replacementBody = { channel: 'test', session: 'replacement' };
  const replacement = (await artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: replacementBody, expectedGeneration: bob.generation }, facts => {
    facts.land({ kind: 'done', actor: 'Bob', at: 10 });
    facts.land({ kind: 'join', actor: 'Bob', at: 11 });
    return facts.seat('Bob');
  })).value;
  assert.equal(replacement.body.session, 'replacement');
  assert.notEqual(replacement.generation, bob.generation);
  assert.equal((await artifact.read(facts => facts.seat('Bob'))).value.generation, replacement.generation);
  assert.equal((await artifact.read(facts => facts.cancelledThrough('Bob', replacement.generation))).value, undefined);
  await assert.rejects(artifact.transactAs({ kind: 'participant', seat: bob }, facts => facts.markSeen('Bob', [2], 12)), /replaced/);
  assert.equal((await artifact.read(facts => facts.seatsForBody(aliceBody))).value.length, 1);
  assert.equal((await artifact.read(facts => facts.seatsForBody(replacementBody))).value[0].participant, 'Bob');

  const committedRevision = await artifact.revision();
  await assert.rejects(artifact.transactAs(undefined, () => assert.fail('missing authority must fail before callback')), /explicit authority/i);
  await assert.rejects(artifact.transactAs({ kind: 'join', participant: 'Alice', body: aliceBody }, facts =>
    facts.land({ kind: 'join', actor: 'Alice', at: 12 })), /already standing/);
  await assert.rejects(artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Bob', at: 12, body: 'mismatch' })), /actor does not match/);
  await assert.rejects(artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: { channel: 'test', session: 'other' }, expectedGeneration: bob.generation }, () => null), /changed before takeover/);
  await assert.rejects(artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: { channel: 'test', session: 'other' }, expectedGeneration: replacement.generation }, facts =>
    facts.land({ kind: 'done', actor: 'Bob', at: 12 })), /did not complete its replacement join/);
  assert.equal(await artifact.revision(), committedRevision, 'rejected admissions and incomplete takeover leave state untouched');
  assert.equal((await artifact.read(facts => facts.seat('Bob'))).value.generation, replacement.generation);
});

test('done removes seat authority, and rejoin/takeover replace it atomically', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const body = { channel: 'test', session: 'same', agent: 'child' };
  const first = await join(artifact, 'Ivy', body, 1);
  await artifact.transactAs({ kind: 'participant', seat: first }, facts => {
    facts.putLease('Ivy', { leaseId: 'old', heartbeatAt: 1, expiresAt: 100 }, first.generation);
    facts.land({ kind: 'done', actor: 'Ivy', at: 2 });
    assert.equal(facts.seat('Ivy'), undefined);
    assert.deepEqual(facts.seatsForBody(body), []);
    assert.equal(facts.lease('Ivy'), undefined);
  });
  await assert.rejects(artifact.transactAs({ kind: 'participant', seat: first }, facts => facts.putLease('Ivy', { leaseId: 'invalid', heartbeatAt: 2, expiresAt: 100 })), /replaced/);
  const second = await join(artifact, 'Ivy', body, 3);
  assert.notEqual(second.generation, first.generation);
  await artifact.transactAs({ kind: 'participant', seat: second }, facts => facts.putLease('Ivy', { leaseId: 'new', heartbeatAt: 3, expiresAt: 100 }, second.generation));
  await assert.rejects(artifact.transactAs({ kind: 'participant', seat: first }, facts => facts.removeLease('Ivy', 'new', first.generation)), /replaced/);
  await assert.rejects(artifact.transactAs({ kind: 'takeover', participant: 'Ivy', body, expectedGeneration: second.generation }, facts => facts.land({ kind: 'done', actor: 'Ivy', at: 4 })), /replacement join/);
  assert.equal((await artifact.read(facts => facts.seat('Ivy'))).value.generation, second.generation);
  assert.equal((await artifact.read(facts => facts.lease('Ivy'))).value.leaseId, 'new');
  await artifact.transactAs({ kind: 'takeover', participant: 'Ivy', body, expectedGeneration: second.generation }, facts => {
    facts.land({ kind: 'done', actor: 'Ivy', at: 4 });
    facts.land({ kind: 'join', actor: 'Ivy', at: 5 });
    assert.notEqual(facts.seat('Ivy').generation, second.generation);
    assert.equal(facts.lease('Ivy'), undefined);
  });
});

 test('reattached handles retain generation fencing without reviving departed names', async t => {
  const { SqliteSquare } = await import('../dist/sqlite-square.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'square-reattach-seat-'));
  const location = path.join(dir, 'shared.square');
  const { createSquareFile } = await import('../dist/artifact.js');
  await createSquareFile(location, empty());
  const body = { channel: 'test', session: 'owner' };
  const square = await SqliteSquare.at({ path: location, env: {} });
  t.after(async () => { await square.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(await square.reattach('Ivy', { body }), null);
  const ivy = (await square.join('Ivy', { body })).participant;
  const generation = (await square.seatsOf(body))[0].generation;
  await square.detach('Ivy', { body, generation });
  const active = await square.reattach('Ivy', { body });
  assert.equal((await square.seatsOf(body))[0].generation, generation);
  assert.equal((await active.express('from restored handle')).activity.body, 'from restored handle');
  await active.done();
  assert.equal(await square.reattach('Ivy', { body }), null);
  await square.join('Ivy', { body });
  await assert.rejects(ivy.express('stale handle'), { code: 'already_joined' });
});

 test('cancellation captures the current head and does not suppress later or replacement activity', async t => {
  const artifact = createArtifactPort(':memory:', empty());
  t.after(() => artifact.close());
  const alice = await join(artifact, 'Alice', { channel: 'test', session: 'alice' }, 1);
  const bob = await join(artifact, 'Bob', { channel: 'test', session: 'bob' }, 2);
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 3, body: 'first @Bob', mentions: ['Bob'] }));
  assert.equal(await artifact.cancelDeliveries(bob), true);
  assert.equal((await artifact.read(facts => facts.cancelledThrough('Bob', bob.generation))).value, 2);
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 4, body: 'later @Bob', mentions: ['Bob'] }));
  assert.equal((await artifact.claimDelivery({ seat: bob, activity: 'act/3', kind: 'wake', at: 5, leaseMs: 50, claimToken: 'later' })).status, 'acquired');
  const replacement = (await artifact.transactAs({ kind: 'takeover', participant: 'Bob', body: { channel: 'test', session: 'new' }, expectedGeneration: bob.generation }, facts => {
    facts.land({ kind: 'done', actor: 'Bob', at: 6 });
    facts.land({ kind: 'join', actor: 'Bob', at: 7 });
    return facts.seat('Bob');
  })).value;
  await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 8, body: 'new generation @Bob', mentions: ['Bob'] }));
  assert.equal((await artifact.claimDelivery({ seat: replacement, activity: 'act/6', kind: 'wake', at: 9, leaseMs: 50, claimToken: 'replacement' })).status, 'acquired');
  assert.equal((await artifact.read(facts => facts.cancelledThrough('Bob', replacement.generation))).value, undefined);
});
