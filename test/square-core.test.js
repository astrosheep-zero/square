import assert from 'node:assert/strict';
import test from 'node:test';

import { fold, perceive, validate } from '../dist/square-core.js';

const T0 = 1_700_000_000_000;

function assertRejected(result, reason) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, reason);
}

test('fold preserves the current participant lifecycle across rejoin', () => {
  const state = fold([
    { kind: 'join', actor: 'Alice', at: T0 },
    { kind: 'say', actor: 'Alice', at: T0 + 10, body: 'one' },
    { kind: 'done', actor: 'Alice', at: T0 + 20, body: 'bye' },
    { kind: 'join', actor: 'Alice', at: T0 + 30 },
  ]);

  assert.deepEqual(state.joined, ['Alice']);
  assert.deepEqual(state.done, []);
  assert.equal(state.participants[0].activityCount, 1);
});

test('validation makes held, capped, and throttled activity uncommittable', () => {
  const cases = [
    {
      state: fold([
        { kind: 'join', actor: 'Alice', at: T0 },
        { kind: 'hold', actor: 'Host', at: T0 + 10, body: 'pause' },
      ]),
      act: { kind: 'say', actor: 'Alice', at: T0 + 20, body: 'blocked' },
      options: {},
      reason: 'held',
    },
    {
      state: fold([
        { kind: 'join', actor: 'Alice', at: T0 },
        { kind: 'say', actor: 'Alice', at: T0 + 10, body: 'one' },
      ]),
      act: { kind: 'say', actor: 'Alice', at: T0 + 20, body: 'two' },
      options: { hardCap: 1 },
      reason: 'hard_cap',
    },
    {
      state: fold([
        { kind: 'join', actor: 'Alice', at: T0 },
        { kind: 'say', actor: 'Alice', at: T0 + 10, body: 'one' },
      ]),
      act: { kind: 'say', actor: 'Alice', at: T0 + 1_000, body: 'two' },
      options: { throttlePerMinute: 1, throttleWindowMs: 60_000 },
      reason: 'throttled',
    },
  ];

  for (const { state, act, options, reason } of cases) {
    assertRejected(validate(state, act, options), reason);
  }
});

test('perception preserves private bodies while retaining third-party presence', () => {
  const state = fold([{ kind: 'join', actor: 'Alice', at: T0 }]);
  const center = { kind: 'say', actor: 'Alice', at: T0 + 1, body: 'hello' };
  const beside = { kind: 'say', actor: 'Alice', at: T0 + 2, body: 'psst', reach: { beside: 'Bob' } };
  const bell = { kind: 'say', actor: 'Alice', at: T0 + 3, body: 'listen', reach: 'bell' };

  assert.equal(perceive(state, center, 'Cara'), 'full');
  assert.equal(perceive(state, beside, 'Bob'), 'full');
  assert.equal(perceive(state, beside, 'Cara'), 'presence');
  assert.equal(perceive(state, bell, 'Cara'), 'full');
});

test('a bell becomes eligible again exactly at the end of its quota window', () => {
  const state = fold([
    { kind: 'join', actor: 'Alice', at: T0 },
    { kind: 'say', actor: 'Alice', at: T0 + 1_000, body: 'hear me', reach: 'bell' },
  ]);

  assertRejected(
    validate(state, { kind: 'say', actor: 'Alice', at: T0 + 2_000, body: 'again', reach: 'bell' }),
    'bell_quota'
  );
  assert.equal(
    validate(state, { kind: 'say', actor: 'Alice', at: T0 + 1_000 + 60 * 60 * 1_000, body: 'later', reach: 'bell' }).ok,
    true
  );
});
