import assert from 'node:assert/strict';
import test from 'node:test';

import { audienceIncludes, audienceOf, fold, formatActivityId, listeningTo, parseActivityId, perceive, resolveAudience, validate } from '../dist/square-core.js';
import { validateName } from '../dist/model.js';

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

test('validation bounds unique mention targets and active listening relations', () => {
  const targets = Array.from({ length: 11 }, (_value, index) => `Target${index}`);
  const speaker = fold([{ kind: 'join', actor: 'Alice', at: T0 }]);
  assertRejected(
    validate(speaker, { kind: 'say', actor: 'Alice', at: T0 + 1, body: 'too many', mentions: targets }),
    'mention_limit'
  );
  assert.equal(
    validate(speaker, { kind: 'say', actor: 'Alice', at: T0 + 1, body: 'deduplicated', mentions: [...targets.slice(0, 10), 'TARGET0'] }).ok,
    true
  );

  const listener = fold([
    { kind: 'join', actor: 'Caller', at: T0 },
    ...targets.slice(0, 10).map((target, index) => ({ kind: 'listen', actor: 'Caller', target, at: T0 + index + 1 })),
  ]);
  assertRejected(validate(listener, { kind: 'listen', actor: 'Caller', target: targets[10], at: T0 + 20 }), 'listening_limit');
  assert.equal(validate(listener, { kind: 'listen', actor: 'Caller', target: 'TARGET0', at: T0 + 20 }).ok, true);
});

test('audience metadata keeps first-appearance spelling and case-insensitive uniqueness', () => {
  assert.deepEqual(audienceOf({ body: 'hey @Bob and @aku/riko/7a then @BOB @Missing', mentions: ['Bob', 'aku/riko/7a', 'BOB', 'Missing'] }), {
    kind: 'mentions',
    names: ['Bob', 'aku/riko/7a', 'Missing'],
  });
  assert.deepEqual(audienceOf({ body: 'ignore @Bob', reach: 'bell' }), { kind: 'bell' });
  assert.equal(audienceIncludes(audienceOf({ body: 'hey @Bob', mentions: ['Bob'] }), 'bob'), true);
  assert.deepEqual(resolveAudience(audienceOf({ body: '@cara then @BOB', mentions: ['cara', 'BOB'] }), ['Alice', 'Bob', 'Cara']), ['Cara', 'Bob']);
  assert.deepEqual(resolveAudience({ kind: 'bell' }, ['Alice', 'Bob']), ['Alice', 'Bob']);
});

test('explicit audience metadata drives routing while body at-signs stay literal', () => {
  assert.deepEqual(audienceOf({ body: 'hey @Bob' }), { kind: 'mentions', names: [] });
  assert.deepEqual(audienceOf({ body: 'hey @Bob', mentions: ['Bob'] }), { kind: 'mentions', names: ['Bob'] });
  assert.equal(audienceIncludes(audienceOf({ body: 'hey @Bob' }), 'Bob'), false);
});

test('participant names allow non-empty slash segments and reject malformed paths', () => {
  const markedAkuId = 'aku/a\u0315/1234abcd'.normalize('NFC');
  assert.match(markedAkuId, /\p{Mark}/u);
  for (const name of ['aku/riko/7a', 'aku/🕷️/1234abcd', 'aku/👨‍👩‍👧‍👦/1234abcd', markedAkuId, 'Alice', '甲/乙-2']) assert.doesNotThrow(() => validateName(name));
  for (const name of ['/aku', 'aku/', 'aku//riko', 'aku/riko!', 'aku/🕷/1234abcd', 'aku/️/1234abcd', 'aku/\u200d/1234abcd', '']) {
    assert.throws(() => validateName(name), (error) => error.code === 'invalid_name');
  }
});

test('done clears outgoing listening and rejoin starts with no old edges', () => {
  const beforeDone = fold([
    { kind: 'join', actor: 'Caller', at: 1 },
    { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 2 },
  ]);
  assert.deepEqual(listeningTo(beforeDone, 'caller'), ['aku/riko']);

  const afterRejoin = fold([
    { kind: 'join', actor: 'Caller', at: 1 },
    { kind: 'listen', actor: 'Caller', target: 'aku/riko', at: 2 },
    { kind: 'done', actor: 'Caller', at: 3 },
    { kind: 'join', actor: 'Caller', at: 4 },
  ]);
  assert.deepEqual(listeningTo(afterRejoin, 'Caller'), []);
});

test('perception is full for author, mentioned viewers, and every bell viewer', () => {
  const directed = { kind: 'say', actor: 'Alice', at: T0 + 2, body: 'psst @Bob', mentions: ['Bob'] };
  const selfMention = { kind: 'say', actor: 'Alice', at: T0 + 3, body: 'note @Alice', mentions: ['Alice'] };
  const bell = { kind: 'say', actor: 'Alice', at: T0 + 4, body: 'listen @Bob', reach: 'bell' };

  assert.equal(perceive(directed, 'Alice'), 'full');
  assert.equal(perceive(directed, 'Bob'), 'full');
  assert.equal(perceive(directed, 'Cara'), 'presence');
  assert.equal(perceive(selfMention, 'Alice'), 'full');
  assert.equal(perceive(selfMention, 'Bob'), 'presence');
  assert.equal(perceive(bell, 'Cara'), 'full');
  assert.equal(perceive(bell, 'Bob'), 'full');
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

test('square-core is the only activity-id formatter and accepts only the canonical spelling', () => {
  assert.equal(formatActivityId(0), 'act/0');
  assert.equal(formatActivityId(12), 'act/12');
  assert.equal(parseActivityId('act/0'), 0);
  assert.equal(parseActivityId('act/12'), 12);

  const underscore = ['act', '12'].join('_');
  const rejected = [
    underscore,
    '12',
    'act/012',
    'act/+12',
    'act/-1',
    ' act/12',
    'act/12 ',
    'act/12.0',
    'ACT/12',
    'act/',
    'act/1e2',
  ];
  for (const value of rejected) {
    assert.equal(parseActivityId(value), undefined, value);
  }
  assert.throws(() => formatActivityId(-1));
  assert.throws(() => formatActivityId(1.5));
  assert.throws(() => formatActivityId(Number.MAX_SAFE_INTEGER + 1));
});
