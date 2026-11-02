import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeStandaloneChannel } from '../dist/channel-sqlite-schema.js';
import { createChannelSqlite } from '../dist/sqlite-channel.js';
import { pendingMessageHeads } from '../dist/channel-delivery.js';

test('directed pages and counts share current address and unseen eligibility', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeStandaloneChannel(db);
    const facts = createChannelSqlite(db);
    facts.storeEndpoint({ participant: 'Bob', owner: 'bob', generation: 'current', attachment: 'attached' });
    for (const generation of [undefined, 'current', 'old', 'current']) {
      facts.publishMessage({ from: 'Alice', at: 1, body: 'hello', to: [{ recipient: 'Bob', ...(generation && { generation }) }] });
    }
    facts.markSeen('Bob', [1], 2);
    const filter = { currentGeneration: true, unseenOnly: true };
    const page = facts.directed('bob', filter, { edge: 'oldest', limit: 10 });
    assert.deepEqual(page.items.map(item => item.index), [0, 3]);
    assert.equal(facts.directedCount('bob', filter), page.items.length);
    assert.equal(facts.directedCount('Bob', { ...filter, afterIndex: 0 }), 1);
  } finally { db.close(); }
});

test('all live current-generation claims contribute exact suppression coverage', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeStandaloneChannel(db);
    const facts = createChannelSqlite(db);
    facts.storeEndpoint({ participant: 'Bob', owner: 'bob', generation: 'current', attachment: 'attached' });
    facts.publishMessage({ from: 'Alice', at: 1, body: 'hello', to: [{ recipient: 'Bob', generation: 'current' }] });
    const claim = (namespace, generation, suppressed, expiresAt) => facts.putReceiveClaim({
      namespace, id: namespace, owner: 'Bob', generation, suppressed, selector: {}, heartbeatAt: 0, expiresAt,
    });
    claim('a', 'current', [], 20);
    claim('b', 'current', [0], 20);
    claim('c', 'old', [1], 20);
    claim('d', 'current', [2], 10);
    assert.equal(facts.suppressed('Bob', 'current', 0, 10), true);
    assert.deepEqual(pendingMessageHeads(facts, 'Bob', 10).map(head => head.index), []);
    assert.equal(facts.suppressed('Bob', 'current', 1, 10), false);
    assert.equal(facts.suppressed('Bob', 'current', 2, 10), false);
    assert.equal(facts.suppressed('Bob', 'current', 3, 10), false);
    assert.equal(facts.suppressed('Bob', 'current', 0, 20), false);
    assert.deepEqual(pendingMessageHeads(facts, 'Bob', 20).map(head => head.index), [0]);
  } finally { db.close(); }
});
