import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createTestArtifactPort as createArtifactPort } from './fixtures/test-artifact-port.js';
import { createSqliteDriver, initializeSqlite } from '../dist/square-sqlite.js';

function state() {
  return {
    hardCap: null, preamble: [], warmup: [],
    acts: [
      { kind: 'join', actor: 'Bob', at: 0, index: 1 },
      { kind: 'say', actor: 'Alice', body: 'before join', at: 1, index: 2 },
      { kind: 'join', actor: 'alice', at: 2, index: 5 },
      { kind: 'say', actor: 'ALICE', body: 'second', at: 3, index: 9 },
      { kind: 'say', actor: 'Bob', body: 'first', at: 4, index: 12 },
      { kind: 'done', actor: 'Alice', at: 5, index: 14 },
      { kind: 'join', actor: 'Alice', at: 6, index: 18 },
      { kind: 'say', actor: 'alice', body: 'after rejoin', at: 7, index: 23 },
      { kind: 'listen', actor: 'Alice', target: 'Bob', at: 8, index: 27 },
      { kind: 'say', actor: 'Bob', body: 'second', at: 9, index: 30 },
      { kind: 'done', actor: 'Bob', at: 10, index: 33 },
    ],
    runtime: { nextActIndex: 34, observations: {}, leases: {} },
  };
}

test('say ordinals preserve lifetime prefix numbering across gaps, case changes, rejoins, and new same-transaction says', async (t) => {
  const cell = createArtifactPort(':memory:', state());
  t.after(() => cell.close());
  const original = (await cell.read((facts) => {
    assert.deepEqual(facts.sayOrdinals([]), {});
    return facts.sayOrdinals([2, 9, 12, 23, 30, 5, 27, 999, 23]);
  })).value;
  assert.deepEqual(original, { 2: 1, 9: 2, 12: 1, 23: 3, 30: 2 });
  assert.throws(() => { original[23] = 100; }, TypeError);
  await cell.transact((facts) => {
    assert.deepEqual(facts.sayOrdinals([23]), { 23: 3 });
    const next = facts.land({ kind: 'say', actor: 'ALICE', body: 'fourth', at: 11 });
    assert.deepEqual(facts.sayOrdinals([2, 23, next.index]), { 2: 1, 23: 3, [next.index]: 4 });
  });
  assert.deepEqual((await cell.read((facts) => facts.sayOrdinals([23, 34]))).value, { 23: 3, 34: 4 });
  assert.deepEqual(original, { 2: 1, 9: 2, 12: 1, 23: 3, 30: 2 });
});

test('missing participant projections retain prefix-count ordinals instead of losing selected says', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSqlite(db, state());
    const facts = createSqliteDriver(db);
    db.prepare('DELETE FROM participants WHERE name_key_json=?').run(JSON.stringify('alice'));
    assert.equal(facts.participant('Alice'), undefined);
    assert.deepEqual(facts.sayOrdinals([2, 9, 23, 30, 999]), { 2: 1, 9: 2, 23: 3, 30: 2 });
  } finally {
    db.close();
  }
});
