import assert from 'node:assert/strict';
import test from 'node:test';

import { renderActivitiesView } from '../dist/presentation.js';

test('history footprints preserve singular and separate coordinates while grouping shared anchors', () => {
  const state = {
    hardCap: null,
    preamble: [],
    warmup: [],
    acts: [
      { kind: 'join', actor: 'Alice', index: 1, at: 0 },
      { kind: 'join', actor: 'Bob', index: 2, at: 0 },
      { kind: 'join', actor: 'Cara', index: 3, at: 0 },
      { kind: 'say', actor: 'Alice', body: 'first @Bob', index: 4, at: 0 },
      { kind: 'say', actor: 'Cara', body: 'second @Alice', index: 5, at: 0 },
    ],
    runtime: {
      observations: { Bob: { 'act/4': { state: 'seen', at: 0 } } },
      leases: {},
      notifyLeases: {},
      nextActIndex: 6,
    },
  };

  const output = renderActivitiesView(state, state.acts, null, true, '/tmp/square', '', 'archive');
  const alice = output.indexOf('→ @Alice was here');
  const grouped = output.indexOf('→ @Bob, @Cara were here');

  assert.ok(alice > output.indexOf('first @Bob'));
  assert.ok(grouped > output.indexOf('second @Alice'));
  assert.ok(alice < grouped);
  assert.doesNotMatch(output, /→ @(?:Bob|Cara) was here/);
});
