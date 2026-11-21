import assert from 'node:assert/strict';
import { perceiveHint, expressHint } from '../dist/hints.js';
import { renderFailureLines } from '../dist/operation-presentation.js';
import test from 'node:test';

import {
  renderAmbientEventFacts,
  renderDoctorUnfixable,
  renderPresenceAnchor,
  renderWatchAlreadyActive,
  renderWatchForceTakeover,
  renderWatchReplaceMissing,
  renderWatchStatus,
} from '../dist/presentation.js';

test('unfixable doctor detail is bounded to 160 Unicode code points', () => {
  const detail = '界'.repeat(200);
  assert.equal(
    renderDoctorUnfixable(detail),
    `✕ unreadable artifact\n  · ${[...detail].slice(0, 159).join('')}…`
  );
});

test('public activity rendering keeps reply ids, multiline bodies, and presence', () => {
  const say = { id: 'act/9', kind: 'say', actor: 'Alice', body: 'first line\nsecond line', mentions: ['Bob'], reply: 'act/3', at: 0 };
  const full = renderAmbientEventFacts(say, { now: 1000, mention: 'Bob', perception: 'full' }).text;
  assert.match(full, /· act\/9.*replies to act\/3/);
  assert.match(full, /first line\n  second line/);
  const presence = renderAmbientEventFacts(say, { now: 1000, perception: 'presence' });
  assert.equal(presence.bodyClipped, false);
  assert.doesNotMatch(presence.text, /first line|second line/);

  const anchor = renderPresenceAnchor(['Alice', 'Bob']);
  assert.match(anchor, /→ @Alice, @Bob were here/);
});

test('blocked activity output bounds unread participant summaries', () => {
  const summaries = Array.from({ length: 12 }, (_value, index) => ({
    name: `Person${index}`,
    count: 1,
    latestActivityAgeMs: index,
    preview: { body: `body ${index}`, structured: false },
  }));
  const output = renderFailureLines({ code: 'behind', message: 'Alice has pending activity', facts: { activitySummaries: summaries } },
    { squarePath: '/tmp/square', name: 'Alice', retry: 'square express -' }).join('\n');

  assert.match(output, /@Person9 spoke/);
  assert.doesNotMatch(output, /@Person10 spoke|@Person11 spoke/);
  assert.match(output, /2 more participants have unread activity/);
});

test('active perceive calls explain the existing lease and point to replacement', () => {
  const output = renderWatchAlreadyActive({ squarePath: '.square/PUBLIC.square', name: 'codex-155777a843b6' });
  assert.match(output, /you are already perceiving/);
  assert.match(output, /active perceive is already running for @codex-155777a843b6/);
  assert.match(output, /--takeover lets a new perceive take over/);
  assert.match(output, /perceive --idle 30m --takeover$/);
});

test('quiet graduates with the idle length and an empty perceive never repeats its own command', () => {
  const base = { squarePath: '.square/PUBLIC.square', name: 'Alice', showPerceiveHint: true };
  assert.match(renderWatchStatus({ ...base, status: 'idle', idleMs: 45_000 }), /^○ only footsteps in the square — nothing new for you$/m);
  assert.match(renderWatchStatus({ ...base, status: 'idle', idleMs: 5 * 60_000 }), /^○ dust settles on the flagstones — 5m of quiet$/m);
  assert.match(renderWatchStatus({ ...base, status: 'idle', idleMs: 2 * 60 * 60_000 }), /^○ dust lies thick — 2h of quiet$/m);

  const empty = renderWatchStatus({ ...base, status: 'drained' });
  assert.match(empty, /^○ only footsteps in the square — nothing new for you$/m);
  assert.match(empty, /perceive --idle 30m/);
});

test('the capped status counts what was spoken and the throttle names its lull', () => {
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

test('replace reports when there was no active perceive to replace', () => {
  const output = renderWatchReplaceMissing({ squarePath: '.square/PUBLIC.square', name: 'Alice' });
  assert.match(output, /^· no perceive stood here/);
  assert.match(output, /yours takes the spot/);
  assert.equal(renderWatchForceTakeover({ squarePath: '.square/PUBLIC.square', name: 'Alice' }), '✓ your new perceive takes over');
});
