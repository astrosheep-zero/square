import assert from 'node:assert/strict';
import test from 'node:test';
import { createArtifactPort } from '../dist/artifact.js';
import { presentPending } from '../dist/presentation-operations.js';

async function fixture(t) {
  const artifact = createArtifactPort(':memory:', { hardCap: null, preamble: [], warmup: [], acts: [],
    runtime: { nextActIndex: 0, observations: {}, leases: {} } });
  t.after(() => artifact.close());
  const join = (participant, at) => artifact.transactAs({ kind: 'join', participant, owner: `test:${participant}` }, facts => {
    facts.land({ kind: 'join', actor: participant, at });
    return facts.seat(participant);
  }).then(result => result.value);
  const alice = await join('Alice', 1), bob = await join('Bob', 2);
  const item = (await artifact.transactAs({ kind: 'participant', seat: alice }, facts =>
    facts.land({ kind: 'say', actor: 'Alice', at: 3, mentions: ['Bob'], body: 'full consumption' }))).value;
  const read = () => artifact.read(facts => ({
    receipt: facts.receipt('Bob', item.index), evidence: facts.deliveryEvidence('Bob', bob.generation, `act/${item.index}`),
    header: facts.header(),
  })).then(result => result.value);
  return { artifact, bob, item, read, input: { artifact, location: 'memory://presentation', participant: 'Bob', seat: bob, activity: item.index, now: 7 } };
}

test('receipt write failure rolls back both captured full receipt and attempt completion in the actual Square transaction', async t => {
  const f = await fixture(t);
  const failure = new Error('receipt write failed');
  let beforeSettlement, writes = 0, effects = 0;
  const artifact = { ...f.artifact, settleAs: (authority, change) => f.artifact.settleAs(authority, facts => change({ ...facts,
    markSeen(...args) {
      writes++;
      assert.equal(facts.deliveryEvidence('Bob', f.bob.generation, `act/${f.item.index}`)[0].outcome, 'presented',
        'attempt completion has already been written in this transaction');
      facts.markSeen(...args);
      assert.ok(facts.receipt('Bob', f.item.index), 'the injected failure is after a real receipt write');
      throw failure;
    },
  })) };
  await assert.rejects(presentPending({ ...f.input, artifact, sink: { async present() {
    effects++;
    beforeSettlement = await f.read();
    assert.equal(beforeSettlement.evidence[0].outcome, 'dispatching');
  } } }), error => error === failure);
  assert.equal(effects, 1);
  assert.equal(writes, 1);
  assert.deepEqual(await f.read(), beforeSettlement, 'receipt, attempt, and both revisions rolled back; cleanup did not overwrite custody');
});

test('Square full/clipped sinks preserve semantic timestamps; clipped success records no full receipt', async t => {
  for (const full of [true, false]) await t.test(full ? 'full' : 'clipped', async t => {
    const f = await fixture(t);
    const result = await presentPending({ ...f.input, markSeen: full, sink: { present(item) { assert.equal(item.body, 'full consumption'); } } });
    assert.equal(result.presented, true);
    assert.equal(result.activity.index, f.item.index);
    const state = await f.read();
    assert.equal(state.evidence[0].outcome, full ? 'presented' : 'clipped');
    assert.equal(state.evidence[0].at, 7);
    assert.equal(Boolean(state.receipt), full);
    if (full) assert.equal(state.receipt.at, 7);
  });
});

test('Square maps a rejected sink explicitly to failed, rethrows its original exception and records no receipt', async t => {
  const f = await fixture(t), failure = new Error('Square sink rejected');
  await assert.rejects(presentPending({ ...f.input, sink: { present() { throw failure; } } }), error => error === failure);
  const state = await f.read();
  assert.equal(state.receipt, undefined);
  assert.equal(state.evidence[0].outcome, 'failed');
  assert.equal(state.evidence[0].message, failure.message);
});
