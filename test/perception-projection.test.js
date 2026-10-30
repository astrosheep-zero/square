import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactPort } from '../dist/artifact.js';
import { emptyRuntimeState } from '../dist/square-sqlite.js';
import { directedTo, perceiveActivity } from '../dist/perception-projection.js';
import { toPerceivedActivity } from '../dist/views.js';

function squareState(acts, runtime = emptyRuntimeState(acts.length)) {
  return {
    hardCap: null,
    preamble: [],
    warmup: ['test'],
    acts: acts.map((act, index) => ({ ...act, index })),
    runtime: { ...runtime, nextActIndex: acts.length },
  };
}

function memoryCell(acts, runtime) {
  return createArtifactPort(':memory:', squareState(acts, runtime));
}

test('perception shares one settled audience across case and rejoin boundaries', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'say', actor: 'Alice', at: 3, body: 'first @BOB', mentions: ['BOB'] },
    { kind: 'done', actor: 'Bob', at: 4 },
    { kind: 'join', actor: 'bob', at: 5 },
    { kind: 'say', actor: 'Alice', at: 6, body: 'second @bob', mentions: ['bob'] },
  ];
  const cell = memoryCell(acts);
  try {
    const facts = (await cell.read((read) => {
      const at = (index) => read.activity(index);
      return {
        audienceCount: read.audience(2).length,
        first: { directed: directedTo(read, at(2), 'BOB'), perception: perceiveActivity(read, at(2), 'BOB') },
        rejoined: { directed: directedTo(read, at(5), 'BOB'), perception: perceiveActivity(read, at(5), 'bob') },
        authorFullUnrouted: { directed: directedTo(read, at(2), 'Alice'), perception: perceiveActivity(read, at(2), 'Alice') },
        outsiderPresence: toPerceivedActivity(read, at(2), 'Cara'),
        authorPublic: toPerceivedActivity(read, at(2), 'Alice'),
        lifecycleFull: perceiveActivity(read, at(0), 'Alice'),
        bobSuffix: read.directedCount('BOB', { unseenOnly: true }),
      };
    })).value;
    assert.deepEqual(facts, {
      audienceCount: 1,
      first: { directed: true, perception: 'full' },
      rejoined: { directed: true, perception: 'full' },
      authorFullUnrouted: { directed: false, perception: 'full' },
      outsiderPresence: { id: 'act/2', at: 3, kind: 'say', actor: 'Alice', body: 'first @BOB', mentions: ['BOB'], perception: 'presence' },
      authorPublic: { id: 'act/2', at: 3, kind: 'say', actor: 'Alice', body: 'first @BOB', mentions: ['BOB'], perception: 'full' },
      lifecycleFull: 'full',
      bobSuffix: 2,
    });

  } finally {
    await cell.close();
  }
});

test('landed audience settles mentions, bell, attention, ignore and self in priority order', async () => {
  const acts = [
    { kind: 'join', actor: 'Alice', at: 1 },
    { kind: 'join', actor: 'Bob', at: 2 },
    { kind: 'join', actor: 'Cara', at: 3 },
    { kind: 'listen', actor: 'Cara', target: 'Alice', at: 4 },
    { kind: 'ignore', actor: 'Bob', target: 'Alice', at: 5 },
    { kind: 'say', actor: 'Alice', at: 6, body: 'mention', mentions: ['Bob', 'Cara'] },
    { kind: 'say', actor: 'Alice', at: 7, body: 'bell', reach: 'bell' },
    { kind: 'say', actor: 'Alice', at: 8, body: 'attention' },
    { kind: 'say', actor: 'Alice', at: 9, body: 'self', mentions: ['Alice'] },
  ];
  const cell = memoryCell(acts);
  try {
    const facts = (await cell.read((read) => ({
      mention: read.audience(5),
      bell: read.audience(6),
      attention: read.audience(7),
      selfEdge: read.directedAt('Alice', 8),
      selfIncluded: read.audience(8).some((recipient) => recipient.recipient === 'Alice'),
      bobDirect: read.directedCount('Bob', {}),
      caraDirect: read.directedCount('Cara', {}),
    }))).value;
    assert.deepEqual(facts.mention, [{ recipient: 'Cara', route: 'mention' }]);
    assert.deepEqual(facts.bell, [{ recipient: 'Bob', route: 'bell' }, { recipient: 'Cara', route: 'bell' }]);
    assert.deepEqual(facts.attention, [{ recipient: 'Cara', route: 'attention' }]);
    assert.equal(facts.selfEdge, undefined);
    assert.equal(facts.selfIncluded, false);
    assert.equal(facts.bobDirect, 1);
    assert.equal(facts.caraDirect, 4);
  } finally {
    await cell.close();
  }
});
