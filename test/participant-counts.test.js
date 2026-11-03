import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { observeCatchSelection, selectCatchPage } from '../dist/catch-decisions.js';
import { inSquareCount, terminalStatusFor, watchTerminalStatus } from '../dist/runtime.js';

function fixture(t, hardCap = null, acts = []) {
  const cell = createArtifactPort(':memory:', {
    hardCap, preamble: [], warmup: [], acts,
    runtime: { nextActIndex: acts.length, observations: {}, leases: {} },
  });
  t.after(() => cell.close());
  return cell;
}

async function establishSeat(cell, participant, at) {
  const body = "test" + ":" + (participant.toLowerCase());
  return (await cell.transactAs({ kind: 'join', participant, owner: body }, (facts) => {
    facts.land({ kind: 'join', actor: participant, at });
    return facts.seat(participant);
  })).value;
}

test('participant counts are immutable, transaction-scoped facts with read-your-writes and rollback', async (t) => {
  const cell = fixture(t);
  const empty = (await cell.read((facts) => facts.participantCounts())).value;
  assert.deepEqual(empty, { known: 0, joined: 0, done: 0 });
  const alice = await establishSeat(cell, 'Alice', 0);
  await establishSeat(cell, 'Bob', 1);
  let escaped;
  const counts = (await cell.transactAs({ kind: 'participant', seat: alice }, (facts) => {
    escaped = facts.participantCounts;
    const before = facts.participantCounts();
    facts.land({ kind: 'done', actor: 'Alice', at: 2 });
    return [before, facts.participantCounts()];
  })).value;
  assert.deepEqual(counts, [{ known: 2, joined: 2, done: 0 }, { known: 2, joined: 1, done: 1 }]);
  assert.deepEqual(empty, { known: 0, joined: 0, done: 0 });
  assert.throws(() => { counts[0].joined = 100; }, TypeError);
  assert.throws(() => escaped(), /expired/);

  const bob = (await cell.read(facts => facts.seat('Bob'))).value;
  const reason = new Error('roll back counts');
  await assert.rejects(cell.transactAs({ kind: 'participant', seat: bob }, (facts) => {
    facts.land({ kind: 'done', actor: 'Bob', at: 3 });
    assert.deepEqual(facts.participantCounts(), { known: 2, joined: 0, done: 2 });
    throw reason;
  }), (error) => error === reason);
  assert.deepEqual((await cell.read((facts) => facts.participantCounts())).value, counts.at(-1));
});

test('catch and terminal summaries use aggregate facts and preserve all-known-peer quorum and cap precedence', async (t) => {
  const cell = fixture(t, 1, [{ kind: 'say', actor: 'Ghost', body: 'known', at: 0, index: 0 }]);
  const aliceSeat = await establishSeat(cell, 'Alice', 0);
  const bobSeat = await establishSeat(cell, 'Bob', 1);
  await cell.transactAs({ kind: 'participant', seat: aliceSeat }, facts => facts.land({ kind: 'done', actor: 'Alice', at: 3 }));
  let countReads = 0;
  const wrap = (facts) => ({
    ...facts,
    roster() { assert.fail('summary must not hydrate the roster'); },
    participantCounts() { countReads++; return facts.participantCounts(); },
  });
  const summary = () => cell.read(facts => {
    const wrapped = wrap(facts), page = selectCatchPage(wrapped, 'bOB', {});
    return observeCatchSelection(wrapped, page.participant, [], page.filter, 100);
  }).then(result => result.value);
  const pendingPeer = await summary();
  assert.equal(pendingPeer.standingCount, 1);
  assert.equal(pendingPeer.terminalStatus, undefined, 'a known nonstanding peer blocks quorum');
  assert.equal(countReads, 1, 'catch shares its aggregate read');
  assert.equal((await cell.read((facts) => inSquareCount(wrap(facts)))).value, 1);

  const ghostSeat = await establishSeat(cell, 'Ghost', 3);
  await cell.transactAs({ kind: 'participant', seat: ghostSeat }, facts => facts.land({ kind: 'done', actor: 'Ghost', at: 4 }));
  assert.equal((await summary()).terminalStatus, 'quorum');
  assert.equal((await cell.read((facts) => watchTerminalStatus(wrap(facts), 'Missing'))).value, undefined);
  await cell.transactAs({ kind: 'participant', seat: bobSeat }, facts => facts.land({ kind: 'say', actor: 'Bob', at: 5, body: 'at cap' }));
  assert.equal((await cell.read((facts) => watchTerminalStatus({
    ...wrap(facts),
    participantCounts() { assert.fail('a capped watcher needs no aggregate read'); },
  }, 'BOB'))).value, 'capped');
  assert.equal((await summary()).terminalStatus, 'capped', 'cap takes precedence over quorum');

  await cell.transactAs({ kind: 'participant', seat: bobSeat }, facts => facts.land({ kind: 'done', actor: 'Bob', at: 6 }));
  await cell.read((facts) => {
    const counts = facts.participantCounts(), current = facts.participant('Bob');
    assert.equal(terminalStatusFor(current, null, counts), 'quorum', 'a done caller is subtracted from done peers');
    assert.equal(watchTerminalStatus(wrap(facts), 'Missing'), 'quorum', 'a missing caller excludes no known peer');
    assert.equal(terminalStatusFor(undefined, null, { known: 0, joined: 0, done: 0 }), undefined);
    assert.equal(terminalStatusFor(current, null, { known: 1, joined: 0, done: 1 }), undefined, 'quorum needs a peer');
  });
});
