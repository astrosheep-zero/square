import assert from 'node:assert/strict';
import test from 'node:test';
import { receive, selectReceivedHeads, consumeReceived, recordConsumed, ReceiveError } from '../dist/receive.js';

// Caller-owned transactional memory, with storage uniqueness and rollback. Keys
// are equality identities; array insertion order, not key spelling, orders heads.
function memory() {
  let state = { items: new Map(), addresses: [], receipts: new Map() };
  const loads = [];
  function transact(change) {
    const draft = structuredClone(state);
    const receipt = ref => draft.receipts.get(ref.recipient)?.get(ref.item);
    const tx = {
      insertItem(item) {
        if (draft.items.has(item.key)) throw new Error('duplicate item');
        draft.items.set(item.key, item.data);
      },
      insertAddress(key, address, order) {
        if (draft.addresses.some(row => row.key === key && row.recipient === address.recipient)) throw new Error('duplicate address');
        draft.addresses.push({ key, ...address, order });
      },
      heads(recipient, query, { unconsumed, limit }) {
        return draft.addresses.filter(row => row.recipient === recipient
          && (query.via === undefined || row.via === query.via)
          && (!unconsumed || receipt({ recipient, item: row.key }) === undefined))
          .slice(0, limit).map(({ key, via }) => ({ key, via }));
      },
      addressed(recipient, key) {
        const row = draft.addresses.find(row => row.recipient === recipient && row.key === key);
        return row === undefined ? undefined : { key, via: row.via };
      },
      load(keys) {
        loads.push([...keys]);
        return new Map([...keys].reverse().filter(key => draft.items.has(key)).map(key => [key, draft.items.get(key)]));
      },
      count(recipient, query, unconsumed) {
        return tx.heads(recipient, query, { unconsumed, limit: Infinity }).length;
      },
      receipt,
      insertReceipt(ref, at) {
        if (receipt(ref) !== undefined) return false;
        if (!draft.receipts.has(ref.recipient)) draft.receipts.set(ref.recipient, new Map());
        draft.receipts.get(ref.recipient).set(ref.item, { at });
        return true;
      },
    };
    const value = change(tx, draft);
    state = draft;
    return value;
  }
  return { transact, loads, snapshot: () => structuredClone(state) };
}
const page = (query = {}, limit = 10) => ({ kind: 'page', query, limit });
const exact = key => ({ kind: 'exact', key, remainingQuery: {} });
const admit = (tx, key, audience, data = key) => receive(tx, { item: { key, data }, audience });
const address = (via = 'direct', recipient = 'east:bob') => ({ recipient, via });

test('admission keeps supplied audience order, allows nobody, and rolls back duplicates', () => {
  const db = memory();
  db.transact(tx => admit(tx, 'unobserved', []));
  db.transact(tx => admit(tx, 'opaque/z', [address(), address('link', 'west:bob')]));
  const before = db.snapshot();
  assert.deepEqual(before.addresses.map(row => [row.recipient, row.order]), [['east:bob', 0], ['west:bob', 1]]);
  assert.throws(() => db.transact(tx => admit(tx, 'opaque/z', [])), /duplicate item/);
  assert.throws(() => db.transact(tx => admit(tx, 'another', [address(), address()])), /duplicate address/);
  assert.deepEqual(db.snapshot(), before);
});

test('page filters before limit, probes do not consume, and sparse exact receipts preserve first time', () => {
  const db = memory();
  db.transact(tx => {
    admit(tx, 'z#first', [address('quiet')]);
    admit(tx, 'a#second', [address()]);
    admit(tx, 'm#third', [address()]);
    admit(tx, '0#last', [address()]);
  });
  db.transact(tx => {
    assert.deepEqual(selectReceivedHeads(tx, 'east:bob', page({ via: 'direct' }, 1)), [{ key: 'a#second', via: 'direct' }]);
    assert.equal(tx.count('east:bob', {}, true), 4);
    assert.deepEqual(consumeReceived(tx, 'east:bob', exact('m#third'), 10), {
      items: [{ key: 'm#third', data: 'm#third', via: 'direct' }], newlyConsumed: 1, remaining: 3,
    });
    const repeat = consumeReceived(tx, 'east:bob', { ...exact('m#third'), remainingQuery: { via: 'quiet' } }, 20);
    assert.equal(repeat.newlyConsumed, 0);
    assert.equal(repeat.remaining, 1);
    assert.deepEqual(tx.receipt({ recipient: 'east:bob', item: 'm#third' }), { at: 10 });
    const caught = consumeReceived(tx, 'east:bob', page({ via: 'direct' }, 1), 30);
    assert.deepEqual(caught.items.map(item => item.key), ['a#second']);
    assert.equal(caught.remaining, 1);
    assert.equal(tx.receipt({ recipient: 'east:bob', item: 'z#first' }), undefined);
    assert.equal(tx.receipt({ recipient: 'west:bob', item: 'm#third' }), undefined);
  });
  assert.deepEqual(db.loads, [['m#third'], ['m#third'], ['a#second']]);
  assert.throws(() => db.transact(tx => consumeReceived(tx, 'west:bob', exact('m#third'), 40)),
    error => error instanceof ReceiveError && error.code === 'not_addressed' && error.key === 'm#third');
});

test('missing hydration writes no receipts; later storage failure rolls back the entire consumption', () => {
  const db = memory();
  db.transact(tx => { admit(tx, 'first', [address()]); admit(tx, 'missing', [address()]); });
  db.transact((_tx, draft) => draft.items.delete('missing'));
  const before = db.snapshot();
  assert.throws(() => db.transact(tx => consumeReceived({ ...tx, insertReceipt() { assert.fail('must hydrate every item first'); } }, 'east:bob', page(), 10)),
    error => error.code === 'missing_item' && error.key === 'missing');
  assert.deepEqual(db.snapshot(), before);
  db.transact((_tx, draft) => draft.items.set('missing', undefined));
  const hydrated = db.snapshot();
  assert.throws(() => db.transact(tx => consumeReceived({ ...tx, count() { throw new Error('storage failure after receipts'); } }, 'east:bob', page(), 20)), /storage failure/);
  assert.deepEqual(db.snapshot(), hydrated);
  const consumed = db.transact(tx => consumeReceived(tx, 'east:bob', page(), 30));
  assert.deepEqual(consumed.items.map(item => item.key), ['first', 'missing']);
  assert.deepEqual(consumed.items.map(item => item.data), ['first', undefined]);
  assert.equal(consumed.newlyConsumed, 2);
});

test('captured receipts need only insertion, keep coordinates independent, and validate arguments', () => {
  const db = memory();
  db.transact(tx => {
    const refs = [{ recipient: 'captured', item: 9 }, { recipient: 'captured', item: 9 }, { recipient: 'other', item: 9 }];
    assert.equal(recordConsumed({ insertReceipt: tx.insertReceipt }, refs, -0.5), 2);
    assert.equal(recordConsumed({ insertReceipt: tx.insertReceipt }, refs, 100), 0);
    assert.deepEqual(tx.receipt(refs[0]), { at: -0.5 });
    for (const at of [NaN, Infinity]) assert.throws(() => recordConsumed(tx, refs, at), RangeError);
    assert.throws(() => recordConsumed(tx, refs, '10'), TypeError);
    for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => selectReceivedHeads(tx, 'captured', page({}, limit)), RangeError);
    }
    assert.throws(() => selectReceivedHeads(tx, 'captured', page({}, '1')), TypeError);
    assert.deepEqual(selectReceivedHeads(tx, 'captured', page({}, Number.MAX_SAFE_INTEGER)), []);
  });
});
