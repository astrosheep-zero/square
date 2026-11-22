import { renderWatchAlreadyActive, renderWatchStatus } from '../dist/surfaces/perceive-presentation.js';
import assert from 'node:assert/strict';
import { perceiveHint, expressHint } from '../dist/core/hints.js';
import { renderFailureLines } from '../dist/surfaces/operation-presentation.js';
import test from 'node:test';

import {
  renderAmbientEventFacts,
  renderPresenceAnchor,
} from '../dist/surfaces/presentation.js';

test('public activity rendering keeps reply ids, multiline bodies, and presence', () => {
  const say = { id: 'act/9', kind: 'say', actor: 'Alice', body: 'first line\nsecond line', mentions: ['Bob'], reply: 'act/3', at: 0 };
  const full = renderAmbientEventFacts(say, { now: 1000, mention: 'Bob', perception: 'full' }).text;
  assert.match(full, /· act\/9.*replies to act\/3/);
  assert.match(full, /first line\n  second line/);
  const presence = renderAmbientEventFacts(say, { now: 1000, perception: 'presence' });
  assert.equal(presence.bodyClipped, false);
  assert.doesNotMatch(presence.text, /first line|second line/);
  assert.match(renderPresenceAnchor(['Alice', 'Bob']), /→ @Alice, @Bob were here/);
});

test('active perceive calls explain the existing lease and point to replacement', () => {
  const output = renderWatchAlreadyActive({ squarePath: '.square/PUBLIC.square', name: 'codex-155777a843b6' });
  assert.match(output, /you are already perceiving/);
  assert.match(output, /active perceive is already running for @codex-155777a843b6/);
  assert.match(output, /--takeover lets a new perceive take over/);
  assert.match(output, /perceive --wait 30m --takeover$/);
});

test('quiet graduates with the idle length', () => {
  const output = renderWatchStatus({ squarePath: '.square/PUBLIC.square', name: 'Alice',
    showPerceiveHint: false, status: 'idle', idleMs: 5 * 60_000 });
  assert.match(output, /^○ dust settles on the flagstones — 5m of quiet$/m);
});

test('capped and throttled output keeps their next actions', () => {
  assert.match(
    renderWatchStatus({ squarePath: '.square/PUBLIC.square', name: 'Alice', status: 'capped', ownActivityCount: 3, hardCap: 3 }),
    /^✕ you’ve reached your speaking cap — 3\/3 spoken$/m
  );
  const throttled = renderFailureLines({ code: 'throttled', message: 'Alice is throttled', facts: { retryAfterMs: 60_000 } },
    { squarePath: '.square/PUBLIC.square', name: 'Alice', retry: 'square express -' }).join('\n');
  assert.match(throttled, /✕ the square is packed — shoulder to shoulder/);
  assert.match(throttled, /· a lull opens in 1m/);
});

test('express hints surface on the first activity and every fifth, rotating distinct ideas', () => {
  const hints = [1, 5, 10].map((count) => expressHint(count));
  assert.ok(hints.every((hint) => typeof hint === 'string' && hint.length > 0));
  assert.equal(new Set(hints).size, 3);
  assert.equal(expressHint(2), undefined);
});

test('perceive hints surface on the first perceive and then once per ten perceived', () => {
  assert.equal(typeof perceiveHint(0, 3), 'string');
  assert.equal(perceiveHint(3, 9), undefined);
  assert.equal(typeof perceiveHint(9, 12), 'string');
  assert.notEqual(perceiveHint(0, 3), perceiveHint(9, 12));
  assert.equal(perceiveHint(12, 12), undefined);
});
