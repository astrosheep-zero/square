import assert from 'node:assert/strict';
import { catchHint, expressHint } from '../dist/hints.js';
import test from 'node:test';

import {
  renderActivityBlocked,
  renderAmbientEvent,
  renderDoctorUnfixable,
  renderExpressNoWait,
  renderEventCli,
  renderPresenceAnchor,
  renderWatchAlreadyActive,
  renderWatchForceTakeover,
  renderWatchReplaceMissing,
  renderWatchStatus,
} from '../dist/presentation.js';
import { toPublicActivity } from '../dist/views.js';

test('unfixable doctor detail is bounded to 160 Unicode code points', () => {
  const detail = '界'.repeat(200);
  assert.equal(
    renderDoctorUnfixable(detail),
    `✕ unreadable artifact\n  · ${[...detail].slice(0, 159).join('')}…`
  );
});

test('legacy presence rendering bounds identity lists and names the remainder', () => {
  const names = Array.from({ length: 12 }, (_value, index) => `Person${index}`);
  const presence = renderAmbientEvent(
    { kind: 'say', actor: 'Alice', body: 'private', mentions: names, index: 1, at: 0 },
    'Observer',
    { perception: 'presence' }
  );
  assert.match(presence, /talked to @Person0.*@Person9 and 2 others/);
  assert.doesNotMatch(presence, /Person10|Person11/);

  const anchor = renderPresenceAnchor(names);
  assert.match(anchor, /@Person0.*@Person9 and 2 more were here/);
  assert.doesNotMatch(anchor, /Person10|Person11/);
});

test('public activities render directly with the same IDs, replies, bodies and presence as archive records', () => {
  const records = [
    { kind: 'say', actor: 'Alice', body: 'first line\nsecond line', mentions: ['Bob'], reply: 3, index: 9, at: 0 },
    { kind: 'done', actor: 'Alice', body: '', index: 10, at: 0 },
    { kind: 'listen', actor: 'Alice', target: 'Bob', index: 11, at: 0 },
  ];
  const options = { now: 1000, mention: 'Bob', perception: 'full' };
  for (const record of records) {
    assert.equal(renderAmbientEvent(toPublicActivity(record), 'Bob', options), renderAmbientEvent(record, 'Bob', options));
  }
  const rendered = renderAmbientEvent(toPublicActivity(records[0]), 'Bob', options);
  assert.match(rendered, /· act\/9.*replies to act\/3/);
  assert.match(rendered, /first line\n  second line/);
  const presence = { ...options, perception: 'presence' };
  assert.equal(renderAmbientEvent(toPublicActivity(records[0]), 'Cara', presence), renderAmbientEvent(records[0], 'Cara', presence));
  assert.doesNotMatch(renderAmbientEvent(toPublicActivity(records[0]), 'Cara', presence), /first line|second line/);
  assert.equal(renderEventCli({ kind: 'read', actor: 'Bob', through: 9, index: 12, at: 0 }), '');
});

test('blocked activity output bounds unread participant summaries', () => {
  const summaries = Array.from({ length: 12 }, (_value, index) => ({
    name: `Person${index}`,
    count: 1,
    latestActivityAgeMs: index,
    preview: { kind: 'say', actor: `Person${index}`, body: `body ${index}`, mentions: [], index, at: 0 },
  }));
  const output = renderActivityBlocked({
    squarePath: '/tmp/square',
    name: 'Alice',
    retryCommand: 'square express -',
    activitySummaries: summaries,
  });

  assert.match(output, /@Person9 spoke/);
  assert.doesNotMatch(output, /@Person10 spoke|@Person11 spoke/);
  assert.match(output, /2 more participants have unread activity/);
});

test('active catches explain the existing lease and point to replacement', () => {
  const output = renderWatchAlreadyActive({ squarePath: '.square/PUBLIC.square', name: 'codex-155777a843b6' });
  assert.match(output, /you are already catching/);
  assert.match(output, /active catch is already running for @codex-155777a843b6/);
  assert.match(output, /--replace lets a new catch take over/);
  assert.match(output, /catch --idle 30m --replace$/);
});

test('quiet graduates with the idle length and an empty catch never repeats its own command', () => {
  const base = { squarePath: '.square/PUBLIC.square', name: 'Alice', showCatchHint: true };
  assert.match(renderWatchStatus({ ...base, status: 'idle', idleMs: 45_000 }), /^○ only footsteps in the square — nothing new for you$/m);
  assert.match(renderWatchStatus({ ...base, status: 'idle', idleMs: 5 * 60_000 }), /^○ dust settles on the flagstones — 5m of quiet$/m);
  assert.match(renderWatchStatus({ ...base, status: 'idle', idleMs: 2 * 60 * 60_000 }), /^○ dust lies thick — 2h of quiet$/m);

  const empty = renderWatchStatus({ ...base, status: 'drained' });
  assert.match(empty, /^○ only footsteps in the square — nothing new for you$/m);
  assert.match(empty, /catch --idle 30m/);
  assert.doesNotMatch(empty, /catch --now/);

  // A quiet catch repeats neither itself nor a second copy of the same command.
  const stale = renderWatchStatus({ ...base, status: 'idle', idleMs: 45_000 });
  assert.doesNotMatch(stale, /catch --now/);
});

test('the capped status counts what was spoken and the throttle names its lull', () => {
  assert.match(
    renderWatchStatus({ squarePath: '.square/PUBLIC.square', name: 'Alice', status: 'capped', ownActivityCount: 3, hardCap: 3 }),
    /^✕ you’ve reached your speaking cap — 3\/3 spoken$/m
  );

  const throttled = renderExpressNoWait({ squarePath: '.square/PUBLIC.square', name: 'Alice', reason: 'throttled', delayMs: 60_000, retryCommand: 'square express -' });
  assert.match(throttled, /✕ the square is packed — shoulder to shoulder/);
  assert.match(throttled, /· a lull opens in 1m/);
});

test('express hints surface on the first activity and every fifth, rotating distinct ideas', () => {
  const hints = [1, 5, 10].map((count) => expressHint(count));
  assert.ok(hints.every((hint) => typeof hint === 'string' && hint.length > 0));
  assert.equal(new Set(hints).size, 3);
  assert.equal(expressHint(2), undefined);
});

test('catch hints surface on the first catch and then once per ten caught', () => {
  assert.equal(typeof catchHint(0, 3), 'string');
  assert.equal(catchHint(3, 9), undefined);
  assert.equal(typeof catchHint(9, 12), 'string');
  assert.notEqual(catchHint(0, 3), catchHint(9, 12));
  assert.equal(catchHint(12, 12), undefined);
});

test('replace reports when there was no active catch to replace', () => {
  const output = renderWatchReplaceMissing({ squarePath: '.square/PUBLIC.square', name: 'Alice' });
  assert.match(output, /^· no catch stood here/);
  assert.match(output, /yours takes the spot/);
  assert.equal(renderWatchForceTakeover({ squarePath: '.square/PUBLIC.square', name: 'Alice' }), '✓ your new catch takes over');
});
