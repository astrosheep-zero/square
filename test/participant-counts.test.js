import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { catchUp } from '../dist/square-actions.js';
import { inSquareCount, terminalStatusFor, watchTerminalStatus } from '../dist/runtime.js';

function fixture(t, hardCap = null) {
  const cell = createArtifactPort(':memory:', {
    hardCap, preamble: [], warmup: [], acts: [],
    runtime: { nextActIndex: 0, observations: {}, leases: {} },
  });
  t.after(() => cell.close());
  return cell;
}

test('participant counts are immutable, transaction-scoped facts with read-your-writes and rollback', async (t) => {
  const cell = fixture(t);
  const empty = (await cell.read((facts) => facts.participantCounts())).value;
  assert.deepEqual(empty, { known: 0, joined: 0, done: 0 });
  let escaped;
  const counts = (await cell.transact((facts) => {
    escaped = facts.participantCounts;
    const observed = [];
    const land = (activity) => {
      facts.land(activity);
      observed.push(facts.participantCounts());
    };
    land({ kind: 'join', actor: 'Alice', at: 0 });
    land({ kind: 'join', actor: 'Bob', at: 1 });
    land({ kind: 'say', actor: 'Ghost', at: 2, body: 'known without a join' });
    land({ kind: 'done', actor: 'Alice', at: 3 });
    land({ kind: 'done', actor: 'Ghost', at: 4 });
    land({ kind: 'join', actor: 'ALICE', at: 5 });
    return observed;
  })).value;
  assert.deepEqual(counts, [
    { known: 1, joined: 1, done: 0 },
    { known: 2, joined: 2, done: 0 },
    { known: 3, joined: 2, done: 0 },
    { known: 3, joined: 1, done: 1 },
    { known: 3, joined: 1, done: 2 },
    { known: 3, joined: 2, done: 1 },
  ]);
  assert.deepEqual(empty, { known: 0, joined: 0, done: 0 });
  assert.throws(() => { counts[0].joined = 100; }, TypeError);
  assert.throws(() => escaped(), /expired/);

  const reason = new Error('roll back counts');
  await assert.rejects(cell.transact((facts) => {
    facts.land({ kind: 'done', actor: 'Bob', at: 6 });
    assert.deepEqual(facts.participantCounts(), { known: 3, joined: 1, done: 2 });
    throw reason;
  }), (error) => error === reason);
  assert.deepEqual((await cell.read((facts) => facts.participantCounts())).value, counts.at(-1));
});

test('catch and terminal summaries use aggregate facts and preserve all-known-peer quorum and cap precedence', async (t) => {
  const cell = fixture(t, 1);
  await cell.transact((facts) => {
    facts.land({ kind: 'join', actor: 'Alice', at: 0 });
    facts.land({ kind: 'join', actor: 'Bob', at: 1 });
    facts.land({ kind: 'say', actor: 'Ghost', at: 2, body: 'not standing, not done' });
    facts.land({ kind: 'done', actor: 'Alice', at: 3 });
  });
  let countReads = 0;
  const wrap = (facts) => ({
    ...facts,
    roster() { assert.fail('summary must not hydrate the roster'); },
    participantCounts() { countReads++; return facts.participantCounts(); },
  });
  const square = { clock: () => 100, location: 'memory', artifact: {
    ...cell,
    read: (select, signal) => cell.read((facts) => select(wrap(facts)), signal),
    transact: (change, signal) => cell.transact((facts) => change(wrap(facts)), signal),
  } };
  const pendingPeer = await catchUp(square, 'bOB');
  assert.equal(pendingPeer.standingCount, 1);
  assert.equal(pendingPeer.terminalStatus, undefined, 'a known nonstanding peer still blocks quorum');
  assert.equal(countReads, 1, 'catch shares its aggregate read');
  assert.equal((await cell.read((facts) => inSquareCount(wrap(facts)))).value, 1);

  await cell.transact((facts) => facts.land({ kind: 'done', actor: 'Ghost', at: 4 }));
  assert.equal((await catchUp(square, 'Bob')).terminalStatus, 'quorum');
  assert.equal((await cell.read((facts) => watchTerminalStatus(wrap(facts), 'Missing'))).value, undefined);
  await cell.transact((facts) => facts.land({ kind: 'say', actor: 'Bob', at: 5, body: 'at cap' }));
  assert.equal((await cell.read((facts) => watchTerminalStatus({
    ...wrap(facts),
    participantCounts() { assert.fail('a capped watcher needs no aggregate read'); },
  }, 'BOB'))).value, 'capped');
  assert.equal((await catchUp(square, 'Bob')).terminalStatus, 'capped', 'cap takes precedence over quorum');

  await cell.transact((facts) => facts.land({ kind: 'done', actor: 'Bob', at: 6 }));
  await cell.read((facts) => {
    const counts = facts.participantCounts(), current = facts.participant('Bob');
    assert.equal(terminalStatusFor(current, null, counts), 'quorum', 'a done caller is subtracted from done peers');
    assert.equal(watchTerminalStatus(wrap(facts), 'Missing'), 'quorum', 'a missing caller excludes no known peer');
    assert.equal(terminalStatusFor(undefined, null, { known: 0, joined: 0, done: 0 }), undefined);
    assert.equal(terminalStatusFor(current, null, { known: 1, joined: 0, done: 1 }), undefined, 'quorum needs a peer');
  });
});
