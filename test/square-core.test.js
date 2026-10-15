import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_IDENTITY_SET_SIZE, audienceIncludes, audienceOf, formatActivityId, parseActivityId } from '../dist/square-core.js';
import { NAME_GRAPHEME_SOURCE, validateName } from '../dist/model.js';

test('audience metadata keeps first-appearance spelling and case-insensitive uniqueness', () => {
  assert.deepEqual(audienceOf({ body: 'hey @Bob and @aku/riko/7a then @BOB @Missing', mentions: ['Bob', 'aku/riko/7a', 'BOB', 'Missing'] }), {
    kind: 'mentions',
    names: ['Bob', 'aku/riko/7a', 'Missing'],
  });
  assert.deepEqual(audienceOf({ body: 'ignore @Bob', reach: 'bell' }), { kind: 'bell' });
  assert.equal(audienceIncludes(audienceOf({ body: 'hey @Bob', mentions: ['Bob'] }), 'bob'), true);
  assert.equal(audienceIncludes({ kind: 'bell' }, 'Anyone'), true);
});

test('explicit audience metadata drives routing while body at-signs stay literal', () => {
  assert.deepEqual(audienceOf({ body: 'hey @Bob' }), { kind: 'mentions', names: [] });
  assert.deepEqual(audienceOf({ body: 'hey @Bob', mentions: ['Bob'] }), { kind: 'mentions', names: ['Bob'] });
  assert.equal(audienceIncludes(audienceOf({ body: 'hey @Bob' }), 'Bob'), false);
  assert.equal(MAX_IDENTITY_SET_SIZE, 10);
});

test('Unicode text-name fast path preserves full name acceptance and malformed boundaries', () => {
  const markedAkuId = 'aku/a\u0315/1234abcd'.normalize('NFC');
  assert.match(markedAkuId, /\p{Mark}/u);
  const fullPattern = new RegExp(`^(?:${NAME_GRAPHEME_SOURCE})+(?:/(?:${NAME_GRAPHEME_SOURCE})+)*$`, 'v');
  const accepted = [
    'aku/riko/7a', 'Alice', '甲/乙-2', markedAkuId, 'Δοκιμή/Жук_٢',
    '𝔘/𠀀/Ⅷ', '\u0301/mark', 'a/\u20e3',
    'aku/🕷️/1234abcd', 'aku/👨‍👩‍👧‍👦/1234abcd', '甲/👩🏽‍💻/🇨🇳', 'a/1️⃣',
  ];
  const rejected = [
    '/aku', 'aku/', 'aku//riko', 'aku/riko!', '', 'a b', 'a/甲.乙',
    'aku/🕷/1234abcd', 'a/🇦🇦', 'a/🇨', 'a/😀\u200d😀',
    'aku/️/1234abcd', 'aku/\u200d/1234abcd', 'a/A\ufe0f', 'a/\ufe0e',
    'a/\u180b', 'a/\u{E0100}', 'a/\ud800/b', 'a/\udfff/b', 'a/\u0000',
  ];
  for (const name of accepted) {
    assert.equal(fullPattern.test(name), true, JSON.stringify(name));
    assert.doesNotThrow(() => validateName(name), JSON.stringify(name));
  }
  for (const name of rejected) {
    assert.equal(fullPattern.test(name), false, JSON.stringify(name));
    assert.throws(() => validateName(name), (error) => error.code === 'invalid_name', JSON.stringify(name));
  }
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
