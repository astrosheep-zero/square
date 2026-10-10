import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expressHintLine,
  renderActivityBlocked,
  renderAmbientEvent,
  renderDoctorUnfixable,
  renderExpressNoWait,
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

test('blocked activity output bounds unread participant summaries', () => {
  const summaries = Array.from({ length: 12 }, (_value, index) => ({
    name: `Person${index}`,
    count: 1,
    latestActivityAgeMs: index,
    previews: [{
      number: 1,
      perception: 'full',
      act: { kind: 'say', actor: `Person${index}`, body: `body ${index}`, mentions: [], index, at: 0 },
    }],
  }));
  const output = renderActivityBlocked({
    squarePath: '/tmp/square',
    name: 'Alice',
    retryCommand: 'square express -',
    forceCommand: 'square express --force -',
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
  assert.match(renderWatchStatus({ ...base, status: 'stale', idleMs: 45_000 }), /^○ only footsteps in the square — nothing new for you$/m);
  assert.match(renderWatchStatus({ ...base, status: 'stale', idleMs: 5 * 60_000 }), /^○ dust settles on the flagstones — 5m of quiet$/m);
  assert.match(renderWatchStatus({ ...base, status: 'stale', idleMs: 2 * 60 * 60_000 }), /^○ dust lies thick — 2h of quiet$/m);

  const empty = renderWatchStatus({ ...base, status: 'empty-now' });
  assert.match(empty, /^○ only footsteps in the square — nothing new for you$/m);
  assert.match(empty, /catch --idle 30m/);
  assert.doesNotMatch(empty, /catch --now/);

  // A quiet catch repeats neither itself nor a second copy of the same command.
  const stale = renderWatchStatus({ ...base, status: 'stale', idleMs: 45_000 });
  assert.doesNotMatch(stale, /catch --now/);
});

test('the capped status counts what was spoken and the throttle names its lull', () => {
  assert.match(
    renderWatchStatus({ squarePath: '.square/PUBLIC.square', name: 'Alice', status: 'capped', ownActivityCount: 3, hardCap: 3 }),
    /^✕ nothing left in you — 3\/3 spoken$/m
  );

  const throttled = renderExpressNoWait({ squarePath: '.square/PUBLIC.square', name: 'Alice', reason: 'throttled', delayMs: 60_000, retryCommand: 'square express -' });
  assert.match(throttled, /✕ the square is packed — shoulder to shoulder/);
  assert.match(throttled, /· a lull opens in 1m/);
});

test('express hints are three distinct ideas rather than one slogan', () => {
  const hints = [1, 5, 10].map((count) => expressHintLine(count));
  assert.equal(new Set(hints).size, 3);
  assert.match(hints[0], /\*asterisks\* are your body — slam a table, shrug, sketch in the air/);
  assert.match(hints[1], /answer someone's actual words — they're standing right there/);
  assert.match(hints[2], /say the half-shaped thing — that's what the square is for/);
});

test('replace reports when there was no active catch to replace', () => {
  const output = renderWatchReplaceMissing({ squarePath: '.square/PUBLIC.square', name: 'Alice' });
  assert.match(output, /^· no catch stood here/);
  assert.match(output, /yours takes the spot/);
  assert.equal(renderWatchForceTakeover({ squarePath: '.square/PUBLIC.square', name: 'Alice' }), '✓ your new catch takes over');
});
