import assert from 'node:assert/strict';
import test from 'node:test';
import { claimAttempt, prepareAttempt, settleAttempt, presentationBlocksDispatch, automaticDispatchEligible } from '../dist/delivery-primitives.js';

function series(initial = []) {
  const records = new Map(initial.map(row => [row.token, row]));
  let writes = 0;
  return {
    list: () => [...records.values()].sort((a, b) => b.ordinal - a.ordinal),
    byToken: token => records.get(token),
    insert(row) { assert.equal(records.has(row.token), false); records.set(row.token, row); writes++; },
    replace(row) {
      const previous = records.get(row.token);
      assert.ok(previous);
      assert.equal(row.purpose, previous.purpose);
      assert.equal(row.ordinal, previous.ordinal);
      records.set(row.token, row); writes++;
    },
    get writes() { return writes; },
  };
}
const input = { purpose: 'dispatch', token: 'opaque claim', at: 10, leaseMs: 5, data: { route: 'anything' } };
const completion = { token: input.token, at: 12, outcome: 'accepted', data: { proof: 'ack' } };

test('scoped claims acquire exclusive live custody, including a missing expiry', () => {
  const rows = series();
  assert.deepEqual(claimAttempt(rows, input), { status: 'acquired', token: input.token, ordinal: 0 });
  assert.equal(prepareAttempt(rows, { token: 'foreign', data: {} }), false);
  assert.equal(prepareAttempt(rows, { token: input.token, data: { prepared: true } }), true);
  const busy = claimAttempt(rows, { ...input, token: 'next', at: 14 });
  assert.equal(busy.status, 'busy');
  assert.deepEqual(busy.evidence.data, { prepared: true });
  assert.equal(rows.writes, 2);
  const { expiresAt, ...unbounded } = busy.evidence;
  assert.equal(claimAttempt(series([unbounded]), { ...input, at: 500 }).status, 'busy');
});

test('exact expiry becomes terminal unknown with original data, never a fresh claim', () => {
  const rows = series();
  claimAttempt(rows, input);
  const interrupted = claimAttempt(rows, { ...input, token: 'replacement', at: 15, data: { wrong: true } });
  assert.equal(interrupted.status, 'terminal');
  assert.equal(interrupted.interrupted, true);
  assert.equal(interrupted.evidence.outcome, 'unknown');
  assert.equal(interrupted.evidence.at, 15);
  assert.equal(Object.hasOwn(interrupted.evidence, 'expiresAt'), false);
  assert.equal(interrupted.evidence.data, input.data);
  assert.equal(prepareAttempt(rows, { token: input.token, data: {} }), false);
  assert.equal(settleAttempt(rows, { ...completion, outcome: 'presented' }), false);
  assert.equal(settleAttempt(rows, { ...completion, outcome: 'failed' }), false);
  assert.equal(claimAttempt(rows, { ...input, at: 20 }).status, 'terminal');
  assert.equal(rows.list().length, 1);
  assert.equal(rows.writes, 2);
});

test('failed and released attempts permit the next ordinal but fence old and foreign tokens', () => {
  const rows = series();
  claimAttempt(rows, input);
  assert.equal(settleAttempt(rows, { ...completion, token: 'foreign' }), false);
  for (const [ordinal, outcome] of ['failed', 'released'].entries()) {
    const token = ordinal === 0 ? input.token : `retry/${ordinal}`;
    assert.equal(settleAttempt(rows, { ...completion, token, outcome }), true);
    const retry = claimAttempt(rows, { ...input, token: `retry/${ordinal + 1}` });
    assert.equal(retry.status, 'acquired');
    assert.equal(retry.ordinal, ordinal + 1);
    assert.equal(settleAttempt(rows, { ...completion, token }), false);
  }
});

test('late acceptance settles unknown; repeated acceptance preserves all evidence without a write', () => {
  const rows = series();
  claimAttempt(rows, input);
  claimAttempt(rows, { ...input, at: 15 });
  assert.equal(settleAttempt(rows, completion), true);
  const accepted = rows.byToken(input.token), writes = rows.writes;
  assert.equal(accepted.expiresAt, undefined);
  assert.equal(settleAttempt(rows, { ...completion, at: 99, data: { proof: 'must not replace' } }), true);
  assert.equal(rows.byToken(input.token), accepted);
  assert.equal(rows.writes, writes);
  assert.equal(claimAttempt(rows, { ...input, token: 'replay' }).status, 'terminal');
  // Terminal evidence takes precedence even over a newer live claim.
  const live = { ...accepted, token: 'live', ordinal: 1, outcome: 'dispatching', expiresAt: 100 };
  assert.equal(claimAttempt(series([accepted, live]), input).evidence, accepted);
});

test('presentation has its own terminal custody and cannot turn uncertainty into presentation', () => {
  const rows = series(), presentation = { ...input, purpose: 'presentation' };
  claimAttempt(rows, presentation);
  claimAttempt(rows, { ...presentation, at: 15 });
  assert.equal(settleAttempt(rows, { ...completion, outcome: 'presented' }), false);
  assert.equal(claimAttempt(rows, { ...presentation, at: 16 }).status, 'terminal');
  const fresh = series();
  claimAttempt(fresh, presentation);
  assert.equal(settleAttempt(fresh, { ...completion, outcome: 'presented' }), true);
  assert.equal(claimAttempt(fresh, presentation).status, 'terminal');
});

test('suppression predicates distinguish presentation custody and uncertain dispatch', () => {
  const presentation = { purpose: 'presentation', outcome: 'dispatching', expiresAt: 15 };
  assert.equal(presentationBlocksDispatch([presentation], 14), true);
  assert.equal(presentationBlocksDispatch([presentation], 15), false);
  assert.equal(automaticDispatchEligible([presentation], 15), true);
  for (const outcome of ['presented', 'clipped', 'unknown']) {
    assert.equal(presentationBlocksDispatch([{ ...presentation, outcome }], 20), true);
  }
  assert.equal(automaticDispatchEligible([{ purpose: 'dispatch', outcome: 'dispatching', expiresAt: 15 }], 20), false);
  for (const outcome of ['accepted', 'unknown']) {
    assert.equal(automaticDispatchEligible([{ purpose: 'dispatch', outcome }], 20), false);
  }
  assert.equal(automaticDispatchEligible([{ purpose: 'dispatch', outcome: 'failed' }], 20), true);
});

test('invalid claims, completions and exhausted ordinals reject before mutation', () => {
  const rows = series();
  for (const change of [{ token: '' }, { at: NaN }, { at: Infinity }, { leaseMs: 0 }, { leaseMs: 0.5 },
    { leaseMs: Number.MAX_SAFE_INTEGER + 1 }, { purpose: 'other' }]) {
    assert.throws(() => claimAttempt(rows, { ...input, ...change }), error => error instanceof TypeError || error instanceof RangeError);
  }
  assert.throws(() => prepareAttempt(rows, { token: '', data: {} }), TypeError);
  assert.throws(() => settleAttempt(rows, { ...completion, outcome: 'invented' }), TypeError);
  assert.throws(() => settleAttempt(rows, { ...completion, outcome: 'dispatching' }), TypeError);
  assert.throws(() => settleAttempt(rows, { ...completion, at: Infinity }), RangeError);
  assert.equal(rows.writes, 0);
  const exhausted = series([{ ...input, ordinal: Number.MAX_SAFE_INTEGER, outcome: 'failed' }]);
  assert.throws(() => claimAttempt(exhausted, input), RangeError);
  assert.equal(exhausted.writes, 0);
});
