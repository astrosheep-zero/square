import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderActivityBlocked,
  renderAmbientEvent,
  renderDoctorUnfixable,
  renderPresenceAnchor,
  renderWatchAlreadyActive,
  renderWatchForceTakeover,
  renderWatchReplaceMissing,
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

test('replace reports when there was no active catch to replace', () => {
  const output = renderWatchReplaceMissing({ squarePath: '.square/PUBLIC.square', name: 'Alice' });
  assert.match(output, /^· no catch stood here/);
  assert.match(output, /yours takes the spot/);
  assert.equal(renderWatchForceTakeover({ squarePath: '.square/PUBLIC.square', name: 'Alice' }), '✓ your new catch takes over');
});
