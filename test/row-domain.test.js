import assert from 'node:assert/strict';
import test from 'node:test';

import { readCursor, presenceAnchor } from '../dist/runtime.js';
import { createArtifactPort } from '../dist/artifact.js';
import { pendingHeads } from '../dist/delivery.js';
import { catchCoverage } from '../dist/square-domain.js';

const T0 = 1_700_000_000_000;

test('pending reasons and catch coverage need only say relations, not content', () => {
  const heads = [
    { index: 3, at: T0, from: 'Alice', recipient: 'Bob' },
    { index: 4, at: T0, from: 'Carol', recipient: 'Bob' },
    { index: 5, at: T0, from: 'Alice', recipient: 'Bob' },
  ];
  const facts = {
    channel: {
      endpoint: () => ({ participant: 'Bob', attachment: 'attached', generation: 'join' }),
      directed: () => ({ items: heads, hasMore: false }),
      suppressed: () => false,
    },
    activityByMessage: index => index === 5 ? undefined : {
      kind: 'say', index: index + 10, at: T0, actor: index === 3 ? 'Alice' : 'Carol', messageIndex: index,
      get body() { throw new Error('content must not be hydrated'); },
      get metadata() { throw new Error('metadata must not be hydrated'); },
    },
    directedAt: (name, index) => name === 'Bob' ? { route: index === 13 ? 'mention' : 'reply' } : undefined,
  };
  assert.deepEqual(pendingHeads(facts, 'Bob', T0), [
    { index: 3, at: T0, actor: 'Alice', recipient: 'Bob', activityIndex: 13, route: 'mention' },
    { index: 4, at: T0, actor: 'Carol', recipient: 'Bob', activityIndex: 14, route: 'reply' },
    { index: 5, at: T0, actor: 'Alice', recipient: 'Bob' },
  ]);
  const lease = { leaseId: 'catch', heartbeatAt: T0, expiresAt: T0 + 1000, filter: { participants: ['Alice'], mention: 'Bob' } };
  assert.deepEqual(catchCoverage(facts, 'Bob', lease), [3]);
  assert.deepEqual(catchCoverage(facts, 'Bob', { ...lease, filter: { mention: 'Bob' } }), [3, 4]);
});

function fixtureState(acts, options = {}) {
  const lastIndex = acts.reduce((max, act) => Math.max(max, act.index), -1);
  let messageIndex = 0;
  const imported = acts.map(act => act.kind === 'say' ? { ...act, messageIndex: messageIndex++ } : act);
  return {
    hardCap: options.hardCap === undefined ? null : options.hardCap,
    preamble: ['preamble line'],
    warmup: ['warmup line'],
    acts: imported,
    runtime: {
      nextActIndex: options.nextActIndex === undefined ? lastIndex + 1 : options.nextActIndex,
      observations: options.observations ?? {},
      leases: {},
    },
  };
}

/** Dense sequence for the land() path: index equals position, at equals T0 + index. */
function stored(acts) {
  return acts.map((act, index) => ({ ...act, index, at: T0 + index }));
}

// Covers mention, reply, listen, ignore, bell, done, rejoin, case-variant
// spellings, unknown/self mentions, a departed reply author, an ignored
// mention target, a read activity used as a reply author, and a
// case-variant actor that must fold onto the first spelling.
const SEQUENTIAL_SOURCE = [
  { kind: 'join', actor: 'Alice' },
  { kind: 'join', actor: 'Bob' },
  { kind: 'join', actor: 'Carol' },
  { kind: 'say', actor: 'Alice', body: 'a3', mentions: ['Bob', 'carol'] },
  { kind: 'say', actor: 'Alice', body: 'a4', mentions: ['Nobody', 'Alice'] },
  { kind: 'say', actor: 'Bob', body: 'a5', reply: 3 },
  { kind: 'listen', actor: 'Carol', target: 'alice' },
  { kind: 'say', actor: 'Alice', body: 'a7' },
  { kind: 'ignore', actor: 'Bob', target: 'Alice' },
  { kind: 'say', actor: 'Alice', body: 'a9', mentions: ['bob', 'Carol'] },
  { kind: 'say', actor: 'Alice', body: 'bell10', reach: 'bell' },
  { kind: 'done', actor: 'Bob', body: 'bye' },
  { kind: 'say', actor: 'Alice', body: 'bell12', reach: 'bell' },
  { kind: 'join', actor: 'Bob' },
  { kind: 'say', actor: 'Carol', body: 'a14', reply: 4 },
  { kind: 'done', actor: 'Carol' },
  { kind: 'say', actor: 'Alice', body: 'a16', mentions: ['bob', 'CAROL'] },
  { kind: 'say', actor: 'Alice', body: 'a17', reply: 15 },
  { kind: 'read', actor: 'Alice', through: 17 },
  { kind: 'read', actor: 'Alice', through: 18 },
  { kind: 'read', actor: 'Alice', through: 19 },
  { kind: 'say', actor: 'Alice', body: 'a21' },
  { kind: 'read', actor: 'Bob', through: 21 },
  { kind: 'say', actor: 'Alice', body: 'a23', reply: 22 },
  { kind: 'read', actor: 'CAROL', through: 23 },
  { kind: 'join', actor: 'Dave' },
  { kind: 'listen', actor: 'Dave', target: 'bob' },
  { kind: 'listen', actor: 'Dave', target: 'Carol' },
  { kind: 'ignore', actor: 'Dave', target: 'bob' },
  { kind: 'listen', actor: 'Dave', target: 'Bob' },
  { kind: 'listen', actor: 'Dave', target: 'Bob' },
  { kind: 'listen', actor: 'Dave', target: 'carol' },
  { kind: 'read', actor: 'Dave', through: 31 },
  { kind: 'say', actor: 'Alice', body: 'a33', reply: 32 },
];

// Imported with deliberate coordinate gaps, an orphan receipt coordinate, and
// a reply pointing at an assigned-but-missing activity.
const GAPPED_ACTS = [
  { index: 0, at: T0 + 0, kind: 'join', actor: 'Alice' },
  { index: 3, at: T0 + 3, kind: 'join', actor: 'Bob' },
  { index: 5, at: T0 + 5, kind: 'say', actor: 'Alice', body: 'g5', mentions: ['Bob'] },
  { index: 8, at: T0 + 8, kind: 'listen', actor: 'Bob', target: 'Alice' },
  { index: 11, at: T0 + 11, kind: 'say', actor: 'Alice', body: 'g11', reach: 'bell' },
  { index: 14, at: T0 + 14, kind: 'say', actor: 'Bob', body: 'g14', reply: 5 },
  { index: 20, at: T0 + 20, kind: 'say', actor: 'Alice', body: 'g20', reply: 18 },
  { index: 23, at: T0 + 23, kind: 'done', actor: 'Bob' },
  { index: 25, at: T0 + 25, kind: 'say', actor: 'Alice', body: 'g25', reach: 'bell' },
];

// Cursor fixture: non-read 5/7/8, reads 6/9/10/11, and two
// unseen addressed says (12, 13) after Alice's second join at 4.
const CURSOR_SOURCE = [
  { kind: 'join', actor: 'Alice' },
  { kind: 'join', actor: 'Bob' },
  { kind: 'say', actor: 'Bob', body: 'c2' },
  { kind: 'join', actor: 'Carol' },
  { kind: 'join', actor: 'Alice' },
  { kind: 'say', actor: 'Bob', body: 'c5' },
  { kind: 'read', actor: 'Alice', through: 5 },
  { kind: 'say', actor: 'Bob', body: 'c7' },
  { kind: 'say', actor: 'Bob', body: 'c8' },
  { kind: 'read', actor: 'Bob', through: 8 },
  { kind: 'read', actor: 'Bob', through: 9 },
  { kind: 'read', actor: 'Bob', through: 10 },
  { kind: 'say', actor: 'Bob', body: 'c12', mentions: ['alice', 'carol'] },
  { kind: 'say', actor: 'Bob', body: 'c13', mentions: ['alice', 'carol'] },
];

// Pre-rejoin edges: 2 and 3 land while Alice is standing, then she leaves and
// rejoins at 6, which is where the notification cutoff moves.
const REJOIN_ACTS = [
  { index: 0, at: T0 + 0, kind: 'join', actor: 'Bob' },
  { index: 1, at: T0 + 1, kind: 'join', actor: 'Alice' },
  { index: 2, at: T0 + 2, kind: 'say', actor: 'Bob', body: 'd2', mentions: ['alice'] },
  { index: 3, at: T0 + 3, kind: 'say', actor: 'Bob', body: 'd3', mentions: ['alice'] },
  { index: 4, at: T0 + 4, kind: 'done', actor: 'Alice' },
  { index: 5, at: T0 + 5, kind: 'say', actor: 'Bob', body: 'd5', mentions: ['alice'] },
  { index: 6, at: T0 + 6, kind: 'join', actor: 'Alice' },
  { index: 7, at: T0 + 7, kind: 'say', actor: 'Bob', body: 'd7', mentions: ['alice'] },
  { index: 8, at: T0 + 8, kind: 'say', actor: 'Bob', body: 'd8', mentions: ['alice'] },
];

test('audience priority is bell > mention > reply > attention, with self and ignore rules', async () => {
  const acts = stored(SEQUENTIAL_SOURCE);
  const port = createArtifactPort(':memory:', fixtureState(acts));
  try {
    const audience = async (index) => (await port.read((facts) => facts.audience(index))).value;
    assert.deepEqual(await audience(3), [{ recipient: 'Bob', route: 'mention', generation: 'act/1' }, { recipient: 'Carol', route: 'mention', generation: 'act/2' }], 'case-variant mentions resolve to roster spelling');
    assert.deepEqual(await audience(4), [], 'unknown and self mentions reach nobody');
    assert.deepEqual(await audience(5), [{ recipient: 'Alice', route: 'reply', generation: 'act/0' }]);
    assert.deepEqual(await audience(7), [{ recipient: 'Carol', route: 'attention', generation: 'act/2' }], 'listener-only edge');
    assert.deepEqual(await audience(9), [{ recipient: 'Carol', route: 'mention', generation: 'act/2' }], 'mention beats listening, ignoring sender is skipped');
    assert.deepEqual(await audience(10), [{ recipient: 'Bob', route: 'bell', generation: 'act/1' }, { recipient: 'Carol', route: 'bell', generation: 'act/2' }], 'bell bypasses ignore');
    assert.deepEqual(await audience(12), [{ recipient: 'Carol', route: 'bell', generation: 'act/2' }], 'departed peers are not reached');
    assert.deepEqual(await audience(14), [{ recipient: 'Alice', route: 'reply', generation: 'act/0' }]);
    assert.deepEqual(await audience(16), [], 'done mention target drops; ignoring target stays skipped after rejoin');
    assert.deepEqual(await audience(17), [], 'reply author who is no longer standing reaches nobody');
    assert.deepEqual(await audience(23), [], 'ignore blocks a reply as well as a mention');
    assert.deepEqual(await audience(33), [{ recipient: 'Dave', route: 'reply', generation: 'act/25' }], 'a read activity can be a reply author');
  } finally {
    await port.close();
  }
});

test('sparse orphan receipts retain coordinates and owner spelling', async () => {
  const observations = {
    Alice: Object.fromEntries([5, 11].map(index => [`act/${index}`, { state: 'seen', at: T0 + 100 }])),
    ghost: { 'act/14': { state: 'seen', at: T0 + 150 } },
  };
  const port = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS, { observations }));
  try {
    const view = (await port.read(facts => ({
      orphan: facts.receipt('ALICE', 5), missing: facts.receipt('Alice', 8),
      facts: facts.receiptFacts('Alice', -1), exact: facts.receipt('ghost', 14),
      casefolded: facts.receipt('Ghost', 14),
    }))).value;
    assert.deepEqual(view, { orphan: { at: T0 + 100 }, missing: undefined,
      facts: { latestAt: T0 + 100, latestActorActivityIndex: 11 }, exact: { at: T0 + 150 }, casefolded: undefined });
  } finally { await port.close(); }
});

test('cursor and presence distinguish holes, reads and orphan receipts', async () => {
  const acts = stored(CURSOR_SOURCE);
  async function probe(observations = {}) {
    const port = createArtifactPort(':memory:', fixtureState(acts, { observations }));
    try {
      return (await port.read(facts => ({
        cursor: readCursor(facts, 'ALICE'), presence: presenceAnchor(facts, 'Alice'),
        receiptFacts: facts.receiptFacts('Alice', 4),
        carolCursor: readCursor(facts, 'Carol'), carolPresence: presenceAnchor(facts, 'Carol'),
      }))).value;
    } finally { await port.close(); }
  }
  const before = await probe();
  assert.equal(before.cursor, 8);
  assert.equal(before.presence, 5);
  assert.equal(before.carolCursor, 8);
  assert.equal(before.carolPresence, -1);
  const beyond = await probe({ Alice: { 'act/13': { state: 'seen', at: T0 + 900 },
    'act/10': { state: 'seen', at: T0 + 950 } } });
  assert.equal(beyond.cursor, 8, 'a seen row beyond a hole does not advance the cursor');
  assert.equal(beyond.presence, 13, 'an orphan receipt does not move the anchor');
  assert.equal(beyond.receiptFacts.latestAt, T0 + 900, 'a receipt on a non-content activity has no message to survive import');
  assert.equal(beyond.receiptFacts.latestActorActivityIndex, 13);
  const complete = await probe({ Alice: { 'act/12': { state: 'seen', at: T0 + 1000 },
    'act/13': { state: 'seen', at: T0 + 900 } } });
  assert.equal(complete.cursor, 13);
});

test('historical audience retains earlier holes while pending discovery stops at the latest join', async () => {
  const port = createArtifactPort(':memory:', fixtureState(REJOIN_ACTS));
  try {
    const beforeCatch = (await port.read((facts) => ({
      historical: facts.directed('Alice', { unseenOnly: true }, { edge: 'oldest', limit: 10 }).items.map((head) => head.index),
      cursor: readCursor(facts, 'Alice'),
    }))).value;
    assert.deepEqual(beforeCatch.historical, [2, 3, 7, 8], 'ordinary catch is not cut by the latest join');
    assert.equal(beforeCatch.cursor, 6, 'cursor sits at the rejoin coordinate before any addressed row');

  } finally {
    await port.close();
  }
});

test('history context selects neighboring existing positions across gaps', async () => {
  const port = createArtifactPort(':memory:', fixtureState(GAPPED_ACTS));
  try {
    const context = async (centers, before, after) => (await port.read((facts) => facts.contextIndexes(centers, before, after))).value;
    assert.deepEqual(await context([14], 3, 3), [5, 8, 11, 14, 20, 23, 25], 'neighbors are existing positions, not coordinate arithmetic');
    assert.deepEqual(await context([8], 1, 1), [5, 8, 11], 'the previous position is act/5, not act/7');
    assert.deepEqual(await context([20], 1, 1), [14, 20, 23]);
    assert.deepEqual(await context([20, 5], 0, 0), [5, 20], 'centers union in index order');
  } finally {
    await port.close();
  }
});
